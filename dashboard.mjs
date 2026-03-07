/**
 * Customer-facing web UI: signup, login, dashboard.
 * Server-rendered HTML with inline CSS.
 */

import { Router } from "express";
import { randomUUID } from "crypto";
import {
  hashPassword, verifyPassword, generateCsrfToken,
  loginLimiter, requireLogin,
} from "./auth.mjs";

const APP_URL = () => process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;

const PLAN_LIMITS = {
  free:    { messages: 100,   instances: 2,  channels: 3,   shared_data_mb: 1,   retention_days: 7  },
  starter: { messages: 1000,  instances: 5,  channels: 10,  shared_data_mb: 10,  retention_days: 30 },
  pro:     { messages: 10000, instances: -1, channels: -1,  shared_data_mb: 100, retention_days: 90 },
};

export { PLAN_LIMITS };

// --- HTML layout ---

function layout(title, body, flash = null, isAdmin = false) {
  const flashHtml = flash ? `<div class="flash ${flash.type}">${escHtml(flash.text)}</div>` : "";
  const adminLink = isAdmin ? `<a href="/admin">Admin</a>` : "";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)} - Cross-Claude MCP</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;line-height:1.6;color:#1a1a2e;background:#f8f9fa}
.container{max-width:720px;margin:0 auto;padding:24px 20px}
h1{font-size:1.8em;margin-bottom:8px;color:#16213e}
h2{font-size:1.3em;margin:24px 0 12px;color:#16213e}
.subtitle{color:#666;margin-bottom:24px}
a{color:#0a66c2}
.nav{background:#16213e;padding:12px 20px;display:flex;align-items:center;gap:20px}
.nav a{color:#fff;text-decoration:none;font-size:0.9em}
.nav .brand{font-weight:700;font-size:1.1em;margin-right:auto}
.card{background:#fff;border-radius:8px;padding:24px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,0.1)}
.form-group{margin-bottom:16px}
label{display:block;font-weight:600;margin-bottom:4px;font-size:0.9em}
input[type="email"],input[type="password"],input[type="text"]{width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:6px;font-size:1em}
input:focus{outline:none;border-color:#0a66c2;box-shadow:0 0 0 2px rgba(10,102,194,0.15)}
button,.btn{display:inline-block;padding:10px 20px;border:none;border-radius:6px;font-size:1em;cursor:pointer;text-decoration:none;font-weight:600}
.btn-primary{background:#0a66c2;color:#fff}
.btn-primary:hover{background:#084e96}
.btn-secondary{background:#e9ecef;color:#333}
.btn-secondary:hover{background:#dee2e6}
.btn-danger{background:#dc3545;color:#fff}
.btn-small{padding:6px 14px;font-size:0.85em}
.flash{padding:12px 16px;border-radius:6px;margin-bottom:16px;font-size:0.9em}
.flash.success{background:#d4edda;color:#155724;border:1px solid #c3e6cb}
.flash.error{background:#f8d7da;color:#721c24;border:1px solid #f5c6cb}
.api-key{font-family:monospace;background:#f4f4f4;padding:12px;border-radius:6px;word-break:break-all;font-size:0.95em;border:1px solid #ddd}
.config-block{background:#1e1e1e;color:#d4d4d4;padding:16px;border-radius:6px;overflow-x:auto;font-size:0.85em;font-family:'SF Mono',Monaco,monospace;white-space:pre}
.config-block .key{color:#9cdcfe}
.config-block .str{color:#ce9178}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.stat{text-align:center;padding:16px;background:#f8f9fa;border-radius:6px}
.stat .number{font-size:1.8em;font-weight:700;color:#0a66c2}
.stat .label{font-size:0.8em;color:#666;text-transform:uppercase;letter-spacing:0.5px}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:0.8em;font-weight:600}
.badge-free{background:#e9ecef;color:#666}
.badge-starter{background:#cce5ff;color:#004085}
.badge-pro{background:#d4edda;color:#155724}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.mt-16{margin-top:16px}
.mb-8{margin-bottom:8px}
.text-muted{color:#666;font-size:0.9em}
table{width:100%;border-collapse:collapse;font-size:0.9em}
th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #eee}
th{font-weight:600;color:#666;font-size:0.85em;text-transform:uppercase;letter-spacing:0.3px}
</style></head>
<body>
<nav class="nav">
  <span class="brand">Cross-Claude MCP</span>
  <a href="/dashboard">Dashboard</a>
  ${adminLink}
  <a href="/logout">Logout</a>
</nav>
<div class="container">${flashHtml}${body}</div>
</body></html>`;
}

function authLayout(title, body) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)} - Cross-Claude MCP</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;line-height:1.6;color:#1a1a2e;background:#f8f9fa;display:flex;align-items:center;justify-content:center;min-height:100vh}
.auth-card{background:#fff;border-radius:12px;padding:40px;width:100%;max-width:420px;box-shadow:0 4px 12px rgba(0,0,0,0.1)}
h1{font-size:1.5em;margin-bottom:4px;color:#16213e;text-align:center}
.subtitle{color:#666;text-align:center;margin-bottom:24px;font-size:0.9em}
.form-group{margin-bottom:16px}
label{display:block;font-weight:600;margin-bottom:4px;font-size:0.9em}
input[type="email"],input[type="password"],input[type="text"]{width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:6px;font-size:1em}
input:focus{outline:none;border-color:#0a66c2;box-shadow:0 0 0 2px rgba(10,102,194,0.15)}
button{width:100%;padding:12px;border:none;border-radius:6px;font-size:1em;cursor:pointer;font-weight:600;background:#0a66c2;color:#fff}
button:hover{background:#084e96}
a{color:#0a66c2}
.flash{padding:12px 16px;border-radius:6px;margin-bottom:16px;font-size:0.9em}
.flash.error{background:#f8d7da;color:#721c24;border:1px solid #f5c6cb}
.flash.success{background:#d4edda;color:#155724;border:1px solid #c3e6cb}
.text-center{text-align:center;margin-top:16px;font-size:0.9em}
</style></head>
<body><div class="auth-card">${body}</div></body></html>`;
}

function escHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- Routes ---

export function createDashboardRouter(db) {
  const router = Router();

  // --- Signup ---

  router.get("/signup", (req, res) => {
    if (req.session?.tenantId) return res.redirect("/dashboard");
    const csrf = generateCsrfToken(req.session);
    const flash = req.session.flash ? `<div class="flash error">${escHtml(req.session.flash)}</div>` : "";
    req.session.flash = null;
    res.type("html").send(authLayout("Sign Up", `
      <h1>Get Started</h1>
      <p class="subtitle">Create your Cross-Claude MCP account</p>
      ${flash}
      <form method="POST" action="/signup">
        <input type="hidden" name="_csrf" value="${csrf}">
        <div class="form-group">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" required autocomplete="email">
        </div>
        <div class="form-group">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required minlength="8" autocomplete="new-password">
        </div>
        <div class="form-group">
          <label for="name">Name (optional)</label>
          <input type="text" id="name" name="name" autocomplete="name">
        </div>
        <button type="submit">Create Account</button>
      </form>
      <p class="text-center">Already have an account? <a href="/login">Log in</a></p>
    `));
  });

  router.post("/signup", async (req, res) => {
    try {
      const { email, password, name } = req.body;

      if (!email || !password) {
        req.session.flash = "Email and password are required.";
        return res.redirect("/signup");
      }
      if (password.length < 8) {
        req.session.flash = "Password must be at least 8 characters.";
        return res.redirect("/signup");
      }

      const existing = await db.getTenantByEmail(email.toLowerCase().trim());
      if (existing) {
        req.session.flash = "An account with that email already exists.";
        return res.redirect("/signup");
      }

      const id = randomUUID();
      const apiKey = `cc_${randomUUID().replace(/-/g, "")}`;
      const passwordHash = await hashPassword(password);

      const isAdmin = !!(process.env.ADMIN_EMAIL && email.toLowerCase().trim() === process.env.ADMIN_EMAIL.toLowerCase().trim());
      await db.createTenant(id, email.toLowerCase().trim(), passwordHash, name || null, apiKey, isAdmin);
      await db.seedTenantChannel(id);

      // Auto-login
      req.session.tenantId = id;
      req.session.isAdmin = isAdmin;
      req.session.flashMsg = { type: "success", text: "Account created! Here's your API key." };
      res.redirect("/dashboard");
    } catch (err) {
      console.error("Signup error:", err);
      req.session.flash = "Something went wrong. Please try again.";
      res.redirect("/signup");
    }
  });

  // --- Login ---

  router.get("/login", (req, res) => {
    if (req.session?.tenantId) return res.redirect("/dashboard");
    const csrf = generateCsrfToken(req.session);
    const flash = req.session.flash ? `<div class="flash error">${escHtml(req.session.flash)}</div>` : "";
    req.session.flash = null;
    res.type("html").send(authLayout("Log In", `
      <h1>Welcome Back</h1>
      <p class="subtitle">Log in to your Cross-Claude MCP account</p>
      ${flash}
      <form method="POST" action="/login">
        <input type="hidden" name="_csrf" value="${csrf}">
        <div class="form-group">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" required autocomplete="email">
        </div>
        <div class="form-group">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required autocomplete="current-password">
        </div>
        <button type="submit">Log In</button>
      </form>
      <p class="text-center">Don't have an account? <a href="/signup">Sign up</a></p>
    `));
  });

  router.post("/login", loginLimiter, async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        req.session.flash = "Email and password are required.";
        return res.redirect("/login");
      }

      const tenant = await db.getTenantByEmail(email.toLowerCase().trim());
      if (!tenant || !(await verifyPassword(password, tenant.password_hash))) {
        req.session.flash = "Invalid email or password.";
        return res.redirect("/login");
      }

      if (tenant.status === "suspended") {
        req.session.flash = "Your account has been suspended. Please contact support.";
        return res.redirect("/login");
      }

      req.session.tenantId = tenant.id;
      req.session.isAdmin = tenant.is_admin;
      res.redirect("/dashboard");
    } catch (err) {
      console.error("Login error:", err);
      req.session.flash = "Something went wrong. Please try again.";
      res.redirect("/login");
    }
  });

  // --- Logout ---

  router.get("/logout", (req, res) => {
    req.session.destroy(() => {
      res.redirect("/login");
    });
  });

  // --- Dashboard ---

  router.get("/dashboard", requireLogin, async (req, res) => {
    try {
      const tenant = await db.getTenantById(req.session.tenantId);
      if (!tenant) {
        req.session.destroy(() => res.redirect("/login"));
        return;
      }

      const limits = PLAN_LIMITS[tenant.plan] || PLAN_LIMITS.free;
      const channelCount = await db.countChannels(tenant.id);
      const instanceCount = await db.countInstances(tenant.id);
      const flash = req.session.flashMsg;
      req.session.flashMsg = null;

      const csrf = generateCsrfToken(req.session);
      const appUrl = APP_URL();

      const planBadge = `<span class="badge badge-${tenant.plan}">${tenant.plan.toUpperCase()}</span>`;
      const messagesUsed = tenant.messages_this_month || 0;
      const messagesLimit = limits.messages;
      const instancesLimit = limits.instances === -1 ? "Unlimited" : limits.instances;
      const channelsLimit = limits.channels === -1 ? "Unlimited" : limits.channels;

      const upgradeSection = tenant.plan === "pro" ? "" : `
        <h2>Upgrade Your Plan</h2>
        <div class="card">
          <div class="stats">
            ${tenant.plan === "free" ? `
            <div class="stat" style="text-align:left;padding:16px">
              <div style="font-weight:700;margin-bottom:4px">Starter - $9/mo</div>
              <div style="font-size:0.85em;color:#666">1,000 messages, 5 instances, 10 channels</div>
              <form method="POST" action="/api/billing/checkout" class="mt-16">
                <input type="hidden" name="_csrf" value="${csrf}">
                <input type="hidden" name="plan" value="starter">
                <button class="btn-primary btn-small">Upgrade</button>
              </form>
            </div>` : ""}
            <div class="stat" style="text-align:left;padding:16px">
              <div style="font-weight:700;margin-bottom:4px">Pro - $29/mo</div>
              <div style="font-size:0.85em;color:#666">10,000 messages, unlimited instances & channels</div>
              <form method="POST" action="/api/billing/checkout" class="mt-16">
                <input type="hidden" name="_csrf" value="${csrf}">
                <input type="hidden" name="plan" value="pro">
                <button class="btn-primary btn-small">Upgrade</button>
              </form>
            </div>
          </div>
        </div>`;

      const billingSection = tenant.stripe_customer_id ? `
        <form method="POST" action="/api/billing/portal" style="display:inline">
          <input type="hidden" name="_csrf" value="${csrf}">
          <button class="btn-secondary btn-small">Manage Billing</button>
        </form>` : "";

      res.type("html").send(layout("Dashboard", `
        <h1>Dashboard</h1>
        <p class="subtitle">Welcome${tenant.name ? ", " + escHtml(tenant.name) : ""}! ${planBadge} ${billingSection}</p>

        <h2>Usage This Month</h2>
        <div class="card">
          <div class="stats">
            <div class="stat">
              <div class="number">${messagesUsed}</div>
              <div class="label">Messages (of ${messagesLimit.toLocaleString()})</div>
            </div>
            <div class="stat">
              <div class="number">${instanceCount}</div>
              <div class="label">Instances (of ${instancesLimit})</div>
            </div>
            <div class="stat">
              <div class="number">${channelCount}</div>
              <div class="label">Channels (of ${channelsLimit})</div>
            </div>
          </div>
        </div>

        <h2>Your API Key</h2>
        <div class="card">
          <div class="api-key" id="api-key">${escHtml(tenant.api_key)}</div>
          <div class="row mt-16">
            <button class="btn-secondary btn-small" onclick="navigator.clipboard.writeText(document.getElementById('api-key').textContent).then(()=>this.textContent='Copied!')">Copy</button>
            <form method="POST" action="/dashboard/regenerate-key" style="display:inline">
              <input type="hidden" name="_csrf" value="${csrf}">
              <button class="btn-danger btn-small" onclick="return confirm('This will invalidate your current key. Continue?')">Regenerate</button>
            </form>
          </div>
        </div>

        <h2>Connection Config</h2>
        <div class="card">
          <p class="mb-8"><strong>Claude Code</strong> (~/.claude.json):</p>
          <div class="config-block">{
  <span class="key">"mcpServers"</span>: {
    <span class="key">"cross-claude"</span>: {
      <span class="key">"type"</span>: <span class="str">"streamableHttp"</span>,
      <span class="key">"url"</span>: <span class="str">"${appUrl}/mcp"</span>,
      <span class="key">"headers"</span>: {
        <span class="key">"Authorization"</span>: <span class="str">"Bearer ${escHtml(tenant.api_key)}"</span>
      }
    }
  }
}</div>

          <p class="mb-8 mt-16"><strong>Claude.ai / Claude Desktop</strong> (MCP connector URL):</p>
          <div class="config-block">${appUrl}/mcp?api_key=${escHtml(tenant.api_key)}</div>
        </div>

        ${upgradeSection}
      `, flash, tenant.is_admin));
    } catch (err) {
      console.error("Dashboard error:", err);
      res.status(500).send("Something went wrong.");
    }
  });

  // --- Regenerate API key ---

  router.post("/dashboard/regenerate-key", requireLogin, async (req, res) => {
    try {
      const newKey = `cc_${randomUUID().replace(/-/g, "")}`;
      await db.updateTenant(req.session.tenantId, { api_key: newKey });
      req.session.flashMsg = { type: "success", text: "API key regenerated. Update your Claude config." };
      res.redirect("/dashboard");
    } catch (err) {
      console.error("Regenerate key error:", err);
      req.session.flashMsg = { type: "error", text: "Failed to regenerate key." };
      res.redirect("/dashboard");
    }
  });

  return router;
}
