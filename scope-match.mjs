// Shared channel-scope matcher for teammate keys (Gate 6 + team-* rooms; security-guard conditions 2026-11-17).
// The server (server.mjs, rest-api.mjs) and the bridge (bridge/trust.mjs) both import this file, so the two
// sides can never disagree about which channel a teammate may use.
//
// A scope is a list of exact channel names, plus optionally the ONE pattern form "team-*". "team-*" grants every
// room whose name matches TEAM_ROOM_RE. dm-* channels and any name containing "*" are never in scope.

export const TEAM_PATTERN = "team-*";
export const TEAM_ROOM_RE = /^team-[a-z0-9][a-z0-9-]{0,30}$/;
export const TEAM_ROOM_CAP = 20;

export function isTeamRoom(name) {
  return typeof name === "string" && TEAM_ROOM_RE.test(name);
}

// allowed: a Set or an Array of scope entries (exact names and/or TEAM_PATTERN).
export function channelAllowed(allowed, name) {
  if (typeof name !== "string" || name.length === 0 || name.includes("*") || name.startsWith("dm-")) return false;
  const has = (x) => (allowed instanceof Set ? allowed.has(x) : Array.isArray(allowed) && allowed.includes(x));
  return has(name) || (has(TEAM_PATTERN) && isTeamRoom(name));
}
