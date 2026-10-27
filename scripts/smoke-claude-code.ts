// Manual smoke for the claude-code provider: REAL `claude` calls on your
// subscription (Haiku by default, a few cents' worth of usage).
//   npx tsx scripts/smoke-claude-code.ts [model-id]
// Checks: tool call round-trip through pi-ai's Anthropic adapter, the warm
// follow-up step, plain text, abort, and that no processes are left behind.
import { execFileSync } from "node:child_process";
import { normalizeContext, Type, type AssistantMessage, type Context, type Message } from "@earendil-works/pi-ai";
import { piEngineForSpec } from "../src/agent/models.ts";
import { drainClaudeCodePool } from "../src/agent/claude-code-process.ts";

const id = process.argv[2] ?? "claude-haiku-5-5";
const engine = piEngineForSpec({ provider: "claude-code", id, thinkingLevel: "low" });
const tools = [{
	name: "ask_question",
	description: "Ask the learner one multiple-choice question. Their answer arrives as the tool result.",
	parameters: Type.Object({ question: Type.String(), options: Type.Array(Type.String()) }),
}];
const systemPrompt = "You are a tutor. Before explaining anything, call ask_question once to find out what the learner already knows. After you get the answer, explain in two sentences and stop.";

async function step(label: string, context: Context, abortAfterText = false): Promise<AssistantMessage> {
	const started = performance.now();
	const controller = new AbortController();
	let firstAt: number | undefined, kinds = new Set<string>();
	// the agent loop always hands stream functions a normalized transcript
	const stream = engine.streamFn(engine.model, normalizeContext(context), { signal: controller.signal });
	let final: AssistantMessage | undefined;
	for await (const event of stream) {
		kinds.add(event.type);
		if (firstAt === undefined && (event.type === "text_delta" || event.type === "toolcall_delta" || event.type === "toolcall_start")) firstAt = performance.now();
		if (abortAfterText && event.type === "text_delta") controller.abort();
		if (event.type === "done") final = event.message;
		if (event.type === "error") final = event.error;
	}
	const m = final!;
	console.log(`\n[${label}] stop=${m.stopReason} first=${firstAt ? Math.round(firstAt - started) : "-"}ms total=${Math.round(performance.now() - started)}ms`);
	console.log(`  events: ${[...kinds].join(", ")}`);
	console.log(`  usage: in=${m.usage.input} out=${m.usage.output} cacheRead=${m.usage.cacheRead} cacheWrite=${m.usage.cacheWrite} cost=$${m.usage.cost.total}`);
	for (const block of m.content) {
		if (block.type === "text") console.log(`  text: ${block.text.slice(0, 300)}`);
		if (block.type === "toolCall") console.log(`  toolCall: ${block.name} ${JSON.stringify(block.arguments)}`);
		if (block.type === "thinking") console.log(`  thinking: ${block.thinking.slice(0, 120)}…`);
	}
	if (m.errorMessage) console.log(`  error: ${m.errorMessage}`);
	return m;
}

const messages: Message[] = [{ role: "user", content: "Teach me what a capacitor does.", timestamp: Date.now() }];
const first = await step("1 tool call", { systemPrompt, tools, messages });
const call = first.content.find((b) => b.type === "toolCall");
if (first.stopReason !== "toolUse" || !call || call.type !== "toolCall") throw new Error("expected a tool call");
messages.push(first, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "The learner picked the second option." }], isError: false, timestamp: Date.now() });
const second = await step("2 follow-up (warm)", { systemPrompt, tools, messages });
if (second.stopReason === "error") throw new Error("follow-up failed");
await step("3 abort mid-text", { systemPrompt: "Write a long, detailed essay.", messages: [{ role: "user", content: "Explain the history of the capacitor.", timestamp: Date.now() }] }, true);

drainClaudeCodePool();
await new Promise((r) => setTimeout(r, 1500));
let stray = "";
try { stray = execFileSync("pgrep", ["-fl", "lh-claude"], { encoding: "utf-8" }).trim(); } catch { /* none */ }
console.log(`\nstray processes: ${stray || "none"}`);
