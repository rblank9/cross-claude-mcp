---
name: cross-claude
description: >
  Enforce Cross-Claude MCP collaboration protocol: session startup, channel
  discipline, persistent connections, done signals. Triggers on Cross-Claude
  tool usage or collaboration keywords like "collaborate", "cross-claude",
  "send message to", "talk to", "work with", "coordinate with", "message bus",
  "other instance", "other Claude".
---

# Cross-Claude MCP — Collaboration Protocol

Rigid behavioral skill for multi-instance AI collaboration via the Cross-Claude message bus. This skill enforces the full protocol so you don't have to think about it.

## Auto-Startup Sequence (MANDATORY)

When any Cross-Claude tool is detected or collaboration is requested, execute these steps in order. No skipping. No "I'll just send a message directly."

1. Call `register` with a descriptive instance_id (e.g., "builder", "reviewer", "data-analyst")
2. Call `list_channels` to see all active channels
3. Pick the most specific channel for your work — only use `general` if nothing more specific exists
4. Call `check_messages` on that channel to see what's been discussed

Only after completing all four steps should you proceed with the user's request.

## Channel Discipline (MANDATORY)

- **NEVER send to a channel without calling `list_channels` or `find_channel` first.** The `general` default is a fallback, not the norm.
- **Before creating a new channel**, check if a suitable one already exists with `find_channel`
- **If you switch channels mid-conversation**, send a message in the OLD channel first: "Moving to #new-channel"
- **Stay in one channel per conversation thread.** Don't scatter related messages across channels.

## Message Protocol

- After sending a `request` or message that expects a reply, call `wait_for_reply` **immediately** — do not wait for a user prompt
- When a `done` message is received, stop polling
- For long-running tasks (>30s), send periodic `status` messages so the other instance knows you're still working
- For large data (>500 chars), use `share_data` to store by key, then send a short message referencing the key
- Use descriptive `message_type` values: `request` (asking), `response` (answering), `handoff` (passing work), `status` (progress), `done` (finished)
- Keep your `instance_id` consistent within a session — don't re-register mid-conversation

## Persistent Connection (DEFAULT — Rigid)

`wait_for_reply` is **persistent by default**. It keeps listening across multiple poll cycles until a message arrives, a `done` signal is received, or 30 minutes elapse. The server handles re-polling internally — you will NOT see "no messages" timeout responses during persistent mode.

**Rules:**
- Always call `wait_for_reply` with default parameters (persistent: true). Do NOT pass `persistent: false` unless the user explicitly signals a one-shot interaction.
- If `wait_for_reply` returns because `max_wait_minutes` was reached, ask the user: "Still listening on #channel? Say 'disconnect' to stop, or I'll keep waiting." Then re-call `wait_for_reply`.
- You do NOT need user permission to keep polling — persistence is the default behavior.

### Anti-Rationalization Rules (No Exceptions)

These thoughts are WRONG. Do not act on them:

| Wrong Thought | Reality |
|---------------|---------|
| "No response yet, they must be gone" | The other instance is working. The tool re-polls automatically. |
| "It timed out, I should stop" | Persistent mode handles retries. You only see a return at the hard ceiling. |
| "I should ask the user if they want to keep waiting" | No. Persistence is the default. Only ask at the hard ceiling. |
| "The other instance may be offline" | Check `list_instances` if concerned, but don't stop listening. |
| "I'll check back later" | No. Stay in `wait_for_reply`. That IS checking. |

### When to Stop Listening

Only stop when ONE of these is true:
1. You received a `done` message from the other instance
2. The user explicitly says: "disconnect", "stop listening", "leave channel", "stop", "done"
3. You have sent your own `done` message (your work is complete)

Nothing else is a valid reason to stop.

## Done Signal Enforcement (MANDATORY)

- After your final response in a collaboration, ALWAYS send a **separate** `done` message
- A `response` message is NOT a `done` signal — they are different message types
- Without `done`, the other instance polls forever waiting for more from you
- Send `done` with a brief summary: "Done — completed the review, no further feedback."

## Temporary Mode (Opt-In Only)

Use `persistent: false` ONLY when the user's language explicitly signals a one-shot interaction:

**Trigger phrases:** "quick message to X", "just tell them Y", "send this and move on", "fire and forget", "don't wait for a reply"

**Behavior in temporary mode:**
1. Send the message
2. Call `wait_for_reply` with `persistent: false` (single 90s poll cycle)
3. If a reply comes, show it. If not, move on.

**If the user's intent is ambiguous, default to persistent mode.** It's always better to wait too long than to disconnect too early.
