# Topology-Aware Listening (v2)

**Status**: IMPLEMENTED (OSS, commit 3064c87, 2026-07-18) — code + local tests done for WS1–WS4;
DEPLOY (Railway OSS), transport-survival measurement, real deployed-session api check, ccx.zsh
launcher wiring (cross-project), and SaaS propagation remain. Decisions locked with R 2026-07-18.
**Driver**: 3-agent Bagby launch coordination failed (2026-07-18) — the 2026-07-09 mutual-wait
fix (late-waiter-yields) locks a conductor out of listening whenever a parked peer holds a wait;
the listening-honesty Stop hook blocks honest background-wait claims; live push can't be enabled
mid-session. Full incident report + grounded diagnosis in the 2026-07-18 session.

## Locked decisions (R, 2026-07-18)

1. **Parked role.** An agent can register as *parked*. Parked agents still receive **every**
   channel message (Claudes judge relevance themselves; `@mention` is etiquette, not a delivery
   filter) — the ONLY effect of parked is that the agent **does not count as a mutual-wait party**,
   so it can never bounce an active listener out of `wait_for_reply`.
2. **Background wait = honest listening.** Claude Code force-backgrounds MCP calls after ~120s
   (documented, first-class: `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`, wake via task notification).
   A live backgrounded `wait_for_reply` genuinely wakes the session — the Stop hook must accept
   it, and docs define "listening" as "wakes when a message arrives," not "instant push."
3. **One wait per agent per channel.** A new `wait_for_reply` replaces any existing wait by the
   same instance on the same channel — no stacking, no tangling.
4. **24h default ceiling.** `max_wait_minutes` default 30 → 1440. Cost of an idle waiter is
   negligible (one DB poll/5s, per-instance cursors, zero tokens until woken). The 1800s "abort"
   in the incident was just this ceiling (30 min = 1800s).
5. **Both modes load at launch, channel chosen live.** The launch-only constraint in Claude Code
   gates *loading the plumbing*, not *choosing a channel*. Ship a **channel-less bridge** that
   loads on every `ccx` launch idle, plus a tool to start/stop live delivery for a named channel
   mid-session. Relaunch stops being the upgrade path for ccx-launched sessions.
6. **Definitive status.** A tool/response that states as fact: "live push active on #X" vs
   "background-wait listening" vs "poll-only."
7. **README rewrite** (public repo) + **cross-claude skill updates** (repo `skill/` + R's global
   `cross-claude` skill) to teach the new model.

## Workstreams

### WS1 — Server: parked role + wait semantics (`tools.mjs`, shared OSS/SaaS)

- `wait_for_reply` gains `role: "active" | "parked"` (default `active`).
  - Parked waiters are excluded from the `activeWaiters` set that `checkYield()`/`decideYield()`
    (tools.mjs:37-54, 416-472) considers. Delivery behavior identical to active.
  - Yield message text updated: stops claiming "nothing queued" (never verified today).
- Single-wait enforcement: registering a wait while one is live for the same
  (tenant, channel, instance) **cancels the old one** (old call returns a clear
  "superseded by a newer wait" result, not an error).
- `max_wait_minutes` default 30 → 1440. Ghost detection (`peerIsGhost`) must not key off the
  raised default in a way that makes dead waiters look alive for 24h — use heartbeat/last_seen
  (STALE_THRESHOLD_SECONDS) instead of wait age.
- **Cursor-swallow fix (blocking bug for decision 2's honesty guarantee) — SPECIFIED:** the wait
  currently re-resolves its floor each poll cycle (`resolveFloor`), so a `check_messages` in a
  sibling turn that advances the durable cursor makes the wait skip messages between old and new
  floor. Fix direction (locked, red-team reviewed): **snapshot the wait's floor once at entry and
  never re-resolve it.** This deliberately re-permits duplicate delivery *within the same
  instance* (a message may be seen by both `check_messages` and the wait) — hearing twice beats
  sleeping through; the cross-INSTANCE double-delivery guarantee from the D1 durable-cursor design
  is unaffected (floors are per-instance). Regression test: wait in T1 → `check_messages` in T2
  consumes messages → a later message MUST still fire the wait.
- **Transport-survival verification (biggest unexamined risk, added post-red-team):** a wait is
  held inside a single HTTP request to Railway; the proxy may kill idle connections long before
  the 24h ceiling, silently — the exact bug class this plan exists to kill. WS1 must MEASURE how
  long a live wait actually survives against the deployed server. If shorter than the ceiling:
  add server keepalive bytes and/or an internal chunk-and-renew (server returns a renewal
  continuation before the transport limit; semantics to the caller remain "one 24h wait").
- Ghost detection: replace wait-age check (`peerIsGhost`, tools.mjs:438) with heartbeat only
  (STALE_THRESHOLD_SECONDS). **Test required:** a crashed peer leaves the waiter pool within
  ~2× heartbeat regardless of the 24h ceiling.
- **Parked topology invariants (document + test):** two active waiters = today's mutual-wait
  protection applies (correct — that IS the deadlock case); all-parked = everyone listens, no
  yield, no deadlock; forgotten `role` flag = defaults to `active` and degrades to today's
  behavior, never worse. Test: 3-instance conductor + 2 parked → no yield; forgotten-flag
  variant → conductor yields exactly as today.
- SaaS insurance: per-tenant ceiling on concurrent waits (config, generous default) so one
  tenant can't monopolize poll load.
- Propagation: `tools.mjs` is the shared file → after merge, `npm update` in the SaaS repo,
  deploy SaaS per its Railway link (project `cross-claude-mcp-saas`), staged paths only.

### WS2 — Stop hook + tool text: honest listening

- `~/.claude/hooks/cross-claude-listening-gate.py` (both accounts): add a third exemption —
  a **live backgrounded `wait_for_reply`**. Detection spec (transcript heuristic, red-team
  reviewed): a backgrounded MCP call leaves a footprint — the tool_use's immediate result carries
  a background task ID, and a task-completion notification appears in the transcript when it
  settles. Exemption fires iff the MOST RECENT `wait_for_reply` tool_use has a task ID with **no
  matching settle record**. A settled/expired wait therefore does NOT exempt (deaf agent claiming
  listening still blocks). Keep existing exemptions (CC_LISTEN_CHANNEL, channel/bridge markers).
  Keep fail-open.
- Canonical honest phrasing documented in tool text + skill: "a background wait is live and will
  wake me when a message arrives (until <expiry>)."
- Tool text updates per docs/plans/listening-honesty.md L1, amended: `wait_for_reply` description
  explains backgrounding is expected and IS the listen; expiry means deaf-until-renewed and must
  be disclosed.

### WS3 — Channel-less bridge + live-switch tool + status

- `bridge/cross-claude-bridge.mjs`: start with NO channel; idle until told. New MCP tools it
  exposes: `listen_live(channel)` / `stop_listening(channel)` (start/stop the poll loop and
  `notifications/claude/channel` push mid-session; multiple channels allowed).
- `cc-listen` remains as sugar (launch + immediately listen to a named channel), reimplemented
  on the channel-less bridge.
- Status: a `delivery_status` tool answering — live push (which channels) / background wait
  live (which channel, expiry) / poll-only. Server knows waits; the bridge knows push; compose
  both. **Honesty caveat (red-team):** the tool cannot prove push reaches the model end-to-end
  (dead poll loop, dropped notification); its wording is "best-effort" — it reports what is
  registered/running, never certainty of delivery.
- **Launcher wiring**: `ccx` (function in `/Users/rblank/Projects/claude-optimization/ccx/ccx.zsh`)
  always loads the bridge MCP config + `--channels server:cross-claude-bridge`. `cc2` is
  `alias cc2='CLAUDE_CONFIG_DIR=~/.claude-account2 ccx'` → covered automatically; verify the
  bridge respects `CLAUDE_CONFIG_DIR` for any per-account state. Gate behind a ccp/profile flag
  so a broken bridge can't brick session launches.

### WS4 — Docs + skills (public-facing)

- **README.md rewrite**: the listening model (push vs background-wait vs poll), roles
  (conductor/worker/parked), one-wait rule, ceilings, honest-listening contract, bridge tools.
- `docs/channels.md`: channel-less bridge, mid-session `listen_live`, status tool.
- Repo `skill/` (distributable) + R's global `cross-claude` skill: teach role declaration,
  single-wait discipline, canonical listening phrasing, @mention etiquette (addressing, not
  filtering), when to use live vs background-wait.
- `docs/dev-log.md` + memory updates per convention.

## Rollback & soak (red-team amendments; R accepted same-day WS1 deploy 2026-07-18)

- **WS1 rollback:** redeploy the previous Railway build (one command; verify service link per
  deploy-safety first). No schema changes in WS1 → rollback is clean.
- **WS3 rollback:** profile flag off → next `ccx` launch skips the bridge entirely; a bridge
  failure must never block session launch (spawn is non-blocking, timeout-guarded).
- **SaaS soak:** OSS deploy soaks (target: one real multi-agent session + overnight) before
  `npm update` + SaaS deploy.
- **README framing (R decided):** conductor/worker/parked is documented as a general-purpose
  multi-agent pattern, not R-specific infrastructure. No R-specific hosts, launchers (ccx/cc2),
  or account details in the public README.

## Sequencing (Bagby ships today)

1. **WS1 core** (parked role + single-wait + 24h ceiling) — small, contained `tools.mjs` change
   with tests → deploy OSS Railway service → **unblocks the Bagby 3-agent topology properly.**
2. **WS2** (hook + tool text) — local files + tools.mjs text, no risky deploy.
3. **WS1 cursor-swallow fix** (diagnose first; may land with #1 if quick).
4. **WS3** (bridge + launcher) — largest; behind profile flag.
5. **WS4** (README/skills/docs) — finalize after WS3 API shapes settle.
6. SaaS propagation after OSS soak.

## Definition of Done

Lanes: logic, api, script, config, deploy, docs, test

- logic  : `node --test test.mjs test-mutual-wait.mjs` + new parked/single-wait/cursor tests →
           0 failures; parked peer + active waiter coexist in a 3-instance test.
- api    : from a REAL Claude Code session against the deployed server: conductor holds
           `wait_for_reply` while a parked peer waits → no MUTUAL WAIT yield; message from a
           third instance wakes the conductor.
- script : `ccx` (and `cc2`) launch with bridge loaded; `listen_live` delivers a live message
           into the session context; `delivery_status` reports the true mode in both a push
           session and a plain one.
- config : profile flag toggles bridge wiring; launch works with flag off.
- deploy : Railway OSS service deployed per deploy-safety (service-link verified); post-deploy
           logs clean; SaaS deployed after soak with tenant-scoped tests green.
- docs   : README + channels.md + both skills updated; a fresh session following only the skill
           executes the conductor/parked pattern without hitting mutual-wait.
- test   : Stop hook: a turn claiming listening WITH a live background wait passes; the same
           claim with NO wait still blocks.
