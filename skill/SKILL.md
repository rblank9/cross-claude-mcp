---
name: cross-claude
description: "Cross-Claude MCP — the ONLY remaining use is reaching an AI that native SendMessage cannot address: a non-Claude-Code participant (ChatGPT, Claude.ai, Claude Desktop) or an AI on someone else's machine. Every Claude-Code-to-Claude-Code case, including spawning a peer in another project, goes to the native cross-session skill instead. Triggers: message ChatGPT, talk to Claude.ai / Claude Desktop, reach an AI on another machine, cross-machine agent handoff, cross-claude."
---

# Cross-Claude MCP — external-participant fallback

**Scope is now narrow. Use this skill ONLY when the peer is one of:**

1. **A non-Claude-Code AI** — ChatGPT, Claude.ai (web), Claude Desktop.
2. **An AI on someone else's machine** — outside this harness's session registry.

**Everything else goes native.** `SendMessage` + `ListAgents` are built into the harness, are
push-delivered, need no registration, no channel, and no polling — and they work better. See the
**`cross-session`** skill. That includes cases this skill used to own:

- **Another Claude Code session** → `SendMessage`, addressed by project-dir basename.
- **Spawning a peer in another project** → `cd <project-dir> && claude --bg "<task>"`. It inherits
  that project's `CLAUDE.md`, memory, MCP servers, skills, and hooks — the whole reason
  `spawn-collaborator` existed. Verified end-to-end 2026-08-21. **Do not use `spawn-collaborator`
  for this; it is superseded.**
- **The MANDATORY cross-project change rule** → lives in `cross-session` now. Read it there.

If you are reaching for this skill and the peer is a Claude Code session, you are in the wrong
skill.

## Before Starting (MANDATORY)

If the user's request does not specify a channel, stop and ask: "Which channel should I use?" Do not
call any Cross-Claude tools until a channel is provided.

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
- When you poll, prefer the `after_id` from your last **read** (the "Last message ID" line of a
  `check_messages`/`wait_for_reply` result), not the id `send_message` just returned for your own
  message. The server floors polling at your read position so a message that *crossed* your send is
  still delivered — feeding it your read high-water mark keeps that guarantee even across
  reconnects.
- **One wait per channel:** starting a new `wait_for_reply` on a channel you're already waiting on
  **supersedes** the old one. Never stack waits.

## Delivery modes — know yours before making listening claims (MANDATORY)

Unlike native `SendMessage`, this transport does **not** push. Know which state you are in before
saying "listening":

1. **Live push** — a `listen_live(channel)` bridge, `cc-listen <channel>`, or a
   `--dangerously-load-development-channels` subscription is active. Messages are injected as
   `<channel>` blocks and wake you when idle. "I'll see messages as they arrive" is TRUE **only
   here**. Requires a channels-enabled launch; these tools do not exist in a plain session.
2. **Foreground blocking wait (~2 min only)** — you called `wait_for_reply` and are blocked *right
   now*. At ~120s the harness backgrounds the call and **you go deaf.**
3. **Poll-only** — everything else, INCLUDING any backgrounded `wait_for_reply`. Do NOT say you're
   "listening"/"standing by"/"watching."

**HARD TRUTH — a backgrounded `wait_for_reply` does NOT wake you (MANDATORY).** Verified 2026-07-18
on Claude Code v2.1.214: a `wait_for_reply` that auto-backgrounds at ~120s does not wake an idle
session when a message arrives; it unblocks only when a human next prompts you. Never claim
otherwise. (Harness limitation, not a server bug — the server delivers fine.)

## Durable listening — parked-wait-and-reschedule

The honest way to keep listening in a plain session. Each cycle:

1. `check_messages(channel=<channel>, instance_id=<your id>, after_id=<cursor>)`
2. Act on anything new.
3. `ScheduleWakeup` with a `prompt` repeating this loop verbatim, and a `delaySeconds` matched to
   how fast the external peer actually replies.
4. End your turn. The wakeup re-invokes you; go to step 1.

## Done Signal (MANDATORY)

After your final message in a collaboration, always send a separate `done` message with a brief
summary. A `response` is not a `done`. Without it, the other participant polls indefinitely.
