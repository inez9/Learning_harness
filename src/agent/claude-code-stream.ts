/**
 * The claude-code provider: Claude via the local `claude` CLI on the
 * user's claude.ai subscription — no API key.
 *
 * Shape: pi-ai's OWN Anthropic adapter runs unchanged against a local
 * `fetch`. That fetch reads the Messages request the adapter built,
 * starts (or takes a prewarmed) Claude Code process, and answers with an
 * SSE body made of the raw Anthropic stream events Claude Code passes
 * through (--include-partial-messages). So text, thinking, streamed tool
 * arguments, usage and stop reasons all parse through pi-ai's tested
 * code path — this module only moves bytes and renames our MCP tools back.
 *
 * Tool calls: Claude calls the app's tools through an MCP stub that never
 * answers (claude-code-process.ts). At message_stop the response ends and
 * the process is killed; the agent loop sees stopReason "toolUse" and runs
 * the tool itself, exactly as with any API provider.
 */

import type { Api, Model, SimpleStreamOptions, StreamFunction } from "@earendil-works/pi-ai";
import { streamSimple as anthropicStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { CLAUDE_CODE_TOOL_PREFIX, claudeCodeRequest, type AnthropicBody } from "./claude-code-request.ts";
import { takeClaudeCode, type ClaudeCodeEvent } from "./claude-code-process.ts";

export const CLAUDE_CODE_PROVIDER = "claude-code";
/** The models offered, by their Anthropic catalog ids (claude --model accepts them). */
export const CLAUDE_CODE_MODEL_IDS = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** A catalog Anthropic model re-homed under the claude-code provider:
 *  subscription use, so no per-token price. */
export function claudeCodeModel(base: Model<Api>): Model<Api> {
	return { ...base, provider: CLAUDE_CODE_PROVIDER, baseUrl: "http://claude-code.local", cost: { ...base.cost, ...FREE } };
}

function errorResponse(status: number, message: string): Response {
	return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message } }), { status, headers: { "content-type": "application/json" } });
}

/** A failure Claude Code reported before streaming, as a readable error. */
export function claudeCodeFailure(event: ClaudeCodeEvent | undefined, stderr: string): { status: number; message: string } {
	const detail = String(event?.result ?? event?.error ?? stderr ?? "").trim();
	const apiStatus = typeof event?.api_error_status === "number" ? event.api_error_status : undefined;
	if (/log ?in|logged out|auth|credential|401/i.test(detail) || apiStatus === 401) {
		return { status: 401, message: "Claude Code is not signed in. Run `claude` in a terminal and use /login, then retry." };
	}
	if (/rate.?limit|usage limit|limit reached|429/i.test(detail) || apiStatus === 429) {
		return { status: 429, message: `Claude subscription usage limit reached. Try again later.${detail ? ` (${detail.slice(0, 200)})` : ""}` };
	}
	if (/ENOENT|not found/i.test(detail)) return { status: 503, message: "The `claude` CLI was not found. Install Claude Code or set LH_CLAUDE_BIN." };
	return { status: apiStatus ?? 502, message: `Claude Code request failed${detail ? `: ${detail.slice(0, 500)}` : "."}` };
}

/** Restore the app's tool name on a streamed tool_use block. */
function unprefixTool(event: Record<string, unknown>): Record<string, unknown> {
	const block = event.content_block as { type?: string; name?: string } | undefined;
	if (event.type !== "content_block_start" || block?.type !== "tool_use" || !block.name?.startsWith(CLAUDE_CODE_TOOL_PREFIX)) return event;
	return { ...event, content_block: { ...block, name: block.name.slice(CLAUDE_CODE_TOOL_PREFIX.length) } };
}

const sse = (event: Record<string, unknown>) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;

/** The local fetch the Anthropic adapter calls instead of the network. */
export async function claudeCodeFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
	let body: AnthropicBody;
	try { body = JSON.parse(String(init?.body)) as AnthropicBody; } catch { return errorResponse(400, "Unreadable request for Claude Code."); }
	const request = claudeCodeRequest(body);
	const proc = takeClaudeCode(request.config);
	const signal = init?.signal ?? undefined;
	if (signal?.aborted) { proc.kill(); throw signal.reason ?? new DOMException("Aborted", "AbortError"); }
	const onAbort = () => proc.kill();
	signal?.addEventListener("abort", onAbort, { once: true });
	proc.send(request.content);

	const events = proc.events()[Symbol.asyncIterator]();
	const finish = () => { signal?.removeEventListener("abort", onAbort); proc.kill(); };
	// Hold the response until the model starts streaming, so a failure before
	// any output (signed out, usage limit) becomes an HTTP error pi-ai reports.
	let first: Record<string, unknown> | undefined;
	for (;;) {
		const next = await events.next();
		if (next.done) {
			finish();
			if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
			const failure = claudeCodeFailure(undefined, proc.stderr());
			return errorResponse(failure.status, failure.message);
		}
		const event = next.value;
		if (event.type === "stream_event") { first = event.event as Record<string, unknown>; break; }
		if (event.type === "result" || (event.type === "rate_limit_event" && (event.rate_limit_info as { status?: string } | undefined)?.status === "rejected")) {
			finish();
			const failure = claudeCodeFailure(event.type === "result" ? event : { ...event, result: "usage limit reached" }, proc.stderr());
			return errorResponse(failure.status, failure.message);
		}
	}

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) { controller.enqueue(encoder.encode(sse(unprefixTool(first!)))); },
		async pull(controller) {
			try {
				for (;;) {
					const next = await events.next();
					if (next.done) {
						// exited mid-message: surface it instead of a silent truncation
						controller.enqueue(encoder.encode(sse({ type: "error", error: { type: "api_error", message: claudeCodeFailure(undefined, proc.stderr()).message } })));
						finish(); controller.close(); return;
					}
					const event = next.value;
					if (event.type === "result" && event.is_error) {
						controller.enqueue(encoder.encode(sse({ type: "error", error: { type: "api_error", message: claudeCodeFailure(event, proc.stderr()).message } })));
						finish(); controller.close(); return;
					}
					if (event.type !== "stream_event") continue;
					const inner = unprefixTool(event.event as Record<string, unknown>);
					controller.enqueue(encoder.encode(sse(inner)));
					if (inner.type === "message_stop") { finish(); controller.close(); return; }
					return; // one event per pull keeps backpressure honest
				}
			} catch (error) { finish(); controller.error(error); }
		},
		cancel() { finish(); },
	});
	return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** The StreamFunction for claude-code engines: pi-ai's Anthropic adapter on
 *  the local fetch. The placeholder key only satisfies the adapter's auth
 *  check; nothing leaves the machine except through the CLI. */
export function claudeCodeStream(): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options) => anthropicStreamSimple(
		{ ...model, api: "anthropic-messages" } as Model<"anthropic-messages">,
		context,
		{ ...options, apiKey: "claude-code-local", fetch: claudeCodeFetch, maxRetries: 0 },
	);
}
