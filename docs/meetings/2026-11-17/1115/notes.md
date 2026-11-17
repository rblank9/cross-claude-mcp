# Cross-claude bridge onboarding, R + Vicky, Nov 17 2026
<!-- AI_PROSE_PATTERN_GATE=off : fixed notes template, see `meeting-aide notes-check` -->

2026-11-17 11:12 to 12:03 EST · participant mode. The first 3 minutes are in ../1112.

## Notes

- Goal: connect Vicky's Claude Code on his Windows PC to the new cross-claude bridge and test it. Vicky is the first teammate on the new setup. Santi and Stephanie (Mac) come later.
- The old setup was dead. A user-scope cross-claude entry used the legacy shared api_key, which was retired 11-07, and a claude.ai Cross Claude connector asked for an invite code. Both were removed.
- The old api_key URL showed on the recorded screen share. Security-guard confirmed the key was already rejected by the server, so nothing needed rotating.
- Vicky cloned the repo and pinned it to 168fc5c, then to 5c86cd5, which has the Windows bridge fixes pushed during the call (88 of 88 bridge tests pass).
- His key is vicky-pc. Init worked on Windows. The key folder had extra Windows permissions (CodexSandboxUsers and an unknown account). They were locked down to Vicky, SYSTEM and Administrators. No Codex had run, so the keys were kept.
- Security-guard created the 1Password note for Vicky on R's instruction. Vicky's Claude confirmed the pubkey MATCH. Security-guard added vicky-pc to the server, limited to team-syb (deploy eb1999c5).
- Vicky trusted R's 4 keys. The guard selftest passed 4/4, the guard hook was wired, and a test run of the exact wired command returned deny.
- The bridge connected with 6 tools. Hello posted as #5735 in team-syb. Security-guard verified Vicky's key and signature.
- Out-of-scope test: the server refused #general with 403 four times, so the boundary held. Bug: the bridge still told Vicky "Live push ON for #general". R said to log it and fix it after the call.
- No bridge of R's is running right now, so no R session got the hello live.
- After the call, a guard fix was pushed (1cc35ac): the guard now warns visibly when it can't read the transcript, and it handles Windows paths and BOM files. Security-guard wants two more items before approval.
- End of call: R said ad changes are on hold for two weeks. Vicky can think about asset experiments. R will get Vicky access to the Ads Expert dashboard and will consolidate ads tools into one shared agent. Early Black Friday day one matched last year's order count.

## Summary

R and Vicky got Vicky's Claude Code on Windows connected to the new cross-claude bridge, with Claude guiding each step and security-guard checking the trust side. The old shared-key connection was removed. Vicky got his own key, locked down on disk and registered on the server for team-syb only. His hello message arrived and was verified as signed by him. The server correctly blocked his attempt to read another channel. The bridge falsely reported that attempt as a success, and R deferred that fix until after the call. Steph and Santi wait for the fix.

## Decisions

- Security-guard may create a teammate's 1Password key note and share it, instead of the teammate doing it.
- Vicky stays connected, limited to team-syb.
- The bridge out-of-scope bug gets fixed after the call. Steph and Santi are not connected until it is fixed.
- Ad changes are on hold for the next two weeks.

## Action items

- Claude: fix the bridge so listen_live refuses channels outside the teammate's scope and reports a 403 as an error
- Claude: finish the guard follow-ups security-guard asked for, then send the final version to security-guard
- Security-guard: update the copy of the guard in claude-optimization once the guard fix is approved
- Vicky: switch to the final version, then check /hooks and a debug run
- R: give Vicky access to the Ads Expert dashboard
- R: consolidate the ads tools into one shared agent over the next two weeks
- R: connect Steph and Santi using docs/teammate-live-session-mac.md once the bug is fixed

## Open questions

- Should one of R's sessions run a bridge all the time, so teammate messages arrive live?
- Santi's bridge has been silent since 11-05. Is his local setup still intact?
