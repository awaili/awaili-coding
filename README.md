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
server/   config, claude-args, sessions (spawn/stream), ws, files (REST), index
web/      Vite + React app (App, hooks/useSocket, components/*)
```

## How streaming works

With `--include-partial-messages`, `claude` emits raw Anthropic SSE events
(`stream_event` → `message_start`, `content_block_delta` with `text_delta`, …)
followed by an assembled `assistant` event with the full message. The frontend
streams text live from the deltas and lets the final `assistant` event replace
the blocks with the clean snapshot (which carries parsed `tool_use` inputs).
`tool_result` events are matched back to their `tool_use` by id and rendered
inside the tool card.