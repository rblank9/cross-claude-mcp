# Wait-Transport Cap Investigation

**Status**: COMPLETED  
**Evidence Level**: SOURCED + INFERRED (one piece remains undocumented)  
**Investigation Date**: 2026-07-19

## Executive Summary

The ~30-min (1829s) abort of `wait_for_reply` originates from **Claude Code's maximum duration cap on backgrounded MCP tool calls** — an absolute ~30-minute hard limit, NOT an idle timeout. The 30s keepalive does not prevent it because the limit is duration-based, not idle-based. The observed 1829s abort is consistent with this cap and represents a client-side disconnection (severed HTTP request) before the app can return gracefully.

**Verdict on cap source**: Claude Code client limit (**HIGH CONFIDENCE**)  
**Is 25 min safe?**: Yes; 5-min margin under observed 1829s (**SAFE**)  
**Chunk-and-renew recommendation**: **Keep client rejoin as-is** — server-side chunk-and-renew cannot help if the client is aborting the request (**see rationale below**)

---

## AUTHORITATIVE CORRECTION (2026-07-19, added on review)

The executive summary above was directionally right (client-side, ~30 min, keepalive did not
save it) but **wrong on mechanism**. Verified against official docs
(https://code.claude.com/docs/en/mcp.md, §"Automatic backgrounding / per-server timeout / idle
timeout") **and** the actual client config, the real picture is:

1. **It is an IDLE timeout, not an absolute-duration cap.** Claude Code's `MCP_TOOL_TIMEOUT`
   wall-clock default is ~28h (far above 30 min). The relevant knob is
   **`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`**, whose default is **5 min for HTTP/SSE servers** and
   **30 min for stdio servers**. It aborts when neither a response nor a progress notification
   arrives within the window. **This timeout IS configurable** — it is not immovable.

2. **cross-claude is a STDIO server to Claude Code — confirmed, not inferred.** The client
   `~/.claude.json` connects it via `npx -y mcp-remote https://…/mcp` (a local stdio bridge to the
   remote HTTP endpoint). So Claude Code applies the **stdio 30-min idle default**. 1829s ≈ 30.5 min
   matches this almost exactly. This is the source — decisively, without any empirical test.

3. **The real defect: our 30s keepalive is NOT resetting that idle timer.** If it were, the wait
   would live to the ~28h wall-clock. It died at the 30-min idle window instead. Leading hypotheses
   (need one test to choose): (a) `mcp-remote` does not forward `notifications/progress` over stdio
   in a form Claude Code counts as activity; or (b) our `sendKeepalive` only emits a true
   `notifications/progress` when the client supplied a `progressToken`, else falls back to
   `notifications/message` (a log) — which may not count as idle-reset activity (tools.mjs ~419-433).

**Consequences for the recommendations below:** the "absolute duration cap / keepalive-immune /
chunk-and-renew impossible" framing is superseded. The 25-min clamp + rejoin remains a correct,
robust *floor* (works for every consumer regardless of transport/version). But a genuine root fix
may exist: make the keepalive reset the idle timer (server-side, fix (b)), or raise
`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (consumer-side, not distributable). Ruled out earlier by their
known values: Railway (15-min active / 5-min idle), Node `requestTimeout` (300s), Cloudflare (100s).

---

## Ranked Candidate Analysis

### 1. Claude Code Backgrounded MCP Tool Call Timeout (**PRIMARY SUSPECT — HIGH CONFIDENCE**)

**Evidence**:
- Web search results from Claude Code docs / issues reference a **"30-minute" server-side timeout** for claude-code-mcp (issue #47076, timeout guides).
- Claude Code auto-backgrounds MCP calls after ~120s (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`); once backgrounded, the client continues polling the MCP server for results.
- A backgrounded tool call that exceeds ~30 minutes is terminated **by the Claude Code client**, severing the HTTP request from above — this matches the "ABORTED at 1829s" field report exactly (an abort = client-initiated disconnect, NOT a graceful server return).
- The 30s keepalive **cannot prevent** an absolute duration cap — keepalives reset IDLE timeouts, not maximum-duration caps. The fact that the keepalive is sending (and not preventing the abort) is diagnostic: **this is a hard max-duration limit, not idle-based**.
- 1829s ≈ 30.48 minutes, consistent with a ~30-min hardcoded ceiling.
- **Why it appears as an abort, not a graceful return**: Claude Code client kills the HTTP request when its internal backgrounded-call timeout fires; the server never reaches the line `if (Date.now() >= hardDeadline)` in the wait loop (tools.mjs:607) that would return a clean "ceiling hit" message.

**Source Documentation**:
- [Claude Code MCP Tool Timeout Issue #47076](https://github.com/anthropics/claude-code/issues/47076) — mentions 30-minute timeout configuration
- [Auto-background long-running MCP tool calls Issue #23611](https://github.com/anthropics/claude-code/issues/23611) — documents the 120s backgrounding threshold and mentions backgrounded calls
- CLAUDE.md (global rules, cross-claude protocol): `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` confirmed; full backgrounding semantics documented

**Confidence**: **HIGH** (matches observed behavior precisely; explain the "abort" vs "return" distinction)

---

### 2. Railway's Public Networking "Active Data Transfer" Limit (15 min) — RULED OUT

**Spec** (from [Railway Specs & Limits](https://docs.railway.com/networking/public-networking/specs-and-limits)):
- **Active data transfer** (keep-alive protected): up to **15 minutes**
- **Idle timeout** (no data): 5 minutes

**Why it doesn't match**:
- 15 minutes = 900 seconds
- Observed abort: 1829 seconds ≈ 30.5 minutes
- 1829s > 900s, so Railway's limit would fire first — **but it doesn't match the observed value**.
- The 30s keepalive IS transferring data (sending progress notifications), so it should fall under "active" and be protected up to 15 min. The fact that it aborts at 30+ min suggests a different cap.

**Verdict**: RULED OUT — the observed 1829s exceeds Railway's 15-min limit.

---

### 3. Node.js http.Server requestTimeout Default (5 min) — RULED OUT

**Default** (Node 18+, [Node.js HTTP Docs](https://nodejs.org/api/http.html)):
- `server.requestTimeout` = 300 seconds (5 minutes)
- `server.headersTimeout` = min(60s, requestTimeout) = 60 seconds

**Why it doesn't match**:
- server.mjs does NOT explicitly set these timeouts; Node defaults apply.
- 300s = 5 minutes
- Observed abort: 1829s ≈ 30.5 minutes
- 1829s >> 300s, so this cannot be the source.

**Verdict**: RULED OUT — Node's 5-min default would fire at 300s, not 1829s.

---

### 4. Cloudflare Edge Proxy Timeout (100s) — NOT IN FRONT

**Spec** (from [Cloudflare Connection Limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)):
- Default: **100 seconds** (free/pro)
- Enterprise: up to 6000 seconds

**Why it doesn't apply**:
- Cloudflare is NOT in front of the production Railway domain (`cross-claude-mcp-production.up.railway.app`). If it were, it would be configured in Railway's UI or Procfile; no evidence of that exists in the repo.
- 100s < 1829s, so it would fire first anyway.

**Verdict**: NOT APPLICABLE — no Cloudflare in front of the deployed server.

---

### 5. MCP SDK StreamableHTTPServerTransport Timeout — UNDOCUMENTED

**Search results**:
- The TypeScript MCP SDK's `StreamableHTTPServerTransport` does not appear to have a documented hard timeout in public docs or the issue tracker.
- Python FastMCP allows configurable `session_timeout`, but the TypeScript SDK does not expose this.

**Why it's unlikely to be the sole source**:
- If the transport had a 30-min timeout, it would be configurable or documented (following pattern from Python SDK).
- The fact that it's not mentioned in any Claude Code docs suggests the timeout originates upstream (Claude Code client).

**Verdict**: UNLIKELY — no configuration path visible; likely not the direct source, though the client's timeout may be expressed as a request cancellation to the transport.

---

## Keepalive Analysis: Does It Actually Prevent the Timeout?

**Current implementation** (tools.mjs:387–446):
```javascript
const KEEPALIVE_INTERVAL_MS = 30_000;  // 30 seconds
async function sendKeepalive() {
  if (!extra?.sendNotification) return;
  // Sends notifications/progress or notifications/message every 30s
  await extra.sendNotification({ ... });
  lastKeepalive = Date.now();
}
```

**Call site** (tools.mjs:548):
```javascript
if (Date.now() - lastKeepalive >= KEEPALIVE_INTERVAL_MS) {
  await sendKeepalive();
}
```

**Question**: Does the keepalive byte actually go out on the wire, and does it reset the relevant timer?

**Answer**: 
- **Yes, the keepalive notification is sent** (no guards against SSE/HTTP connection state; `extra.sendNotification` is a first-class MCP capability).
- **If the limit is IDLE-based**: the keepalive byte would reset the clock, and the wait should survive indefinitely (until the hard deadline from `max_wait_minutes`).
- **If the limit is ABSOLUTE DURATION**: the keepalive byte is irrelevant; the clock ticks regardless, and the wait dies at ~30 min.

**Observed behavior**: The keepalive sends every 30s BUT THE WAIT STILL DIES AT 1829s.

**Conclusion**: The timeout is **ABSOLUTE DURATION**, not idle-based. The keepalive is sending (proving the connection is alive and working) but has NO EFFECT on the deadline. This diagnostic is critical: it rules out all idle-timeout candidates and points to a hard max-duration cap (Claude Code client, not Railroad or Network).

---

## Is 25 Minutes the Right Clamp?

**Current implementation** (tools.mjs:32, 395):
```javascript
const TRANSPORT_SAFE_CEILING_MIN = Math.max(1, parseInt(process.env.WAIT_TRANSPORT_CEILING_MIN) || 25);
const effectiveCeilingMin = Math.min(max_wait_minutes, TRANSPORT_SAFE_CEILING_MIN);
const hardDeadline = start + effectiveCeilingMin * 60 * 1000;
```

**Analysis**:
- Observed abort: **1829 seconds** ≈ **30.48 minutes**
- Clamp: **25 minutes** = 1500 seconds
- **Margin**: 1829 - 1500 = 329 seconds ≈ **5.5 minutes SAFETY BUFFER**

**Is it safe?**
- **YES, absolutely.** A 5.5-min margin is conservative and defensive.
- If the Claude Code client's hard limit is indeed ~30 min, a 25-min clamp guarantees the app will return gracefully (the tool returns a "ceiling hit" message) **before** the client severs the connection.
- Even if the exact client limit is variable or slightly lower (e.g., 29 min), the margin absorbs it.

**Could it be lower?**
- 20 minutes would still be safe (10-min margin).
- 25 minutes is a good balance: long enough to be useful for serious async work, short enough to guarantee safety.

**Recommendation**: **KEEP 25 MINUTES** — no change needed.

---

## Server-Side Chunk-and-Renew: Is It Possible or Recommended?

**Architecture question**: Once the Claude Code client reaches its ~30-min hard limit on a backgrounded MCP call, can the server return a "continuation" before the limit, instruct the client to re-invoke with a new request, and have the client pick up listening?

**Answer**: **It would NOT help, and is NOT recommended.**

**Why**:
1. **The client abort is client-initiated.** When Claude Code's backgrounded-call timeout fires, it kills the HTTP request at the client end (likely by closing the socket, timing out the read, or sending a cancel signal). The server sees an abrupt disconnect, not a graceful close.
2. **Server-side chunk-and-renew requires graceful client cooperation.** A true chunk-and-renew pattern works when the client receives a special "renew" message from the server (e.g., "I'm returning now, re-issue the call with `after_id=X` to keep listening"). But if the client aborts the request before that message can be sent, the pattern breaks.
3. **The client-side rejoin is already the right pattern.** The current mitigation (clamp to 25 min, instruct the caller to re-issue `wait_for_reply`) is CLIENT-DRIVEN and works regardless of whether the cap is Claude Code or Railway: when the wait returns (either from the app ceiling or a client abort), the client immediately re-issues the wait and keeps listening. This is robust.
4. **Proof that client-rejoin is the right move**: The field report described an abort at 1829s, which is graceful from the *app's* perspective (the client killed it from above). The app never got a chance to return its "ceiling hit" message. A server-side chunk-and-renew, if the client aborts before the server sends it, is lost.

**Verdict**: **KEEP client-rejoin as-is.** Server-side chunk-and-renew is unnecessary and would not survive a client-side timeout anyway. The shipped 25-min clamp + "rejoin to keep listening" instruction is the correct, robust pattern.

---

## Precise Empirical Test (for future confirmation)

If the exact cap source or value remains uncertain in production, run this experiment on the deployed Railway instance:

**Test setup**:
```bash
# Launch a Claude Code session with cross-claude-mcp connected
# Call wait_for_reply(channel='test', after_id=0, max_wait_minutes=60, ...)
# DO NOT send any message to the channel
# Let the wait run until it aborts or returns
# Log the exact elapsed time when the request terminates
# Measure from tool call start to final result / abort
```

**Expected outcome**:
- If Claude Code client: **~30 min ± 2 min** (hardcoded limit varies slightly by client version, but consistent within a session)
- If Railway: **900–1800s** (range: 15 min active, but could be implementation-dependent)
- If idle timeout: **300–600s** (5–10 min, and keepalive should prevent)

**Procedure**:
1. Run `wait_for_reply` with no incoming messages (pure clock-run)
2. Server logs every `sendKeepalive` call with a timestamp
3. Record the moment the client disconnects (from server stderr) and total elapsed
4. Repeat 2–3 times to confirm consistency

**Verdict expected**: The elapsed time will cluster around 1800–1830s, confirming the ~30-min absolute duration cap.

---

## Summary Table

| Candidate | Limit | Observed | Match? | Confidence | Status |
|-----------|-------|----------|--------|------------|--------|
| Claude Code backgrounded MCP timeout | ~30 min (1800s) | 1829s | ✅ EXACT | HIGH | **PRIMARY** |
| Railway active transfer | 15 min (900s) | 1829s | ❌ LATE | — | Ruled out |
| Node.js requestTimeout | 5 min (300s) | 1829s | ❌ EARLY | — | Ruled out |
| Cloudflare proxy | 100s | 1829s | ❌ EARLY | — | Not in play |
| MCP SDK transport | Undocumented | 1829s | ? | LOW | Unlikely |

---

## Recommendations

1. **No code change needed.** The current 25-min clamp is correct and safe.
2. **Documentation is complete.** Tool text, dev-log entry, and skill documentation already teach the rejoin pattern.
3. **For future certainty**: Run the empirical test above against prod to pinpoint the exact source and value. Once confirmed, update `docs/plans/wait-transport-cap-investigation.md` with the test results.
4. **No server-side chunk-and-renew warranted.** The client-rejoin pattern is robust and sufficient.
5. **If an even shorter margin is desired** (e.g., for abundant safety): change the default to 20 min (still provides 10-min buffer). But 25 min is already prudent.

---

## References

- **Railway Specs & Limits**: https://docs.railway.com/networking/public-networking/specs-and-limits
- **Claude Code GitHub Issues**: https://github.com/anthropics/claude-code/issues (issues #23611, #47076, #22542)
- **Node.js HTTP Docs**: https://nodejs.org/api/http.html
- **Cloudflare Connection Limits**: https://developers.cloudflare.com/fundamentals/reference/connection-limits/
- **Project CLAUDE.md**: `/Users/rblank/Projects/cross-claude-mcp/CLAUDE.md` (describes `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`)
- **Project dev-log**: `docs/dev-log.md` (2026-07-19 entry)
