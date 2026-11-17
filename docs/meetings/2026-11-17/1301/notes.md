# Cross-claude bridge onboarding, R + Stephanie, Nov 17 2026
<!-- AI_PROSE_PATTERN_GATE=off : fixed notes template, see `meeting-aide notes-check` -->

2026-11-17 13:01 · participant mode

## Notes

- Kestrel drove the setup by Slack DM and voice. Security-guard handled the 1Password note, the server keys and the trust side.
- Stephanie had Node 24.13.0 and git 2.50.1, and no bridge clone or key yet.
- She has a cross-claude-local server that she uses. It stays.
- She removed the old claude.ai Cross-Claude connector. It no longer shows in /mcp.
- Clone pinned to 5c86cd5. npm ci added 157 packages and reported 2 moderate advisories.
- New key stephanie-mac was created. Key files are owner-only (rw-------).
- The SYB Bot DM does not accept replies, so Stephanie sent her key lines to R in Slack and R copied them for Kestrel. Pubkey sha8 is f95648f5 and bearer sha8 is a803d590.
- R unlocked 1Password so security-guard could sign in.
- Security-guard created the note "bridge-key stephanie-mac" in "Bridge keys: Stephanie".
- Security-guard added stephanie-mac to the server keys, scoped to team-syb with prefix stephanie. Deploy 52876eb9 succeeded.
- Stephanie was trusted on the laptop and hive.
- A terminal check against the 1Password note printed MATCH. Two earlier tries failed because placeholder letters were left in the command.
- R's 4 Claude ids are now trusted as teammates on team-syb only.
- Guard selftest passed 4/4. The guard was wired into settings.json, which was backed up to settings.json.bak. A wired-deny proof returned permissionDecision deny with empty stderr.
- teammate-mcp.json was written. Claude 2.1.288 was launched with the bridge in debug mode.
- /mcp shows cross-claude-bridge with 6 tools. /hooks lists the guard under PreToolUse.
- Hello was sent as #5737 to team-syb. Security-guard verified AUTH OK for key stephanie-mac and a valid signature.
- The #general out-of-scope test was skipped, because on 5c86cd5 it blocks all live push (the bug seen on Santi's call).
- Stephanie was told by DM to always launch Claude with the bridge command and not to listen on #general for now.
- R said they will not use the bridge today, but it will help in their Gorgias sessions going forward.

## Summary

R and Stephanie connected Stephanie's Mac to the cross-claude bridge on a live call. Kestrel guided each step by Slack DM and voice, and security-guard ran the trust side. Stephanie got a new key, and security-guard put it in 1Password, added it to the server and trusted it. Her hello reached team-syb with a verified signature, and the guard is proven to block credential tools in teammate turns. The #general test was skipped because of the known bug on the pinned version.

## Decisions

- Stephanie stays pinned to 5c86cd5 until the listen_live fix ships.
- Skip the #general out-of-scope test for Stephanie, because the bug was already proven on Santi's call.
- Keep Stephanie's cross-claude-local server.

## Action items

- Claude: fix the bridge so a channel refused with 403 is dropped and reported.
- Claude: re-pin Stephanie and Santi to the fixed SHA once it ships, and DM Stephanie the update.
- Someone: allow replies to the SYB Bot DM so teammates can paste back into it.

## Open questions

- No R bridge is running, so a live round trip to R's sessions is still untested.
