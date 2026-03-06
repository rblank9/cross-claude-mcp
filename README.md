# Cross-Claude MCP

An MCP server that lets multiple Claude Code instances communicate with each other through a shared message bus.

## How It Works

Each Claude Code process connects to the same MCP server, which stores messages in a local SQLite database (`~/.cross-claude-mcp/messages.db`). Instances register with an identity, then send and receive messages on named channels — like a lightweight Slack for Claude Code sessions.

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

Both instances connect to the **same** `cross-claude` MCP server, and both read/write to the **same** SQLite file. SQLite WAL mode handles concurrent access safely.

## Setup

Already installed in `~/.claude/settings.json` as:

```json
"cross-claude": {
  "command": "node",
  "args": ["/Users/rblank/Projects/cross-claude-mcp/server.mjs"]
}
```

Restart Claude Code (or start a new session) to pick it up.

## Usage

### Step 1: Open two terminals with Claude Code

```bash
# Terminal A
cd ~/Projects/my-project
claude

# Terminal B
cd ~/Projects/my-project
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
| `get_replies` | Get all replies to a specific message |
| `create_channel` | Create a named channel for organizing topics |
| `list_channels` | List all channels |
| `list_instances` | See who's registered |
| `search_messages` | Search message content across all channels |
| `wait_for_reply` | Poll until a reply arrives or timeout (used for async collaboration) |

## Message Types

When sending messages, you can specify a type for clarity:

- **message** — General communication (default)
- **request** — Asking the other instance for something
- **response** — Answering a request
- **status** — Progress update
- **handoff** — Passing work to another instance
- **done** — Signals that no further replies are expected (other instances stop polling)

## Channels

Messages go to the `general` channel by default. Create topic channels for organized communication:

- `code-review` — Review requests and feedback
- `bugs` — Bug reports and fixes
- `architecture` — Design discussions

## Waiting for Replies

After sending a message, use `wait_for_reply` to automatically poll until the other instance responds:

> "Send bob a request to review auth.py, then wait for his reply."

Claude will call `send_message`, then `wait_for_reply` which blocks (polling every 5 seconds) until bob responds or 90 seconds elapse. If bob sends a `done` message, polling stops immediately.

This is the recommended pattern for back-and-forth collaboration — it avoids the need for you to manually say "check messages" after every exchange.

## Manual Polling

For finer control, use `check_messages` directly:

1. First `check_messages` returns all recent messages and a `last_id`
2. Subsequent calls use `after_id: <last_id>` to only get new messages
3. Use `instance_id` parameter to filter out your own messages

## Presence Detection

Instances are automatically tracked as online/offline:

- **Heartbeat**: Every tool call updates `last_seen` timestamp
- **Clean exit**: When Claude Code exits, the instance is marked offline via signal handlers
- **Staleness**: Instances not seen for 120 seconds are marked offline when `list_instances` is called
- **Hard kill**: If Claude Code is force-killed (`kill -9`), the staleness check catches it on the next `list_instances` call

## Ending a Conversation

When an instance is done collaborating, it sends a `done` message:

> "Send bob a done message — we're finished with the review."

This tells the other instance's `wait_for_reply` to stop polling immediately rather than waiting for timeout. The done signal is per-conversation context — the instances can start a new exchange anytime by sending a new `request`.

## Data Storage

- Messages persist in `~/.cross-claude-mcp/messages.db`
- Survives across sessions — you can pick up conversations later
- Delete the database to start fresh: `rm ~/.cross-claude-mcp/messages.db`

## Example Workflows

### Code Review
1. **Builder** finishes a feature, sends a `request` message with the file paths and a summary
2. **Reviewer** checks messages, reads the files, sends back `response` with feedback
3. **Builder** polls for responses, sees feedback, makes changes, sends `status` update

### Parallel Development
1. Create channels: `frontend`, `backend`, `integration`
2. Two instances work independently, posting `status` updates to their channel
3. When they need to coordinate (e.g., API contract), they post to `integration`

### Task Delegation
1. **Manager** instance sends `handoff` messages with specific tasks
2. **Worker** instance picks them up, works on them, sends `response` when done
3. **Manager** polls and coordinates the overall flow

## Running Tests

```bash
cd ~/Projects/cross-claude-mcp
npm test
```
