#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// --- Database Setup ---

const DATA_DIR = join(homedir(), ".cross-claude-mcp");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = join(DATA_DIR, "messages.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    name TEXT PRIMARY KEY,
    description TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    sender TEXT NOT NULL,
    content TEXT NOT NULL,
    message_type TEXT DEFAULT 'message',
    in_reply_to INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (channel) REFERENCES channels(name),
    FOREIGN KEY (in_reply_to) REFERENCES messages(id)
  );

  CREATE TABLE IF NOT EXISTS instances (
    instance_id TEXT PRIMARY KEY,
    description TEXT,
    last_seen TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT 'online'
  );

  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
`);

// Ensure "general" channel exists
db.prepare(
  `INSERT OR IGNORE INTO channels (name, description) VALUES ('general', 'Default channel for cross-instance communication')`
).run();

// --- Process-level instance tracking ---

let currentInstanceId = null;
const STALE_THRESHOLD_SECONDS = 120;

function markOffline(instanceId) {
  if (!instanceId) return;
  try {
    db.prepare(
      `UPDATE instances SET status = 'offline' WHERE instance_id = ?`
    ).run(instanceId);
  } catch {
    // DB may already be closed during shutdown
  }
}

function touchHeartbeat() {
  if (!currentInstanceId) return;
  try {
    db.prepare(
      `UPDATE instances SET last_seen = datetime('now'), status = 'online' WHERE instance_id = ?`
    ).run(currentInstanceId);
  } catch {
    // Ignore errors during shutdown
  }
}

function markStaleInstancesOffline() {
  db.prepare(
    `UPDATE instances SET status = 'offline'
     WHERE status = 'online'
       AND last_seen < datetime('now', '-${STALE_THRESHOLD_SECONDS} seconds')`
  ).run();
}

// Clean shutdown: mark this instance offline
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    markOffline(currentInstanceId);
    process.exit(0);
  });
}

// Also handle normal exit and stdin close (Claude Code closed)
process.on("exit", () => markOffline(currentInstanceId));
process.stdin.on("end", () => {
  markOffline(currentInstanceId);
  process.exit(0);
});

// --- Prepared Statements ---

const stmts = {
  registerInstance: db.prepare(
    `INSERT INTO instances (instance_id, description, last_seen, status)
     VALUES (?, ?, datetime('now'), 'online')
     ON CONFLICT(instance_id) DO UPDATE SET
       description = excluded.description,
       last_seen = datetime('now'),
       status = 'online'`
  ),
  heartbeat: db.prepare(
    `UPDATE instances SET last_seen = datetime('now'), status = 'online'
     WHERE instance_id = ?`
  ),
  createChannel: db.prepare(
    `INSERT OR IGNORE INTO channels (name, description) VALUES (?, ?)`
  ),
  listChannels: db.prepare(`SELECT * FROM channels ORDER BY name`),
  sendMessage: db.prepare(
    `INSERT INTO messages (channel, sender, content, message_type, in_reply_to)
     VALUES (?, ?, ?, ?, ?)`
  ),
  getMessages: db.prepare(
    `SELECT m.*,
       (SELECT COUNT(*) FROM messages r WHERE r.in_reply_to = m.id) as reply_count
     FROM messages m
     WHERE m.channel = ?
     ORDER BY m.created_at DESC
     LIMIT ?`
  ),
  getMessagesSince: db.prepare(
    `SELECT m.*,
       (SELECT COUNT(*) FROM messages r WHERE r.in_reply_to = m.id) as reply_count
     FROM messages m
     WHERE m.channel = ? AND m.id > ?
     ORDER BY m.created_at ASC`
  ),
  getReplies: db.prepare(
    `SELECT * FROM messages WHERE in_reply_to = ? ORDER BY created_at ASC`
  ),
  getMessage: db.prepare(`SELECT * FROM messages WHERE id = ?`),
  listInstances: db.prepare(`SELECT * FROM instances ORDER BY last_seen DESC`),
  searchMessages: db.prepare(
    `SELECT m.*,
       (SELECT COUNT(*) FROM messages r WHERE r.in_reply_to = m.id) as reply_count
     FROM messages m
     WHERE m.content LIKE ?
     ORDER BY m.created_at DESC
     LIMIT ?`
  ),
  getUnread: db.prepare(
    `SELECT m.*,
       (SELECT COUNT(*) FROM messages r WHERE r.in_reply_to = m.id) as reply_count
     FROM messages m
     WHERE m.channel = ? AND m.id > ? AND m.sender != ?
     ORDER BY m.created_at ASC`
  ),
};

// --- MCP Server ---

const server = new McpServer({
  name: "cross-claude-mcp",
  version: "1.0.0",
});

// Tool: Register this instance
server.tool(
  "register",
  "Register this Claude Code instance with an identity. Call this first before using other tools.",
  {
    instance_id: z.string().describe("Unique name for this instance (e.g., 'alice', 'builder', 'reviewer')"),
    description: z.string().optional().describe("What this instance is working on"),
  },
  async ({ instance_id, description }) => {
    // If re-registering with a different id, mark old one offline
    if (currentInstanceId && currentInstanceId !== instance_id) {
      markOffline(currentInstanceId);
    }
    currentInstanceId = instance_id;
    stmts.registerInstance.run(instance_id, description || null);
    return {
      content: [
        {
          type: "text",
          text: `Registered as "${instance_id}". You can now send and receive messages. Use 'check_messages' to see if anyone has sent you anything.`,
        },
      ],
    };
  }
);

// Tool: Send a message
server.tool(
  "send_message",
  "Send a message to a channel for other Claude Code instances to read.",
  {
    channel: z.string().default("general").describe("Channel to post to (default: 'general')"),
    sender: z.string().describe("Your instance_id"),
    content: z.string().describe("The message content"),
    message_type: z
      .enum(["message", "request", "response", "status", "handoff", "done"])
      .default("message")
      .describe("Type of message: message (general), request (asking for something), response (answering), status (progress update), handoff (passing work), done (signals no more replies expected - other instances stop polling)"),
    in_reply_to: z.number().optional().describe("Message ID this is replying to"),
  },
  async ({ channel, sender, content, message_type, in_reply_to }) => {
    // Auto-create channel if needed
    stmts.createChannel.run(channel, null);
    touchHeartbeat();

    const result = stmts.sendMessage.run(channel, sender, content, message_type, in_reply_to || null);
    return {
      content: [
        {
          type: "text",
          text: `Message #${result.lastInsertRowid} sent to #${channel} as "${sender}" [${message_type}]`,
        },
      ],
    };
  }
);

// Tool: Check for new messages
server.tool(
  "check_messages",
  "Check for new messages in a channel. Use after_id to only get messages newer than a specific message.",
  {
    channel: z.string().default("general").describe("Channel to check"),
    after_id: z.number().optional().describe("Only show messages after this ID (for polling)"),
    limit: z.number().default(20).describe("Max messages to return"),
    instance_id: z.string().optional().describe("Your instance_id - if provided, filters out your own messages"),
  },
  async ({ channel, after_id, limit, instance_id }) => {
    touchHeartbeat();
    let messages;
    if (instance_id && after_id !== undefined) {
      messages = stmts.getUnread.all(channel, after_id, instance_id);
    } else if (after_id !== undefined) {
      messages = stmts.getMessagesSince.all(channel, after_id);
    } else {
      messages = stmts.getMessages.all(channel, limit);
      messages.reverse(); // Show oldest first
    }

    if (messages.length === 0) {
      return {
        content: [{ type: "text", text: `No ${after_id !== undefined ? "new " : ""}messages in #${channel}.` }],
      };
    }

    const formatted = messages
      .map(
        (m) =>
          `#${m.id} [${m.message_type}] ${m.sender} (${m.created_at})${m.in_reply_to ? ` (reply to #${m.in_reply_to})` : ""}${m.reply_count > 0 ? ` [${m.reply_count} replies]` : ""}:\n${m.content}`
      )
      .join("\n\n---\n\n");

    const lastId = messages[messages.length - 1].id;
    return {
      content: [
        {
          type: "text",
          text: `${messages.length} message(s) in #${channel}:\n\n${formatted}\n\n---\nLast message ID: ${lastId} (use as after_id to poll for new messages)`,
        },
      ],
    };
  }
);

// Tool: Get replies to a message
server.tool(
  "get_replies",
  "Get all replies to a specific message.",
  {
    message_id: z.number().describe("The message ID to get replies for"),
  },
  async ({ message_id }) => {
    const parent = stmts.getMessage.get(message_id);
    if (!parent) {
      return { content: [{ type: "text", text: `Message #${message_id} not found.` }] };
    }

    const replies = stmts.getReplies.all(message_id);
    if (replies.length === 0) {
      return { content: [{ type: "text", text: `No replies to message #${message_id}.` }] };
    }

    const formatted = replies
      .map((r) => `#${r.id} [${r.message_type}] ${r.sender} (${r.created_at}):\n${r.content}`)
      .join("\n\n---\n\n");

    return {
      content: [
        {
          type: "text",
          text: `Original #${parent.id} from ${parent.sender}: ${parent.content}\n\n${replies.length} replies:\n\n${formatted}`,
        },
      ],
    };
  }
);

// Tool: Create a channel
server.tool(
  "create_channel",
  "Create a named channel for organizing communication (e.g., 'code-review', 'bug-triage').",
  {
    name: z.string().describe("Channel name (lowercase, no spaces - use hyphens)"),
    description: z.string().optional().describe("What this channel is for"),
  },
  async ({ name, description }) => {
    stmts.createChannel.run(name, description || null);
    return {
      content: [{ type: "text", text: `Channel #${name} created.${description ? ` Purpose: ${description}` : ""}` }],
    };
  }
);

// Tool: List channels
server.tool("list_channels", "List all available channels.", {}, async () => {
  const channels = stmts.listChannels.all();
  const formatted = channels
    .map((c) => `#${c.name}${c.description ? ` - ${c.description}` : ""}`)
    .join("\n");
  return { content: [{ type: "text", text: `Channels:\n${formatted}` }] };
});

// Tool: List connected instances
server.tool(
  "list_instances",
  "See all Claude Code instances that have registered.",
  {},
  async () => {
    touchHeartbeat();
    markStaleInstancesOffline();
    const instances = stmts.listInstances.all();
    if (instances.length === 0) {
      return { content: [{ type: "text", text: "No instances registered yet." }] };
    }
    const formatted = instances
      .map(
        (i) =>
          `${i.instance_id} [${i.status}] - last seen: ${i.last_seen}${i.description ? ` - ${i.description}` : ""}`
      )
      .join("\n");
    return { content: [{ type: "text", text: `Registered instances:\n${formatted}` }] };
  }
);

// Tool: Search messages
server.tool(
  "search_messages",
  "Search message content across all channels.",
  {
    query: z.string().describe("Text to search for in messages"),
    limit: z.number().default(10).describe("Max results"),
  },
  async ({ query, limit }) => {
    const messages = stmts.searchMessages.all(`%${query}%`, limit);
    if (messages.length === 0) {
      return { content: [{ type: "text", text: `No messages matching "${query}".` }] };
    }

    const formatted = messages
      .map(
        (m) =>
          `#${m.id} [#${m.channel}] ${m.sender} (${m.created_at}) [${m.message_type}]:\n${m.content}`
      )
      .join("\n\n---\n\n");

    return {
      content: [{ type: "text", text: `${messages.length} result(s) for "${query}":\n\n${formatted}` }],
    };
  }
);

// Tool: Wait for a reply (polling loop)
server.tool(
  "wait_for_reply",
  "Poll a channel until a new message arrives from another instance, or until timeout. Use this after sending a message to wait for a response. Stops early if a 'done' message is received.",
  {
    channel: z.string().default("general").describe("Channel to poll"),
    after_id: z.number().describe("Only look for messages after this ID (use the ID from your last send_message)"),
    instance_id: z.string().describe("Your instance_id (to filter out your own messages)"),
    timeout_seconds: z.number().default(90).describe("Max seconds to wait before giving up (default: 90)"),
    poll_interval_seconds: z.number().default(5).describe("Seconds between polls (default: 5)"),
  },
  async ({ channel, after_id, instance_id, timeout_seconds, poll_interval_seconds }) => {
    const deadline = Date.now() + timeout_seconds * 1000;
    let lastCheckedId = after_id;

    while (Date.now() < deadline) {
      touchHeartbeat();

      const messages = stmts.getUnread.all(channel, lastCheckedId, instance_id);

      if (messages.length > 0) {
        const hasDone = messages.some((m) => m.message_type === "done");

        const formatted = messages
          .map(
            (m) =>
              `#${m.id} [${m.message_type}] ${m.sender} (${m.created_at})${m.in_reply_to ? ` (reply to #${m.in_reply_to})` : ""}:\n${m.content}`
          )
          .join("\n\n---\n\n");

        const lastId = messages[messages.length - 1].id;

        return {
          content: [
            {
              type: "text",
              text: `${messages.length} new message(s) in #${channel}:\n\n${formatted}\n\n---\nLast message ID: ${lastId}${hasDone ? "\n\nThe other instance signaled DONE — no further replies expected." : ""}`,
            },
          ],
        };
      }

      // Sleep before next poll
      await new Promise((resolve) => setTimeout(resolve, poll_interval_seconds * 1000));
    }

    return {
      content: [
        {
          type: "text",
          text: `No new messages in #${channel} after waiting ${timeout_seconds}s. The other instance may be busy or offline. You can try again or check list_instances.`,
        },
      ],
    };
  }
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
