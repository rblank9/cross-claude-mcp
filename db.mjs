/**
 * Database abstraction layer.
 * Uses SQLite locally, PostgreSQL on Railway (when DATABASE_URL is set).
 */

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

const INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
`;

/**
 * Normalize channel names: lowercase, replace spaces/underscores with hyphens,
 * strip non-alphanumeric (except hyphens), collapse multiple hyphens.
 */
export function normalizeChannelName(name) {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

const SEED_SQL = `INSERT INTO channels (name, description) VALUES ('general', 'Default channel for cross-instance communication') ON CONFLICT (name) DO NOTHING`;

// --- SQLite Implementation ---

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
         AND last_seen < datetime('now', '-' || ? || ' seconds')`
    ).run(thresholdSeconds);
  }

  createChannel(name, description) {
    this.db.prepare(`INSERT OR IGNORE INTO channels (name, description) VALUES (?, ?)`).run(name, description);
  }

  listChannels() {
    return this.db.prepare(`SELECT * FROM channels ORDER BY name`).all();
  }

  listChannelsWithActivity() {
    return this.db.prepare(`
      SELECT c.*,
        COALESCE(s.message_count, 0) as message_count,
        s.last_message_at,
        s.active_senders
      FROM channels c
      LEFT JOIN (
        SELECT channel,
          COUNT(*) as message_count,
          MAX(created_at) as last_message_at,
          GROUP_CONCAT(DISTINCT sender) as active_senders
        FROM messages
        GROUP BY channel
      ) s ON c.name = s.channel
      ORDER BY s.last_message_at DESC NULLS LAST, c.name
    `).all();
  }

  findChannels(query) {
    const pattern = `%${query}%`;
    return this.db.prepare(`
      SELECT c.*,
        COALESCE(s.message_count, 0) as message_count,
        s.last_message_at
      FROM channels c
      LEFT JOIN (
        SELECT channel, COUNT(*) as message_count, MAX(created_at) as last_message_at
        FROM messages GROUP BY channel
      ) s ON c.name = s.channel
      WHERE c.name LIKE ? OR c.description LIKE ?
      ORDER BY s.last_message_at DESC NULLS LAST
    `).all(pattern, pattern);
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

  cleanup(maxAgeDays = 7) {
    const interval = `-${maxAgeDays} days`;
    const msgs = this.db.prepare(`DELETE FROM messages WHERE created_at < datetime('now', ?)`).run(interval);
    const inst = this.db.prepare(`DELETE FROM instances WHERE last_seen < datetime('now', ?)`).run(interval);
    const data = this.db.prepare(`DELETE FROM shared_data WHERE created_at < datetime('now', ?)`).run(interval);
    return { messages: msgs.changes, instances: inst.changes, shared_data: data.changes };
  }

  purgeAll() {
    this.db.prepare(`DELETE FROM messages`).run();
    this.db.prepare(`DELETE FROM instances`).run();
    this.db.prepare(`DELETE FROM shared_data`).run();
  }
}

// --- PostgreSQL Implementation ---

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

  async listChannelsWithActivity() {
    const result = await this.pool.query(`
      SELECT c.*,
        COALESCE(s.message_count, 0)::int as message_count,
        s.last_message_at,
        s.active_senders
      FROM channels c
      LEFT JOIN (
        SELECT channel,
          COUNT(*)::int as message_count,
          MAX(created_at) as last_message_at,
          STRING_AGG(DISTINCT sender, ', ') as active_senders
        FROM messages
        GROUP BY channel
      ) s ON c.name = s.channel
      ORDER BY s.last_message_at DESC NULLS LAST, c.name
    `);
    return result.rows;
  }

  async findChannels(query) {
    const pattern = `%${query}%`;
    const result = await this.pool.query(`
      SELECT c.*,
        COALESCE(s.message_count, 0)::int as message_count,
        s.last_message_at
      FROM channels c
      LEFT JOIN (
        SELECT channel, COUNT(*)::int as message_count, MAX(created_at) as last_message_at
        FROM messages GROUP BY channel
      ) s ON c.name = s.channel
      WHERE c.name ILIKE $1 OR c.description ILIKE $1
      ORDER BY s.last_message_at DESC NULLS LAST
    `, [pattern]);
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

  async cleanup(maxAgeDays = 7) {
    const interval = `${maxAgeDays} days`;
    const msgs = await this.pool.query(`DELETE FROM messages WHERE created_at < NOW() - INTERVAL '1 day' * $1`, [maxAgeDays]);
    const inst = await this.pool.query(`DELETE FROM instances WHERE last_seen < NOW() - INTERVAL '1 day' * $1`, [maxAgeDays]);
    const data = await this.pool.query(`DELETE FROM shared_data WHERE created_at < NOW() - INTERVAL '1 day' * $1`, [maxAgeDays]);
    return { messages: msgs.rowCount, instances: inst.rowCount, shared_data: data.rowCount };
  }

  async purgeAll() {
    await this.pool.query(`DELETE FROM messages`);
    await this.pool.query(`DELETE FROM instances`);
    await this.pool.query(`DELETE FROM shared_data`);
  }
}

// --- Factory ---

export async function createDB() {
  if (process.env.DATABASE_URL) {
    const pg = await import("pg");
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
