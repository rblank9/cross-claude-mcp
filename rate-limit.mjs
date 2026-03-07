/**
 * Per-tenant rate limiting and plan usage enforcement.
 */

import { PLAN_LIMITS } from "./dashboard.mjs";

// --- Per-tenant rate limiter (in-memory sliding window) ---

const tenantWindows = new Map(); // tenantId -> { count, windowStart }
const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_CALLS_PER_MINUTE = 60;

// Prune stale entries every 5 minutes to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [id, w] of tenantWindows) {
    if (now - w.windowStart > WINDOW_MS) tenantWindows.delete(id);
  }
}, 5 * 60 * 1000).unref();

export function checkRateLimit(tenantId) {
  const now = Date.now();
  let window = tenantWindows.get(tenantId);

  if (!window || (now - window.windowStart) > WINDOW_MS) {
    window = { count: 0, windowStart: now };
    tenantWindows.set(tenantId, window);
  }

  window.count++;

  if (window.count > MAX_CALLS_PER_MINUTE) {
    return { allowed: false, message: "Rate limit exceeded. Maximum 60 tool calls per minute." };
  }

  return { allowed: true };
}

// --- Plan limit enforcement ---

export async function checkPlanLimits(db, tenant, action) {
  const limits = PLAN_LIMITS[tenant.plan] || PLAN_LIMITS.free;

  // Lazy monthly reset
  const resetAt = new Date(tenant.messages_reset_at);
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  if (resetAt < startOfMonth) {
    await db.resetMonthlyUsage(tenant.id);
    tenant.messages_this_month = 0;
  }

  if (action === "send_message") {
    if (tenant.messages_this_month >= limits.messages) {
      const appUrl = process.env.APP_URL || "https://cross-claude-mcp.up.railway.app";
      return {
        allowed: false,
        message: `Monthly message limit reached (${limits.messages} messages on ${tenant.plan} plan). Upgrade at ${appUrl}/dashboard`,
      };
    }
  }

  if (action === "create_channel") {
    if (limits.channels !== -1) {
      const count = await db.countChannels(tenant.id);
      if (count >= limits.channels) {
        return {
          allowed: false,
          message: `Channel limit reached (${limits.channels} on ${tenant.plan} plan). Upgrade for more channels.`,
        };
      }
    }
  }

  if (action === "register") {
    if (limits.instances !== -1) {
      const count = await db.countInstances(tenant.id);
      if (count >= limits.instances) {
        return {
          allowed: false,
          message: `Instance limit reached (${limits.instances} on ${tenant.plan} plan). Upgrade for more instances.`,
        };
      }
    }
  }

  if (action === "share_data") {
    const limitBytes = limits.shared_data_mb * 1024 * 1024;
    const currentBytes = await db.getSharedDataSize(tenant.id);
    if (currentBytes >= limitBytes) {
      return {
        allowed: false,
        message: `Shared data limit reached (${limits.shared_data_mb} MB on ${tenant.plan} plan). Upgrade for more storage.`,
      };
    }
  }

  return { allowed: true };
}
