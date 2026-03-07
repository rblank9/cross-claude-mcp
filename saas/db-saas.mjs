/**
 * SaaS database layer — multi-tenant PostgreSQL.
 * SaasPostgresDB handles tenant management (auth, billing, admin).
 * TenantDB wraps it to scope all MCP operations to a single tenant.
 */

// --- SaaS schema (multi-tenant PostgreSQL) ---

const SAAS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    status TEXT DEFAULT 'active',
    plan TEXT DEFAULT 'free',
    api_key TEXT UNIQUE NOT NULL,
    stripe_customer_id TEXT UNIQUE,
    stripe_subscription_id TEXT,
    messages_this_month INT DEFAULT 0,
    messages_reset_at TIMESTAMP DEFAULT NOW(),
    is_admin BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS usage_log (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    timestamp TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS channels (
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, name)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    sender TEXT NOT NULL,
    content TEXT NOT NULL,
    message_type TEXT DEFAULT 'message',
    in_reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id, channel) REFERENCES channels(tenant_id, name) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS instances (
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    instance_id TEXT NOT NULL,
    description TEXT,
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'online',
    PRIMARY KEY (tenant_id, instance_id)
  );

  CREATE TABLE IF NOT EXISTS shared_data (
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    content TEXT NOT NULL,
    created_by TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, key)
  );
`;

const SAAS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_messages_tenant_channel ON messages(tenant_id, channel);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_log_tenant ON usage_log(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_tenants_api_key ON tenants(api_key);
  CREATE INDEX IF NOT EXISTS idx_tenants_email ON tenants(email);
`;

// --- SaasPostgresDB: tenant management + admin queries ---

export class SaasPostgresDB {
  constructor(connectionString) {
    this.connectionString = connectionString;
    this.pool = null;
  }

  async init(pg) {
    this.pool = new pg.Pool({ connectionString: this.connectionString });
    await this.pool.query(SAAS_SCHEMA_SQL);
    await this.pool.query(SAAS_INDEX_SQL);
    await this.migrateConstraints();
  }

  async migrateConstraints() {
    const migrations = [
      { table: 'usage_log', constraint: 'usage_log_tenant_id_fkey', col: 'tenant_id', ref: 'tenants(id)', action: 'CASCADE' },
      { table: 'channels', constraint: 'channels_tenant_id_fkey', col: 'tenant_id', ref: 'tenants(id)', action: 'CASCADE' },
      { table: 'instances', constraint: 'instances_tenant_id_fkey', col: 'tenant_id', ref: 'tenants(id)', action: 'CASCADE' },
      { table: 'shared_data', constraint: 'shared_data_tenant_id_fkey', col: 'tenant_id', ref: 'tenants(id)', action: 'CASCADE' },
    ];
    for (const m of migrations) {
      try {
        const check = await this.pool.query(
          `SELECT confdeltype FROM pg_constraint WHERE conname = $1`, [m.constraint]
        );
        if (check.rows[0] && check.rows[0].confdeltype === 'c') continue;
        if (check.rows[0]) {
          await this.pool.query(`ALTER TABLE ${m.table} DROP CONSTRAINT ${m.constraint}`);
          await this.pool.query(`ALTER TABLE ${m.table} ADD CONSTRAINT ${m.constraint} FOREIGN KEY (${m.col}) REFERENCES ${m.ref} ON DELETE ${m.action}`);
        }
      } catch { /* constraint may not exist on fresh DBs */ }
    }
    try {
      const check = await this.pool.query(
        `SELECT confdeltype FROM pg_constraint WHERE conname = 'messages_in_reply_to_fkey'`
      );
      if (check.rows[0] && check.rows[0].confdeltype !== 'n') {
        await this.pool.query(`ALTER TABLE messages DROP CONSTRAINT messages_in_reply_to_fkey`);
        await this.pool.query(`ALTER TABLE messages ADD CONSTRAINT messages_in_reply_to_fkey FOREIGN KEY (in_reply_to) REFERENCES messages(id) ON DELETE SET NULL`);
      }
    } catch { /* ignore */ }
    try {
      const check = await this.pool.query(
        `SELECT confdeltype FROM pg_constraint WHERE conname = 'messages_tenant_id_channel_fkey'`
      );
      if (check.rows[0] && check.rows[0].confdeltype !== 'c') {
        await this.pool.query(`ALTER TABLE messages DROP CONSTRAINT messages_tenant_id_channel_fkey`);
        await this.pool.query(`ALTER TABLE messages ADD CONSTRAINT messages_tenant_id_channel_fkey FOREIGN KEY (tenant_id, channel) REFERENCES channels(tenant_id, name) ON DELETE CASCADE`);
      }
    } catch { /* ignore */ }
  }

  // --- Tenant CRUD ---

  async createTenant(id, email, passwordHash, name, apiKey, isAdmin = false) {
    await this.pool.query(
      `INSERT INTO tenants (id, email, password_hash, name, api_key, is_admin)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, email, passwordHash, name, apiKey, isAdmin]
    );
  }

  async getTenantByEmail(email) {
    const result = await this.pool.query(`SELECT * FROM tenants WHERE email = $1`, [email]);
    return result.rows[0] || null;
  }

  async getTenantByApiKey(apiKey) {
    const result = await this.pool.query(`SELECT * FROM tenants WHERE api_key = $1`, [apiKey]);
    return result.rows[0] || null;
  }

  async getTenantById(id) {
    const result = await this.pool.query(`SELECT * FROM tenants WHERE id = $1`, [id]);
    return result.rows[0] || null;
  }

  async updateTenant(id, fields) {
    const ALLOWED_FIELDS = new Set([
      'email', 'password_hash', 'name', 'status', 'plan',
      'api_key', 'stripe_customer_id', 'stripe_subscription_id',
      'messages_this_month', 'messages_reset_at', 'is_admin',
    ]);
    const sets = [];
    const values = [];
    let i = 1;
    for (const [key, value] of Object.entries(fields)) {
      if (!ALLOWED_FIELDS.has(key)) throw new Error(`Disallowed field: ${key}`);
      sets.push(`${key} = $${i}`);
      values.push(value);
      i++;
    }
    values.push(id);
    await this.pool.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $${i}`, values);
  }

  async deleteTenant(id) {
    const result = await this.pool.query(`DELETE FROM tenants WHERE id = $1 RETURNING id`, [id]);
    return result.rowCount > 0;
  }

  async listTenants() {
    const result = await this.pool.query(
      `SELECT id, email, name, status, plan, messages_this_month, is_admin, created_at FROM tenants ORDER BY created_at DESC`
    );
    return result.rows;
  }

  async getTenantStats() {
    const result = await this.pool.query(`
      SELECT
        COUNT(*) as total_tenants,
        COUNT(*) FILTER (WHERE plan = 'free') as free_count,
        COUNT(*) FILTER (WHERE plan = 'starter') as starter_count,
        COUNT(*) FILTER (WHERE plan = 'pro') as pro_count,
        COUNT(*) FILTER (WHERE status = 'active') as active_count
      FROM tenants
    `);
    return result.rows[0];
  }

  async logUsage(tenantId, action) {
    await this.pool.query(
      `INSERT INTO usage_log (tenant_id, action) VALUES ($1, $2)`,
      [tenantId, action]
    );
  }

  async getRecentUsage(tenantId, limit = 50) {
    const result = await this.pool.query(
      `SELECT * FROM usage_log WHERE tenant_id = $1 ORDER BY timestamp DESC LIMIT $2`,
      [tenantId, limit]
    );
    return result.rows;
  }

  async getUsageToday() {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int as count FROM usage_log WHERE timestamp > NOW() - INTERVAL '1 day'`
    );
    return result.rows[0].count;
  }

  async resetMonthlyUsage(tenantId) {
    await this.pool.query(
      `UPDATE tenants SET messages_this_month = 0, messages_reset_at = NOW() WHERE id = $1`,
      [tenantId]
    );
  }

  async incrementMessageCount(tenantId) {
    await this.pool.query(
      `UPDATE tenants SET messages_this_month = messages_this_month + 1 WHERE id = $1`,
      [tenantId]
    );
  }

  async seedTenantChannel(tenantId) {
    await this.pool.query(
      `INSERT INTO channels (tenant_id, name, description)
       VALUES ($1, 'general', 'Default channel for cross-instance communication')
       ON CONFLICT (tenant_id, name) DO NOTHING`,
      [tenantId]
    );
  }

  async countChannels(tenantId) {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int as count FROM channels WHERE tenant_id = $1`, [tenantId]
    );
    return result.rows[0].count;
  }

  async countInstances(tenantId) {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int as count FROM instances WHERE tenant_id = $1 AND status = 'online'`, [tenantId]
    );
    return result.rows[0].count;
  }

  async getSharedDataSize(tenantId) {
    const result = await this.pool.query(
      `SELECT COALESCE(SUM(length(content)), 0)::bigint as total_bytes FROM shared_data WHERE tenant_id = $1`, [tenantId]
    );
    return Number(result.rows[0].total_bytes);
  }
}

// --- TenantDB: same interface as SqliteDB/PostgresDB, scoped to one tenant ---

export class TenantDB {
  constructor(saasDb, tenantId) {
    this.db = saasDb;
    this.tenantId = tenantId;
  }

  async registerInstance(instanceId, description) {
    await this.db.pool.query(
      `INSERT INTO instances (tenant_id, instance_id, description, last_seen, status)
       VALUES ($1, $2, $3, NOW(), 'online')
       ON CONFLICT(tenant_id, instance_id) DO UPDATE SET
         description = EXCLUDED.description,
         last_seen = NOW(),
         status = 'online'`,
      [this.tenantId, instanceId, description]
    );
  }

  async heartbeat(instanceId) {
    await this.db.pool.query(
      `UPDATE instances SET last_seen = NOW(), status = 'online'
       WHERE tenant_id = $1 AND instance_id = $2`,
      [this.tenantId, instanceId]
    );
  }

  async markOffline(instanceId) {
    try {
      await this.db.pool.query(
        `UPDATE instances SET status = 'offline' WHERE tenant_id = $1 AND instance_id = $2`,
        [this.tenantId, instanceId]
      );
    } catch { /* ignore */ }
  }

  async markStaleOffline(thresholdSeconds) {
    await this.db.pool.query(
      `UPDATE instances SET status = 'offline'
       WHERE tenant_id = $1 AND status = 'online'
         AND last_seen < NOW() - INTERVAL '1 second' * $2`,
      [this.tenantId, thresholdSeconds]
    );
  }

  async createChannel(name, description) {
    await this.db.pool.query(
      `INSERT INTO channels (tenant_id, name, description) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, name) DO NOTHING`,
      [this.tenantId, name, description]
    );
  }

  async listChannels() {
    const result = await this.db.pool.query(
      `SELECT name, description, created_at FROM channels WHERE tenant_id = $1 ORDER BY name`,
      [this.tenantId]
    );
    return result.rows;
  }

  async sendMessage(channel, sender, content, messageType, inReplyTo) {
    const result = await this.db.pool.query(
      `INSERT INTO messages (tenant_id, channel, sender, content, message_type, in_reply_to)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [this.tenantId, channel, sender, content, messageType, inReplyTo]
    );
    await this.db.incrementMessageCount(this.tenantId);
    await this.db.logUsage(this.tenantId, 'send_message');
    return result.rows[0].id;
  }

  async getMessages(channel, limit) {
    const result = await this.db.pool.query(
      `SELECT m.*, (SELECT COUNT(*)::int FROM messages r WHERE r.in_reply_to = m.id) as reply_count
       FROM messages m WHERE m.tenant_id = $1 AND m.channel = $2 ORDER BY m.created_at DESC LIMIT $3`,
      [this.tenantId, channel, limit]
    );
    return result.rows;
  }

  async getMessagesSince(channel, afterId) {
    const result = await this.db.pool.query(
      `SELECT m.*, (SELECT COUNT(*)::int FROM messages r WHERE r.in_reply_to = m.id) as reply_count
       FROM messages m WHERE m.tenant_id = $1 AND m.channel = $2 AND m.id > $3 ORDER BY m.created_at ASC`,
      [this.tenantId, channel, afterId]
    );
    return result.rows;
  }

  async getUnread(channel, afterId, instanceId) {
    const result = await this.db.pool.query(
      `SELECT m.*, (SELECT COUNT(*)::int FROM messages r WHERE r.in_reply_to = m.id) as reply_count
       FROM messages m WHERE m.tenant_id = $1 AND m.channel = $2 AND m.id > $3 AND m.sender != $4
       ORDER BY m.created_at ASC`,
      [this.tenantId, channel, afterId, instanceId]
    );
    return result.rows;
  }

  async getMessage(id) {
    const result = await this.db.pool.query(
      `SELECT * FROM messages WHERE tenant_id = $1 AND id = $2`,
      [this.tenantId, id]
    );
    return result.rows[0] || null;
  }

  async getReplies(messageId) {
    const result = await this.db.pool.query(
      `SELECT * FROM messages WHERE tenant_id = $1 AND in_reply_to = $2 ORDER BY created_at ASC`,
      [this.tenantId, messageId]
    );
    return result.rows;
  }

  async listInstances() {
    const result = await this.db.pool.query(
      `SELECT instance_id, description, last_seen, status FROM instances
       WHERE tenant_id = $1 ORDER BY last_seen DESC`,
      [this.tenantId]
    );
    return result.rows;
  }

  async searchMessages(query, limit) {
    const result = await this.db.pool.query(
      `SELECT m.*, (SELECT COUNT(*)::int FROM messages r WHERE r.in_reply_to = m.id) as reply_count
       FROM messages m WHERE m.tenant_id = $1 AND m.content ILIKE $2 ORDER BY m.created_at DESC LIMIT $3`,
      [this.tenantId, `%${query}%`, limit]
    );
    return result.rows;
  }

  async shareData(key, content, createdBy, description) {
    await this.db.pool.query(
      `INSERT INTO shared_data (tenant_id, key, content, created_by, description)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(tenant_id, key) DO UPDATE SET
         content = EXCLUDED.content,
         created_by = EXCLUDED.created_by,
         description = EXCLUDED.description,
         created_at = NOW()`,
      [this.tenantId, key, content, createdBy, description]
    );
    await this.db.logUsage(this.tenantId, 'share_data');
  }

  async getSharedData(key) {
    const result = await this.db.pool.query(
      `SELECT key, content, created_by, description, created_at FROM shared_data
       WHERE tenant_id = $1 AND key = $2`,
      [this.tenantId, key]
    );
    return result.rows[0] || null;
  }

  async listSharedData() {
    const result = await this.db.pool.query(
      `SELECT key, created_by, description, length(content) as size_bytes, created_at
       FROM shared_data WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [this.tenantId]
    );
    return result.rows;
  }

  async deleteSharedData(key) {
    await this.db.pool.query(
      `DELETE FROM shared_data WHERE tenant_id = $1 AND key = $2`,
      [this.tenantId, key]
    );
  }
}

// --- Factory ---

export async function createSaasDB() {
  const pg = await import("pg");
  const db = new SaasPostgresDB(process.env.DATABASE_URL);
  await db.init(pg.default || pg);
  return db;
}
