# Learning Harness

An AI tutor that runs on your Mac and teaches with your **Claude subscription**. You don't need an API key.

Tell it what you want to understand. It first finds out what you already know, then plans a path to your goal, teaches it step by step with questions, diagrams and interactive demos, and gives you practice sessions afterwards. A knowledge graph keeps track of what you've learned across sessions.

## Credit

This project is built on **[LearnHarness](https://github.com/amosblomqvist/learnharness)** by Amos Blomqvist. It is a modified version of that project (modified October 2026) and, like the original, is licensed under the [GNU AGPL-3.0](LICENSE).

## What you need

| | What | Why |
|---|---|---|
| 1 | **A Claude subscription** (Pro or Max) at [claude.ai](https://claude.ai) | Pays for the tutor's model use; no API key needed |
| 2 | **macOS** | Tested there; Linux likely works but is untested |
| 3 | **Git** | To download the project |
| 4 | **Node.js 22.19 or newer** | Runs the app |
| 5 | **Claude Code** (the `claude` command), signed in | The app talks to Claude through it |

## Setup (first time)

### 1. Install Homebrew (if you don't have it)

Homebrew is the usual way to install developer tools on a Mac. Check whether you have it:

```bash
brew --version
```

If that says "command not found", install it from [brew.sh](https://brew.sh) and follow the instructions it prints at the end.

### 2. Install Git

```bash
git --version          # already installed? you're done
brew install git       # otherwise
```

### 3. Install Node.js 22

```bash
node --version
```

If it prints `v22.19.0` or higher (for example `v22.23.4`, or `v24.x`), skip this step. Otherwise:

```bash
brew install node@22
```

> **Already using an older Node for other projects?** Homebrew installs `node@22` *beside* your current Node without replacing it. To use Node 22 for this project only, put this in front of the npm commands below:
> `PATH=/opt/homebrew/opt/node@22/bin:$PATH`
> e.g. `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run dev`
> (On Intel Macs the path is `/usr/local/opt/node@22/bin`.)

### 4. Install Claude Code and sign in

Install it (see [Claude Code's docs](https://docs.claude.com/en/docs/claude-code/setup) for other options):

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Then start it once and sign in with your **claude.ai account** (not an API key):

```bash
claude
# inside Claude Code, type:  /login   and follow the browser sign-in, then /exit
```

Check that it worked:

```bash
claude auth status
```

You should see `"loggedIn": true` and `"authMethod": "claude.ai"`.

> If you have an `ANTHROPIC_API_KEY` set in your shell, that's fine: the app removes it when calling Claude Code, so lessons always use your subscription.

### 5. Download and install the app

```bash
git clone https://github.com/inez9/Learning_harness.git
cd Learning_harness
npm install
```

`npm install` downloads the app's libraries. It takes a minute or two and only needs to run once (and again after you pull updates).

## Run it

From the `Learning_harness` folder:

```bash
npm run dev
```

Open **http://localhost:3000** in your browser. Leave the terminal open while you use the app; press `Ctrl+C` there to stop it.

**First time in the app:**

1. Open **Settings → Providers**. Under **Subscriptions** it should say *Claude Code · Signed in*. If it says *Not found*, see Troubleshooting below, then press **Recheck**.
2. Open **Settings → Models** and pick `claude-code` models for all three slots:
   - **strong** (teaching): Sonnet 5.5, or Opus 5.5 for the best quality
   - **cheap** (background helpers): Haiku 5.5
   - **vision** (reading images/PDFs): Sonnet 5.5
3. Start a new session and type what you want to understand.

API-key providers still work too, if you'd rather use them.

## Troubleshooting

| Problem | Fix |
|---|---|
| `npm install` or `npm run dev` fails with engine/syntax errors | Your Node is too old. Run `node --version`; see step 3. |
| Settings shows *Claude Code: Not found* | Run `claude auth status` in a terminal. If `claude` isn't found, redo step 4 and open a new terminal window. If it says not logged in, run `claude` and `/login`. Then press **Recheck**. |
| "Claude Code is not signed in" error during a lesson | Your sign-in expired: run `claude`, `/login`, then retry the turn. |
| "usage limit reached" | You've hit your Claude plan's usage limit for now. Wait for it to reset, or switch to a smaller model (Haiku) in Settings → Models. |
| Port 3000 is already in use | Run `npm run dev -- -p 3001` and open http://localhost:3001. |
| Lessons broke after a Claude Code update | Run `npx tsx scripts/smoke-claude-code.ts` to test the connection on its own. |

## Updating

```bash
cd Learning_harness
git pull
npm install
```

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
