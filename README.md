# Learning Harness

An AI tutor that runs on your Mac and teaches with your **Claude subscription**. You don't need an API key.

Tell it what you want to understand. It first finds out what you already know, then plans a path to your goal, teaches it step by step with questions, diagrams and interactive demos, and gives you practice sessions afterwards. A knowledge graph keeps track of what you've learned across sessions.

## Credit

This project is built on **[LearnHarness](https://github.com/amosblomqvist/learnharness)** by Amos Blomqvist. It is a modified version of that project (modified October 2026) and, like the original, is licensed under the [GNU AGPL-3.0](LICENSE).

## Requirements

- macOS (Linux likely works too, but it is untested)
- **Node.js 22.19 or newer**
- **[Claude Code](https://claude.com/claude-code)** installed and signed in with your claude.ai account (run `claude` once, then `/login`)

## Run it

```bash
git clone https://github.com/inez9/Learning_harness.git
cd Learning_harness
npm install
npm run dev
```

Then open http://localhost:3000.

1. **Settings → Providers → Subscriptions** should show *Claude Code · Signed in*.
2. In **Settings → Models**, choose `claude-code` models for the three slots. A good start: Sonnet 5.5 for *strong* and *vision*, Haiku 5.5 for *cheap*.
3. Start a session with something you want to learn.

API-key providers still work too, if you'd rather use them.

## How the Claude connection works

Each time the tutor needs a model reply, the app runs the `claude` command-line tool on your machine instead of calling an API. Claude Code's own tools and settings are switched off, the tutor's tools are offered to Claude, and the reply streams back into the app. Usage counts against your Claude plan's limits, and prompt caching keeps long lessons affordable.

Details: [docs/claude-code-provider.md](docs/claude-code-provider.md).

## Notes

- **Personal use.** Each person runs the app on their own computer with their own Claude Code sign-in. Don't host it as a service for others.
- **Your data stays local.** Sessions, the knowledge graph and settings are plain files in `data/`. Model requests go to Anthropic through Claude Code.
- **Claude Code updates.** If lessons stop working after a Claude Code update, run `npx tsx scripts/smoke-claude-code.ts` to check the connection.

## Development

```bash
npm test           # no network, no model calls
npm run typecheck
npm run lint
```

## License

[AGPL-3.0](LICENSE). See the original project for its full documentation.
