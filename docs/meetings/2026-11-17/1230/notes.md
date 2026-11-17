# Cross-claude bridge onboarding, R + Santi, Nov 17 2026
<!-- AI_PROSE_PATTERN_GATE=off : fixed notes template, see `meeting-aide notes-check` -->

2026-11-17 12:30 · participant mode

## Notes

- Santi's existing key files santi-mac.pem and santi-mac.pub were present, so no re-init. His machine printed pubkey sha8 3d6e4359 and bearer sha8 ab3f6451. Both match the security-guard reference.
- Santi's 1Password item "bridge-key santi-mac" already exists, created by Santi on Nov 4. No new note was needed.
- Clone re-pinned from 99b19d6 to 5c86cd5. npm ci added 157 packages and reported 2 moderate advisories.
- Key files are owner-only (rw-------).
- Security-guard built the trust command. R's 4 Claude ids are now trusted as teammates on team-syb only.
- Guard selftest passed 4/4. The guard was already wired in settings.json. A wired-deny proof returned permissionDecision deny with empty stderr.
- The old cross-claude server (needs authentication) was found in /mcp and removed.
- teammate-mcp.json was rewritten and parses. Claude was launched with the bridge config in debug mode.
- Hello sent as #5736 to team-syb. Security-guard verified AUTH OK for key santi-mac and a valid signature.
- The listen on #general was refused by the server with 403 out_of_scope, and nothing was delivered. The bridge falsely said Live push ON. It kept retrying, which blocked his team-syb push too.
- Santi stopped listening on #general. Security-guard confirmed his next stream was clean and holding.
- Santi has an older Bash credential hook that returns an invalid decision value. It prints a hook error on each Bash call but blocks nothing.
- R told Santi SYB data will be reconnected soon, not today.
- R asked Santi to put test plan feedback on the ticket.

## Summary

R and Santi connected Santi's Mac to the cross-claude bridge on a live call, with security-guard checking the trust side. Santi's existing key was verified by hash, his clone was moved to the 5c86cd5 fix, and R's Claudes were trusted on team-syb only. The guard was proven to deny credential tools in teammate turns. His hello reached team-syb with a verified signature, and the server refused #general as designed. The call exposed that the bridge bug is worse than cosmetic: a refused channel blocks all live push until it is stopped.

## Decisions

- Santi keeps his existing santi-mac key. No re-init and no KEYS change.
- Santi stays pinned to 5c86cd5 until the listen_live fix ships.

## Action items

- Claude: fix the bridge so a channel refused with 403 is dropped and reported, not retried while claiming Live push ON.
- Claude: re-pin Santi to the fixed SHA once it ships.
- Someone: fix Santi's old Bash credential hook so it returns a valid decision.
- Someone: review the 2 moderate npm advisories on the 5c86cd5 lockfile.
- R: reconnect SYB data for Santi, soon.
- Santi: put test plan feedback on the ticket.

## Open questions

- No R bridge is running, so a live round trip to R's sessions is still untested.
