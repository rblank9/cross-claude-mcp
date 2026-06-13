# Dev Channel Probe — Running Instructions

This is a diagnostic MCP server that probes whether Claude Code's experimental "channels" feature is live.

## Registration (.mcp.json)

Add this snippet to your `.mcp.json` file (or create it if needed):

```json
{
  "mcpServers": {
    "devchan": {
      "command": "node",
      "args": ["/absolute/path/to/dev-channel-probe.mjs"]
    }
  }
}
```

Replace `/absolute/path/to/` with the actual absolute path. For this project, use:

```json
{
  "mcpServers": {
    "devchan": {
      "command": "node",
      "args": ["/Users/rblank/Projects/cross-claude-mcp/dev-channel-probe.mjs"]
    }
  }
}
```

## Launch Command

```bash
claude --channels devchan --dangerously-load-development-channels devchan
```

This tells Claude Code to:
- Enable the experimental `--channels` flag
- Load the "devchan" development channel from your registered MCP servers

## What SUCCESS Looks Like

Within ~30 seconds of launching the Claude session, you should see:
- A new prompt or message in Claude Code's main chat window
- The message originates from a "channel" (rather than a regular tool or user message)
- The message contains text like: `PROBE: hello from devchan #1 @ 2026-01-15T...`
- Five such messages appear in total (about every 15 seconds), stopping after the 5th one

If you see these channel-originated probe messages, the feature is **live**.

## What FAILURE Looks Like

- Nothing ever appears in the Claude session
- No channel-based messages or notifications show up, even after 30+ seconds
- (The feature-flag is likely disabled on your account or Claude Code build)

## How It Works

The probe server:
1. Registers the experimental capability `"claude/channel"` in its initialization
2. Connects over stdio transport (like a normal MCP server)
3. Registers a trivial "ping" tool to be a valid connectable server
4. Every 15 seconds (starting at ~6s after launch), sends a server-initiated notification with `method: "notifications/claude/channel"`
5. **Stops after 5 probes** (by design — no infinite loop)

All logging goes to **stderr**, so it won't corrupt the MCP protocol on stdout.

## Troubleshooting

**The server starts but nothing happens:**
- Verify `.mcp.json` is in the right location (usually `~/.claude/.mcp.json`)
- Check that the absolute path to the `.mjs` file is correct
- Look for any errors in Claude Code's logs (if available)
- Ensure `node` is in your PATH

**The probe sends messages but they don't show in Claude:**
- The channel feature may not be enabled on your account
- Double-check the command-line flags: both `--channels devchan` and `--dangerously-load-development-channels devchan` are required

**You see errors on stderr:**
- The server prints all diagnostics to stderr; check the terminal where you launched Claude
- Common errors: SDK import issues (fix: ensure `@modelcontextprotocol/sdk` is installed in the repo), transport failures (transient)
