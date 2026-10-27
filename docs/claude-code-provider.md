# Claude Code provider

Runs the app on a **claude.ai subscription** through the local `claude` CLI. No API key is needed. It is meant for personal use on your own machine, with your own Claude Code sign-in. Do not host it for other people: a shared deployment would need API keys instead.

## Use it

1. Install [Claude Code](https://claude.com/claude-code), run `claude` once, and `/login` with your claude.ai account.
2. Start the app with **Node ≥ 22.19**:

   ```bash
   npm install
   npm run dev     # http://localhost:3000
   ```

   With Homebrew you can install `node@22` beside another default Node and use it for this project only: `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run dev`.

3. Settings → Providers → **Subscriptions** shows "Claude Code · Signed in".
4. Settings → Models: choose `claude-code` models for the three slots. A good start: strong = Sonnet 5.5 or Opus 5.5, cheap = Haiku 5.5, vision = Sonnet 5.5.

## How it works

```
agent loop ──> pi-ai Anthropic adapter ──> claudeCodeFetch()  (instead of the network)
                                                │  Anthropic request body
                                                ▼
                                   claude-code-request.ts: system prompt, tools,
                                   effort, and the whole conversation replayed
                                   as ONE <transcript> user message
                                                │
                                                ▼
                         `claude -p` (stream-json), Claude Code's tools off,
                         the app's tools offered via an MCP stub that never answers
                                                │  raw Anthropic stream events
                                                ▼
              SSE back to the adapter, which parses text, thinking, tool calls and usage
```

- **Stateless, like the app.** The app replays the full transcript on every model call, so each `claude` process serves exactly one call and then exits. No process holds conversation state that could drift from the chat record.
- **Tool calls.** Claude calls the app's tools through an MCP stub. When the message ends with `tool_use`, the response ends and the process is killed. The app's own loop runs the tool, as it does for any API provider.
- **Speed.** After each call, a spare process with the same setup is started and waits on stdin, which hides about 1 s of startup on the next step. At most 3 spares exist; idle ones exit after 5 minutes.
- **Prompt caching.** The transcript is append-only, so each call's prefix matches the previous one and Claude Code's cache hits (measured: about 10k of 11k prompt tokens read from cache on step 2).
- **Isolation.** The process gets no Claude Code tools, no settings files, no MCP servers other than ours, no slash commands, no saved sessions, and runs in an empty temp dir. `ANTHROPIC_API_KEY` is stripped, so calls always bill the subscription. Claude Code still adds a small block of its own (account email and name, date, model). `--bare` would remove it, but `--bare` disables subscription login.

## Files

| File | Role |
|---|---|
| `src/agent/claude-code-request.ts` | Anthropic body → CLI config + transcript (pure) |
| `src/agent/claude-code-process.ts` | spawn, prewarm pool, MCP stub, `claude auth status` detection |
| `src/agent/claude-code-stream.ts` | the local `fetch`, model list, `StreamFunction` |
| `src/agent/models.ts`, `src/server/model-catalog.ts`, `src/core/prices.ts` | wiring: engine branch, picker, "Claude Code" subscription label |
| `components/settings/claude-code-connection.tsx` | status row in Subscriptions |
| `tests/claude-code.test.ts` | unit tests against a fake `claude` (no network) |
| `scripts/smoke-claude-code.ts` | real calls: `npx tsx scripts/smoke-claude-code.ts [model-id]` |

`LH_CLAUDE_BIN` overrides the CLI path.

## Limits

- Each model call resends the whole lesson. Caching softens this, but long lessons use your plan's allowance faster than chatting normally.
- The stream-json format belongs to Claude Code and can change between versions. If lessons break after a Claude Code update, run the smoke script first.
- Thinking level "off" isn't supported by every model; the picker shows what each model allows.
