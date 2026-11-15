# Coding UI

A web-based coding assistant built on the **Claude Code CLI**, using the
**`glm-5.2:cloud`** model served by a local Anthropic-compatible gateway.

The browser UI talks to a small Node backend over WebSocket. The backend spawns
one headless `claude` process per chat session (stream-json in/out) and relays
its events to the browser in real time. Claude's tool calls (Read / Write / Edit
/ Bash / Glob / Grep) are rendered as collapsible cards with diffs and results.

```
Browser (React) ──WebSocket──▶ Node backend ──spawn──▶ claude -p --output-format stream-json
                                                              │ POST /v1/messages (Anthropic fmt)
                                                              ▼
                                          Gateway @ http://127.0.0.1:11434 (glm-5.2:cloud)
```

## Why no bridge (claude-code-router / LiteLLM)?

Claude Code speaks the Anthropic Messages API. The gateway at `127.0.0.1:11434`
**already speaks that protocol natively** (it returns Anthropic-shaped
`/v1/messages` responses), so Claude Code can hit it directly — no OpenAI↔Anthropic
translation layer is needed. The endpoint/model are configurable in `.env`; if you
ever point at a plain OpenAI-compatible endpoint, drop a bridge in front and point
`ANTHROPIC_BASE_URL` at the bridge instead.

## Prerequisites

- Node.js >= 20 (developed on 22)
- The `claude` CLI on PATH (`which claude`)
- A running Anthropic-compatible gateway serving `glm-5.2:cloud` at
  `ANTHROPIC_BASE_URL` (default `http://127.0.0.1:11434`)

## Setup

```bash
npm install
cp .env.example .env      # edit if your gateway/model/auth differ
```

`.env` defaults match the local gateway this was built against:

| Var | Meaning |
|---|---|
| `ANTHROPIC_BASE_URL` | Gateway Claude Code sends `/v1/messages` to |
| `ANTHROPIC_MODEL` | Model name in the request `model` field |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Model for background (haiku) calls — must resolve on the gateway |
| `ANTHROPIC_AUTH_TOKEN` | `Authorization: Bearer` token (local gateway ignores it) |
| `PORT` | Backend port (default 3001) |
| `WORKSPACE_ROOT` | Parent dir for per-session working directories |
| `SKIP_PERMISSIONS` | `1` = run headless Claude with full autonomy (see below) |

## Run

```bash
npm run dev      # Vite frontend (5173) + backend (3001), with proxy
# open http://localhost:5173
```

Production (single port, backend serves the built UI):

```bash
npm run build && npm start
# open http://localhost:3001
```

## Using it

1. Pick a working directory in the sidebar (or **+ dir** to create one under
   `WORKSPACE_ROOT`).
2. Click **+ New chat** — this starts a `claude` session in that directory.
3. Message Claude Code. Ask it to read, edit, or run things. Tool calls and their
   results render as collapsible cards; file edits show a diff. The right-hand
   panel browses the working directory.
4. Sessions are listed in the sidebar and can be resumed (the backend re-spawns
   `claude --resume <id>`). **Stop** kills the current turn's subprocess.

## Usage / quota panel

The topbar's **Usage** button opens a cross-provider usage view
(`web/src/components/Usage.jsx` ← `GET /api/usage` ← `server/usage.js`). What
each channel can actually answer, as measured 2026-11-15:

| Channel | Quota source | Notes |
|---|---|---|
| Claude subscription | `anthropic-ratelimit-unified-*` response headers (5h + 7d utilization, resets) via a 1-token probe request | `GET /api/oauth/usage` is richer but rate-limited to ~1 call/hour (429 + `Retry-After` ≈ 56min), so it is only an enrichment, cached an hour and shown as the card's raw payload |
| ChatGPT plan (codex) | `GET chatgpt.com/backend-api/codex/usage` with the Codex CLI's token | Free to call: plan type, 5h + weekly window percent, reset timestamps, credit balance |
| grok.com subscription | `GET cli-chat-proxy.grok.com/v1/billing` + `x-ratelimit-*` headers from a 1-token probe | Every call **must** send `x-grok-client-version`, else the proxy answers `426 … version (none) is outdated`. xAI reports limit/remaining but no window length or reset time |
| Ollama cloud gateway | none — `POST /api/me` gives account + plan tier only | ollama.com publishes no usage API and its completions carry no rate-limit headers, so this channel's consumption is only visible in the local ledger |

Tokens are read from each official CLI's own credential file, never returned to
the browser, and never refreshed by us (the CLIs rotate their own refresh
tokens — racing them can invalidate a working login). Expired credentials are
reported as `stale` instead.

Below the provider cards, the **local ledger** aggregates what we actually spent by
scanning `~/.claude/projects/**/*.jsonl`: claude-engine turns carry
`message.usage` natively (so this is retroactive), and `codex.js`/`grok.js`
append a `{"type":"usage"}` sidecar record per turn — `loadHistory` ignores
unknown record types, so it stays invisible to the chat. Streamed records repeat
one `message.id` with a growing usage snapshot, so the scan keeps the largest
snapshot per id; per-file aggregates are memoized on (size, mtime).

`GET /api/usage?probe=0` skips the two probe requests (serving the last cached
probe), `force=1` drops every cache entry, `days=N` sizes the ledger window.

## Permissions

Headless `claude -p` (stream-json) cannot answer interactive permission prompts,
so the agent would stall on them. Two strategies, chosen automatically:

- **`SKIP_PERMISSIONS=1` and not root** → `--dangerously-skip-permissions` (full
  autonomy). Only safe on a sandboxed machine with no untrusted input.
- **running as root** → Claude Code refuses `--dangerously-skip-permissions`, so
  the backend falls back to an `--allowedTools` allowlist (`Read Write Edit Bash
  Glob Grep`) so those tools run without prompts. Set `ALLOWED_TOOLS` in `.env` to
  change the list. Tools outside the list are denied in print mode.

## Diagnostics

```bash
npm run probe    # spawn claude once, print raw stream-json events, exit
```

## Project layout

```
server/   config, claude-args, sessions (spawn/stream), transcript (JSONL
          reader: history pagination, image index, budget), ws, files (REST),
          skills, term (PTY), usage (provider quotas + token ledger), index
web/      Vite + React app (App, hooks/useSocket, components/*)
test/     node:test suites (npm test)
```

## Bundle layout (and a deploy footgun)

`npm run build` emits more than one chunk on purpose:

| chunk | when it loads |
|---|---|
| `index-*.js`, `react-*.js`, `markdown-*.js`, `index-*.css` | always (~190 KB gzip total) |
| `highlight.js` chunk (~310 KB gzip) | first time a message contains a code block |
| `jsxgraph` chunk (~245 KB gzip) | only for a ` ```jsxgraph ` figure |
| `Terminal-*.js/.css` (~85 KB gzip) | only when the TUI / Shell overlay opens |

**Do not prune `dist/assets/` by "keep only what `index.html` references"** — the
lazy chunks are referenced from JavaScript, not from the HTML, so that rule
deletes them and the app breaks the moment someone opens a terminal or renders
code. No pruning is needed at all: `emptyOutDir: true` clears `dist/` on every
build. Copy the whole directory when syncing to the live instance.

## Tests

```bash
npm test         # node:test — transcript reader: pagination, tool_result
                 # merging, UTF-8 chunk boundaries, image index, append rescan
```

## Secrets and child processes

The server's own credentials (`AUTH_PASSWORD`, `AUTH_SECRET`, and the Claude
subscription `CLAUDE_CODE_OAUTH_TOKEN`) are stripped from the environment of
every child process — the `claude` / `codex` / `grok` CLIs, the `/shell` PTY,
and `git`. Spawn sites must build their env from `safeProcessEnv()` /
`childEnv()` in `server/config.js`, never from `process.env` directly: these
children run with Bash and would otherwise be one `env` away from the login
password and the key that signs session cookies.

## How streaming works

With `--include-partial-messages`, `claude` emits raw Anthropic SSE events
(`stream_event` → `message_start`, `content_block_delta` with `text_delta`, …)
followed by an assembled `assistant` event with the full message. The frontend
streams text live from the deltas and lets the final `assistant` event replace
the blocks with the clean snapshot (which carries parsed `tool_use` inputs).
`tool_result` events are matched back to their `tool_use` by id and rendered
inside the tool card.