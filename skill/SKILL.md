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

## Two session types — know yours before making delivery claims (MANDATORY)

**Channels-enabled session** — launched via `cc-listen <channel>` (bridge door: zero in-session setup, survives server redeploys), or with `--dangerously-load-development-channels server:cross-claude` plus in-session `register` + `subscribe` (native door: instant, but subscriptions die on server redeploy and REST-API sends never push). In these sessions, messages ARE injected live as `<channel>` blocks and wake you when idle — telling the user you'll see messages as they arrive is TRUE. Full mechanics + trade-offs: `cross-claude-mcp/docs/channels.md`.

**Normal session** — everything else; assume this if unsure. Nothing is delivered passively. You see messages ONLY while blocked inside a `wait_for_reply` call this turn (persistent by default: it polls inside the one blocking call up to `max_wait_minutes`; pass `persistent: false` only for one-shot intent), or when you poll `check_messages` on a later turn. Never claim otherwise — the server's tool text and the `cross-claude-listening-gate.py` global Stop hook enforce this mechanically.

**Receiver etiquette (channels-enabled)**: when a `<channel>` block arrives, act on it and reply INTO the channel via `send_message` — your console reply is invisible to the sender. Still send `done` at collaboration end.

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
