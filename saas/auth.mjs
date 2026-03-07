/**
 * Authentication middleware for SaaS mode.
 * - bcryptjs for password hashing
 * - express-session + connect-pg-simple for web sessions
 * - CSRF token generation/validation
 * - Brute-force login rate limiting
 * - API key -> tenant resolution
 */

import bcrypt from "bcryptjs";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import rateLimit from "express-rate-limit";
import { randomBytes } from "crypto";

const SALT_ROUNDS = 12;

// --- Password hashing ---

export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// --- Session setup ---

export function createSessionMiddleware(pool) {
  const PgStore = connectPgSimple(session);

  return session({
    store: new PgStore({
      pool,
      tableName: "web_sessions",
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      sameSite: "lax",
    },
    name: "cc.sid",
  });
}

// --- CSRF protection ---

export function generateCsrfToken(session) {
  if (!session.csrfToken) {
    session.csrfToken = randomBytes(32).toString("hex");
  }
  return session.csrfToken;
}

export function validateCsrf(req, res, next) {
  if (req.method !== "POST") return next();

  // Skip CSRF for MCP endpoints (Bearer token auth) and Stripe webhook (signature-verified)
  const CSRF_SKIP = ["/mcp", "/messages", "/api/billing/webhook"];
  if (CSRF_SKIP.some(p => req.path === p)) return next();

  const token = req.body?._csrf;
  if (!token || token !== req.session?.csrfToken) {
    return res.status(403).send("Invalid CSRF token");
  }
  next();
}

// --- Brute-force login rate limiting ---

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per window
  message: "Too many login attempts. Please try again in 15 minutes.",
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
});

// --- API key resolution ---

export async function resolveTenant(db, apiKey) {
  if (!apiKey) return null;
  const tenant = await db.getTenantByApiKey(apiKey);
  if (!tenant) return null;

  // Lazy monthly usage reset
  const resetAt = new Date(tenant.messages_reset_at);
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  if (resetAt < startOfMonth) {
    await db.resetMonthlyUsage(tenant.id);
    tenant.messages_this_month = 0;
    tenant.messages_reset_at = now;
  }

  return tenant;
}

// --- Extract API key from request ---

export function extractApiKey(req) {
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return req.query.api_key || null;
}

// --- Web session auth check ---

export function requireLogin(req, res, next) {
  if (!req.session?.tenantId) {
    return res.redirect("/login");
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.session?.isAdmin) {
    return res.status(403).send("Forbidden");
  }
  next();
}
