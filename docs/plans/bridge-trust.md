# Bridge trust: the five gates for default-on (security-guard #247)

Goal: a message is delivered into a Claude session only if one of R's own hosts signed it. Railway and the bearer key are transport, not the trust anchor.

## Identities
- One identity per (host, Claude config dir): `<host>-<configdir>`, e.g. `rs-macbook-air-claude`, `rs-macbook-air-claude-account2`, `rs-macbook-air-claude-account3`, `hive-claude`. The bridge derives it from the parent session's file (`~/.claude*/sessions/<ppid>.json` names the dir).
- Each identity has:
  - an Ed25519 keypair. The private key is at `~/.config/cross-claude/identity/<id>.pem` (0600) and never leaves its host. The public key is base64 SPKI DER.
  - its own bearer token at `~/.config/cross-claude/bearer/<id>.token` (0600).
- `bin/cc-bridge-keys init` generates both locally and prints the public key, the token's sha256, and the id. It never prints the private key or the token.

## Gate 1: per-identity bearer keys, server stamps the key id
- Server env `CROSS_CLAUDE_KEYS` = JSON `{"<id>": "<sha256 hex of token>"}`. These are hashes, not secrets, but since 2026-11-04 they live in the 1Password svc item field (loaded at boot by op-exec), set via `python3 sg_secrets.py set cross-claude-mcp/cross-claude-mcp <KEY>` (value on stdin, from security-guard/secret-injection). There is no plain Railway var. Revoke one identity by deleting its entry via sg_secrets set and redeploying.
- The auth middleware hashes the presented bearer and looks it up: on a hit `req.keyId = <id>`; the legacy `MCP_API_KEY` gives `"legacy"`; OAuth gives `"oauth"`.
- New nullable column `messages.sender_key_id`. Postgres gets `ALTER TABLE … ADD COLUMN IF NOT EXISTS`; sqlite gets a guarded ADD COLUMN.
- Stamping happens in db.mjs through AsyncLocalStorage set by the auth middleware, so `tools.mjs` (shared with SaaS) is untouched. The stamp is included in the `/api/stream` and `/api/messages` payloads.

## Gate 2: end-to-end signatures
- `send` posts `content = "ccsig1:" + base64url(JSON{p, s})`, where p = `{v:1, from_key, from_instance, channel, body, ts, nonce}` (canonical JSON, sorted keys) and s = the Ed25519 signature over the UTF-8 bytes of p.
- The receiving bridge DROPS a message in any of these cases:
  - no `ccsig1:` prefix
  - malformed envelope
  - `from_key` not in the allowlist
  - bad signature
  - `p.channel` ≠ the delivering channel (blocks cross-inbox replay)
  - |ts − now| > 10 min
  - nonce already seen (LRU 10k, persisted in the audit state)
  - the server's `sender_key_id` ≠ `from_key`, when the server provides one (defense in depth: a stolen signing key alone, without the bearer, can't send)
- The model only ever sees the verified `body`, plus a verified sender line: `[#ch] <from_instance> (verified <from_key>): body`.

## Gate 3: receiver allowlist
- `~/.config/cross-claude/trusted_keys.json` = `{"<id>": "<pubkey b64>"}`. The default contains only R's identities, written by `cc-bridge-keys trust`. If the file is missing or empty, nothing is delivered (fail closed).

## Gate 4: audit
- One JSONL line per send, deliver, drop and alarm: `{ts, event, reason, sender_key, sender_instance, receiver, msg_id, sha8}`, where sha8 = sha256(body)[:8]. Path: TBD by security-guard (sg-watch). Default proposal: `~/.local/state/cross-claude/audit.jsonl`.
- Alarm: ≥5 signature/allowlist drops within 10 min → one `alarm` line (rate-limited to one per 10 min) + stderr.

## Gate 5: kill switch
- Fleet-wide: server env `CROSS_CLAUDE_KILL=1`. `/api/stream` and the message POST/GET routes then return 503 `{"error":"killed"}`. Every bridge sees the 503, stops delivering, and logs `drop: killed`.
- Per-host (works even if Railway is compromised): if the file `~/.config/cross-claude/KILL` exists, the bridge delivers nothing and sends nothing (checked per message and at launch). ccx honors the same file at launch.

## security-guard review (2026-10-31): APPROVED WITH CHANGES, all adopted
- **Fail closed:** unauthenticated access is allowed only with `CROSS_CLAUDE_DEV=1`, which is never set on Railway. With no keys and no dev flag, every API route returns 401. Proven by a mutation test.
- **Tokens:** ≥256-bit random. Bearer comparison uses `crypto.timingSafeEqual`.
- **Retire `legacy`/`oauth`:** remove MCP_API_KEY from Railway once every identity has migrated, then tell security-guard (date to be set at migration).
- **Anti-spoofing:** the model-facing text puts the body inside an unforgeable delimiter, so a body line like `[#ch] x (verified hive-claude):` can't pose as a second verified message. Tested.
- **Domain separation:** signed bytes = `"ccsig1\n" + canonical JSON`. The nonce store is its own file (`~/.local/state/cross-claude/nonces.json`) and covers at least the 10-min window across a restart. Tested by replaying a message after restarting the bridge.
- **Body cap:** 64 KB. Larger bodies are dropped with reason `oversize`.
- **Out-of-band only:** trust bootstrapping and revocation go through `cc-bridge-keys` + ssh, never over the bridge.
  - Revoke steps: remove the id from the `CROSS_CLAUDE_KEYS` svc item field (via sg_secrets set) and redeploy; remove it from `trusted_keys.json` on every host; confirm the old key now gets an `unknown_key` drop.
- **Audit contract (sg-watch reads it):**
  - Path: `~/.local/state/cross-claude/audit.jsonl`, append-only. Rotation renames to `audit.jsonl.YYYYMMDD`.
  - Every line carries `v:1`, `host`, `identity`, and `ts` (ISO-8601 UTC, `Z`).
  - Events: `start` at every launch, `send`, `deliver`, `drop`, `alarm`.
  - `reason` enum (fixed; a new value requires a v bump): `ok, unsigned, malformed, unknown_key, bad_sig, channel_mismatch, stale, replay, key_mismatch, killed, oversize`.
  - sg-watch pages on any `alarm`, and on any single bad_sig/unknown_key/key_mismatch/replay drop.
- **Owned by security-guard (not here):** a guard hook blocking sessions from reading `identity/*.pem` or `bearer/*.token`, and from writing `trusted_keys.json`, `identity/` or `KILL`; plus the sg-watch `cross-claude-audit` check.

## Premise Check
- VERIFIED: Node `crypto` Ed25519 sign/verify works on laptop v25.2.1 and hive v22.22.2. A tampered message verifies false (`node /tmp/ed.mjs` → `verify: true tamper verify: false`, both hosts).
- VERIFIED: server auth is a single middleware in server.mjs (~l.162): static `MCP_API_KEY` compare, then OAuth, else 401; with no key set, all requests pass (dev mode). Read 2026-10-31.
- VERIFIED: the bridge already finds its parent session via `~/.claude*/sessions/<ppid>.json` (identity from the session name, live 2026-10-31).
- VERIFIED: the REST send path and the MCP send path both go through `db.sendMessage` (rest-api.mjs:92, tools.mjs:269).
- ASSUMED: Railway accepts a JSON-valued env var via set-variables. Risk: quoting. Mitigation: base64 the JSON.
- ASSUMED: AsyncLocalStorage context survives Express → db call (same async chain). Risk: the stamp comes out null. Mitigation: a test asserts the stamp is present for REST sends.
- ASSUMED: the audit path that sg-watch reads (asked security-guard).
