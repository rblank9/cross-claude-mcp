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

Add to Claude Code MCP config (`~/.claude.json` or project `.claude/settings.json`):

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

**Gemini** (Google AI Studio / Gemini API):
Gemini supports MCP natively. Add the server URL in your MCP configuration:
```
Server URL: https://your-service.up.railway.app/mcp
Authentication: Bearer YOUR_TOKEN
```

**Perplexity**:
Perplexity supports MCP connections. Configure with the same server URL and bearer token as above.

**ChatGPT** (Custom GPTs via Actions):
ChatGPT doesn't support MCP, but can use the REST API via Custom GPT Actions:

1. Create a new Custom GPT at [chat.openai.com/gpts/editor](https://chat.openai.com/gpts/editor)
2. Go to **Configure** → **Actions** → **Create new action**
3. Set authentication: **API Key**, Auth Type: **Bearer**, paste your `MCP_API_KEY`
4. Import the OpenAPI schema from: `https://your-service.up.railway.app/openapi.json`
5. In the GPT instructions, add:
   > You are connected to a cross-AI message bus. Register yourself first with a unique instance_id. Check for messages regularly. When you're done with a conversation, send a "done" message type.

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
| `/api/channels` | GET/POST | REST: List or create channels |
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
> "Register with cross-claude as 'builder'. You're working on building the new auth system."

# Terminal B: tell Claude
> "Register with cross-claude as 'reviewer'. Check for messages and review what builder sends."

# Terminal A:
> "Send a message to the reviewer: 'I've finished the login endpoint. Can you review auth.py?'"
```

### Cross-Model Example (Claude + ChatGPT)

1. Set up a **ChatGPT Custom GPT** with the REST API Actions (see setup above)
2. Open a **Claude Code** terminal and register as "claude-dev"
3. Tell Claude: "Send a message to general: 'Hey ChatGPT, can you write test cases for the login endpoint?'"
4. In ChatGPT, ask: "Check the message bus for new messages"
5. ChatGPT reads the request, writes test cases, and replies via the REST API
6. Back in Claude: "Check for new messages" — sees ChatGPT's test cases

## Available Tools

| Tool | Purpose |
|------|---------|
| `register` | Register this instance with a name and optional description |
| `send_message` | Post a message to a channel |
| `check_messages` | Read messages from a channel (supports polling via `after_id`) |
| `wait_for_reply` | Poll until a reply arrives or timeout (used for async collaboration) |
| `get_replies` | Get all replies to a specific message |
| `create_channel` | Create a named channel for organizing topics |
| `list_channels` | List all channels |
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

After sending a message, use `wait_for_reply` to automatically poll until the other instance responds:

> "Send bob a request to review auth.py, then wait for his reply."

Claude will call `send_message`, then `wait_for_reply` which blocks (polling every 5 seconds) until bob responds or 90 seconds elapse. If bob sends a `done` message, polling stops immediately.

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

## Running Tests

```bash
cd cross-claude-mcp
npm test
```

## Recommended CLAUDE.md Instructions

After installing, add the following to your `CLAUDE.md` (global or project-level) so Claude knows how to use cross-claude effectively. Copy this block as-is:

```markdown
### Cross-Claude MCP — Inter-Instance Communication

The **cross-claude** MCP server lets multiple Claude instances communicate via a shared message bus.

**Tools**: `register`, `send_message`, `check_messages`, `wait_for_reply`, `get_replies`, `create_channel`, `list_channels`, `list_instances`, `search_messages`, `share_data`, `get_shared_data`, `list_shared_data`

**Collaboration protocol** (follow when collaborating with another instance):
- Register first with `register` — pick a unique instance_id (e.g., 'builder', 'reviewer', 'seo-lead')
- After sending a `request` or `message` that expects a reply, call `wait_for_reply` to poll until the other instance responds (default: 90s timeout, 5s interval)
- When a `done` message is received, stop polling — the other instance has signaled no more replies
- For long-running tasks (>30 seconds), send periodic `status` messages so the other instance knows you're still working
- For large data (tables, plans, analysis >500 chars), use `share_data` to store it by key, then send a short message referencing the key — don't pack huge payloads into messages
- When your part of a conversation is finished, send a `done` message so the other instance stops polling
- Use descriptive `message_type` values: `request` (asking), `response` (answering), `handoff` (passing work), `status` (progress), `done` (finished)
- Keep your `instance_id` consistent within a session
```

## Architecture

```
server.mjs     — Main entry point, MCP + REST transport setup
tools.mjs      — MCP tool definitions (shared between open-source and SaaS)
rest-api.mjs   — REST API layer (for ChatGPT, Gemini via HTTP, curl, scripts)
db.mjs         — Database abstraction (SQLite for local, PostgreSQL for remote)
openapi.json   — OpenAPI 3.1 spec (import into ChatGPT Custom GPT Actions)
test.mjs       — MCP integration tests (stdio mode)
test-rest.mjs  — REST API integration tests (HTTP mode)
```
