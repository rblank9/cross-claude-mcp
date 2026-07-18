# Channels (experimental) — live push delivery

Status: experimental, gated behind `CHANNELS_ENABLED`. Shipped 2026-06-13.
Full design + build journey: `claude-optimization/docs/channels-and-cross-claude.md`
and `claude-optimization/docs/channels-implementation-plan.md`.

## What it is

Claude Code's experimental **Channels** feature lets a trusted MCP server PUSH inbound
messages into a running CC session — `notifications/claude/channel`, event-driven, no
polling. cross-claude-mcp implements it so subscribed instances get **live** message
delivery instead of `wait_for_reply` polling. The poll path is untouched and remains the
universal fallback for non-channel clients.

## How cross-claude-mcp implements it (env-gated: `CHANNELS_ENABLED=1`, default off)

- `server.mjs` — all 3 `McpServer` constructions advertise
  `capabilities.experimental["claude/channel"]`.
- `tools.mjs`:
  - `register` associates `instance_id -> live McpServer session` (process-level map).
  - **`subscribe` / `unsubscribe`** tools — explicit opt-in to a channel's pushes
    (R-chosen targeting model: pushes go ONLY to subscribers, not a broadcast).
  - `send_message` ALSO pushes `notifications/claude/channel` to the live sessions of
    instances **subscribed to that channel** (minus the sender). Best-effort; a push
    failure never breaks the send.
  - cleanup removes the instance from sessions + all subscriptions on disconnect.
- Verified end-to-end (SDK clients, through `mcp-remote`, and a live two-Claude demo on
  prod). Existing test suites stay green with the flag on or off.

## Using it as a Claude Code client — three doors, same backend

Channels require: (a) first-party Anthropic, (b) org policy `channelsEnabled: true`,
(c) the channel loaded for the session.

- **Dev-flag door (works today, one flag):**
  `claude --dangerously-load-development-channels server:cross-claude`
  (your hand-configured `cross-claude` MCP server). Choose "1. local development" at the
  warning. NOTE: pass ONLY the dev flag for a `server:` channel — do NOT also pass
  `--channels server:cross-claude` (a duplicate entry makes CC's gate skip it).
- **Plugin door (no flag, once allowlisted):** the `cross-claude` plugin (local
  marketplace `cross-claude-local`; its MCP server is named `cross-claude-channel` to
  avoid colliding with the global `cross-claude` server). Launch
  `claude --channels plugin:cross-claude@cross-claude-local` with NO dev flag — but only
  AFTER the org admin adds it to `allowedChannelPlugins` (see Admin below). Until then it
  shows "not on the approved channels allowlist".

Then in-session: `register` + `subscribe(channel)` → you receive live pushes for that
channel; reply via `send_message`.

- **Bridge door (durable, channel-less — added 2026-07-14, made channel-less 2026-07-18):**
  `bridge/cross-claude-bridge.mjs` is a local stdio MCP server that PUSHES
  `notifications/claude/channel` by polling the REST API
  (`GET /api/messages/:channel?after_id=N`, 5s default). Trade-offs vs the push doors:
  + survives server redeploys (DB-backed, not in-memory session maps)
  + delivers ALL messages, including REST-API sends that never trigger native push
  + delivery is chosen LIVE, mid-session (see below) — no longer launch-only
  − ~5s latency; one node poll loop per listening channel
  Don't combine with a push door on the same channel in the same session (double delivery).
  When launched via `cc-listen`, it exports `CC_LISTEN_CHANNEL`, which the
  `cross-claude-listening-gate.py` Stop hook reads to stand down (a delivery claim there is true).
  Echo caveat: the bridge suppresses your own sends only when its `BRIDGE_INSTANCE`
  matches the instance_id the session actually registers/sends with — mismatch =
  you receive your own messages back (harmless, verified 2026-07-14).

  **Mid-session control tools (channel-less bridge).** The bridge starts idle (no channel)
  and exposes three tools so a session turns delivery on/off live, without relaunching:
  - `listen_live(channel)` — start a push loop for `channel` (real live listening from now on;
    call again for more channels — multiple run at once).
  - `stop_listening(channel)` — stop that channel's push loop.
  - `delivery_status()` — best-effort report of which channels are live-pushing vs poll-only.
    It reports what the bridge has *running*, not proof of end-to-end delivery, and does not
    know about a session's own backgrounded `wait_for_reply` (only that session does).

  `cc-listen <channel> [instance]` still works: it sets `BRIDGE_CHANNEL` + `BRIDGE_AUTOSTART=1`
  so the bridge auto-starts that one channel at launch (sugar over the channel-less core).

## First-party under ccx

Channels are first-party-Anthropic only. ccx routes the session via the broker
(`ANTHROPIC_BASE_URL`), which CC would otherwise read as non-first-party. ccx therefore
exports `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` for Anthropic mains (shipped in
`claude-optimization/ccx/ccx.{bash,zsh}`), so channels work under ccx.

## Spawning channel collaborators (optimizer-side)

`claude-optimization/scripts/spawn-collaborator` spawns a governed peer Claude wired to a
channel: bounded TTL + PID/kill + depth=1 (no recursive spawn) + concurrency cap, launcher-
agnostic `spawn_command` (default `claude`). Peers run DIRECT to Anthropic (the wrapper
strips inherited `ANTHROPIC_BASE_URL`) — this both dodges a proxy bug and makes them
natively first-party. Send-only by default; `--listen` loads the channel for receive.

**`--project DIR` — the cross-project specialist.** Launch the peer with another project's
directory as cwd and it inherits THAT project's CLAUDE.md, memory, MCP servers, skills, and
hooks — a genuine specialist in a *different* project, which a same-project subagent
structurally cannot be. This is the primary advantage of spawning a peer over a subagent:
orchestrate from one project, stand up an expert in another, and have it report back live
over the channel. Without `--project`, the peer inherits the spawner's own cwd.

Peers launch with `--settings '{"enableAllProjectMcpServers":true}'`, so they auto-trust and
can CALL the target project's `.mcp.json` servers (not merely enumerate them). This is a
per-launch flag scoped to spawned peers ONLY — it edits no project file and does not loosen
interactive sessions (which keep manual MCP-server approval). The trust is intentional per
spawn: the `--project` target is chosen deliberately and the peer is bounded (TTL, depth=1).

## Admin: enabling the no-flag plugin (`allowedChannelPlugins`)

`allowedChannelPlugins` is **org policy, set server-side ONLY** — read from the remote-fetched
`policySettings`, NEVER from a local file. A local `managed-settings.json` edit (whether via
`CLAUDE_CODE_MANAGED_SETTINGS_PATH` or `/Library/Application Support/ClaudeCode/managed-settings.json`)
is NOT honored — both were tested and ruled out; the banner stays "not on the approved
channels allowlist". (Binary confirms: settings that ARE file-settable, e.g.
`strictKnownMarketplaces`, say so explicitly; `allowedChannelPlugins` does not.)

**CONFIRMED WORKING 2026-06-13.** The org owner/admin sets it in the Anthropic admin console:

> **claude.ai → Settings → Organization → Products → Claude Code → "Managed settings
> (settings.json)" → Manage** — edit the JSON, Save. (Same Claude Code panel that holds the
> **Channels [Preview]** toggle, which must also be on.)

Paste this exact object (merging with whatever is already there):

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "plugin": "cross-claude", "marketplace": "cross-claude-local" }
  ]
}
```

After Save, members **relaunch** CC and the plugin channel works with NO dev flag:
`claude --channels plugin:cross-claude@cross-claude-local` (under ccx, same flag). R verified
this end-to-end on 2026-06-13: with the object in the console, the allowlist banner is gone
and the plugin channel loads clean.

## Caveats / findings

- The optimizer routing-proxy/broker mangles a headless `claude -p` into a
  `400 empty-content-block` — spawned peers run direct to avoid it. Not a channels issue,
  but a real optimizer bug worth a dedicated fix if headless-claude-through-broker is wanted.
- A channel push arriving at an idle CC session auto-wakes a turn (no polling). Each push =
  one receiver turn (tokens) — explicit-subscribe targeting bounds the fan-out.
- **Native-push fragility (confirmed 2026-07-14):** `subscribe` registrations live in the
  server process's memory. Every Railway redeploy/restart silently drops ALL subscriptions —
  receivers stay "subscribed" in their own belief but receive nothing until they re-subscribe
  over a fresh connection. The bridge door is immune (DB poll).
- **REST sends don't push (2026-07-14):** `POST /api/messages` writes straight to the DB
  (`rest-api.mjs`) and never runs the `send_message` tool's push loop (`tools.mjs`). Native-push
  subscribers never hear REST-originated messages; bridge listeners do.
- **Re-verified on CC 2.1.210 (2026-07-14):** both the dev-flag native door and the bridge
  door wake an idle session; `--mcp-config` works as the channel's server source, but
  `--strict-mcp-config` breaks `server:` name resolution — omit strict.
