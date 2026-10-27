/**
 * Claude Code request shaping — PURE. The claude-code provider runs pi-ai's
 * own Anthropic adapter against a local fetch (claude-code-stream.ts); this
 * module turns the Anthropic Messages body that adapter builds into what one
 * `claude -p` process needs: model, effort, system prompt, the tools to
 * advertise over MCP, and the whole conversation replayed as ONE user
 * message (stream-json input only carries user turns).
 *
 * The transcript is append-only and deterministic: an earlier call's
 * rendering is a byte prefix of the next one's, so Claude Code's prompt
 * cache keeps hitting as a lesson grows.
 */

import { createHash } from "node:crypto";

/** Claude Code exposes MCP tools as mcp__<server>__<tool>; ours is "lh". */
export const CLAUDE_CODE_MCP_SERVER = "lh";
export const CLAUDE_CODE_TOOL_PREFIX = `mcp__${CLAUDE_CODE_MCP_SERVER}__`;

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export interface McpTool { name: string; description: string; inputSchema: unknown }
export type ClaudeCodeContent =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/** Everything that must be fixed when the process STARTS (CLI flags + MCP
 *  tool list). Two requests with equal config can share a prewarmed process. */
export interface ClaudeCodeConfig { model: string; effort?: string; systemPrompt: string; tools: McpTool[] }
export interface ClaudeCodeRequest { config: ClaudeCodeConfig; content: ClaudeCodeContent[] }

type Block = Record<string, unknown> & { type: string };
interface AnthropicMessage { role: string; content: string | Block[]; output_config?: { effort?: string } }
export interface AnthropicBody {
	model: string;
	system?: string | { type: string; text: string }[];
	messages: AnthropicMessage[];
	tools?: (Block & { name: string; description?: string; input_schema?: unknown; defer_loading?: boolean })[];
	output_config?: { effort?: string };
}

/** Appended to the app's system prompt: how to read the replayed turn. */
export const RUNTIME_NOTE = [
	"<runtime_note>",
	"Each of your replies runs in a fresh process, so the user message replays the whole conversation so far inside <transcript>. Treat it as the live conversation: you are the assistant in it, and its end is the present moment.",
	"Your tools are real. Use them exactly as you would in a live conversation, whenever your instructions call for them. The <tool_call> and <tool_result> records in the transcript are only a log of earlier use; never write tool calls as text.",
	"</runtime_note>",
].join("\n");
export const TRANSCRIPT_PREAMBLE = "<transcript>\n";
export const TRANSCRIPT_CLOSE = "</transcript>\n\nContinue as the assistant from the end of the transcript.";

export function configKey(config: ClaudeCodeConfig): string {
	return createHash("sha256").update(JSON.stringify([config.model, config.effort ?? "", config.systemPrompt, config.tools])).digest("hex");
}

function systemText(system: AnthropicBody["system"]): string {
	if (!system) return "";
	return typeof system === "string" ? system : system.map((b) => b.text).join("\n\n");
}

/** The effort in force now. pi-ai pins the top-level output_config to a
 *  fixed baseline (a stable cached prefix) and states the ACTIVE level in
 *  the trailing mid-conversation system message, so the newest system
 *  message wins; the top level is only the fallback. */
function effortOf(body: AnthropicBody): string | undefined {
	let effort: string | undefined;
	for (const m of body.messages) if (m.role === "system" && m.output_config?.effort) effort = m.output_config.effort;
	effort ??= body.output_config?.effort;
	return effort && EFFORTS.has(effort) ? effort : undefined;
}

function mcpTools(tools: AnthropicBody["tools"]): McpTool[] {
	return (tools ?? [])
		.filter((t) => !t.defer_loading && !t.name.startsWith("__pi_"))
		.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.input_schema ?? { type: "object", properties: {} } }));
}

const attr = (value: string) => value.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]!);

/** Accumulates text, splitting only where an image must sit between runs. */
class ContentBuilder {
	readonly out: ClaudeCodeContent[] = [];
	private text = "";
	push(text: string) { this.text += text; }
	image(block: Block) {
		const source = block.source as { type?: string; media_type?: string; data?: string } | undefined;
		if (source?.type !== "base64" || !source.data || !source.media_type) { this.push("[image omitted]"); return; }
		this.flush();
		this.out.push({ type: "image", source: { type: "base64", media_type: source.media_type, data: source.data } });
	}
	flush() { if (this.text) { this.out.push({ type: "text", text: this.text }); this.text = ""; } }
}

function renderToolResult(builder: ContentBuilder, block: Block, toolNames: Map<string, string>) {
	const id = String(block.tool_use_id ?? "");
	const error = block.is_error ? ' error="true"' : "";
	builder.push(`<tool_result name="${attr(toolNames.get(id) ?? "unknown")}" id="${attr(id)}"${error}>\n`);
	const content = block.content as string | Block[] | undefined;
	if (typeof content === "string") builder.push(content);
	else for (const part of content ?? []) {
		if (part.type === "text") builder.push(String(part.text ?? ""));
		else if (part.type === "image") builder.image(part);
	}
	builder.push("\n</tool_result>\n");
}

/** The Anthropic body → one Claude Code request. */
export function claudeCodeRequest(body: AnthropicBody): ClaudeCodeRequest {
	const builder = new ContentBuilder();
	const toolNames = new Map<string, string>();
	builder.push(TRANSCRIPT_PREAMBLE);
	for (const message of body.messages) {
		const blocks: Block[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
		if (message.role === "system") {
			const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n");
			if (text) builder.push(`<system_update>\n${text}\n</system_update>\n`);
			continue;
		}
		const role = message.role === "assistant" ? "assistant" : "user";
		builder.push(`<${role}>\n`);
		for (const block of blocks) {
			if (block.type === "text") builder.push(`${String(block.text ?? "")}\n`);
			else if (block.type === "image") builder.image(block);
			else if (block.type === "tool_use") {
				toolNames.set(String(block.id), String(block.name));
				builder.push(`<tool_call name="${attr(String(block.name))}" id="${attr(String(block.id))}">${JSON.stringify(block.input ?? {})}</tool_call>\n`);
			} else if (block.type === "tool_result") renderToolResult(builder, block, toolNames);
			// thinking / redacted_thinking: the model's private scratch, not replayed
		}
		builder.push(`</${role}>\n`);
	}
	builder.push(TRANSCRIPT_CLOSE);
	builder.flush();
	return {
		config: { model: body.model, effort: effortOf(body), systemPrompt: `${systemText(body.system)}\n\n${RUNTIME_NOTE}`, tools: mcpTools(body.tools) },
		content: builder.out,
	};
}
