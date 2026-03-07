# Cross-Claude MCP

## Architecture: Dual-Repo Model

**Public (open-source)**: This repo (`rblank9/cross-claude-mcp`) — MIT licensed
- `server.mjs` — Entry point (stdio + HTTP modes)
- `db.mjs` — SQLite (local) / PostgreSQL (remote) abstraction
- `tools.mjs` — Shared MCP tool registration (used by both repos)
- `test.mjs` — Integration tests

**Private (SaaS)**: `rblank9/cross-claude-mcp-saas` at `/Users/rblank/Projects/cross-claude-mcp-saas/`
- Flat structure (no saas/ subdirectory), standalone deployable
- `server-saas.mjs`, `db-saas.mjs`, `auth.mjs`, `billing.mjs`, `dashboard.mjs`, `admin.mjs`, `rate-limit.mjs`
- `tools.mjs` — Copy from this repo (shared MCP tools)

## Development Workflow

- **Source of truth for SaaS code**: `saas/` directory in THIS repo
- **Deployment**: Copy `saas/*.mjs` + `tools.mjs` + `README.md` to private repo, adjust imports (`../tools.mjs` → `./tools.mjs`, README path), commit, push
- **Railway SaaS** deploys from the private repo via Procfile (`web: node server-saas.mjs`)
- **Railway open-source** deploys from this repo's `main` branch

## Key Rules

- NEVER put SaaS-only code (auth, billing, admin, multi-tenancy) into `server.mjs` or `db.mjs`
- `tools.mjs` is the ONE shared file — changes here must be copied to the private repo
- The SaaS DB schema has `tenant_id` on all tables with ON DELETE CASCADE — open-source schema does not
- Procfile controls Railway entry point — not `npm start`
- Stripe webhook route MUST use `express.raw()` BEFORE any `express.json()` middleware
