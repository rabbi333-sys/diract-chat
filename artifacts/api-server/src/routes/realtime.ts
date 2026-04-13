import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import Redis from "ioredis";
import { normalizeRow } from "./sessions.js";
import { logger } from "../lib/logger.js";
import { getServerDbConfig, getAllServerDbConfigs } from "../lib/server-db-config.js";

const router = Router();

// ─── GET /realtime/stream ──────────────────────────────────────────────────────
// Server-Sent Events endpoint.  Keeps the connection alive and pushes a
// normalised JSON payload every time a relevant INSERT/UPDATE occurs.
//
// Supported dbType values: "mongodb" | "redis"
// (Supabase uses the client-side Phoenix WebSocket; PostgreSQL/MySQL use
//  the frontend smart-polling path.)
//
// Query parameters:
//   dbType            "mongodb" | "redis"
//   connectionString  (optional, overrides individual fields)
//   host, port, dbUsername, dbPassword, dbName
//
// MongoDB-specific:
//   tables     comma-separated list of collections to watch
//              (default: "n8n_chat_histories")
//              e.g. "n8n_chat_histories,orders,failed_automations,handoff_requests"
//
// Redis-specific:
//   channels   comma-separated list of Pub/Sub channels to subscribe
//              (default: "chat_new_message")
//              e.g. "chat_new_message,new_order,new_failure,new_handoff"
//
// Every SSE event includes a `_syncTable` field identifying which
// collection/channel the event came from so the frontend can dispatch it
// to the correct React Query cache.
// ──────────────────────────────────────────────────────────────────────────────

// Maps a Redis channel name → the logical table name used on the frontend
const CHANNEL_TO_TABLE: Record<string, string> = {
  chat_new_message: "n8n_chat_histories",
  new_order:        "orders",
  new_failure:      "failed_automations",
  new_handoff:      "handoff_requests",
};

// ─── Realtime session token store ─────────────────────────────────────────────
// Credentials are stored server-side for 60 seconds, keyed by a random UUID.
// The SSE endpoint only accepts a token — never raw credentials in the URL.

interface RealtimeTokenEntry {
  dbType: string;
  connectionString?: string;
  host?: string;
  port?: string;
  dbUsername?: string;
  dbPassword?: string;
  dbName?: string;
  tables?: string;
  channels?: string;
  expiresAt: number;
}

const realtimeTokenStore = new Map<string, RealtimeTokenEntry>();

// Clean up expired tokens periodically (every 2 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of realtimeTokenStore) {
    if (entry.expiresAt < now) realtimeTokenStore.delete(key);
  }
}, 120_000);

// Allowed collection/channel name characters (alphanumeric + underscore, max 64)
function isSafeCollectionName(name: string): boolean {
  return /^[a-zA-Z0-9_]{1,64}$/.test(name);
}

// POST /api/realtime/init — store credentials and return a short-lived token
router.post("/realtime/init", (req: Request, res: Response): void => {
  const body = req.body as Record<string, string | undefined>;
  const { dbType, connectionString, host, port, dbUsername, dbPassword, dbName, tables, channels } = body;

  if (dbType !== "mongodb" && dbType !== "redis") {
    res.status(400).json({ error: "dbType must be 'mongodb' or 'redis'" });
    return;
  }

  // Validate MongoDB collection names if provided
  if (tables) {
    const collectionList = tables.split(",").map(t => t.trim()).filter(Boolean);
    if (collectionList.some(t => !isSafeCollectionName(t))) {
      res.status(400).json({ error: "Invalid collection name: only letters, numbers, and underscores are allowed" });
      return;
    }
  }

  const token = randomUUID();
  realtimeTokenStore.set(token, {
    dbType,
    connectionString,
    host,
    port,
    dbUsername,
    dbPassword,
    dbName,
    tables,
    channels,
    expiresAt: Date.now() + 60_000,
  });

  res.json({ token });
});

router.get("/realtime/stream", async (req: Request, res: Response): Promise<void> => {
  const { token } = req.query as Record<string, string>;

  if (!token) {
    res.status(400).json({ error: "Missing token. Use POST /api/realtime/init first." });
    return;
  }

  const entry = realtimeTokenStore.get(token);
  if (!entry || entry.expiresAt < Date.now()) {
    realtimeTokenStore.delete(token);
    res.status(401).json({ error: "Token expired or invalid. Re-init and reconnect." });
    return;
  }

  // Consume the token immediately — each SSE connection needs its own token
  realtimeTokenStore.delete(token);

  const { dbType, connectionString, host, port, dbUsername, dbPassword, dbName } = entry;

  if (dbType !== "mongodb" && dbType !== "redis") {
    res.status(400).json({ error: "dbType must be 'mongodb' or 'redis'" });
    return;
  }

  // ── SSE headers ─────────────────────────────────────────────────────────────
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx/proxy buffering
  res.flushHeaders();

  // Keep-alive comment every 20 s (prevents proxy timeouts)
  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { /* client gone */ }
  }, 20_000);

  const cleanup = () => clearInterval(heartbeat);

  const sendEvent = (payload: unknown) => {
    try { res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`); }
    catch { /* client gone */ }
  };

  const sendErr = (message: string) => {
    try { res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`); }
    catch { /* ignore */ }
  };

  // ── MongoDB — watch multiple collections via a single change stream ──────────
  if (dbType === "mongodb") {
    // Parse comma-separated tables; default to chat histories only
    const rawTables = (entry.tables || "n8n_chat_histories");
    const tables = rawTables.split(",").map(t => t.trim()).filter(Boolean);

    const uri =
      connectionString ||
      (() => {
        const user = dbUsername ? encodeURIComponent(dbUsername) : "";
        const pass = dbPassword ? encodeURIComponent(dbPassword) : "";
        const auth = user ? `${user}:${pass}@` : "";
        return `mongodb://${auth}${host || "localhost"}:${port || "27017"}/${dbName || ""}`;
      })();

    let client: MongoClient | null = null;

    try {
      client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
      await client.connect();
      const db = client.db(dbName || "meta_automation");

      // Watch the entire database and filter by the requested collections
      // This way we have a single change stream regardless of collection count.
      const pipeline = [
        {
          $match: {
            operationType: { $in: ["insert", "update", "replace"] },
            "ns.coll":     { $in: tables },
          },
        },
      ];

      const changeStream = db.watch(pipeline, { fullDocument: "updateLookup" });

      req.on("close", () => {
        cleanup();
        changeStream.close().catch(() => {/* ignore */});
        client?.close().catch(() => {/* ignore */});
      });

      for await (const change of changeStream) {
        if (
          (change.operationType === "insert" || change.operationType === "update" || change.operationType === "replace") &&
          change.fullDocument
        ) {
          const collName = (change as { ns?: { coll?: string } }).ns?.coll ?? tables[0];
          const doc: Record<string, unknown> = {
            ...change.fullDocument,
            id: String((change.fullDocument as Record<string, unknown>)._id ?? ""),
            _syncTable: collName,
          };

          // For chat messages, also run the normaliser
          const normalized = normalizeRow(doc);
          const payload = normalized
            ? { ...normalized, _syncTable: collName }
            : { ...doc, _syncTable: collName };

          sendEvent(payload);
        }
      }
    } catch (err) {
      const reqId = randomUUID();
      logger.error({ err, reqId }, "MongoDB change stream error");
      sendErr("Stream error. Check server logs for details (reqId: " + reqId + ")");
      cleanup();
      client?.close().catch(() => {/* ignore */});
    }
    return;
  }

  // ── Redis — subscribe to multiple pub/sub channels simultaneously ─────────────
  if (dbType === "redis") {
    const rawChannels = entry.channels || "chat_new_message";
    const channelList = rawChannels.split(",").map(c => c.trim()).filter(Boolean);

    const sub = connectionString
      ? new Redis(connectionString, { maxRetriesPerRequest: 1, lazyConnect: true })
      : new Redis({
          host: host || "localhost",
          port: port ? Number(port) : 6379,
          password: dbPassword || undefined,
          maxRetriesPerRequest: 1,
          lazyConnect: true,
        });

    try {
      await sub.connect();
      // Subscribe to all channels at once
      await sub.subscribe(...channelList);

      sub.on("message", (ch: string, message: string) => {
        try {
          const parsed = JSON.parse(message) as Record<string, unknown>;
          const syncTable = CHANNEL_TO_TABLE[ch] ?? ch;
          const payload: Record<string, unknown> = { ...parsed, _syncTable: syncTable };

          // For chat messages, run through normaliser so the frontend cache gets a clean shape
          if (syncTable === "n8n_chat_histories") {
            const normalized = normalizeRow(payload);
            if (normalized) sendEvent({ ...normalized, _syncTable: syncTable });
          } else {
            sendEvent(payload);
          }
        } catch { /* skip malformed */ }
      });

      sub.on("error", (err: Error) => {
        const reqId = randomUUID();
        logger.error({ err, reqId }, "Redis subscriber error");
        sendErr("Stream error. Check server logs for details (reqId: " + reqId + ")");
      });

      req.on("close", () => {
        cleanup();
        sub.unsubscribe().catch(() => {/* ignore */});
        sub.disconnect();
      });
    } catch (err) {
      const reqId = randomUUID();
      logger.error({ err, reqId }, "Redis connection error");
      sendErr("Stream error. Check server logs for details (reqId: " + reqId + ")");
      cleanup();
      sub.disconnect();
    }
  }
});

// ─── POST /webhook/events ──────────────────────────────────────────────────────
// Receives delivery, read-receipt, reaction, and typing webhook events from n8n
// (or any other webhook relay) and broadcasts them to connected dashboard clients
// via Supabase Realtime broadcast.
//
// Supabase credentials are read from the server-side stored DB config (set via
// POST /api/db-config). They are NEVER accepted from the request body to prevent
// SSRF and credential injection attacks.
//
// Body shape:
//   {
//     session_id:   string,      // chat session ID
//     event_type?:  "delivered" | "read" | "reaction" | "typing",
//     message_id?:  string,      // platform message ID (wamid / FB mid)
//     emoji?:       string,      // for reaction events
//     raw?:         object,      // original raw webhook payload (WA/FB/IG)
//   }
//
// The endpoint also auto-detects delivery/read/reaction from raw WA/FB payloads
// when `raw` is provided so that n8n can forward the webhook verbatim.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/webhook/events", async (req: Request, res: Response): Promise<void> => {
  // ── Shared-secret authentication (required) ───────────────────────────────
  // WEBHOOK_SECRET env var MUST be configured before this endpoint is usable.
  // Callers (e.g. n8n) must include: X-Webhook-Secret: <secret>
  // Returning 500 when unconfigured prevents forged event injection in any env.
  const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
  if (!WEBHOOK_SECRET) {
    logger.error("WEBHOOK_SECRET env var is not set — /webhook/events is disabled until configured");
    res.status(500).json({ error: "Server misconfiguration: WEBHOOK_SECRET env var must be set before using /webhook/events" });
    return;
  }
  const provided = req.headers['x-webhook-secret'] as string | undefined;
  if (!provided || provided !== WEBHOOK_SECRET) {
    logger.warn({ ip: req.ip }, "Webhook event rejected: invalid or missing X-Webhook-Secret header");
    res.status(401).json({ error: "Unauthorized: invalid X-Webhook-Secret header" });
    return;
  }

  // ── Resolve Supabase credentials from server-side config only (no SSRF risk) ─
  // Webhook callers don't carry a user JWT, so we look up the config by userId
  // from the body first, then fall back to any stored Supabase config.
  const webhookBody = req.body as { userId?: string } & Record<string, unknown>;
  const rawServerCfg = webhookBody.userId
    ? getServerDbConfig(webhookBody.userId)
    : getAllServerDbConfigs().find(c => c.dbType === 'supabase' && c.supabase_url && c.anon_key) ?? null;
  const serverCfg = rawServerCfg;
  if (!serverCfg || serverCfg.dbType !== 'supabase' || !serverCfg.supabase_url || !serverCfg.anon_key) {
    res.status(503).json({ error: "Supabase not configured on this server. Push DB config via POST /api/db-config first." });
    return;
  }
  const supabase_url = serverCfg.supabase_url;
  const anon_key     = serverCfg.anon_key;

  const body = req.body as {
    session_id?: string;
    event_type?: string;
    message_id?: string;
    emoji?: string;
    raw?: Record<string, unknown>;
  };

  const { session_id } = body;
  if (!session_id) {
    res.status(400).json({ error: "session_id is required" });
    return;
  }

  let { event_type, message_id, emoji } = body;

  // ── Auto-detect from raw WhatsApp / Facebook / Instagram webhook payload ──
  if (!event_type && body.raw) {
    // Use `unknown` + optional chaining with safe helper to avoid complex generic casts
    const r = body.raw as Record<string, unknown>;
    const entry0 = (Array.isArray((r as Record<string, unknown[]>).entry)
      ? ((r as Record<string, unknown[]>).entry[0] as Record<string, unknown>)
      : undefined);

    // WA delivery/read: entry[0].changes[0].value.statuses[0]
    const waChanges = Array.isArray(entry0?.changes) ? (entry0!.changes as Record<string, unknown>[]) : [];
    const waValue   = waChanges[0]?.value as Record<string, unknown> | undefined;
    const waStatuses: Record<string, unknown>[] = Array.isArray(waValue?.statuses)
      ? (waValue!.statuses as Record<string, unknown>[])
      : [];
    if (waStatuses.length > 0) {
      const s = waStatuses[0];
      const st = s.status as string | undefined;
      if (st === 'delivered' || st === 'read') {
        event_type = st;
        message_id = s.id as string | undefined;
      }
    }

    // WA reaction: entry[0].changes[0].value.messages[0].reaction
    const waMessages: Record<string, unknown>[] = Array.isArray(waValue?.messages)
      ? (waValue!.messages as Record<string, unknown>[])
      : [];
    if (!event_type && waMessages[0]?.type === 'reaction') {
      const rxn = waMessages[0].reaction as Record<string, string> | undefined;
      event_type = 'reaction';
      message_id = rxn?.message_id;
      emoji      = rxn?.emoji;
    }

    // WA typing: value.messages[0].type === 'typing' (WhatsApp typing notifications
    // are not in the official API but some webhook relays forward them as custom events)
    if (!event_type && waMessages[0]?.type === 'typing') {
      event_type = 'typing';
    }

    // FB/IG delivery/read/reaction: entry[0].messaging[0]
    const fbMessaging: Record<string, unknown>[] = Array.isArray(entry0?.messaging)
      ? (entry0!.messaging as Record<string, unknown>[])
      : [];
    if (!event_type && fbMessaging.length > 0) {
      const fbMsg = fbMessaging[0];
      if (fbMsg.delivery) {
        event_type = 'delivered';
        const deliveryObj = fbMsg.delivery as Record<string, unknown> | undefined;
        // delivery.mids: array of concrete message IDs that were delivered.
        // Use these for per-message status persistence when available.
        const mids = Array.isArray(deliveryObj?.mids)
          ? (deliveryObj!.mids as string[]).filter(m => typeof m === 'string' && m.length > 0)
          : [];
        if (mids.length > 0) {
          message_id = mids[0];                           // primary ID for broadcast
          (body as Record<string, unknown>).delivery_mids = mids; // all IDs for persistence
        } else if (deliveryObj?.watermark) {
          // No mids — fall back to watermark-based broadcast only (not persisted)
          (body as Record<string, unknown>).delivery_watermark = deliveryObj.watermark;
        }
      } else if (fbMsg.read) {
        // FB/IG read receipts carry only a watermark — resolve to per-message IDs
        // on the server by querying message_platform_ids (done in persistence step below).
        const readObj = fbMsg.read as Record<string, unknown> | undefined;
        const watermark = readObj?.watermark;
        if (watermark) {
          event_type = 'read_watermark';
          (body as Record<string, unknown>).watermark = watermark;
          // No synthetic message_id — watermark is passed in payload directly
        } else {
          event_type = 'read';
        }
      } else if (fbMsg.reaction) {
        const rxn = fbMsg.reaction as Record<string, string> | undefined;
        event_type = 'reaction';
        message_id = rxn?.mid;
        emoji      = rxn?.emoji;
      } else if (
        // FB/IG typing: sender_action "typing_on" forwarded as a custom webhook event.
        // Some n8n relays forward typing notifications as messaging events with a
        // `sender_action` or `typing` field.
        (fbMsg.sender_action as string | undefined) === 'typing_on' ||
        (fbMsg as Record<string, unknown>).typing === true
      ) {
        event_type = 'typing';
      }
    }
  }

  if (!event_type) {
    res.status(400).json({ error: "Could not determine event_type from payload" });
    return;
  }

  // ── Broadcast to Supabase Realtime ───────────────────────────────────────
  // Supabase Realtime REST broadcast endpoint
  const channel = event_type === 'typing'
    ? `typing:${session_id}`
    : `msg_status:${session_id}`;

  const broadcastUrl = `${supabase_url.replace(/\/$/, "")}/realtime/v1/api/broadcast`;
  // Collect extra metadata attached during auto-detect phase
  const watermarkMs: number | undefined = (body as Record<string, unknown>).watermark as number | undefined;
  const deliveryMids: string[] | undefined = (body as Record<string, unknown>).delivery_mids as string[] | undefined;
  const payload: Record<string, unknown> = {
    message_id,
    emoji,
    ...(watermarkMs != null ? { watermark: watermarkMs } : {}),
    // Expose all delivered mids so the frontend can update every message
    ...(deliveryMids && deliveryMids.length > 1 ? { message_ids: deliveryMids } : {}),
  };

  try {
    const broadcastRes = await fetch(broadcastUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": anon_key,
        "Authorization": `Bearer ${anon_key}`,
      },
      body: JSON.stringify({
        messages: [{ topic: channel, event: event_type, payload }],
      }),
    });

    if (!broadcastRes.ok) {
      const err = await broadcastRes.text();
      logger.warn({ err, event_type, session_id }, "Supabase broadcast failed");
      res.status(502).json({ error: "Supabase broadcast failed", detail: err });
      return;
    }

    logger.info({ event_type, session_id, message_id }, "Broadcast sent");

    // ── Durable persistence: upsert into message_status table ────────────────
    // Required table DDL (run once in your Supabase project):
    //   CREATE TABLE message_status (
    //     session_id           TEXT NOT NULL,
    //     platform_message_id  TEXT NOT NULL,
    //     status               TEXT NOT NULL,   -- 'delivered' | 'read' | 'reaction'
    //     emoji                TEXT,
    //     updated_at           TIMESTAMPTZ DEFAULT NOW(),
    //     PRIMARY KEY (session_id, platform_message_id)
    //   );
    // If the table does not yet exist the upsert error is logged and ignored —
    // broadcast-only mode still works for in-session real-time updates.
    // ── Durable persistence helpers ───────────────────────────────────────────
    const restBase = supabase_url.replace(/\/$/, '');
    const restHeaders = {
      'Content-Type': 'application/json',
      'apikey': anon_key,
      'Authorization': `Bearer ${anon_key}`,
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    };

    /**
     * Upsert one or more rows into message_status.
     * Errors are logged and swallowed — table may not exist yet.
     */
    const upsertStatuses = async (
      rows: Array<Record<string, string | null>>
    ): Promise<void> => {
      if (rows.length === 0) return;
      try {
        const r = await fetch(`${restBase}/rest/v1/message_status`, {
          method: 'POST',
          headers: restHeaders,
          body: JSON.stringify(rows.length === 1 ? rows[0] : rows),
        });
        if (!r.ok) {
          const err = await r.text();
          logger.warn({ err, event_type, session_id }, "message_status upsert failed (table may not exist yet)");
        }
      } catch (e) {
        logger.warn({ e }, "message_status upsert error (table may not exist yet)");
      }
    };

    const now = new Date().toISOString();

    if (event_type === 'delivered') {
      // FB/IG: persist each concrete mid from delivery.mids (real platform message IDs)
      if (deliveryMids && deliveryMids.length > 0) {
        await upsertStatuses(deliveryMids.map(mid => ({
          session_id,
          platform_message_id: mid,
          status: 'delivered',
          emoji: null,
          updated_at: now,
        })));
      } else if (message_id) {
        // WA or single-mid fallback
        await upsertStatuses([{ session_id, platform_message_id: message_id, status: 'delivered', emoji: null, updated_at: now }]);
      }
    } else if (event_type === 'read' && message_id) {
      await upsertStatuses([{ session_id, platform_message_id: message_id, status: 'read', emoji: null, updated_at: now }]);
    } else if (event_type === 'read_watermark' && watermarkMs) {
      // Server-side resolution: find all outbound message IDs sent ≤ watermark
      // from the message_platform_ids sidecar table, then persist each as 'read'.
      try {
        const watermarkMinute = new Date(Number(watermarkMs)).toISOString().slice(0, 16);
        const qUrl =
          `${restBase}/rest/v1/message_platform_ids` +
          `?session_id=eq.${encodeURIComponent(session_id)}` +
          `&sent_at_minute=lte.${encodeURIComponent(watermarkMinute)}` +
          `&select=platform_message_id`;
        const qRes = await fetch(qUrl, {
          headers: { apikey: anon_key, Authorization: `Bearer ${anon_key}` },
        });
        if (qRes.ok) {
          const resolved = await qRes.json() as Array<{ platform_message_id: string }>;
          if (resolved.length > 0) {
            await upsertStatuses(resolved.map(r => ({
              session_id,
              platform_message_id: r.platform_message_id,
              status: 'read',
              emoji: null,
              updated_at: now,
            })));
            logger.info({ count: resolved.length, session_id }, "Watermark-resolved read statuses persisted");
          }
        }
      } catch (e) {
        logger.warn({ e, session_id }, "read_watermark resolution failed (message_platform_ids table may not exist)");
      }
    } else if (event_type === 'reaction' && message_id) {
      await upsertStatuses([{ session_id, platform_message_id: message_id, status: 'reaction', emoji: emoji ?? null, updated_at: now }]);
    }

    res.json({ ok: true, event_type, session_id });
  } catch (err) {
    logger.error({ err }, "Failed to broadcast webhook event");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
