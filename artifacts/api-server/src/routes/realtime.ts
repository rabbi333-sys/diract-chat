import { Router, type Request, type Response } from "express";
import { MongoClient } from "mongodb";
import Redis from "ioredis";
import { normalizeRow } from "./sessions.js";
import { logger } from "../lib/logger.js";
import { getServerDbConfig } from "../lib/server-db-config.js";

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

router.get("/realtime/stream", async (req: Request, res: Response): Promise<void> => {
  const q = req.query as Record<string, string>;
  const {
    dbType,
    connectionString,
    host,
    port,
    dbUsername,
    dbPassword,
    dbName,
  } = q;

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
    const rawTables = (q.tables || q.tableName || "n8n_chat_histories");
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
      logger.error({ err }, "MongoDB change stream error");
      sendErr(err instanceof Error ? err.message : String(err));
      cleanup();
      client?.close().catch(() => {/* ignore */});
    }
    return;
  }

  // ── Redis — subscribe to multiple pub/sub channels simultaneously ─────────────
  if (dbType === "redis") {
    const rawChannels = q.channels || q.channel || "chat_new_message";
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
        logger.error({ err }, "Redis subscriber error");
        sendErr(err.message);
      });

      req.on("close", () => {
        cleanup();
        sub.unsubscribe().catch(() => {/* ignore */});
        sub.disconnect();
      });
    } catch (err) {
      logger.error({ err }, "Redis connection error");
      sendErr(err instanceof Error ? err.message : String(err));
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
  // ── Resolve Supabase credentials from server-side config only (no SSRF risk) ─
  const serverCfg = getServerDbConfig();
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

    // FB/IG delivery/read/reaction: entry[0].messaging[0]
    const fbMessaging: Record<string, unknown>[] = Array.isArray(entry0?.messaging)
      ? (entry0!.messaging as Record<string, unknown>[])
      : [];
    if (!event_type && fbMessaging.length > 0) {
      const fbMsg = fbMessaging[0];
      if (fbMsg.delivery)  event_type = 'delivered';
      else if (fbMsg.read) event_type = 'read';
      else if (fbMsg.reaction) {
        const rxn = fbMsg.reaction as Record<string, string> | undefined;
        event_type = 'reaction';
        message_id = rxn?.mid;
        emoji      = rxn?.emoji;
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
  const payload: Record<string, unknown> = { message_id, emoji };

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
    res.json({ ok: true, event_type, session_id });
  } catch (err) {
    logger.error({ err }, "Failed to broadcast webhook event");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
