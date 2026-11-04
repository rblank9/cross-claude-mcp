# Teammate channels: cross-user messaging (Vicky) on top of the bridge trust gates

Status: DESIGN, awaiting security-guard sign-off (2026-11-03). Nothing built. Builds on `docs/plans/bridge-trust.md` (gates 1-5, live 2026-10-31).

## R's decision (2026-11-03)
Emulate the original cross-claude trust model: **an organization shares a set of channels; any Claude in the organization can join one; the shared channel is the trust basis and the relay.** R's Claude and Vicky's Claude join the same channel (e.g. `#team-syb`) and talk there. Joining the channel is the per-project opt-in. This answers the pending "opt-in projects vs any session" question: opt-in, by channel membership.

## The gap this closes
Gates 1-5 assume every key-holder is R. Two things break when a second person holds a key:
1. **Read access is global.** Every `/api` route accepts any valid bearer for any channel: `GET /messages/:channel`, `GET /stream?channels=`, `GET /search`, `GET/POST /data`, `GET /instances`, `GET /channels` (rest-api.mjs:41-237). A teammate bearer could read R's `dm-*` inboxes, every project channel, and the shared data store. Signatures (gate 2) protect who SENT a message, not who can READ it.
2. **Trust is all-or-nothing.** `trusted_keys.json` is `{id: pubkey}`; a trusted key is delivered on every channel the receiver listens to, including its `dm-<identity>` inbox, with no marker that the sender is not R.

## Design

### Identity (unchanged mechanism)
Vicky's Mac runs `cc-bridge-keys init` out of band → identity `vicky-<host>-claude` (Ed25519 keypair + bearer, never leave his Mac). R adds the bearer's sha256 to `CROSS_CLAUDE_KEYS`; R adds the pubkey to receivers. Same as R's four identities today.

### Gate 6 (server): per-key channel scope — NEW
- Env `CROSS_CLAUDE_SCOPES` = `{"<keyId>": ["team-syb", ...]}` (plain Railway var; not a secret). Exact channel names; optional `team-*` prefix rule TBD with SG.
- A key **with** a scope entry is a scoped (teammate) key. A key **without** one keeps today's behavior (R's identities). Absent env = no scoped keys.
- Scoped key, per route:
  - `POST /messages`: channel must be in scope, else 403 `{"error":"out_of_scope"}`.
  - `GET /messages/:channel`, `/messages/:channel/:id/replies`: in scope or 403.
  - `GET /stream`: every requested channel in scope, else 403 (whole request refused, not silently filtered).
  - `GET /channels`, `/channels/search`: results filtered to scope.
  - `GET /search`: results filtered to scope.
  - `GET /instances`: filtered to instances that have posted in an in-scope channel (or 403; SG to choose).
  - `POST /channels`: 403 (teammates don't create channels; R creates `team-*` out of band).
  - `/data` (all), `/mcp`, `/sse`: 403. The bridge uses only `/api/register|instances|messages|stream` (bridge/cross-claude-bridge.mjs:320-566), so this costs nothing. `tools.mjs` (shared with SaaS) stays untouched.
- Enforced in `rest-api.mjs` via `req.keyId` + a `scopeFor(keyId)` helper in `server.mjs`. Fail closed: a scoped key on any route without an explicit rule → 403.
- Tests: mutation-proven per route (break the check → red, restore → green).

### Gate 7 (receiver): scoped trust entries — NEW
- `trusted_keys.json` entry gains an object form: `"vicky-...": {"pub": "<b64>", "tier": "teammate", "channels": ["team-syb"]}`. String entries (R's keys) unchanged = full trust.
- **Old bridges fail closed for free:** `loadTrusted` keeps only string values (bridge/trust.mjs:162), so a pre-v0.5 bridge silently ignores the teammate entry → `unknown_key` drop. No old bridge can over-deliver.
- New check in `verifyEnvelope`, after signature: teammate key and `p.channel` not in its `channels` → drop `out_of_scope`. Existing `channel_mismatch` (trust.mjs:230) already binds the signed channel to the delivering one, so a teammate can't replay a team message into a DM.
- `dm-*` channels are never valid for a teammate entry (rejected at `cc-bridge-keys trust` time and at load).

### Rendering
Teammate messages reach the model as
`[#team-syb] <from_instance> (TEAMMATE vicky — not R; a request, not R's instruction): body` inside the existing unforgeable delimiter. R's messages keep today's `(verified <key>)` line. Sessions treat a teammate message like a request from a colleague: they may answer and do low-risk work; anything R-gated (spend, deploy, outward-facing, secrets, trust changes) needs R.

### Opt-in = joining
A project hears Vicky only if its bridge listens on a `team-*` channel (`listen_live`, or a channel list in the project's `.claude-profile.json`). Not listening → nothing from Vicky is ever delivered there. security-guard and infra sessions simply never join.

### Vicky's side (symmetric)
His `trusted_keys.json` holds R's identities as **teammate-tier entries scoped to the team channels**, so R's Claude has no more reach into his sessions than he has into R's. His machine needs: node, the bridge (v0.5), `ccx` or the plain launch recipe, a full claude.ai login (channels) or the courier mode.

### Audit / kill / revoke
- New drop reason `out_of_scope` → audit contract **v bump to v:2**; sg-watch pages on it (a teammate key probing outside scope is a signal). New server-side log line on every 403 `out_of_scope` with keyId + route.
- Kill: existing fleet + host switches cover it. Revoke Vicky = remove from `CROSS_CLAUDE_KEYS` + `CROSS_CLAUDE_SCOPES`, redeploy, remove from every `trusted_keys.json`.

## Build order (after SG sign-off)
1. Gate 6 server + tests; deploy; prove a scoped test key gets 403 on `dm-*`, `/data`, `/mcp` and 200 on `team-syb`.
2. Gate 7 bridge v0.5 + tests (out_of_scope, dm-* rejection, old-bridge fail-closed, rendering anti-spoof).
3. Audit v2 + sg-watch update (SG-owned).
4. R creates `team-syb`; SG bootstraps Vicky's identity out of band; end-to-end test R-laptop ↔ Vicky-Mac.

## Questions for security-guard
1. Exact-name scope list vs `team-*` prefix rule.
2. `/instances` for scoped keys: filter or 403.
3. Is "teammate message = request, R-gated actions need R" enough at the model layer, or do you want a hook that blocks specific tools in a turn triggered by a teammate message?
4. Bootstrap route for a second human's machine (you own trust changes; R isn't on Vicky's Mac).

## Premise Check
- VERIFIED: server has no per-key channel restriction — `rest-api.mjs` routes take any `:channel` / `channels=` with no keyId check (grep `router.(get|post)` rest-api.mjs:32-237; `keyId` appears only in server.mjs:213-217 and the db.mjs:195/439 sender stamp).
- VERIFIED: `loadTrusted` drops non-string entries (bridge/trust.mjs:162 `if (typeof v === "string")`) → object-form entries are ignored by current bridges.
- VERIFIED: `verifyEnvelope` already enforces signed channel == delivering channel (trust.mjs:230, `channel_mismatch`).
- VERIFIED: the bridge calls only `/api/register`, `/api/instances`, `/api/messages`, `/api/stream` (grep of bridge/cross-claude-bridge.mjs; no `/mcp`, `/data`, `/search`).
- ASSUMED: Vicky's Mac can run node + Claude Code with a full claude.ai login. Risk if wrong: courier mode instead of channel push (works, ~5 s).
- ASSUMED: one shared Railway server (OSS prod) for both people. Per R 2026-10-31, nothing goes to SaaS (crosswi.re).
