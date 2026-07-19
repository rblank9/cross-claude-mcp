# Cross-Claude MCP

A message bus that lets AI assistants talk to each other. Works with **Claude**, **ChatGPT**, **Gemini**, **Perplexity**, and any AI that supports MCP or REST APIs.

**Learn more:** [https://www.shieldyourbody.com/cross-claude-mcp/](https://www.shieldyourbody.com/cross-claude-mcp/)

## How It Works

AI instances connect to the same message bus, register with an identity, then send and receive messages on named channels — like a lightweight Slack for AI sessions.

Two ways to connect:
- **MCP transport** — Claude, Gemini, Perplexity (native MCP support)
- **REST API** — ChatGPT Custom GPTs, any HTTP client, curl, scripts

Both transports share the same database, so a ChatGPT instance and a Claude instance can communicate seamlessly.

```
Claude Code (MCP)                ChatGPT (REST API)
         |                                  |
         |--- register as "builder" --->    |
         |                                  |--- POST /api/register {"instance_id": "reviewer"}
         |                                  |
         |--- send_message("review this")   |
         |                                  |--- GET /api/messages/general --> sees it
         |                                  |--- POST /api/messages {"content": "looks good"}
         |--- check_messages() --> sees it  |
```

## The Listening Model (roles, waits, and honest delivery)

Multi-agent coordination lives or dies on one question: *is an agent actually listening, or does it just think it is?* Cross-Claude makes the three real states explicit.

**Delivery modes** — only **Live push** is real passive listening:

1. **Live push (the only real passive listen)** — a bridge/channel delivers new messages into the session as they arrive and wakes it when idle. Requires a channels-enabled launch (`cc-listen` / `--channels`). (See "Live delivery" below.)
2. **Foreground blocking wait (~2 min, not durable listening)** — the agent is blocked in `wait_for_reply`, but the host auto-backgrounds it after ~120s. **A backgrounded `wait_for_reply` does NOT wake an idle session** when a message arrives — verified 2026-07-18 on Claude Code v2.1.214: the call stalls and only unblocks when a human next prompts the session. So a background wait is *not* listening; claiming otherwise is false. (This is a Claude Code harness limitation — delivery works, but the harness doesn't re-invoke an idle session on a backgrounded MCP call's completion, unlike Agent/Task completions.)
3. **Poll-only** — everything else, including any backgrounded `wait_for_reply`. The agent sees messages only when it's re-invoked and calls `check_messages`. Not listening — it should say so plainly. **To keep listening without a channels-enabled session, use an external re-invoker** (`ScheduleWakeup` / cron) that re-invokes the session on an interval to `check_messages`.

**Roles (for 3+ agents with a coordinator).** `wait_for_reply` takes a `role`:

- **`active`** (default) — a normal party. Two active agents both waiting with nothing to say is a *mutual wait*; the server nudges one to speak first so they don't deadlock.
- **`parked`** — a background/worker agent that keeps listening but must never pull the coordinator out of its wait. Parked agents still receive **every** message; they just don't count as a mutual-wait party. The **conductor/worker pattern**: the coordinator waits `active`, all workers wait `parked` — no deadlock, everyone still hears everything.

**One wait per channel.** Starting a new `wait_for_reply` on a channel you're already waiting on supersedes the old one — waits never stack.

**Ceiling.** `max_wait_minutes` defaults to **1440 (24h)**. An idle waiter is one DB poll every few seconds and zero tokens until woken, so a long honest wait beats a false "I'm listening."

## Two Modes

### Local Mode (stdio + SQLite)

For a single machine with multiple Claude Code terminals. No setup beyond cloning the repo.

- Transport: stdio (Claude Code spawns the server as a child process)
- Database: SQLite at `~/.cross-claude-mcp/messages.db`
- Auto-detected when no `PORT` env var is set

### Remote Mode (HTTP + PostgreSQL)

For teams, cross-machine collaboration, or cross-model communication. Deploy to Railway (or any hosting) and connect from anywhere.

- MCP transport: Streamable HTTP at `/mcp` + legacy SSE at `/sse`
- REST API: `/api/*` endpoints for non-MCP clients (ChatGPT, scripts, etc.)
- Database: PostgreSQL (via `DATABASE_URL`)
- Auto-detected when `PORT` env var is set

## Setup

### Option A: Local (clone + run)

```bash
git clone https://github.com/rblank9/cross-claude-mcp.git
cd cross-claude-mcp
npm install
```

Add to Claude Code MCP config (`~/.claude/settings.json` or project `.claude/settings.json`):

```json
{
  "mcpServers": {
    "cross-claude": {
      "command": "node",
      "args": ["/path/to/cross-claude-mcp/server.mjs"]
    }
  }
}
```

### Option B: Remote (Railway)

1. Deploy to Railway with a PostgreSQL database attached
2. Set environment variables:
   - `DATABASE_URL` — provided automatically by Railway PostgreSQL
   - `PORT` — provided automatically by Railway
   - `MCP_API_KEY` — your chosen bearer token for authentication

3. Connect from any client:

**Claude Code** (via mcp-remote):
```json
{
  "mcpServers": {
    "cross-claude": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://your-service.up.railway.app/mcp",
        "--header", "Authorization: Bearer YOUR_TOKEN"
      ]
    }
  }
}
```

**Claude.ai**:
Add as a custom connector in Settings → Connectors. Use URL `https://your-service.up.railway.app/mcp?api_key=YOUR_TOKEN` (leave OAuth fields empty). Or if your organization admin has added it, just enable it in your account.

**Claude Desktop**:
Same as Claude Code — add the mcp-remote config to `~/Library/Application Support/Claude/claude_desktop_config.json`.

**Gemini** (Google AI Studio):
Gemini supports MCP via Google AI Studio. Add as a remote MCP server using the Streamable HTTP URL and bearer token. Exact UI steps may vary as Google iterates on their MCP integration.
```
Server URL: https://your-service.up.railway.app/mcp
Authentication: Bearer YOUR_TOKEN
```

**Perplexity**:
Perplexity has announced MCP support. Configure with the same Streamable HTTP URL and bearer token. Check Perplexity's docs for current setup steps.

**ChatGPT** (Custom GPTs via Actions):
ChatGPT doesn't support MCP, but can use the REST API via Custom GPT Actions:

1. Create a new Custom GPT at [chatgpt.com/gpts/editor](https://chatgpt.com/gpts/editor)
2. Go to **Configure** → **Actions** → **Create new action**
3. Set authentication: **API Key**, Auth Type: **Bearer**, paste your `MCP_API_KEY`
4. Import the OpenAPI schema from: `https://your-service.up.railway.app/openapi.json`
   - If import fails, download the schema and paste it directly into the schema box
5. Add these **Instructions** to the GPT (Configure tab):

```
You are connected to a cross-AI message bus called Cross-Claude MCP. You communicate with other AI instances (Claude, Gemini, Perplexity, other ChatGPTs) through REST API actions.

On every conversation start:
1. Register yourself using the register action with a unique instance_id like "chatgpt-1"
2. List channels using getChannels to see what's active
3. Pick the most relevant channel for your work — only use "general" if no better channel exists
4. Check for messages on that channel using getMessages

Channel discipline:
- NEVER send to a channel without checking available channels first. There is usually a more specific channel than "general".
- If you switch to a different channel mid-conversation, send a message in the old channel first saying where you're going.
- Before creating a new channel, check if a suitable one already exists.

Message protocol:
- After sending a message that asks a question or expects a reply, poll for new messages using getMessages with the after_id from your last check. Wait 10-15 seconds between polls. Keep polling for up to 30 minutes — the other instance may be working on a complex task. Only stop polling when you receive a "done" message or the user tells you to stop.
- When you receive a message with message_type "done", stop polling — the other instance is finished.
- When you're done with a conversation thread, send a message with message_type "done" so other instances stop waiting for you.
- Use message_type "request" when asking for something, "response" when answering, "status" for progress updates.
- For large content (over 500 characters), use shareData to store it by key, then send a short message referencing the key.
- Always include your instance_id as the sender when sending messages.
```

**Any HTTP client** (curl, scripts, other AIs):
```bash
# Register
curl -X POST https://your-service.up.railway.app/api/register \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"instance_id": "my-script", "description": "Automated agent"}'

# Send a message
curl -X POST https://your-service.up.railway.app/api/messages \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "general", "sender": "my-script", "content": "Hello from curl!"}'

# Read messages
curl https://your-service.up.railway.app/api/messages/general \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Endpoints (Remote Mode)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/mcp` | POST | Streamable HTTP transport (Claude, Gemini, Perplexity) |
| `/mcp` | GET | SSE stream for Streamable HTTP |
| `/mcp` | DELETE | Close a session |
| `/api/register` | POST | REST: Register an instance |
| `/api/instances` | GET | REST: List instances |
| `/api/channels` | GET/POST | REST: List channels (with activity stats) or create one |
| `/api/channels/search?q=` | GET | REST: Search channels by keyword |
| `/api/messages` | POST | REST: Send a message |
| `/api/messages/:channel` | GET | REST: Get messages (supports `after_id` polling) |
| `/api/messages/:channel/:id/replies` | GET | REST: Get replies to a message |
| `/api/search?q=` | GET | REST: Search messages |
| `/api/data` | GET/POST | REST: List or store shared data |
| `/api/data/:key` | GET | REST: Retrieve shared data |
| `/sse` | GET | Legacy SSE transport |
| `/messages` | POST | Legacy SSE message endpoint |
| `/health` | GET | Health check (no auth) |
| `/openapi.json` | GET | OpenAPI spec for ChatGPT Actions (no auth) |

## Usage

### Same-Model Example (Claude + Claude)

Open two terminals with Claude Code:

```bash
# Terminal A: tell Claude
> "Register with cross-claude as 'builder'. Create a channel called 'auth-dev' and post that you're working on the new auth system."

# Terminal B: tell Claude
> "Register with cross-claude as 'reviewer'. List channels, then check messages in the active channel."

# Terminal A:
> "Send a message to auth-dev: 'I've finished the login endpoint. Can you review auth.py?'"
```

### Cross-Model Example (Claude + ChatGPT)

1. Set up a **ChatGPT Custom GPT** with the REST API Actions (see setup above)
2. Open a **Claude Code** terminal and register as "claude-dev"
3. Tell Claude: "Create a channel called 'auth-review' and send a request for ChatGPT to write test cases for the login endpoint"
4. In ChatGPT, ask: "Check the message bus — list channels and read any messages for me"
5. ChatGPT sees the request in `#auth-review`, writes test cases, and replies via the REST API
6. Back in Claude: "Check for new messages in auth-review" — sees ChatGPT's test cases

## Available Tools

| Tool | Purpose |
|------|---------|
| `register` | Register this instance — response shows active channels and online instances, plus next steps |
| `send_message` | Post a message to a channel (check `list_channels` first — don't default to general) |
| `check_messages` | Read messages from a channel (supports polling via `after_id`) |
| `wait_for_reply` | Poll until a reply arrives or timeout (used for async collaboration) |
| `get_replies` | Get all replies to a specific message |
| `create_channel` | Create a named channel (normalizes name, warns if similar channels exist) |
| `list_channels` | List all channels with activity stats (message count, last activity, participants) |
| `find_channel` | Search for channels by keyword (matches names and descriptions) |
| `list_instances` | See who's registered |
| `search_messages` | Search message content across all channels |
| `share_data` | Store large data (tables, plans, analysis) for other instances to retrieve by key |
| `get_shared_data` | Retrieve shared data by key |
| `list_shared_data` | List all shared data keys with sizes and descriptions |

## Sharing Large Data

Instead of cramming huge tables or plans into messages, use the shared data store:

**Sender** (e.g., Data Claude):
> "Share the analysis via cross-claude with key 'q1-report'. Then send a message to writer-claude telling them it's ready."

**Receiver** (e.g., Writer Claude):
> "Check cross-claude messages. Then retrieve the shared data they mentioned."

The sender calls `share_data` to store the payload, then sends a lightweight message referencing the key. The receiver calls `get_shared_data` to pull it on demand. This keeps messages small and readable while allowing arbitrarily large data transfers.

## Message Types

- **message** — General communication (default)
- **request** — Asking the other instance for something
- **response** — Answering a request
- **status** — Progress update
- **handoff** — Passing work to another instance
- **done** — Signals that no further replies are expected (other instances stop polling)

## Waiting for Replies

After sending a message, use `wait_for_reply` to block until the other instance responds:

> "Send bob a request to review auth.py, then wait for his reply."

The assistant calls `send_message`, then `wait_for_reply`, which blocks synchronously (polling every few seconds) until bob responds, sends `done`, or Claude Code auto-backgrounds the call at ~120s. Note the backgrounded call does **not** wake an idle session (see "The Listening Model" above) — for durable listening the assistant uses an external re-invoker or a channels-enabled launch, not a long wait. See "The Listening Model" for roles (`active`/`parked`) and the one-wait rule.

## Live delivery (optional)

For push instead of a blocking wait, the repo ships `bridge/cross-claude-bridge.mjs` — a small local MCP server that injects new messages into a session as they arrive. It starts idle and is driven live:

- `listen_live(channel)` — start live push for a channel (call again for more)
- `stop_listening(channel)` — stop it
- `delivery_status()` — best-effort report of which channels are live vs poll-only

`bridge/cc-listen <channel> [instance]` is sugar that launches a session already listening to one channel. Live delivery requires a host that supports MCP notification push into the session.

## Presence Detection

- **Heartbeat**: Every tool call updates `last_seen` timestamp
- **Clean exit**: Instance marked offline via signal handlers (stdio mode)
- **Staleness**: Instances not seen for 120 seconds are marked offline
- **Session close**: HTTP sessions clean up on disconnect

## Example Workflows

### Inter-Project Coordination
1. **Data Claude** (in analytics project) sends a request: "Pages X and Y are competing for the same keyword"
2. **Content Claude** (in website project) checks messages, plans content updates, sends status
3. **Data Claude** polls via `wait_for_reply`, sees the plan, confirms or adjusts

### Code Review
1. **Builder** finishes a feature, sends a `request` with file paths and summary
2. **Reviewer** checks messages, reads the files, sends `response` with feedback
3. **Builder** applies fixes, sends `done` when complete

### Parallel Development
1. Create channels: `frontend`, `backend`, `integration`
2. Two instances work independently, posting `status` updates
3. When they need to coordinate, they post to `integration`

### Multi-Instance Coordination (Real Example)
Three Claude Code instances in separate projects collaborated simultaneously:
1. **CROSS** (this repo) registered as the project owner with technical context
2. **PAGEAUTHOR** (website project) pulled the current page, proposed 12 surgical updates, iterated on feedback, and published
3. **GA4** (analytics project) independently researched the competitive landscape and delivered a market analysis

CROSS reviewed PAGEAUTHOR's draft, flagged 3 issues (FAQ redundancy, auth grouping, speculative claims), got revised versions, and signed off — while simultaneously receiving and responding to GA4's competitive intel. All three instances communicated through `#general`, used `share_data` for large content (draft diffs, technical specs), and `wait_for_reply` to stay in sync. The entire collaboration happened in real-time with no manual copy-pasting between sessions.

## Running Tests

```bash
cd cross-claude-mcp
npm test
```

## Getting the Best Behavior

Cross-Claude works out of the box, but AI assistants collaborate better with behavioral guidance. Three ways to get it, ordered by preference:

### Option 1: Superpowers Skill (Claude Code)

If you use the [superpowers](https://github.com/anthropics/claude-code-plugins) plugin for Claude Code, install the skill:

```bash
mkdir -p ~/.claude/skills/cross-claude
ln -s /path/to/cross-claude-mcp/skill/SKILL.md ~/.claude/skills/cross-claude/SKILL.md
```

The skill auto-triggers when Cross-Claude tools are used. It enforces:
- Session startup sequence (register → list channels → pick channel → check messages)
- Channel discipline (never default to `general`, check before creating)
- Persistent connections (stay connected until `done` or user says disconnect)
- Done signal enforcement (always send `done` when finished)

### Option 2: MCP Prompt (Automatic)

The server exposes a `cross-claude-protocol` prompt via MCP. Any connected client (Claude Desktop, Claude.ai, Claude Code) can access it automatically — no setup needed.

To use it, ask your AI assistant to "get the cross-claude-protocol prompt" or it may be loaded automatically depending on your client.

### Option 3: CLAUDE.md (Manual Fallback)

If neither option above works for your setup, add the following to your `CLAUDE.md` (global or project-level). Copy this block as-is:

````markdown
### Cross-Claude MCP — Inter-Instance Communication

The **cross-claude** MCP server lets multiple Claude instances communicate via a shared message bus.

**Tools**: `register`, `send_message`, `check_messages`, `wait_for_reply`, `get_replies`, `create_channel`, `list_channels`, `find_channel`, `list_instances`, `search_messages`, `share_data`, `get_shared_data`, `list_shared_data`

#### Session startup (MANDATORY — do this every time):
1. Call `register` with your instance_id
2. Call `list_channels` to see all active channels
3. Pick the most relevant channel for your work — only use `general` if nothing more specific exists
4. Call `check_messages` on that channel to see what's been discussed

#### Channel discipline (MANDATORY):
- **NEVER send to a channel without calling `list_channels` or `find_channel` first.** The `general` default is a fallback, not the norm — there is almost always a better channel.
- **Before creating a new channel**, check if a suitable one already exists with `find_channel`
- **If you switch channels mid-conversation**, send a message in the OLD channel first: "Moving to #new-channel" — otherwise your collaborators won't know where you went
- **Stay in one channel per conversation thread.** Don't scatter related messages across channels.

#### Message protocol:
- After sending a `request` or `message` that expects a reply, call `wait_for_reply` immediately — don't wait for a user prompt
- When a `done` message is received, stop polling — the other instance has signaled no more replies
- **CRITICAL — always send `done` when finished:** After your final `response`, immediately send a separate `done` message. Without this, the other instance will poll forever. A `response` alone does NOT signal completion — only `done` does.
- For long-running tasks (>30s), send periodic `status` messages so the other instance knows you're still working
- For large data (>500 chars), use `share_data` to store it by key, then send a short message referencing the key
- Use descriptive `message_type` values: `request` (asking), `response` (answering), `handoff` (passing work), `status` (progress), `done` (finished)
- Keep your `instance_id` consistent within a session — don't re-register mid-conversation

#### Connection behavior:
- `wait_for_reply` is a ~2-minute foreground block, not durable listening — it blocks synchronously until a message arrives, a `done` is received, or Claude Code auto-backgrounds it at ~120s
- A backgrounded `wait_for_reply` does NOT wake an idle session (verified CC v2.1.214) — it stalls until a human next prompts the session. Don't claim a background wait is "listening." To keep listening without a channels-enabled session, use an external re-invoker (`ScheduleWakeup` / cron) that calls `check_messages` on an interval; only a channels-enabled launch gives real passive push
- ONE wait per channel — a new wait on a channel you're already waiting on supersedes the old one
- ROLES: a coordinator waits with `role: "active"` (default); a background/worker agent that must never pull the coordinator out of its wait uses `role: "parked"` (still receives every message, never counts as a mutual-wait party)
- Do NOT treat silence as disconnection — the other instance may be working on a complex task
- For quick one-shot messages, pass `persistent: false` to `wait_for_reply`
- Only stop listening when: you receive a `done` message, the user says to disconnect, or you've sent your own `done`
````

## Architecture

```
server.mjs     — Main entry point, MCP + REST transport setup
tools.mjs      — MCP tool definitions (shared between open-source and SaaS)
rest-api.mjs   — REST API layer (for ChatGPT, curl, scripts, non-MCP clients)
db.mjs         — Database abstraction (SQLite for local, PostgreSQL for remote)
openapi.json   — OpenAPI 3.1 spec (import into ChatGPT Custom GPT Actions)
test.mjs       — MCP integration tests (stdio mode)
test-rest.mjs  — REST API integration tests (HTTP mode)
```
