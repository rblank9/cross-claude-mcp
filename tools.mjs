/**
 * MCP tool registration — shared between open-source and SaaS modes.
 * Both server.mjs and saas/server-saas.mjs import this.
 */

import { z } from "zod";
import { normalizeChannelName } from "./db.mjs";

export const STALE_THRESHOLD_SECONDS = 120;

/** Simple check: are two strings within edit distance 2? Good enough for channel name typos. */
function levenshteinClose(a, b) {
  if (Math.abs(a.length - b.length) > 2) return false;
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      matrix[i][j] = a[i - 1] === b[j - 1]
        ? matrix[i - 1][j - 1]
        : 1 + Math.min(matrix[i - 1][j], matrix[i][j - 1], matrix[i - 1][j - 1]);
    }
  }
  return matrix[a.length][b.length] <= 2;
}

/**
 * Register all Cross-Claude MCP tools on a server instance.
 * @param {McpServer} server - The MCP server to register tools on
 * @param {object} db - Database instance (SqliteDB, PostgresDB, or TenantDB)
 * @param {Function|null} planChecker - Optional async (action) => {allowed, message} for SaaS plan limits
 * @returns {Function} cleanup - Call on shutdown to mark instance offline
 */
export function registerTools(server, db, planChecker = null) {
  let currentInstanceId = null;

  function touchHeartbeat() {
    if (!currentInstanceId) return;
    try { db.heartbeat(currentInstanceId); } catch { /* ignore */ }
  }

  server.tool(
    "register",
    "Register this Claude Code instance with an identity. Call this first before using other tools.",
    {
      instance_id: z.string().describe("Unique name for this instance (e.g., 'alice', 'builder', 'reviewer')"),
      description: z.string().optional().describe("What this instance is working on"),
    },
    async ({ instance_id, description }) => {
      if (planChecker) {
        const check = await planChecker("register");
        if (!check.allowed) return { content: [{ type: "text", text: check.message }] };
      }
      if (currentInstanceId && currentInstanceId !== instance_id) {
        await db.markOffline(currentInstanceId);
      }
      currentInstanceId = instance_id;
      await db.registerInstance(instance_id, description || null);

      // Provide context: active channels and online instances
      const channels = await db.listChannelsWithActivity();
      const activeChannels = channels.filter(c => c.message_count > 0);
      const channelSummary = activeChannels.length > 0
        ? "\n\nActive channels:\n" + activeChannels.map(c =>
            `  #${c.name} (${c.message_count} msgs, last: ${c.last_message_at})${c.description ? ` - ${c.description}` : ""}`
          ).join("\n")
        : "\n\nNo active channels yet. Use 'general' or create a new one.";

      await db.markStaleOffline(STALE_THRESHOLD_SECONDS);
      const instances = await db.listInstances();
      const others = instances.filter(i => i.instance_id !== instance_id && i.status === "online");
      const instanceSummary = others.length > 0
        ? "\n\nOnline instances:\n" + others.map(i =>
            `  ${i.instance_id}${i.description ? ` - ${i.description}` : ""}`
          ).join("\n")
        : "\n\nNo other instances online.";

      return {
        content: [{ type: "text", text: `Registered as "${instance_id}".${channelSummary}${instanceSummary}\n\nUse 'check_messages' to see if anyone has sent you anything.` }],
      };
    }
  );

  server.tool(
    "send_message",
    "Send a message to a channel for other Claude Code instances to read.",
    {
      channel: z.string().default("general").describe("Channel to post to (default: 'general')"),
      sender: z.string().describe("Your instance_id"),
      content: z.string().describe("The message content"),
      message_type: z.enum(["message", "request", "response", "status", "handoff", "done"]).default("message")
        .describe("Type: message, request, response, status, handoff, done (signals no more replies)"),
      in_reply_to: z.number().optional().describe("Message ID this is replying to"),
    },
    async ({ channel, sender, content, message_type, in_reply_to }) => {
      if (planChecker) {
        const check = await planChecker("send_message");
        if (!check.allowed) return { content: [{ type: "text", text: check.message }] };
      }
      const normalized = normalizeChannelName(channel);
      if (!normalized) {
        return { content: [{ type: "text", text: `Invalid channel name "${channel}". Use lowercase letters, numbers, and hyphens.` }] };
      }

      // Check if this channel already exists
      const existingChannels = await db.listChannels();
      const exists = existingChannels.some(c => c.name === normalized);
      let warning = "";

      if (!exists) {
        // Find similar existing channels to warn about
        const similar = existingChannels.filter(c => {
          const n = c.name;
          return n.includes(normalized) || normalized.includes(n)
            || levenshteinClose(n, normalized);
        });
        if (similar.length > 0) {
          warning = `\n\n⚠️ New channel #${normalized} created. Did you mean one of these? ${similar.map(c => `#${c.name}`).join(", ")}`;
        }
      }

      await db.createChannel(normalized, null);
      touchHeartbeat();
      const id = await db.sendMessage(normalized, sender, content, message_type, in_reply_to || null);
      const nameNote = normalized !== channel ? ` (normalized from "${channel}")` : "";
      return {
        content: [{ type: "text", text: `Message #${id} sent to #${normalized}${nameNote} as "${sender}" [${message_type}]${warning}` }],
      };
    }
  );

  server.tool(
    "check_messages",
    "Check for new messages in a channel. Use after_id to only get messages newer than a specific message.",
    {
      channel: z.string().default("general").describe("Channel to check"),
      after_id: z.number().optional().describe("Only show messages after this ID (for polling)"),
      limit: z.number().default(20).describe("Max messages to return"),
      instance_id: z.string().optional().describe("Your instance_id - filters out your own messages"),
    },
    async ({ channel, after_id, limit, instance_id }) => {
      const normalized = normalizeChannelName(channel);
      touchHeartbeat();
      let messages;
      if (instance_id && after_id !== undefined) {
        messages = await db.getUnread(normalized, after_id, instance_id);
      } else if (after_id !== undefined) {
        messages = await db.getMessagesSince(normalized, after_id);
      } else {
        messages = await db.getMessages(normalized, limit);
        messages.reverse();
      }

      if (messages.length === 0) {
        return { content: [{ type: "text", text: `No ${after_id !== undefined ? "new " : ""}messages in #${normalized}.` }] };
      }

      const formatted = messages.map((m) =>
        `#${m.id} [${m.message_type}] ${m.sender} (${m.created_at})${m.in_reply_to ? ` (reply to #${m.in_reply_to})` : ""}${m.reply_count > 0 ? ` [${m.reply_count} replies]` : ""}:\n${m.content}`
      ).join("\n\n---\n\n");

      const lastId = messages[messages.length - 1].id;
      return {
        content: [{ type: "text", text: `${messages.length} message(s) in #${normalized}:\n\n${formatted}\n\n---\nLast message ID: ${lastId} (use as after_id to poll for new messages)` }],
      };
    }
  );

  server.tool(
    "wait_for_reply",
    "Poll a channel until a new message arrives from another instance, or until timeout. Stops early on 'done' messages.",
    {
      channel: z.string().default("general").describe("Channel to poll"),
      after_id: z.number().describe("Only look for messages after this ID"),
      instance_id: z.string().describe("Your instance_id (filters out your own messages)"),
      timeout_seconds: z.number().default(90).describe("Max seconds to wait (default: 90)"),
      poll_interval_seconds: z.number().default(5).describe("Seconds between polls (default: 5)"),
    },
    async ({ channel, after_id, instance_id, timeout_seconds, poll_interval_seconds }) => {
      const normalized = normalizeChannelName(channel);
      const deadline = Date.now() + timeout_seconds * 1000;

      while (Date.now() < deadline) {
        touchHeartbeat();
        const messages = await db.getUnread(normalized, after_id, instance_id);

        if (messages.length > 0) {
          const hasDone = messages.some((m) => m.message_type === "done");
          const formatted = messages.map((m) =>
            `#${m.id} [${m.message_type}] ${m.sender} (${m.created_at})${m.in_reply_to ? ` (reply to #${m.in_reply_to})` : ""}:\n${m.content}`
          ).join("\n\n---\n\n");
          const lastId = messages[messages.length - 1].id;
          return {
            content: [{ type: "text", text: `${messages.length} new message(s) in #${normalized}:\n\n${formatted}\n\n---\nLast message ID: ${lastId}${hasDone ? "\n\nThe other instance signaled DONE -- no further replies expected." : ""}` }],
          };
        }

        await new Promise((resolve) => setTimeout(resolve, poll_interval_seconds * 1000));
      }

      return {
        content: [{ type: "text", text: `No new messages in #${normalized} after waiting ${timeout_seconds}s. The other instance may be busy or offline. You can try again or check list_instances.` }],
      };
    }
  );

  server.tool(
    "get_replies",
    "Get all replies to a specific message.",
    { message_id: z.number().describe("The message ID to get replies for") },
    async ({ message_id }) => {
      const parent = await db.getMessage(message_id);
      if (!parent) return { content: [{ type: "text", text: `Message #${message_id} not found.` }] };

      const replies = await db.getReplies(message_id);
      if (replies.length === 0) return { content: [{ type: "text", text: `No replies to message #${message_id}.` }] };

      const formatted = replies.map((r) => `#${r.id} [${r.message_type}] ${r.sender} (${r.created_at}):\n${r.content}`).join("\n\n---\n\n");
      return {
        content: [{ type: "text", text: `Original #${parent.id} from ${parent.sender}: ${parent.content}\n\n${replies.length} replies:\n\n${formatted}` }],
      };
    }
  );

  server.tool(
    "create_channel",
    "Create a named channel for organizing communication.",
    {
      name: z.string().describe("Channel name (lowercase, hyphens, no spaces)"),
      description: z.string().optional().describe("What this channel is for"),
    },
    async ({ name, description }) => {
      if (planChecker) {
        const check = await planChecker("create_channel");
        if (!check.allowed) return { content: [{ type: "text", text: check.message }] };
      }
      const normalized = normalizeChannelName(name);
      if (!normalized) {
        return { content: [{ type: "text", text: `Invalid channel name "${name}". Use lowercase letters, numbers, and hyphens.` }] };
      }

      // Check for similar existing channels
      const existing = await db.listChannels();
      const similar = existing.filter(c => c.name !== normalized && (
        c.name.includes(normalized) || normalized.includes(c.name) || levenshteinClose(c.name, normalized)
      ));

      await db.createChannel(normalized, description || null);
      const nameNote = normalized !== name ? ` (normalized from "${name}")` : "";
      const similarNote = similar.length > 0
        ? `\nNote: similar channels exist: ${similar.map(c => `#${c.name}`).join(", ")}`
        : "";
      return { content: [{ type: "text", text: `Channel #${normalized} created${nameNote}.${description ? ` Purpose: ${description}` : ""}${similarNote}` }] };
    }
  );

  server.tool(
    "list_channels",
    "List all channels with activity stats (message count, last activity, participants). Use this to find the right channel before sending messages.",
    {},
    async () => {
      const channels = await db.listChannelsWithActivity();
      if (channels.length === 0) return { content: [{ type: "text", text: "No channels exist yet." }] };
      const formatted = channels.map((c) => {
        const parts = [`#${c.name}`];
        if (c.description) parts.push(`- ${c.description}`);
        if (c.message_count > 0) {
          parts.push(`(${c.message_count} msgs, last: ${c.last_message_at})`);
          if (c.active_senders) parts.push(`[participants: ${c.active_senders}]`);
        } else {
          parts.push("(empty)");
        }
        return parts.join(" ");
      }).join("\n");
      return { content: [{ type: "text", text: `Channels:\n${formatted}` }] };
    }
  );

  server.tool(
    "find_channel",
    "Search for channels by keyword. Matches against channel names and descriptions. Use this when you're not sure which channel to use.",
    {
      query: z.string().describe("Keyword to search for in channel names and descriptions"),
    },
    async ({ query }) => {
      const channels = await db.findChannels(query);
      if (channels.length === 0) {
        // Suggest listing all channels
        const allChannels = await db.listChannels();
        const suggestion = allChannels.length > 0
          ? `\n\nAvailable channels: ${allChannels.map(c => `#${c.name}`).join(", ")}`
          : "\n\nNo channels exist yet. Create one with create_channel.";
        return { content: [{ type: "text", text: `No channels matching "${query}".${suggestion}` }] };
      }
      const formatted = channels.map(c => {
        const parts = [`#${c.name}`];
        if (c.description) parts.push(`- ${c.description}`);
        if (c.message_count > 0) parts.push(`(${c.message_count} msgs, last: ${c.last_message_at})`);
        else parts.push("(empty)");
        return parts.join(" ");
      }).join("\n");
      return { content: [{ type: "text", text: `${channels.length} channel(s) matching "${query}":\n${formatted}` }] };
    }
  );

  server.tool("list_instances", "See all registered Claude Code instances.", {}, async () => {
    touchHeartbeat();
    await db.markStaleOffline(STALE_THRESHOLD_SECONDS);
    const instances = await db.listInstances();
    if (instances.length === 0) return { content: [{ type: "text", text: "No instances registered yet." }] };
    const formatted = instances.map((i) =>
      `${i.instance_id} [${i.status}] - last seen: ${i.last_seen}${i.description ? ` - ${i.description}` : ""}`
    ).join("\n");
    return { content: [{ type: "text", text: `Registered instances:\n${formatted}` }] };
  });

  server.tool(
    "search_messages",
    "Search message content across all channels.",
    {
      query: z.string().describe("Text to search for"),
      limit: z.number().default(10).describe("Max results"),
    },
    async ({ query, limit }) => {
      const messages = await db.searchMessages(query, limit);
      if (messages.length === 0) return { content: [{ type: "text", text: `No messages matching "${query}".` }] };
      const formatted = messages.map((m) =>
        `#${m.id} [#${m.channel}] ${m.sender} (${m.created_at}) [${m.message_type}]:\n${m.content}`
      ).join("\n\n---\n\n");
      return { content: [{ type: "text", text: `${messages.length} result(s) for "${query}":\n\n${formatted}` }] };
    }
  );

  server.tool(
    "share_data",
    "Store large data (tables, plans, analysis) in a shared store instead of packing it into a message. Other instances can retrieve it by key. Use this for anything over ~500 chars.",
    {
      key: z.string().describe("Unique key for this data (e.g., 'cannibal-analysis', 'faraday-plan')"),
      content: z.string().describe("The data content to share"),
      sender: z.string().describe("Your instance_id"),
      description: z.string().optional().describe("Brief description of what this data is"),
    },
    async ({ key, content, sender, description }) => {
      if (planChecker) {
        const check = await planChecker("share_data");
        if (!check.allowed) return { content: [{ type: "text", text: check.message }] };
      }
      touchHeartbeat();
      await db.shareData(key, content, sender, description || null);
      const sizeKb = (Buffer.byteLength(content) / 1024).toFixed(1);
      return {
        content: [{ type: "text", text: `Shared data stored as "${key}" (${sizeKb} KB). Other instances can retrieve it with get_shared_data.` }],
      };
    }
  );

  server.tool(
    "get_shared_data",
    "Retrieve data that another instance shared via share_data.",
    {
      key: z.string().describe("The key of the shared data to retrieve"),
    },
    async ({ key }) => {
      touchHeartbeat();
      const data = await db.getSharedData(key);
      if (!data) return { content: [{ type: "text", text: `No shared data found for key "${key}". Use list_shared_data to see available keys.` }] };
      return {
        content: [{ type: "text", text: `Shared data "${key}" (by ${data.created_by}, ${data.created_at})${data.description ? ` -- ${data.description}` : ""}:\n\n${data.content}` }],
      };
    }
  );

  server.tool(
    "list_shared_data",
    "List all shared data keys with their descriptions and sizes.",
    {},
    async () => {
      touchHeartbeat();
      const items = await db.listSharedData();
      if (items.length === 0) return { content: [{ type: "text", text: "No shared data stored yet." }] };
      const formatted = items.map((d) => {
        const sizeKb = (Number(d.size_bytes) / 1024).toFixed(1);
        return `"${d.key}" (${sizeKb} KB, by ${d.created_by}, ${d.created_at})${d.description ? ` -- ${d.description}` : ""}`;
      }).join("\n");
      return { content: [{ type: "text", text: `Shared data:\n${formatted}` }] };
    }
  );

  // Return cleanup function for shutdown
  return () => {
    if (currentInstanceId) {
      db.markOffline(currentInstanceId);
    }
  };
}
