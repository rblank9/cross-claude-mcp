# Live onboarding session: Mac teammates (Santi, Stephanie)

This is the runbook for a live Zoom call where R onboards a Mac teammate with Claude (Kestrel, /listen participant) driving. It was distilled from Vicky's Windows session on 2026-11-17 (notes: docs/meetings/2026-11-17/1115/). docs/teammate-onboarding.md is the underlying procedure. This file is how to run it live.

**Gate:** don't run this until the post-call fix queue is closed: the bridge listen_live scope fix plus the guard follow-ups (memory `post-call-fix-queue-2026-11-17`). Pin the teammate to the SHA that contains those fixes. Call it `<PIN>` below, and fill it in from `git rev-parse origin/main` once security-guard has approved it.

## Before the call (Claude)

- Spawn or reach `security-guard` (cc-peers, then `spawnctl spawn --cwd ~/Projects/security-guard`). It owns the 1P note check, KEYS/SCOPES, the redeploy, and trusting the teammate on the laptop and hive.
- Start `/listen participant --screen` and ask the teammate to share their screen. Keep spoken replies to one short sentence.
- Put every command on R's clipboard with `pbcopy`. R forwards it in Slack **inside a code block**, because Slack turns straight quotes into curly ones and breaks commands. Write commands with no quotes where possible.
- Teammate types `!` + paste for shell commands, or pastes plain prompts with no `!`.
- **Santi already has a server identity** (`santi-mac`, team-syb, added 11-04). His bridge has been silent since 11-05. Check whether he already has `~/.config/cross-claude/identity/santi-mac.*`. If he does, skip init and the 1P note, and re-pin plus relaunch only (steps 1-2, then 6-12). **Stephanie** runs every step.

## Santi fast path (R decided 2026-11-17: connect now, pin 5c86cd5, before the listen_live fix)

`<PIN>` = `5c86cd5ac4c6cccf0389c9e2ec65e6821add39cf` for this session. Re-pin to the fixed SHA later; that's one command.

The server side is already done (security-guard verified it 2026-11-17): `santi-mac` is in CROSS_CLAUDE_KEYS, scoped `{"channels":["team-syb"],"instance_prefix":"santi"}`, and trusted on the laptop and hive. He was onboarded from the 11-04 Slack instructions (pin 99b19d6). He last authenticated 11-05.

1. Step 0 (remove any old cross-claude/connector), then probe what he already has: `ls ~/cross-claude-mcp ~/.config/cross-claude/identity; cd ~/cross-claude-mcp && git rev-parse HEAD; node bridge/cc-bridge-keys.mjs list`
2. If `santi-mac.pem`/`.pub` exist: SKIP steps 3 and 5. **Never** re-run init, because that would change his key and break the server entry. Run `node bridge/cc-bridge-keys.mjs show --identity santi-mac` and have security-guard confirm the pubkey and bearer_sha256 still match the svc item.
3. Re-pin (step 2 with `<PIN>` and `npm ci`). Run step 4 (perms). If `list` doesn't show R's 4 ids as `teammate: team-syb`, run step 6.
4. Steps 7-12: selftest, guard wired (check ~/.claude/settings.json; add it if missing), wired-deny proof, teammate-mcp.json, launch, hello.
5. Step 13 will still show the known bug (a false "Live push ON"). Security-guard checks the log for the 403. Logged; not a blocker.
6. If his key files are missing, run the full Stephanie path (steps 3-5). Security-guard must replace santi-mac's KEYS entry, so warn it first.

## Steps (one per turn, verify each on screen before the next)

| # | What | Clipboard | Pass when |
|---|---|---|---|
| 0 | Remove old cross-claude | `claude mcp remove cross-claude -s user` (only if /mcp lists it). Also delete any claude.ai "Cross Claude" connector in claude.ai > Customize. | /mcp shows no `cross-claude` with `?api_key`. That URL leaks a key on screen, but the legacy key has been dead since 11-07. |
| 1 | Prereqs | `node --version; git --version` | Node ≥ 22 |
| 2 | Clone / re-pin | `git clone https://github.com/rblank9/cross-claude-mcp.git ~/cross-claude-mcp; cd ~/cross-claude-mcp && git fetch origin && git checkout <PIN> && git rev-parse HEAD && npm ci` | HEAD prints exactly `<PIN>`, and npm shows "added N packages" |
| 3 | Key | `cd ~/cross-claude-mcp && node bridge/cc-bridge-keys.mjs init --identity <name>-mac` | id, pubkey and bearer_sha256 printed |
| 4 | Perms (Mac) | `ls -l ~/.config/cross-claude/identity ~/.config/cross-claude/bearer` | `.pem` and `.token` show `-rw-------` (owner only). There's no ACL step on Mac. |
| 5 | 1P note | security-guard creates `bridge-key <name>-mac` (identity, pubkey, bearer_sha256) in "Bridge keys: <Name>", shares it, and DMs the teammate (R override 2026-11-17). Then a plain prompt: "Compare this pubkey character for character against ~/.config/cross-claude/identity/<name>-mac.pub. Answer only MATCH or NO MATCH: " + the pubkey **copied from the 1P field**. | MATCH. Never trust a screenshot read: d vs D bit us. SG then adds KEYS/SCOPES, redeploys, and trusts the teammate. Wait for its "deploy up". |
| 6 | Trust R | Build it from the live `~/.config/cross-claude/trusted_keys.json` (python, see below) | `list` shows 4 R ids `(teammate: team-syb)` |
| 7 | Guard selftest | `cd ~/cross-claude-mcp && python3 hooks/teammate-guard-selftest.py` | `SELFTEST: 4/4 passed` + `OK: no ... fail-open` |
| 8 | Wire guard | Plain prompt: add `{"matcher":"*","hooks":[{"type":"command","command":"python3 /Users/<u>/cross-claude-mcp/hooks/teammate-turn-guard.py"}]}` to the PreToolUse hooks in ~/.claude/settings.json, keeping existing entries, and show the section | Straight quotes, file parses |
| 9 | Prove wired deny | Plain prompt: run the EXACT settings.json command with the selftest "teammate message denies op read" fixture on stdin, and show stdout, stderr and the exit code | `"permissionDecision": "deny"`, empty stderr |
| 10 | Bridge config | Plain prompt: create ~/cross-claude-mcp/teammate-mcp.json = `{"mcpServers":{"cross-claude-bridge":{"command":"node","args":["/Users/<u>/cross-claude-mcp/bridge/cross-claude-bridge.mjs"],"env":{"BRIDGE_IDENTITY":"<name>-mac","BRIDGE_INSTANCE":"<name>-mac","BRIDGE_CHANNEL":"team-syb","BRIDGE_NO_INBOX":"1"}}}}` | Parses. Tell the teammate NOT to `claude mcp add` it. |
| 11 | Launch | `/exit`, then `claude --debug --mcp-config ~/cross-claude-mcp/teammate-mcp.json --dangerously-load-development-channels server:cross-claude-bridge`, then press Enter at the local-dev prompt | `/mcp` shows cross-claude-bridge ✓ with 6 tools. `/hooks` lists the guard under PreToolUse. The debug log has no "transcript unreadable" line. |
| 12 | Hello | Plain prompt: send "hello from <name>" to channel team-syb and show the tool result | "Sent #N to #team-syb". SG confirms AUTH OK key:<name>-mac and a signature ok. |
| 13 | Out-of-scope | Plain prompt: try to listen on channel general and report the exact result | The bridge REFUSES (after the fix). SG sees 403 out_of_scope in the log. |
| 14 | Live round trip | Start one R bridge session (none were running on 11-17) and confirm R's Claude receives the hello as TEAMMATE | R's session shows the message |

Step 6 command builder (run on R's laptop; public keys only):
```bash
cd ~/.config/cross-claude && python3 -c "import json,subprocess;d=json.load(open('trusted_keys.json'));ids=['rs-macbook-air-claude','rs-macbook-air-claude-account2','rs-macbook-air-claude-account3','hive-claude'];pk=lambda v:v['pub'] if isinstance(v,dict) else v;subprocess.run(['pbcopy'],input=('cd ~/cross-claude-mcp && '+' && '.join(f'node bridge/cc-bridge-keys.mjs trust {i} {pk(d[i])} --teammate --channels team-syb' for i in ids)+' && node bridge/cc-bridge-keys.mjs list').encode())"
```

## Things the teammate's Claude will suggest that they should decline

- "Re-add cross-claude" or "point .claude.json at the local clone" / `claude mcp add`. The bridge only runs from `--mcp-config`.
- Re-running `npm ci` after a bridge-only re-pin isn't needed, and it's harmless.
