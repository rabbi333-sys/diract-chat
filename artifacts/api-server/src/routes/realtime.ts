import { Router, type Request, type Response } from "express";
import { MongoClient } from "mongodb";
import Redis from "ioredis";
import { normalizeRow } from "./sessions.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ─── GET /realtime/stream ──────────────────────────────────────────────────────
// Server-Sent Events endpoint.  Keeps the connection alive and pushes a
// normalised NormalizedMessage JSON payload every time a new row is inserted.
//
// Supported dbType values: "mongodb" | "redis"
// (Supabase uses the client-side Phoenix WebSocket; PostgreSQL/MySQL use
//  the frontend smart-polling path.)
//
// Query parameters:
//   dbType          "mongodb" | "redis"
//   connectionString (optional, overrides individual fields)
//   host, port, dbUsername, dbPassword, dbName
//   tableName       collection name (MongoDB only, default: "n8n_chat_histories")
//   channel         Redis Pub/Sub channel (default: "chat_new_message")
// ──────────────────────────────────────────────────────────────────────────────

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
    tableName,
    channel,
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

  // Keep-alive comment every 15 s (prevents proxy timeouts)
  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { /* client gone */ }
  }, 15_000);

  const cleanup = () => clearInterval(heartbeat);

  const sendMsg = (msg: unknown) => {
    try { res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`); } catch { /* client gone */ }
  };

  const sendErr = (message: string) => {
    try { res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`); } catch { /* ignore */ }
  };

  // ── MongoDB change stream ──────────────────────────────────────────────────
  if (dbType === "mongodb") {
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
      const coll = db.collection(tableName || "n8n_chat_histories");

      const changeStream = coll.watch(
        [{ $match: { operationType: "insert" } }],
        { fullDocument: "updateLookup" }
      );

      req.on("close", () => {
        cleanup();
        changeStream.close().catch(() => {/* ignore */});
        client?.close().catch(() => {/* ignore */});
      });

      for await (const change of changeStream) {
        if (change.operationType === "insert" && change.fullDocument) {
          const doc = {
            ...change.fullDocument,
            id: String((change.fullDocument as Record<string, unknown>)._id ?? ""),
          };
          const normalized = normalizeRow(doc as Record<string, unknown>);
          if (normalized) sendMsg(normalized);
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

  // ── Redis Pub/Sub ──────────────────────────────────────────────────────────
  if (dbType === "redis") {
    const channelName = channel || "chat_new_message";

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
      await sub.subscribe(channelName);

      sub.on("message", (_ch: string, message: string) => {
        try {
          const parsed = JSON.parse(message) as Record<string, unknown>;
          const normalized = normalizeRow(parsed);
          if (normalized) sendMsg(normalized);
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

export default router;
