# Dev Channel Probe (HTTP) — RUN INSTRUCTIONS

Throwaway diagnostic harness to test whether server->client channel push survives **streamable-HTTP + mcp-remote bridge**.

## Start the Server

```bash
node dev-channel-probe-http.mjs
# Listens on 127.0.0.1:8791 (override via env CHANNEL_PROBE_PORT=<PORT>)
```

Default port **8791** (hardcoded override: `CHANNEL_PROBE_PORT=9000 node dev-channel-probe-http.mjs`).

## Register in .mcp.json

Add to your Claude Code `.mcp.json` (in the project or `~/.claude/.mcp.json`):

```json
{
  "mcpServers": {
    "devchanhttp": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:8791/mcp"]
    }
  }
}
```

Or if you prefer a direct stdio path (NOT using mcp-remote):

```json
{
  "mcpServers": {
    "devchanhttp": {
      "command": "node",
      "args": ["/absolute/path/to/dev-channel-probe-http.mjs"]
    }
  }
}
```

(The first option — mcp-remote bridge — is the actual test target.)

## Launch Claude Code

```bash
ccx --dangerously-load-development-channels server:devchanhttp
```

Or register globally and launch normally:

```bash
ccx  # Will auto-load devchanhttp if registered in global .mcp.json
```

## Expected Behavior

**Success** ✓ — If the channel push survives streamable-HTTP + mcp-remote:
- After ~6 seconds, you see a message in the Claude Code chat:
  ```
  PROBE-HTTP: hello from devchanhttp #1 @ 2025-XX-XXTXX:XX:XXZ
  ```
- Then every ~15 seconds, another:
  ```
  PROBE-HTTP: hello from devchanhttp #2 @ ...
  PROBE-HTTP: hello from devchanhttp #3 @ ...
  ...
  PROBE-HTTP: hello from devchanhttp #5 @ ...
  ```
- Total of 5 messages, then probing stops.

**Failure** ✗ — If channel notifications are dropped:
- No `PROBE-HTTP` messages appear in the session.
- The probe server itself **will still work** (you can call the `ping` tool and get "pong").
- Server logs will show `sent push #1`, `sent push #2`, etc. on stderr, but the notifications never reach Claude Code.
  - This means the issue is **either** streamable-HTTP push routing **or** mcp-remote forwarding.

## What We're Testing

The stdio version (`dev-channel-probe.mjs`) successfully sends channel notifications. This HTTP version does the **exact same thing** but over StreamableHTTP transport instead of stdio. The question:

**Does a server-initiated notification (`.notification({method: "notifications/claude/channel", ...})`) successfully reach the client when the transport is StreamableHTTP?**

### The MCP SDK's Server.notification() Method

Both versions call:
```javascript
server.notification({
  method: "notifications/claude/channel",
  params: {
    content: "...",
    meta: { source: "devchanhttp", transport: "streamable-http" },
  },
});
```

- **Stdio**: transport is a `StdioServerTransport`; notification goes directly to stdout.
- **HTTP**: transport is a `StreamableHTTPServerTransport`; notification must be queued and delivered over the GET `/mcp` stream (or POST response, depending on SDK internals).

If the HTTP probe fails but the stdio one succeeds, **the bottleneck is likely the StreamableHTTPServerTransport's handling of unsolicited server-initiated messages**, not mcp-remote.

## Debugging

1. **Check server logs** (stderr):
   ```
   [devchanhttp] NEW SESSION: <uuid>
   [devchanhttp] sent push #1
   [devchanhttp] sent push #2
   ...
   ```
   If these appear, the server IS calling `.notification()` successfully.

2. **Check Claude Code session**: do the messages appear in the chat?
   - If not, the transport didn't deliver them.

3. **Test the `ping` tool** to ensure the session itself is working:
   - Call the `ping` tool; you should get "pong".
   - If `ping` fails, the whole session is broken.

4. **Watch the mcp-remote bridge** (if applicable):
   - mcp-remote is a thin HTTP-to-stdio bridge; if it's dropping notifications, they won't appear.

## Architecture Notes

- **Server**: low-level MCP `Server` (not `McpServer`), with experimental `"claude/channel"` capability.
- **Transport**: `StreamableHTTPServerTransport` (same as `server.mjs` in this repo).
- **Session management**: one `Server` per active HTTP session (stored in `sessions` Map).
- **Probe timing**: first at ~6s, then every 15s, max 5 total (prevents infinite loops).
- **Logging**: all to stderr only (stdout stays clean for MCP protocol).

## Key Lines (Reference)

**Capability declaration** (line ~73):
```javascript
experimental: {
  "claude/channel": {}, // Declare experimental channel capability
},
```

**StreamableHTTP transport setup** (line ~113):
```javascript
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
});
```

**Notification send** (line ~179):
```javascript
targetSession.server.notification({
  method: "notifications/claude/channel",
  params: {
    content: message,
    meta: { source: "devchanhttp", transport: "streamable-http" },
  },
});
```

Both HTTP endpoints (`POST /mcp` and `GET /mcp`) mirror `server.mjs` lines 230–277.
