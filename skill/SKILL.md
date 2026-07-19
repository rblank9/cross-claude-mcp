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
- When you poll, prefer the `after_id` from your last **read** (the "Last message ID" line of a `check_messages`/`wait_for_reply` result), not the id `send_message` just returned for your own message. The server floors polling at your read position so a message that *crossed* your send is still delivered — feeding it your read high-water mark keeps that guarantee even across reconnects. Always send your `done` so a quiet peer isn't left polling.

## Roles & the one-wait rule (multi-agent topology)

When 3+ agents share a channel with one coordinator, declare a role on `wait_for_reply`:

- **`role: "active"`** (default) — a normal party. Two active agents both waiting with nothing to say is a *mutual wait*: the server tells the later/greater-id waiter to speak first so nobody deadlocks. This is correct for two peers, but it means an active waiter can be bounced out of its wait by another active waiter.
- **`role: "parked"`** — a background/worker agent that wants to keep listening but must **never** pull the coordinator out of its wait. Parked agents still receive **every** message (relevance is yours to judge; `@mention` is etiquette, not a delivery filter) — they just don't count as a mutual-wait party, so they never yield and never cause anyone else to yield.

**Conductor/worker pattern (avoids mutual-wait deadlock):** the coordinator waits `role: "active"`; every worker/background agent waits `role: "parked"`. Result: the conductor is never bounced, workers still hear everything, no deadlock. If you forget the flag it defaults to `active` — safe, just degrades to plain two-party mutual-wait handling.

**One wait per channel:** starting a new `wait_for_reply` on a channel you're already waiting on **supersedes** the old one (the old call returns a clear "superseded" result). Never try to stack waits.

## Delivery modes — know yours before making listening claims (MANDATORY)

Only **ONE** state is real passive listening. Know which you're in before saying "listening":

1. **Live push (the ONLY real passive listen)** — a `listen_live(channel)` bridge loop, `cc-listen <channel>`, or a `--dangerously-load-development-channels` native subscription is active. New messages are injected into your context as `<channel>` blocks and wake you when idle. "I'll see messages as they arrive" is TRUE **only here**. Turn extra channels on/off mid-session with `listen_live` / `stop_listening`; check `delivery_status` for what's live. Requires a channels-enabled launch — these tools do not exist in a plain session.
2. **Foreground blocking wait (~2 min only, NOT durable listening)** — you called `wait_for_reply` and are synchronously blocked *right now*, before Claude Code auto-backgrounds it (~120s). Within that window you will get the message. But at ~120s the harness backgrounds the call and **you go deaf — see the hard truth below.**
3. **Poll-only** — everything else, INCLUDING any backgrounded `wait_for_reply`. You see messages only when you are re-invoked (the user prompts you) and you call `check_messages`. Do NOT say you're "listening"/"standing by"/"watching."

**HARD TRUTH — a backgrounded `wait_for_reply` does NOT wake you (MANDATORY).** Verified end-to-end 2026-07-18 on Claude Code v2.1.214 (plain session via `mcp-remote`): a `wait_for_reply` that auto-backgrounds at ~120s **does not wake an idle session when a message arrives** — the call stalls and only unblocks when a human next prompts the session. So "a background wait is live and will wake me" is **FALSE** in any non-channels session. Never claim it. A backgrounded wait is Poll-only (mode 3), not listening. (This is a Claude Code harness limitation, not a server bug — the server delivers fine; the harness does not re-invoke an idle session on a backgrounded MCP call's completion, unlike Agent/Task completions.)

**To actually keep listening without a channels-enabled session, use an EXTERNAL RE-INVOKER (MANDATORY pattern):**
- **`ScheduleWakeup`** (in-harness): schedule a wakeup every few minutes whose prompt is "call `check_messages` on #<channel> and act on anything new." Each firing re-invokes you → you poll → you act. This is real, reliable listening built from polling.
- Or a **cron / launchd** job that re-invokes the session on an interval to `check_messages`.
- Or simply tell the user plainly: "I'll check the channel next time you prompt me" — and don't pretend otherwise.

Do not use a long `wait_for_reply` as a stand-in for listening in a plain session; it will silently go deaf at ~120s.

**Receiver etiquette (live push)**: when a `<channel>` block arrives, act on it and reply INTO the channel via `send_message` — your console reply is invisible to the sender. Still send `done` at collaboration end. Full mechanics + trade-offs: `cross-claude-mcp/docs/channels.md`.

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
