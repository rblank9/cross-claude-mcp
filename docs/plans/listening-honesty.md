# Listening Honesty — Layers 1 & 2

**Problem**: Claude instances tell R they are "staying subscribed" / "listening" to cross-claude
channels when nothing is listening. The cross-claude skill already forbids this (HARD RULE,
SKILL.md:36) and it doesn't work, because (a) skills aren't guaranteed to be loaded, and
(b) the server's own tool text teaches the false belief: `subscribe`'s description promises
"LIVE PUSH... injected into your session in real time — no polling" and its return says
"will be pushed to you live" (`tools.mjs:284,302`).

**Nuance (verified)**: push is real server-side — `send_message` emits
`notifications/claude/channel` MCP notifications to subscribed live sessions
(`tools.mjs:257–269`, gated on `CHANNELS_ENABLED`). But turn-based clients (Claude Code CLI,
Desktop, claude.ai) do not surface custom MCP notifications to the model, so subscribing still
delivers nothing a model will ever see. Wording must be honest about both halves.

## Layer 1 — Truth-in-advertising in `tools.mjs` (reaches every client, every model, no skill needed)

1. **`subscribe` description (line 284)** → rewrite: subscription registers server-side push, but
   turn-based clients never surface those notifications to the model; subscribing is NOT
   listening; the only ways to actually see messages are blocking in `wait_for_reply` or polling
   `check_messages`; never tell the user you are "listening"/"watching" after this call alone.
2. **`subscribe` return text (lines 301–303, both branches)** → same enforcement in the payload the
   model reads at the exact moment it's about to write the lie, with the two honest alternatives
   spelled out (block in `wait_for_reply` now, or tell the user you'll only see messages next turn).
3. **`unsubscribe` description/return (310, 319)** → drop "live push delivery" framing.
4. **`check_messages` return (357)** → trailing hint gains one sentence: you only see messages when
   you poll; if collaboration is ongoing, block in `wait_for_reply` or say you'll check next turn.
5. **`wait_for_reply` description (364)** → replace "keeps listening" with "blocks inside this tool
   call, polling" so "listening" language isn't legitimized; state this blocking call is the ONLY
   true "listening" state.

Then: run repo tests, commit, push, deploy OSS to Railway; propagate to SaaS
(`/Users/rblank/Projects/cross-claude-mcp-saas`: `npm update cross-claude-mcp`, stage explicit
paths only, commit, push, deploy to Railway `cross-claude-mcp-saas`/production).

## Layer 2 — Stop hook (harness enforcement, Claude Code only)

- **Script**: `~/.claude/hooks/cross-claude-listening-gate.py` (python3, stdlib only, fail-open).
  Logic: read stdin JSON → if `stop_hook_active` allow (loop guard) → get final text from
  `last_assistant_message` (fallback: parse last assistant text from `transcript_path` JSONL) →
  if transcript contains `mcp__cross-claude__` tool use AND final text matches listening-claim
  regex (staying subscribed / standing by / actively listening / watching|monitoring the channel /
  I'm listening / keeping an eye on the channel, case-insensitive) → emit
  `{"decision":"block","reason":"You told the user you are listening, but your turn is ending and
  nothing will be listening. Either call wait_for_reply now and stay blocked, or retract the claim
  and say you'll only see messages when next prompted."}`. Any exception → exit 0.
- **Config**: append to existing `Stop` array in `~/.claude/settings.json` (merge, never clobber —
  Stop hooks already exist at lines 27–117).
- Hook script is new-file code-from-spec → delegate authoring; verify + test inline.

## Verification (fresh CC CLI sessions)

- **Layer 1 (behavioral, N=3)**: fresh `claude -p` sessions (haiku, sonnet, opus) prompted to
  register + subscribe to a throwaway channel and report status to the user. PASS = no
  listening/watching/subscribed-and-waiting claims in output; honest statement instead.
  (Stop hooks don't fire in `-p`, so this isolates Layer 1.)
- **Layer 2 (hook)**: pipe crafted stdin JSON cases → claim+cross-claude ⇒ block; claim without
  cross-claude ⇒ allow; no claim ⇒ allow; `stop_hook_active` ⇒ allow; malformed ⇒ allow.
  Then one tmux-driven interactive session to see the block fire live (best-effort; if tmux
  driving is flaky, hook unit tests + R manual spot-check).
- **Deploy check**: fresh session's `subscribe` call against prod returns the NEW text (proves both
  Railway deploys serve the change).

## Definition of Done
Lanes: logic, deploy, config, script
- logic  : fresh CC session calls `subscribe` against prod → new honest return text shown; repo tests green
- deploy : OSS + SaaS Railway deploys succeed; prod serves new tool text (consumer path above)
- config : `~/.claude/settings.json` Stop entry present; existing hooks intact; hook fires in a real Stop event
- script : gate script blocks/allows correctly on all five crafted stdin cases
