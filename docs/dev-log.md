# Dev Log

Running log of notable issues investigated, decisions made, and why. Newest entries first.

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
