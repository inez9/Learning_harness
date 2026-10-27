import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeContext, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { claudeCodeRequest, RUNTIME_NOTE, TRANSCRIPT_CLOSE, type AnthropicBody } from "../src/agent/claude-code-request.ts";

// A fake `claude` (LH_CLAUDE_BIN): logs its argv, env and stdin, then
// replays LH_FAKE_SCRIPT's stream-json lines — the event shapes recorded
// from the real CLI with --include-partial-messages. "hang" keeps it alive
// like a real process waiting on a tool result, until it is killed.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-code-test-"));
const fakeBin = path.join(dir, "claude");
const logFile = path.join(dir, "calls.jsonl");
fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
let input = "";
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
	const systemFile = args[args.indexOf("--system-prompt-file") + 1];
	fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args, input, system: fs.readFileSync(systemFile, "utf-8"), apiKey: process.env.ANTHROPIC_API_KEY ?? null }) + "\\n");
	const script = JSON.parse(fs.readFileSync(process.env.LH_FAKE_SCRIPT, "utf-8"));
	for (const line of script.lines) process.stdout.write(JSON.stringify(line) + "\\n");
	if (!script.hang) process.exit(0);
	setInterval(() => {}, 1000);
});
`);
fs.chmodSync(fakeBin, 0o755);
const scriptFile = path.join(dir, "script.json");
const script = (lines: unknown[], hang = false) => fs.writeFileSync(scriptFile, JSON.stringify({ lines, hang }));
const calls = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l)) : [];

const se = (event: Record<string, unknown>) => ({ type: "stream_event", event });
const usage = { input_tokens: 2, output_tokens: 9, cache_read_input_tokens: 700, cache_creation_input_tokens: 40 };
const start = se({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], usage } });
const TOOL_STREAM = [
	{ type: "system", subtype: "init", tools: ["mcp__lh__ask_question"] },
	start,
	se({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__lh__ask_question", input: {} } }),
	se({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"question\":\"What is a cap" } }),
	se({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "acitor?\",\"options\":[\"a\",\"b\"]}" } }),
	se({ type: "content_block_stop", index: 0 }),
	se({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage }),
	se({ type: "message_stop" }),
	{ type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
];
const TEXT_STREAM = [
	start,
	se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } }),
	se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "there." } }),
	se({ type: "content_block_stop", index: 0 }),
	se({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage }),
	se({ type: "message_stop" }),
	{ type: "result", subtype: "success", is_error: false, result: "Hello there." },
];

const savedEnv = { bin: process.env.LH_CLAUDE_BIN, script: process.env.LH_FAKE_SCRIPT, key: process.env.ANTHROPIC_API_KEY };
let mod: {
	piEngineForSpec: typeof import("../src/agent/models.ts").piEngineForSpec;
	drainClaudeCodePool: typeof import("../src/agent/claude-code-process.ts").drainClaudeCodePool;
};
before(async () => {
	// The binary path is read at module load, so import after setting it.
	process.env.LH_CLAUDE_BIN = fakeBin;
	process.env.LH_FAKE_SCRIPT = scriptFile;
	process.env.ANTHROPIC_API_KEY = "sk-must-not-reach-claude-code";
	const models = await import("../src/agent/models.ts");
	const proc = await import("../src/agent/claude-code-process.ts");
	mod = { piEngineForSpec: models.piEngineForSpec, drainClaudeCodePool: proc.drainClaudeCodePool };
});
after(() => {
	mod.drainClaudeCodePool();
	for (const [key, value] of [["LH_CLAUDE_BIN", savedEnv.bin], ["LH_FAKE_SCRIPT", savedEnv.script], ["ANTHROPIC_API_KEY", savedEnv.key]] as const) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	fs.rmSync(dir, { recursive: true, force: true });
});

const tools = [{ name: "ask_question", description: "Ask one question.", parameters: Type.Object({ question: Type.String(), options: Type.Array(Type.String()) }) }];
async function run(context: Context, signalAfterText?: AbortController): Promise<AssistantMessage> {
	const engine = mod.piEngineForSpec({ provider: "claude-code", id: "claude-haiku-5-5", thinkingLevel: "low" });
	let final: AssistantMessage | undefined;
	for await (const event of engine.streamFn(engine.model, normalizeContext(context), { signal: signalAfterText?.signal })) {
		if (event.type === "text_delta") signalAfterText?.abort();
		if (event.type === "done") final = event.message;
		if (event.type === "error") final = event.error;
	}
	return final!;
}

test("transcript: roles, tool calls/results by name, images split out, thinking dropped", () => {
	const body: AnthropicBody = {
		model: "claude-sonnet-5-5",
		system: [{ type: "text", text: "You teach." }],
		output_config: { effort: "medium" },
		tools: [
			{ type: "custom", name: "plan_init", description: "Plan.", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
			{ type: "custom", name: "__pi_deferred_placeholder__", input_schema: { type: "object" }, defer_loading: true },
		],
		messages: [
			{ role: "user", content: [{ type: "text", text: "teach me" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
			{ role: "assistant", content: [{ type: "thinking", thinking: "secret", signature: "s" }, { type: "text", text: "Planning." }, { type: "tool_use", id: "t1", name: "plan_init", input: { goal: "x" } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "saved", is_error: false }] },
			{ role: "system", content: [], output_config: { effort: "high" } },
		],
	};
	const { config, content } = claudeCodeRequest(body);
	assert.equal(config.model, "claude-sonnet-5-5");
	assert.equal(config.effort, "high", "the trailing system message states the active level; top level is pi-ai's fixed baseline");
	assert.equal(config.systemPrompt, `You teach.\n\n${RUNTIME_NOTE}`);
	assert.deepEqual(config.tools, [{ name: "plan_init", description: "Plan.", inputSchema: { type: "object" } }]);
	assert.equal(content.length, 3, "text, image, text");
	assert.deepEqual(content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
	const rest = content[2]!.type === "text" ? content[2]!.text : "";
	assert.match(rest, /<tool_call name="plan_init" id="t1">\{"goal":"x"\}<\/tool_call>/);
	assert.match(rest, /<tool_result name="plan_init" id="t1">\nsaved\n<\/tool_result>/);
	assert.doesNotMatch(rest, /secret/);
	assert.ok(rest.endsWith(TRANSCRIPT_CLOSE));
});

test("transcript is append-only, so the prompt cache keeps hitting", () => {
	const turn1: AnthropicBody = { model: "m", messages: [{ role: "user", content: "hi" }] };
	const turn2: AnthropicBody = { model: "m", messages: [...turn1.messages, { role: "assistant", content: "hello" }, { role: "user", content: "more" }] };
	const text = (b: AnthropicBody) => claudeCodeRequest(b).content.map((c) => c.type === "text" ? c.text : "").join("");
	assert.ok(text(turn2).startsWith(text(turn1).slice(0, -TRANSCRIPT_CLOSE.length)));
});

test("tool call: MCP name restored, arguments streamed, stopReason toolUse, CLI isolated", async () => {
	script(TOOL_STREAM, true);
	const before = calls().length;
	const message = await run({ systemPrompt: "Teach.", tools, messages: [{ role: "user", content: "capacitors", timestamp: 1 }] });
	assert.equal(message.stopReason, "toolUse");
	const call = message.content.find((b) => b.type === "toolCall");
	assert.ok(call && call.type === "toolCall");
	assert.equal(call.name, "ask_question");
	assert.deepEqual(call.arguments, { question: "What is a capacitor?", options: ["a", "b"] });
	assert.equal(message.usage.cacheRead, 700);
	assert.equal(message.usage.cost.total, 0, "subscription use is unpriced");
	const log = calls()[before]!;
	for (const flag of ["--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "--include-partial-messages"]) assert.ok(log.args.includes(flag), flag);
	assert.equal(log.args[log.args.indexOf("--tools") + 1], "");
	assert.equal(log.args[log.args.indexOf("--model") + 1], "claude-haiku-5-5");
	assert.equal(log.apiKey, null, "API keys never reach the CLI: it must bill the subscription");
	assert.match(log.system, /^Teach\.\n\n<runtime_note>/);
	assert.match(JSON.parse(log.input).message.content[0].text, /<user>\ncapacitors\n<\/user>/);
});

test("plain text reply ends with stop", async () => {
	script(TEXT_STREAM);
	const message = await run({ systemPrompt: "Greet.", messages: [{ role: "user", content: "hi", timestamp: 1 }] });
	assert.equal(message.stopReason, "stop");
	assert.deepEqual(message.content.filter((b) => b.type === "text").map((b) => b.type === "text" && b.text), ["Hello there."]);
});

test("a failure before any output becomes a readable error", async () => {
	script([{ type: "result", subtype: "error", is_error: true, result: "Not logged in · Please run /login" }]);
	const message = await run({ systemPrompt: "Fail.", messages: [{ role: "user", content: "hi", timestamp: 1 }] });
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage ?? "", /not signed in/i);
});

test("abort mid-stream stops cleanly", async () => {
	script([...TEXT_STREAM.slice(0, 3)], true);
	const message = await run({ systemPrompt: "Abort.", messages: [{ role: "user", content: "go", timestamp: 1 }] }, new AbortController());
	assert.equal(message.stopReason, "aborted");
});
