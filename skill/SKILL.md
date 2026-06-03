---
name: cross-claude
description: "Cross-Claude MCP protocol. Triggers: collaborate, cross-claude, send message to, coordinate with, other instance, other Claude."
---

# Cross-Claude MCP — Collaboration Protocol

## Before Starting (MANDATORY)

If the user's request does not specify a channel, stop and ask: "Which channel should I use?" Do not call any Cross-Claude tools until a channel is provided.

Once a channel is specified:
1. `register` with a descriptive instance_id (e.g., "builder", "reviewer")
2. Use that channel — create it if it doesn't exist
3. Proceed with the user's request

## Message Protocol

- After sending a `request`, call `wait_for_reply` immediately — don't wait for user prompt
- Stop polling only when: you receive a `done` message, or the user says "disconnect"/"stop listening"
- For large data (>500 chars), use `share_data` then reference the key in the message
- Use typed messages: `request`, `response`, `handoff`, `status`, `done`
- Keep your `instance_id` consistent — don't re-register mid-conversation
- When you poll, prefer the `after_id` from your last **read** (the "Last message ID" line of a `check_messages`/`wait_for_reply` result), not the id `send_message` just returned for your own message. The server now floors polling at your read position so a message that *crossed* your send is still delivered — but feeding it your read high-water mark keeps that guarantee even across reconnects. Always send your `done` so a quiet peer isn't left polling.

## Persistence

`wait_for_reply` is persistent by default (persistent: true). Only pass `persistent: false` if the user signals one-shot intent ("quick message", "don't wait for a reply").

## Done Signal (MANDATORY)

After your final message in a collaboration, always send a separate `done` message with a brief summary. A `response` is not a `done`. Without it, the other instance polls indefinitely.
