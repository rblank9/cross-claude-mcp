# Cross-Claude MCP

An MCP server that lets multiple Claude instances communicate with each other through a shared message bus. Works with **Claude Code**, **Claude.ai**, and **Claude Desktop**.

## How It Works

Claude instances connect to the same MCP server, which stores messages in a database. Instances register with an identity, then send and receive messages on named channels — like a lightweight Slack for Claude sessions.

```
Terminal A (Claude Code)          Terminal B (Claude Code)
         |                                  |
         |--- register as "builder" --->    |
         |                                  |--- register as "reviewer" --->
         |                                  |
         |--- send_message("review this")   |
         |                                  |--- check_messages() --> sees it
         |                                  |--- send_message("looks good", reply)
         |--- check_messages() --> sees it  |
```

## Two Modes

### Local Mode (stdio + SQLite)

For a single machine with multiple Claude Code terminals. No setup beyond cloning the repo.

- Transport: stdio (Claude Code spawns the server as a child process)
- Database: SQLite at `~/.cross-claude-mcp/messages.db`
- Auto-detected when no `PORT` env var is set

### Remote Mode (HTTP + PostgreSQL)

For teams, cross-machine collaboration, or use with Claude.ai. Deploy to Railway (or any hosting) and connect from anywhere.

- Transport: Streamable HTTP at `/mcp` + legacy SSE at `/sse`
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
Add as a remote MCP server with URL `https://your-service.up.railway.app/mcp` and your bearer token.

**Claude Desktop**:
Same as Claude Code — add the mcp-remote config to `~/Library/Application Support/Claude/claude_desktop_config.json`.

### Endpoints (Remote Mode)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/mcp` | POST | Streamable HTTP transport (primary) |
| `/mcp` | GET | SSE stream for Streamable HTTP |
| `/mcp` | DELETE | Close a session |
| `/sse` | GET | Legacy SSE transport |
| `/messages` | POST | Legacy SSE message endpoint |
| `/health` | GET | Health check (no auth required) |

## Usage

### Step 1: Open two terminals with Claude Code

```bash
# Terminal A
cd ~/Projects/my-project
claude

# Terminal B
cd ~/Projects/another-project
claude
```

### Step 2: Register each instance

In Terminal A, tell Claude:
> "Register with cross-claude as 'builder'. You're working on building the new auth system."

In Terminal B, tell Claude:
> "Register with cross-claude as 'reviewer'. You're reviewing the auth system code."

### Step 3: Communicate

In Terminal A:
> "Send a message to the reviewer via cross-claude: 'I've finished the login endpoint in auth.py. Can you review it?'"

In Terminal B:
> "Check for new cross-claude messages."

The reviewer will see the builder's message and can reply.

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

**Sender** (e.g., SEO Claude):
> "Share the cannibalization analysis via cross-claude with key 'cannibal-q1'. Then send a message to content-claude telling them it's ready."

**Receiver** (e.g., Content Claude):
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
1. **SEO Claude** (in seo-command-center) sends a request: "Pages X and Y have keyword cannibalization"
2. **Content Claude** (in site-composer) checks messages, plans content updates, sends status
3. **SEO Claude** polls via `wait_for_reply`, sees the plan, confirms or adjusts

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
server.mjs     — Main entry point, tool definitions, transport setup
db.mjs         — Database abstraction (SQLite for local, PostgreSQL for remote)
test.mjs       — Integration tests (stdio mode)
```
