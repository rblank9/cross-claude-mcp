/**
 * Database abstraction layer.
 * Uses SQLite locally, PostgreSQL on Railway (when DATABASE_URL is set).
 * SaaS mode adds multi-tenant isolation via TenantDB wrapper.
 */

// --- Original schema (non-SaaS / SQLite local mode) ---

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS channels (
    name TEXT PRIMARY KEY,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    channel TEXT NOT NULL REFERENCES channels(name),
    sender TEXT NOT NULL,
    content TEXT NOT NULL,
    message_type TEXT DEFAULT 'message',
    in_reply_to INTEGER REFERENCES messages(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS instances (
    instance_id TEXT PRIMARY KEY,
    description TEXT,
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'online'
  );

  CREATE TABLE IF NOT EXISTS shared_data (
    key TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_by TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`;

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

const INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
`;

const SEED_SQL = `INSERT INTO channels (name, description) VALUES ('general', 'Default channel for cross-instance communication') ON CONFLICT (name) DO NOTHING`;

// --- SQLite Implementation (unchanged -- local mode, no tenants) ---

class SqliteDB {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  async init(Database) {
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    const sqliteSchema = SCHEMA_SQL.replace("SERIAL PRIMARY KEY", "INTEGER PRIMARY KEY AUTOINCREMENT")
      .replace(/TIMESTAMP DEFAULT CURRENT_TIMESTAMP/g, "TEXT DEFAULT (datetime('now'))");
    this.db.exec(sqliteSchema);
    this.db.exec(INDEX_SQL);
    this.db.prepare(`INSERT OR IGNORE INTO channels (name, description) VALUES ('general', 'Default channel for cross-instance communication')`).run();
  }

  registerInstance(instanceId, description) {
    this.db.prepare(
      `INSERT INTO instances (instance_id, description, last_seen, status)
       VALUES (?, ?, datetime('now'), 'online')
       ON CONFLICT(instance_id) DO UPDATE SET
         description = excluded.description,
         last_seen = datetime('now'),
         status = 'online'`
    ).run(instanceId, description);
  }

  heartbeat(instanceId) {
    this.db.prepare(
      `UPDATE instances SET last_seen = datetime('now'), status = 'online' WHERE instance_id = ?`
    ).run(instanceId);
  }

  markOffline(instanceId) {
    try {
      this.db.prepare(`UPDATE instances SET status = 'offline' WHERE instance_id = ?`).run(instanceId);
    } catch { /* DB may be closed during shutdown */ }
  }

  markStaleOffline(thresholdSeconds) {
    this.db.prepare(
      `UPDATE instances SET status = 'offline'
       WHERE status = 'online'
         AND last_seen < datetime('now', '-${thresholdSeconds} seconds')`
    ).run();
  }

  createChannel(name, description) {
    this.db.prepare(`INSERT OR IGNORE INTO channels (name, description) VALUES (?, ?)`).run(name, description);
  }

  listChannels() {
    return this.db.prepare(`SELECT * FROM channels ORDER BY name`).all();
  }

  sendMessage(channel, sender, content, messageType, inReplyTo) {
    const result = this.db.prepare(
      `INSERT INTO messages (channel, sender, content, message_type, in_reply_to) VALUES (?, ?, ?, ?, ?)`
    ).run(channel, sender, content, messageType, inReplyTo);
    return result.lastInsertRowid;
  }

  getMessages(channel, limit) {
    return this.db.prepare(
      `SELECT m.*, (SELECT COUNT(*) FROM messages r WHERE r.in_reply_to = m.id) as reply_count
       FROM messages m WHERE m.channel = ? ORDER BY m.created_at DESC LIMIT ?`
    ).all(channel, limit);
  }

  getMessagesSince(channel, afterId) {
    return this.db.prepare(
      `SELECT m.*, (SELECT COUNT(*) FROM messages r WHERE r.in_reply_to = m.id) as reply_count
       FROM messages m WHERE m.channel = ? AND m.id > ? ORDER BY m.created_at ASC`
    ).all(channel, afterId);
  }

  getUnread(channel, afterId, instanceId) {
    return this.db.prepare(
      `SELECT m.*, (SELECT COUNT(*) FROM messages r WHERE r.in_reply_to = m.id) as reply_count
       FROM messages m WHERE m.channel = ? AND m.id > ? AND m.sender != ? ORDER BY m.created_at ASC`
    ).all(channel, afterId, instanceId);
  }

  getMessage(id) {
    return this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id);
  }

  getReplies(messageId) {
    return this.db.prepare(`SELECT * FROM messages WHERE in_reply_to = ? ORDER BY created_at ASC`).all(messageId);
  }

  listInstances() {
    return this.db.prepare(`SELECT * FROM instances ORDER BY last_seen DESC`).all();
  }

  searchMessages(query, limit) {
    return this.db.prepare(
      `SELECT m.*, (SELECT COUNT(*) FROM messages r WHERE r.in_reply_to = m.id) as reply_count
       FROM messages m WHERE m.content LIKE ? ORDER BY m.created_at DESC LIMIT ?`
    ).all(`%${query}%`, limit);
  }

  shareData(key, content, createdBy, description) {
    this.db.prepare(
      `INSERT INTO shared_data (key, content, created_by, description, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         content = excluded.content,
         created_by = excluded.created_by,
         description = excluded.description,
         created_at = datetime('now')`
    ).run(key, content, createdBy, description);
  }

  getSharedData(key) {
    return this.db.prepare(`SELECT * FROM shared_data WHERE key = ?`).get(key);
  }

  listSharedData() {
    return this.db.prepare(
      `SELECT key, created_by, description, length(content) as size_bytes, created_at FROM shared_data ORDER BY created_at DESC`
    ).all();
  }

  deleteSharedData(key) {
    this.db.prepare(`DELETE FROM shared_data WHERE key = ?`).run(key);
  }
}

// --- PostgreSQL Implementation (non-SaaS, single-tenant) ---

class PostgresDB {
  constructor(connectionString) {
    this.connectionString = connectionString;
    this.pool = null;
  }

  async init(pg) {
    this.pool = new pg.Pool({ connectionString: this.connectionString });
    await this.pool.query(SCHEMA_SQL);
    await this.pool.query(INDEX_SQL);
    await this.pool.query(SEED_SQL);
  }

  async registerInstance(instanceId, description) {
    await this.pool.query(
      `INSERT INTO instances (instance_id, description, last_seen, status)
       VALUES ($1, $2, NOW(), 'online')
       ON CONFLICT(instance_id) DO UPDATE SET
         description = EXCLUDED.description,
         last_seen = NOW(),
         status = 'online'`,
      [instanceId, description]
    );
  }

  async heartbeat(instanceId) {
    await this.pool.query(
      `UPDATE instances SET last_seen = NOW(), status = 'online' WHERE instance_id = $1`,
      [instanceId]
    );
  }

  async markOffline(instanceId) {
    try {
      await this.pool.query(`UPDATE instances SET status = 'offline' WHERE instance_id = $1`, [instanceId]);
    } catch { /* ignore */ }
  }

  async markStaleOffline(thresholdSeconds) {
    await this.pool.query(
      `UPDATE instances SET status = 'offline'
       WHERE status = 'online'
         AND last_seen < NOW() - INTERVAL '1 second' * $1`,
      [thresholdSeconds]
    );
  }

  async createChannel(name, description) {
    await this.pool.query(
      `INSERT INTO channels (name, description) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
      [name, description]
    );
  }

  async listChannels() {
    const result = await this.pool.query(`SELECT * FROM channels ORDER BY name`);
    return result.rows;
  }

  async sendMessage(channel, sender, content, messageType, inReplyTo) {
    const result = await this.pool.query(
      `INSERT INTO messages (channel, sender, content, message_type, in_reply_to) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [channel, sender, content, messageType, inReplyTo]
    );
    return result.rows[0].id;
  }

  async getMessages(channel, limit) {
    const result = await this.pool.query(
      `SELECT m.*, (SELECT COUNT(*)::int FROM messages r WHERE r.in_reply_to = m.id) as reply_count
       FROM messages m WHERE m.channel = $1 ORDER BY m.created_at DESC LIMIT $2`,
      [channel, limit]
    );
    return result.rows;
  }

  async getMessagesSince(channel, afterId) {
    const result = await this.pool.query(
      `SELECT m.*, (SELECT COUNT(*)::int FROM messages r WHERE r.in_reply_to = m.id) as reply_count
       FROM messages m WHERE m.channel = $1 AND m.id > $2 ORDER BY m.created_at ASC`,
      [channel, afterId]
    );
    return result.rows;
  }

  async getUnread(channel, afterId, instanceId) {
    const result = await this.pool.query(
      `SELECT m.*, (SELECT COUNT(*)::int FROM messages r WHERE r.in_reply_to = m.id) as reply_count
       FROM messages m WHERE m.channel = $1 AND m.id > $2 AND m.sender != $3 ORDER BY m.created_at ASC`,
      [channel, afterId, instanceId]
    );
    return result.rows;
  }

  async getMessage(id) {
    const result = await this.pool.query(`SELECT * FROM messages WHERE id = $1`, [id]);
    return result.rows[0] || null;
  }

  async getReplies(messageId) {
    const result = await this.pool.query(
      `SELECT * FROM messages WHERE in_reply_to = $1 ORDER BY created_at ASC`,
      [messageId]
    );
    return result.rows;
  }

  async listInstances() {
    const result = await this.pool.query(`SELECT * FROM instances ORDER BY last_seen DESC`);
    return result.rows;
  }

  async searchMessages(query, limit) {
    const result = await this.pool.query(
      `SELECT m.*, (SELECT COUNT(*)::int FROM messages r WHERE r.in_reply_to = m.id) as reply_count
       FROM messages m WHERE m.content ILIKE $1 ORDER BY m.created_at DESC LIMIT $2`,
      [`%${query}%`, limit]
    );
    return result.rows;
  }

  async shareData(key, content, createdBy, description) {
    await this.pool.query(
      `INSERT INTO shared_data (key, content, created_by, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(key) DO UPDATE SET
         content = EXCLUDED.content,
         created_by = EXCLUDED.created_by,
         description = EXCLUDED.description,
         created_at = NOW()`,
      [key, content, createdBy, description]
    );
  }

  async getSharedData(key) {
    const result = await this.pool.query(`SELECT * FROM shared_data WHERE key = $1`, [key]);
    return result.rows[0] || null;
  }

  async listSharedData() {
    const result = await this.pool.query(
      `SELECT key, created_by, description, length(content) as size_bytes, created_at FROM shared_data ORDER BY created_at DESC`
    );
    return result.rows;
  }

  async deleteSharedData(key) {
    await this.pool.query(`DELETE FROM shared_data WHERE key = $1`, [key]);
  }
}

// --- SaaS PostgreSQL Implementation (multi-tenant) ---

class SaasPostgresDB {
  constructor(connectionString) {
    this.connectionString = connectionString;
    this.pool = null;
  }

  async init(pg) {
    this.pool = new pg.Pool({ connectionString: this.connectionString });
    await this.pool.query(SAAS_SCHEMA_SQL);
    await this.pool.query(SAAS_INDEX_SQL);
    // Migrate existing FK constraints to add ON DELETE CASCADE
    await this.migrateConstraints();
  }

  async migrateConstraints() {
    // For each child table, drop the old FK and re-add with CASCADE if needed
    const migrations = [
      { table: 'usage_log', constraint: 'usage_log_tenant_id_fkey', col: 'tenant_id', ref: 'tenants(id)', action: 'CASCADE' },
      { table: 'channels', constraint: 'channels_tenant_id_fkey', col: 'tenant_id', ref: 'tenants(id)', action: 'CASCADE' },
      { table: 'instances', constraint: 'instances_tenant_id_fkey', col: 'tenant_id', ref: 'tenants(id)', action: 'CASCADE' },
      { table: 'shared_data', constraint: 'shared_data_tenant_id_fkey', col: 'tenant_id', ref: 'tenants(id)', action: 'CASCADE' },
    ];
    for (const m of migrations) {
      try {
        // Check if the constraint already has CASCADE
        const check = await this.pool.query(
          `SELECT confdeltype FROM pg_constraint WHERE conname = $1`, [m.constraint]
        );
        if (check.rows[0] && check.rows[0].confdeltype === 'c') continue; // already CASCADE
        if (check.rows[0]) {
          await this.pool.query(`ALTER TABLE ${m.table} DROP CONSTRAINT ${m.constraint}`);
          await this.pool.query(`ALTER TABLE ${m.table} ADD CONSTRAINT ${m.constraint} FOREIGN KEY (${m.col}) REFERENCES ${m.ref} ON DELETE ${m.action}`);
        }
      } catch { /* constraint may not exist on fresh DBs */ }
    }
    // Also fix messages.in_reply_to to SET NULL on delete
    try {
      const check = await this.pool.query(
        `SELECT confdeltype FROM pg_constraint WHERE conname = 'messages_in_reply_to_fkey'`
      );
      if (check.rows[0] && check.rows[0].confdeltype !== 'n') {
        await this.pool.query(`ALTER TABLE messages DROP CONSTRAINT messages_in_reply_to_fkey`);
        await this.pool.query(`ALTER TABLE messages ADD CONSTRAINT messages_in_reply_to_fkey FOREIGN KEY (in_reply_to) REFERENCES messages(id) ON DELETE SET NULL`);
      }
    } catch { /* ignore */ }
    // Fix messages FK to channels
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

  // --- Tenant management (used by auth/billing/admin, not by MCP tools) ---

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
    // ON DELETE CASCADE handles child rows (usage_log, channels, messages, instances, shared_data)
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

// --- TenantDB Wrapper (same interface as SqliteDB/PostgresDB, scoped to tenant) ---

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

export function isSaasMode() {
  return !!(process.env.STRIPE_SECRET_KEY && process.env.DATABASE_URL);
}

export async function createDB() {
  if (process.env.DATABASE_URL) {
    const pg = await import("pg");

    if (isSaasMode()) {
      const db = new SaasPostgresDB(process.env.DATABASE_URL);
      await db.init(pg.default || pg);
      return db;
    }

    const db = new PostgresDB(process.env.DATABASE_URL);
    await db.init(pg.default || pg);
    return db;
  } else {
    const { default: Database } = await import("better-sqlite3");
    const { existsSync, mkdirSync } = await import("fs");
    const { join } = await import("path");
    const { homedir } = await import("os");

    const dataDir = join(homedir(), ".cross-claude-mcp");
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    const db = new SqliteDB(join(dataDir, "messages.db"));
    await db.init(Database);
    return db;
  }
}
