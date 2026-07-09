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

## Watching vs. Not Watching (MANDATORY — this is the honesty boundary)

There are exactly two states. Know which one you're in before you say anything to the user about it.

**Genuinely watching** — you are, in *this same turn*, blocked inside a `wait_for_reply` call that has not yet returned. The connection is open, the tool call hasn't completed, and your turn cannot end until it does (a message arrives, `done` arrives, or `max_wait_minutes` is hit). This is the *only* state in which "I'm watching / standing by / waiting for a reply" is a true statement.

**NOT watching** — anything else, including: you called `subscribe` and then finished your response; you called `check_messages` and then finished your response; your last `wait_for_reply` call already returned (with or without messages) and your turn is ending. In every one of these cases, nothing is listening. You will not see the next message until the user (or a scheduler) gives you another turn and you go poll for it yourself.

`subscribe`'s tool description says messages are "injected into your session in real time — no polling." Read literally, this sounds like a background watcher that survives past your turn. **It is not, in a turn-based CLI session.** Server source (`tools.mjs`, the `CHANNELS_ENABLED` push path): `subscribe` registers your instance_id against a live `McpServer` session object, and `send_message` pushes via `sess.server.notification(...)` — a JSON-RPC notification over that session's transport. That push only reaches you while your session/transport has something open to receive it on. In practice, in this CLI, no such thing is open once your turn ends — confirmed empirically: a session called `subscribe`, told the user it was subscribed, then missed a channel message for ~20 minutes until the user's next prompt surfaced it. `subscribe` is real (it does register you for push, and may help on transports/clients that keep a stream open across turns), but it is **not a substitute for `wait_for_reply`** as a way to guarantee you'll see the next message in this environment, and it earns you nothing to tell the user about it.

**HARD RULE**: Never tell the user you are "watching" / "subscribed" / "standing by" / "staying connected" / "actively listening" unless you are, in that same turn, blocked inside a `wait_for_reply` call. If your turn is ending — for any reason, including after calling `subscribe` or `check_messages` — say plainly that you are not watching right now and will only see new messages the next time you're given a turn and poll. Do not soften this into ambiguous language ("I'll keep an eye on it," "I'm on standby") that implies persistence you don't have.

## Persistence

`wait_for_reply` is persistent by default (persistent: true) — meaning it loops polling *within a single blocking tool call*, up to `max_wait_minutes`, without returning control to you or ending your turn. That in-turn blocking loop is the entire meaning of "persistent" here. It is NOT a background watcher: once `wait_for_reply` returns (message received, `done` received, or the ceiling hit) and your turn ends, persistence is over — see "Watching vs. Not Watching" above. Only pass `persistent: false` if the user signals one-shot intent ("quick message", "don't wait for a reply").

## Done Signal (MANDATORY)

After your final message in a collaboration, always send a separate `done` message with a brief summary. A `response` is not a `done`. Without it, the other instance polls indefinitely.

## Cross-project changes (MANDATORY)

If a CHANGE (create/edit/commit) belongs to ANOTHER project, do not make it from your own session. Spawn a resident Claude IN that project (`spawn-collaborator --project <path>`) and let IT make and commit the change. That peer loads the target project's CLAUDE.md, memory, MCP servers, skills, and hooks — you do not, and editing its files from outside skips all of that.

This is the general rule. It applies everywhere, not only inside plan-step execution — see "Plan-step cross-project invocation" below for that narrower, `xproj`-flagged case.

**Edge case — global config with no owning project**: edit directly, no spawn needed. Examples: a plain `~/.claude/skills/*/SKILL.md` that is not symlinked from a repo, or other loose global config. Exception within the exception: `~/.claude/CLAUDE.md` itself is edited directly ONLY with the user's explicit authorization.

## Plan-step cross-project invocation

When executing a plan step that contains an `xproj: <project>` line (on its own line, directly under the step header, before the step body):

1. Before starting any step work, resolve `<project>` to a path via `~/.claude/project-manifest.jsonl` (exact name match, case-insensitive).
2. `spawn-collaborator spawn --project <resolved-path> [--channel <current-or-new>] [--model sonnet]`
3. Post the step's title + full body to the shared channel so the collaborator has task context immediately.
4. Continue — the collaborator runs in parallel; coordinate via the channel.

Fallback: if the project is not in the manifest or spawn fails, warn once and proceed solo. Do not block execution.
