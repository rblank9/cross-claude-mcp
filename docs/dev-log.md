# Dev Log

Running log of notable issues investigated, decisions made, and why. Newest entries first.

---

## 2026-07-19 — wait_for_reply clamped to transport-safe ~25 min + rejoin (24h ceiling was a lie)

**Field report (from a live Claude):** an MCP `wait_for_reply` was **aborted at 1829s** (~30.5 min).
The topology-aware-listening plan (WS1, `docs/plans/topology-aware-listening.md:58-63`) had flagged
this as "the biggest unexamined risk" and never measured it — it *assumed* the earlier 1800s death
was the app ceiling (old 30-min default) and "fixed" it by raising `max_wait_minutes` 30 → 1440 (24h).

**Diagnosis:** the word *abort* is the tell. The app ceiling RETURNS gracefully (`tools.mjs`, a clean
text result), so a claude would report "30 minute(s)", not a severed connection at a precise 1829s.
An abort means the HTTP request was **severed underneath the tool** — a transport-layer max-request-
duration cap (~30 min) on the path (Railway proxy and/or the client's backgrounded-MCP limit). The
30s keepalive notifications (`tools.mjs:387,548`) do NOT prevent it, so it is a hard duration cap, not
an idle timeout. **A wait is held in ONE HTTP request → it cannot logically outlive that cap.** The
shipped 24h ceiling was therefore a lie: agents believed they were listening for 24h and went deaf at
~30 min (exactly the honesty bug the v2 feature existed to kill).

**Fix (decision: "cap + tell the truth" + client-driven rejoin):**
- `TRANSPORT_SAFE_CEILING_MIN` (env `WAIT_TRANSPORT_CEILING_MIN`, default **25**). `max_wait_minutes`
  default 1440 → 25, and the requested value is **clamped** to the safe ceiling — promising more is a lie.
- Ceiling-return message rewritten: states it hit the ~25-min transport-safe limit (expected, not a
  failure) and instructs the caller to **immediately re-issue the wait (rejoin)** to keep listening.
- Tool text / README / skill (`skill/SKILL.md`, symlinked to R's global `cross-claude` skill) teach the
  rejoin rule + point true always-on listening at the channels bridge (Live push).
- Tests updated (ceiling-message assertions) — full suite green (54 + 41 + 14, 0 failed).

**Cap source — RESOLVED (same day, via a verification pass):** it is **Claude Code's stdio
idle-timeout (30-min default)**, not an infra proxy and not an absolute cap. Confirmed decisively:
`~/.claude.json` connects cross-claude via `npx -y mcp-remote …/mcp`, so the client treats it as a
**stdio** server and applies the 30-min stdio `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` default (HTTP would
be 5 min; wall-clock `MCP_TOOL_TIMEOUT` is ~28h). 1829s ≈ that window. Official-doc sourced
(code.claude.com/docs/en/mcp.md). Full write-up + the corrected mechanism:
`docs/plans/wait-transport-cap-investigation.md` (AUTHORITATIVE CORRECTION block). An earlier Opus
pass had mis-called this an immovable absolute cap sourced to unverified GitHub issues — corrected.

**Root-fix ATTEMPT (unvalidated — do not remove the clamp yet):** the idle timer resets on a
response or a *progress* notification, but our old keepalive only sent real `notifications/progress`
when the client supplied a progressToken, else it sent a `notifications/message` log (which likely
does not count). `sendKeepalive` now ALWAYS sends `notifications/progress` (synthesizing a stable
`wfr-<token>` when absent) + a server-side `console.error` heartbeat for observability. **Must be
measured in prod** (a >30-min wait that survives) before trusting it; if progress already reached the
client and still didn't reset the timer (visible progress text in a prior session would indicate
this), a server fix cannot help and clamp+rejoin is the permanent answer.

**NOT deployed:** R has live cross-claude sessions; redeploy is deferred. Shared `tools.mjs` change →
needs commit (staged paths only) + SaaS `npm update` + redeploy of both, then the survival
measurement from a FRESH session (this one is connected to the MCP it changed). Steps in RESUME.md.

---

## 2026-07-18 — Topology-aware listening v2 (parked role, one-wait, 24h, honest listening, channel-less bridge)

Implemented `docs/plans/topology-aware-listening.md`. Driver: a 3-agent Bagby launch failed
because the 2026-07-09 late-waiter-yields fix let a parked peer bounce the conductor out of its
wait, the Stop hook blocked honest background-wait claims, and live push couldn't be turned on
mid-session.

Shipped (OSS, `tools.mjs` shared with SaaS):
- **Parked role** on `wait_for_reply` (`role: active|parked`). Parked waiters are excluded from
  the mutual-wait party set (`checkYield`): they never yield and never cause a yield. Default
  `active` = unchanged behavior (safe when the flag is forgotten).
- **One wait per (tenant, channel, instance)** — a new wait overwrites the `activeWaiters` token;
  the superseded loop detects the token change and returns a clear "superseded" result.
- **`max_wait_minutes` 30 → 1440 (24h).**
- **Ghost detection by heartbeat, not wait-age** — dropped the `peerIsGhost = waitAge >= ceiling`
  check (would keep a crashed peer "alive" for 24h); eviction now keys on `STALE_THRESHOLD` only.
- **Cursor-swallow fix** — the wait snapshots its poll floor ONCE at entry and never re-resolves
  it, so a sibling `check_messages` advancing the durable cursor can't raise the floor and skip a
  crossing message. Re-permits intra-instance duplicate delivery (hearing twice > sleeping through);
  cross-instance de-dup unaffected (floors are per-instance).
- **SaaS insurance** — `MAX_WAITS_PER_TENANT` (default 100) caps concurrent waits per tenant.
- **`GRACE_MS` env-overridable** (`MUTUAL_WAIT_GRACE_MS`) — testability seam, prod default 30s.

WS2 — honest listening:
- `~/.claude*/hooks/cross-claude-listening-gate.py` (both accounts, symlinked-identical): new
  exemption for a LIVE backgrounded `wait_for_reply`. Schema-robust heuristic — the most-recent
  `wait_for_reply` tool_use with NO final-settle result (settle markers: "new message(s) in #",
  "superseded", "MUTUAL WAIT", ceiling, "signaled DONE") is still running → exempt; a settled/
  expired wait does NOT exempt (deaf agent still blocks). Fail-open on parse trouble.
- Tool text + MCP prompt updated: backgrounding is expected and IS the listen; one-wait; roles.

WS3 — channel-less bridge:
- `bridge/cross-claude-bridge.mjs` rewritten to start idle and expose `listen_live(channel)` /
  `stop_listening(channel)` / `delivery_status()` (multiple per-channel poll loops). `cc-listen`
  now sets `BRIDGE_AUTOSTART=1` (sugar). E2E verified against prod REST (test-bridge.mjs, 7/7).
- **Launcher wiring (ccx.zsh, `claude-optimization`) is a separate cross-project change** behind a
  default-off profile flag — tracked separately; not in this repo.

Verification: `npm test` green (test.mjs 54, test-rest.mjs 41, test-mutual-wait.mjs 14 incl. 5 new
WS1 tests, test-bridge.mjs 7). Stop-hook consumer-path test: live-wait ALLOW, settled/no-wait BLOCK.
**Deploy of the OSS Railway service + a real deployed-session mutual-wait check + SaaS propagation
after soak remain** (a session can't verify a redeploy of the MCP it's connected to from inside).

---

## 2026-07-01 — Hono CORS vulnerability (Dependabot alert) — not applicable

GitHub flagged a CORS vulnerability in `hono` (CORS middleware reflects any `Origin` with
credentials when `origin` defaults to the wildcard) via `package-lock.json`.

**Status: acknowledged, no action needed.**

- `hono@4.12.18` is present only as a transitive dependency of `@modelcontextprotocol/sdk`
  (via `@hono/node-server`). It is not a direct dependency.
- This project does not use Hono's HTTP server or its `cors()` middleware anywhere.
- CORS in `server.mjs` (~line 53) is hand-rolled Express middleware, unrelated to Hono's
  vulnerable code path.
- The vulnerable code path is never reached — nothing to patch on our end. Only lever if we
  ever want to silence the alert is bumping `@modelcontextprotocol/sdk` once it ships a patched
  `hono`.
