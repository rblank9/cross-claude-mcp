# Teammate onboarding (macOS)

These steps connect a teammate's Claude Code to R's Claude on the shared `team-syb` channel. The trust model is in `docs/plans/teammate-channels.md`, and security-guard runs the trust side. Slack carries only these instructions, never key material. Windows doesn't work yet, so Vicky waits until it's proven.

You need macOS with `git` and Node.js 22 or newer, Claude Code signed in with your full claude.ai account (the startup banner shows your Claude plan, not "API Usage Billing"), and your own 1Password account with access to the vault "Bridge keys: <your name>". security-guard creates that vault with only you and R in it.

1. Get the bridge at the exact commit R names in Slack:
   ```bash
   git clone https://github.com/rblank9/cross-claude-mcp.git ~/cross-claude-mcp
   cd ~/cross-claude-mcp
   git checkout <COMMIT_SHA_FROM_R>
   git rev-parse HEAD
   npm ci
   ```
   `git rev-parse HEAD` has to print exactly R's SHA. If it doesn't, stop and tell R by voice or in person, not in the same Slack thread.

2. Make your key. The private half never leaves your Mac:
   ```bash
   node bridge/cc-bridge-keys.mjs init --identity <yourname>-mac
   ```
   It prints your identity, your public key, and your bearer's sha256. The private key and the bearer itself stay in `~/.config/cross-claude/`. Never copy anything out of that folder.

3. From your own 1Password account, in your vault, create one Secure Note titled `bridge-key <yourname>-mac` with exactly three fields: `identity` (`<yourname>-mac`), `pubkey` (the public key from step 2), and `bearer_sha256` (the 64-character sha256 from step 2). Put nothing else in it: no bearer, no private key, no file contents. An item with anything extra gets rejected, and you'd re-run step 2 with `--force`. Tell R it's there. security-guard checks who created it and that nothing secret is in it, then adds you to the server, limited to `team-syb`.

4. security-guard puts R's public keys into the same vault, in an item created by R's account. Check that R created it, then trust each key:
   ```bash
   node bridge/cc-bridge-keys.mjs trust <R_KEY_ID> <R_PUBKEY> --teammate --channels team-syb
   ```

5. Save this as `~/cross-claude-mcp/teammate-mcp.json`, with your Mac username and name filled in:
   ```json
   {"mcpServers":{"cross-claude-bridge":{"command":"node","args":["/Users/<you>/cross-claude-mcp/bridge/cross-claude-bridge.mjs"],"env":{"BRIDGE_IDENTITY":"<yourname>-mac","BRIDGE_INSTANCE":"<yourname>-mac","BRIDGE_CHANNEL":"team-syb","BRIDGE_NO_INBOX":"1"}}}}
   ```
   Then start Claude from the project you want connected, and press Enter at "I am using this for local development":
   ```bash
   claude --mcp-config ~/cross-claude-mcp/teammate-mcp.json --dangerously-load-development-channels server:cross-claude-bridge
   ```
   Keep `BRIDGE_NO_INBOX` at 1. Without it, the bridge asks for a private inbox your key can't read, and the server refuses the whole connection. The instance name has to start with `<yourname>-`, and `team-syb` is the only channel your key can use.

6. Ask your Claude to send `hello from <yourname>` to `#team-syb`. R's Claude sees it labeled TEAMMATE <yourname>-mac.
