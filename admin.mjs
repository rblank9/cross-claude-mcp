/**
 * Admin dashboard: tenant management, usage stats.
 */

import { Router } from "express";
import { randomUUID } from "crypto";
import { requireAdmin, generateCsrfToken } from "./auth.mjs";

function escHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function adminLayout(title, body) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)} - Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;line-height:1.6;color:#1a1a2e;background:#f8f9fa}
.container{max-width:960px;margin:0 auto;padding:24px 20px}
h1{font-size:1.8em;margin-bottom:8px;color:#16213e}
h2{font-size:1.3em;margin:24px 0 12px;color:#16213e}
a{color:#0a66c2}
.nav{background:#2d1b4e;padding:12px 20px;display:flex;align-items:center;gap:20px}
.nav a{color:#fff;text-decoration:none;font-size:0.9em}
.nav .brand{font-weight:700;font-size:1.1em;margin-right:auto;color:#fff}
.card{background:#fff;border-radius:8px;padding:24px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,0.1)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.stat{text-align:center;padding:16px;background:#f8f9fa;border-radius:6px}
.stat .number{font-size:1.8em;font-weight:700;color:#6f42c1}
.stat .label{font-size:0.8em;color:#666;text-transform:uppercase;letter-spacing:0.5px}
table{width:100%;border-collapse:collapse;font-size:0.9em}
th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #eee}
th{font-weight:600;color:#666;font-size:0.85em;text-transform:uppercase;letter-spacing:0.3px}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:0.8em;font-weight:600}
.badge-active{background:#d4edda;color:#155724}
.badge-suspended{background:#f8d7da;color:#721c24}
.badge-free{background:#e9ecef;color:#666}
.badge-starter{background:#cce5ff;color:#004085}
.badge-pro{background:#d4edda;color:#155724}
button,.btn{display:inline-block;padding:6px 14px;border:none;border-radius:6px;font-size:0.85em;cursor:pointer;font-weight:600}
.btn-danger{background:#dc3545;color:#fff}
.btn-warning{background:#ffc107;color:#333}
.btn-secondary{background:#e9ecef;color:#333}
.btn-small{padding:4px 10px;font-size:0.8em}
.text-muted{color:#666;font-size:0.85em}
.mt-16{margin-top:16px}
.back{margin-bottom:16px;display:inline-block}
</style></head>
<body>
<nav class="nav">
  <span class="brand">Admin Panel</span>
  <a href="/admin">Overview</a>
  <a href="/admin/tenants">Tenants</a>
  <a href="/dashboard">Dashboard</a>
  <a href="/logout">Logout</a>
</nav>
<div class="container">${body}</div>
</body></html>`;
}

export function createAdminRouter(db) {
  const router = Router();

  // All admin routes require admin auth
  router.use(requireAdmin);

  // --- Overview ---

  router.get("/", async (req, res) => {
    try {
      const stats = await db.getTenantStats();
      const usageToday = await db.getUsageToday();
      const starterMrr = (Number(stats.starter_count) || 0) * 9;
      const proMrr = (Number(stats.pro_count) || 0) * 29;
      const mrr = starterMrr + proMrr;

      res.type("html").send(adminLayout("Overview", `
        <h1>Admin Overview</h1>
        <div class="card">
          <div class="stats">
            <div class="stat">
              <div class="number">${stats.total_tenants}</div>
              <div class="label">Total Tenants</div>
            </div>
            <div class="stat">
              <div class="number">$${mrr}</div>
              <div class="label">MRR</div>
            </div>
            <div class="stat">
              <div class="number">${usageToday}</div>
              <div class="label">Actions Today</div>
            </div>
            <div class="stat">
              <div class="number">${stats.active_count}</div>
              <div class="label">Active</div>
            </div>
          </div>
        </div>

        <h2>By Plan</h2>
        <div class="card">
          <div class="stats">
            <div class="stat">
              <div class="number">${stats.free_count}</div>
              <div class="label">Free</div>
            </div>
            <div class="stat">
              <div class="number">${stats.starter_count}</div>
              <div class="label">Starter ($9)</div>
            </div>
            <div class="stat">
              <div class="number">${stats.pro_count}</div>
              <div class="label">Pro ($29)</div>
            </div>
          </div>
        </div>
      `));
    } catch (err) {
      console.error("Admin overview error:", err);
      res.status(500).send("Error loading admin overview.");
    }
  });

  // --- Tenant list ---

  router.get("/tenants", async (req, res) => {
    try {
      const tenants = await db.listTenants();
      const rows = tenants.map(t => `
        <tr>
          <td><a href="/admin/tenants/${escHtml(t.id)}">${escHtml(t.email)}</a></td>
          <td>${escHtml(t.name || "-")}</td>
          <td><span class="badge badge-${t.plan}">${t.plan}</span></td>
          <td><span class="badge badge-${t.status}">${t.status}</span></td>
          <td>${t.messages_this_month || 0}</td>
          <td class="text-muted">${new Date(t.created_at).toLocaleDateString()}</td>
        </tr>
      `).join("");

      res.type("html").send(adminLayout("Tenants", `
        <h1>Tenants</h1>
        <div class="card">
          <table>
            <thead><tr><th>Email</th><th>Name</th><th>Plan</th><th>Status</th><th>Msgs/Mo</th><th>Signup</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="6">No tenants yet.</td></tr>'}</tbody>
          </table>
        </div>
      `));
    } catch (err) {
      console.error("Admin tenants error:", err);
      res.status(500).send("Error loading tenants.");
    }
  });

  // --- Tenant detail ---

  router.get("/tenants/:id", async (req, res) => {
    try {
      const tenant = await db.getTenantById(req.params.id);
      if (!tenant) return res.status(404).send("Tenant not found.");

      const usage = await db.getRecentUsage(tenant.id, 20);
      const csrf = generateCsrfToken(req.session);

      const usageRows = usage.map(u => `
        <tr>
          <td>${escHtml(u.action)}</td>
          <td class="text-muted">${new Date(u.timestamp).toLocaleString()}</td>
        </tr>
      `).join("");

      res.type("html").send(adminLayout(`Tenant: ${tenant.email}`, `
        <a href="/admin/tenants" class="back">&larr; Back to tenants</a>
        <h1>${escHtml(tenant.email)}</h1>

        <div class="card">
          <table>
            <tr><td><strong>ID</strong></td><td class="text-muted">${escHtml(tenant.id)}</td></tr>
            <tr><td><strong>Name</strong></td><td>${escHtml(tenant.name || "-")}</td></tr>
            <tr><td><strong>Plan</strong></td><td><span class="badge badge-${tenant.plan}">${tenant.plan}</span></td></tr>
            <tr><td><strong>Status</strong></td><td><span class="badge badge-${tenant.status}">${tenant.status}</span></td></tr>
            <tr><td><strong>Messages This Month</strong></td><td>${tenant.messages_this_month || 0}</td></tr>
            <tr><td><strong>API Key</strong></td><td class="text-muted" style="font-family:monospace;font-size:0.85em">${escHtml(tenant.api_key)}</td></tr>
            <tr><td><strong>Stripe Customer</strong></td><td class="text-muted">${escHtml(tenant.stripe_customer_id || "-")}</td></tr>
            <tr><td><strong>Signup Date</strong></td><td>${new Date(tenant.created_at).toLocaleString()}</td></tr>
            <tr><td><strong>Admin</strong></td><td>${tenant.is_admin ? "Yes" : "No"}</td></tr>
          </table>

          <div class="mt-16" style="display:flex;gap:8px">
            <form method="POST" action="/admin/tenants/${escHtml(tenant.id)}/suspend">
              <input type="hidden" name="_csrf" value="${csrf}">
              <button class="${tenant.status === 'active' ? 'btn-warning' : 'btn-secondary'} btn-small">
                ${tenant.status === 'active' ? 'Suspend' : 'Reactivate'}
              </button>
            </form>
            <form method="POST" action="/admin/tenants/${escHtml(tenant.id)}/reset-key">
              <input type="hidden" name="_csrf" value="${csrf}">
              <button class="btn-danger btn-small" onclick="return confirm('Reset API key for this tenant?')">Reset API Key</button>
            </form>
          </div>
        </div>

        <h2>Recent Activity</h2>
        <div class="card">
          <table>
            <thead><tr><th>Action</th><th>Time</th></tr></thead>
            <tbody>${usageRows || '<tr><td colspan="2">No recent activity.</td></tr>'}</tbody>
          </table>
        </div>
      `));
    } catch (err) {
      console.error("Admin tenant detail error:", err);
      res.status(500).send("Error loading tenant.");
    }
  });

  // --- Suspend / Reactivate ---

  router.post("/tenants/:id/suspend", async (req, res) => {
    try {
      const tenant = await db.getTenantById(req.params.id);
      if (!tenant) return res.status(404).send("Tenant not found.");

      const newStatus = tenant.status === "active" ? "suspended" : "active";
      await db.updateTenant(tenant.id, { status: newStatus });
      res.redirect(`/admin/tenants/${tenant.id}`);
    } catch (err) {
      console.error("Suspend error:", err);
      res.status(500).send("Error toggling status.");
    }
  });

  // --- Reset API Key ---

  router.post("/tenants/:id/reset-key", async (req, res) => {
    try {
      const newKey = `cc_${randomUUID().replace(/-/g, "")}`;
      await db.updateTenant(req.params.id, { api_key: newKey });
      res.redirect(`/admin/tenants/${req.params.id}`);
    } catch (err) {
      console.error("Reset key error:", err);
      res.status(500).send("Error resetting key.");
    }
  });

  return router;
}
