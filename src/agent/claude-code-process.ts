/**
 * Claude Code processes — spawn, prewarm, availability.
 *
 * One `claude -p` process serves exactly ONE model call, then dies: the app
 * replays the full transcript every call (claude-code-request.ts), so no
 * process ever holds conversation state that could drift from the record.
 * Startup (~1-2 s) is hidden by a PREWARM: after a call, a spare process
 * with the same config (model, effort, system prompt, tools) is started
 * and waits on stdin; the agent loop's next step usually takes it.
 *
 * Isolation: Claude Code's own tools are off, only our MCP stub is loaded,
 * no settings files, slash commands or session files, and it runs in an
 * empty temp dir. API-key env vars are stripped so the call always bills
 * the claude.ai subscription. (--bare would isolate further but disables
 * subscription login.)
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { CLAUDE_CODE_MCP_SERVER, configKey, type ClaudeCodeConfig, type ClaudeCodeContent } from "./claude-code-request.ts";

const CLAUDE_BIN = process.env.LH_CLAUDE_BIN || "claude";
const POOL_MAX = 3;
const IDLE_MS = 5 * 60_000;

/** The MCP stub: advertises the tools in LH_TOOLS_FILE and never answers a
 *  tools/call — the stream adapter kills Claude as soon as the tool_use is
 *  complete, and the APP runs the tool. Newline-delimited JSON-RPC. */
const MCP_STUB = `import * as fs from "node:fs";
import * as readline from "node:readline";
const tools = JSON.parse(fs.readFileSync(process.env.LH_TOOLS_FILE, "utf-8"));
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	let r; try { r = JSON.parse(line); } catch { return; }
	if (r.id === undefined || r.method === "tools/call") return;
	if (r.method === "initialize") send({ id: r.id, result: { protocolVersion: r.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "lh", version: "0" } } });
	else if (r.method === "tools/list") send({ id: r.id, result: { tools } });
	else if (r.method === "ping") send({ id: r.id, result: {} });
	else send({ id: r.id, error: { code: -32601, message: "unsupported: " + r.method } });
});
`;

let stubPath: string | undefined;
function mcpStub(): string {
	if (!stubPath || !fs.existsSync(stubPath)) {
		stubPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-mcp-")), "stub.mjs");
		fs.writeFileSync(stubPath, MCP_STUB);
	}
	return stubPath;
}

function childEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_") || key === "ANTHROPIC_API_KEY" || key === "ANTHROPIC_AUTH_TOKEN") delete env[key];
	}
	return env;
}

/** One stream-json line from Claude Code's stdout. */
export type ClaudeCodeEvent = Record<string, unknown> & { type: string };

export interface ClaudeCodeProcess {
	/** Write the single user message and close stdin. */
	send(content: ClaudeCodeContent[]): void;
	/** stdout events in order; ends when the process exits. */
	events(): AsyncIterable<ClaudeCodeEvent>;
	stderr(): string;
	kill(): void;
	readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export function claudeCodeArgs(config: ClaudeCodeConfig, dir: string): string[] {
	const systemFile = path.join(dir, "system.md");
	fs.writeFileSync(systemFile, config.systemPrompt);
	const args = [
		"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--model", config.model, "--system-prompt-file", systemFile,
		"--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands",
	];
	if (config.effort) args.push("--effort", config.effort);
	if (config.tools.length > 0) {
		const toolsFile = path.join(dir, "tools.json");
		fs.writeFileSync(toolsFile, JSON.stringify(config.tools));
		const mcp = { mcpServers: { [CLAUDE_CODE_MCP_SERVER]: { command: process.execPath, args: [mcpStub()], env: { LH_TOOLS_FILE: toolsFile } } } };
		args.push("--mcp-config", JSON.stringify(mcp), "--allowedTools", `mcp__${CLAUDE_CODE_MCP_SERVER}`);
	}
	return args;
}

function spawnClaudeCode(config: ClaudeCodeConfig): ClaudeCodeProcess {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-"));
	const child: ChildProcess = spawn(CLAUDE_BIN, claudeCodeArgs(config, dir), { cwd: dir, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
	child.stdin?.on("error", () => { /* EPIPE after a kill — the exit path reports */ });
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.on("error", (error) => { stderr += String(error); resolve({ code: -1, signal: null }); });
		child.on("exit", (code, signal) => resolve({ code, signal }));
	});
	void exited.then(() => fs.rm(dir, { recursive: true, force: true }, () => {}));
	// Buffer from spawn on: a prewarmed process may print before anyone reads.
	const queue: ClaudeCodeEvent[] = [];
	let closed = false, wake: (() => void) | undefined;
	const lines = readline.createInterface({ input: child.stdout! });
	lines.on("line", (line) => {
		if (!line.trim()) return;
		try { queue.push(JSON.parse(line) as ClaudeCodeEvent); } catch { return; /* non-JSON noise */ }
		wake?.();
	});
	lines.on("close", () => { closed = true; wake?.(); });
	return {
		send(content) {
			child.stdin?.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
			child.stdin?.end();
		},
		async *events() {
			for (;;) {
				if (queue.length > 0) { yield queue.shift()!; continue; }
				if (closed) return;
				await new Promise<void>((resolve) => { wake = resolve; });
				wake = undefined;
			}
		},
		stderr: () => stderr,
		kill() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); },
		exited,
	};
}

interface Spare { key: string; process: ClaudeCodeProcess; timer: ReturnType<typeof setTimeout> }
const POOL_KEY = Symbol.for("lh.claudeCode.pool");
function pool(): Spare[] {
	const global = globalThis as typeof globalThis & { [POOL_KEY]?: Spare[] };
	if (!global[POOL_KEY]) {
		global[POOL_KEY] = [];
		process.once("exit", () => { for (const spare of global[POOL_KEY]!) spare.process.kill(); });
	}
	return global[POOL_KEY];
}

function retire(spare: Spare) {
	clearTimeout(spare.timer);
	const spares = pool(), index = spares.indexOf(spare);
	if (index >= 0) spares.splice(index, 1);
}

function prewarm(key: string, config: ClaudeCodeConfig) {
	const spares = pool();
	if (spares.some((s) => s.key === key)) return;
	while (spares.length >= POOL_MAX) { const oldest = spares[0]!; retire(oldest); oldest.process.kill(); }
	const spare: Spare = { key, process: spawnClaudeCode(config), timer: setTimeout(() => { retire(spare); spare.process.kill(); }, IDLE_MS) };
	spare.timer.unref?.();
	void spare.process.exited.then(() => retire(spare));
	spares.push(spare);
}

/** A process for this config — the prewarmed spare when one matches, else a
 *  fresh spawn — and a new spare queued for the agent loop's next step. */
export function takeClaudeCode(config: ClaudeCodeConfig): ClaudeCodeProcess {
	const key = configKey(config);
	const spare = pool().find((s) => s.key === key);
	if (spare) retire(spare);
	const taken = spare?.process ?? spawnClaudeCode(config);
	prewarm(key, config);
	return taken;
}

/** Kill every idle spare (tests, shutdown). */
export function drainClaudeCodePool() {
	for (const spare of [...pool()]) { retire(spare); spare.process.kill(); }
}

/** Is the CLI installed and signed in to claude.ai? Cached: a positive
 *  answer for the process lifetime, a negative one re-checked after 30 s
 *  (so signing in elsewhere shows up without a restart). */
let status: { ok: boolean; at: number; pending?: Promise<void> } = { ok: false, at: 0 };
export function claudeCodeAvailable(): boolean {
	if (!status.ok && !status.pending && Date.now() - status.at > 30_000) refreshClaudeCodeStatus();
	return status.ok;
}
export function refreshClaudeCodeStatus(): Promise<void> {
	status.pending ??= new Promise<void>((resolve) => {
		execFile(CLAUDE_BIN, ["auth", "status"], { env: childEnv(), timeout: 15_000 }, (error, stdout) => {
			let ok = false;
			try { const parsed = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string }; ok = !error && parsed.loggedIn === true && parsed.authMethod === "claude.ai"; } catch { ok = false; }
			status = { ok, at: Date.now() };
			resolve();
		});
	});
	return status.pending;
}
