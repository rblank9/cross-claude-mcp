// Gate 6 scope enforcement shared by server.mjs and rest-api.mjs. Scoped keys are teammate identities only.
// Refusal logging + the scoped-key alarm, the per-key send rate cap, the content size cap, and name binding.

export const SCOPE_WINDOW_MS = 10 * 60 * 1000;
export const SCOPE_SEND_MAX = 30;
export const SCOPE_CONTENT_MAX = 65536;
const ALARM_REFUSALS = 5;

const refusalTimes = new Map();
const sendTimes = new Map();
const lastAlarm = new Map();

function recent(map, keyId, now) {
  const kept = (map.get(keyId) || []).filter((t) => now - t < SCOPE_WINDOW_MS);
  map.set(keyId, kept);
  return kept;
}

// One [SCOPE] line per refusal. One ALARM per key per window once ALARM_REFUSALS refusals land inside the window.
export function scopeRefuse(req, res, reason, status, now = Date.now()) {
  console.error(`[SCOPE] ${reason} key=${req.keyId} route=${req.method} ${req.originalUrl.split("?")[0]}`);
  const times = recent(refusalTimes, req.keyId, now);
  times.push(now);
  if (times.length >= ALARM_REFUSALS) {
    const last = lastAlarm.get(req.keyId);
    if (last === undefined || now - last >= SCOPE_WINDOW_MS) {
      lastAlarm.set(req.keyId, now);
      console.error(`[SCOPE] ALARM key=${req.keyId}`);
    }
  }
  return res.status(status).json({ error: reason });
}

// Accepted sends for a scoped key: at most SCOPE_SEND_MAX per rolling window. Records the send when allowed.
export function scopeSendAllowed(keyId, now = Date.now()) {
  const times = recent(sendTimes, keyId, now);
  if (times.length >= SCOPE_SEND_MAX) return false;
  times.push(now);
  return true;
}

// Name binding: a scoped key may register or send only as "<instance_prefix>-<name>". No prefix means no names.
export function nameBound(scope, name) {
  return typeof name === "string" && !!scope.prefix && name.length > scope.prefix.length + 1 && name.startsWith(`${scope.prefix}-`);
}
