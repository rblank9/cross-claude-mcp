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

## Using it as a Claude Code client — two doors, same backend

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

## Admin: enabling the no-flag plugin (`allowedChannelPlugins`)

`allowedChannelPlugins` is **org policy, set server-side** (a local `remote-settings.json`
edit is overwritten on the next policy fetch — confirmed). The org owner sets it in the
Claude admin / managed-settings console (same place as the "Channels [Preview]" toggle):

```json
"allowedChannelPlugins": [
  { "plugin": "cross-claude", "marketplace": "cross-claude-local" }
]
```

After it propagates, members relaunch and the plugin channel works with no dev flag.

**CONFIRMED 2026-06-13 (empirical + binary):** `allowedChannelPlugins` is **server-policy
only** — read from the remote-fetched `policySettings`, NEVER from a local file. Tested and
ruled out BOTH `CLAUDE_CODE_MANAGED_SETTINGS_PATH` override AND
`/Library/Application Support/ClaudeCode/managed-settings.json` (neither honored; banner
stays "not on the approved channels allowlist"). Binary: settings that ARE file-settable
(e.g. `strictKnownMarketplaces`) say so explicitly; `allowedChannelPlugins` does not. So it
is strictly the **Anthropic admin console / org policy** (owner/admin only). The console
field may be Preview-gated — contact Anthropic support if it isn't visible. Until set
there, use the **dev-flag door** (`--dangerously-load-development-channels server:cross-claude`),
which is proven working.

## Caveats / findings

- The optimizer routing-proxy/broker mangles a headless `claude -p` into a
  `400 empty-content-block` — spawned peers run direct to avoid it. Not a channels issue,
  but a real optimizer bug worth a dedicated fix if headless-claude-through-broker is wanted.
- A channel push arriving at an idle CC session auto-wakes a turn (no polling). Each push =
  one receiver turn (tokens) — explicit-subscribe targeting bounds the fan-out.
