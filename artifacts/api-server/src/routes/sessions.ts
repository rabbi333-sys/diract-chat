import { Router, type Request, type Response } from "express";
import pg from "pg";
import mysql from "mysql2/promise";
import { MongoClient } from "mongodb";
import Redis from "ioredis";

const router = Router();

// ─── Types ────────────────────────────────────────────────────────────────────

export type SessionsCreds = {
  dbType: "postgresql" | "mysql" | "mongodb" | "redis" | "supabase";
  // PostgreSQL / MySQL
  host?: string;
  port?: string;
  dbUsername?: string;
  dbPassword?: string;
  dbName?: string;
  // MongoDB / Redis
  connectionString?: string;
  // Supabase (direct pg connection via dbPassword)
  supabaseUrl?: string;
  // Table / collection name override
  tableName?: string;
};

export type NormalizedMessage = {
  id: string | number;
  session_id: string;
  sender: "User" | "AI" | "Agent";
  message_text: string;
  timestamp: string;
  recipient?: string;
};

export type SessionInfo = {
  session_id: string;
  recipient: string;
  last_message_at: string;
  message_count: number;
  last_message_text?: string;
};

// ─── Row normalizer (mirrors frontend normalizeRow) ───────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeRow(raw: Record<string, any>): NormalizedMessage | null {
  if (!raw) return null;
  const id = (raw.id ?? raw._id ?? "") as string | number;
  const session_id = String(raw.session_id ?? raw.sessionId ?? raw.conversation_id ?? "unknown");
  const recipient = (raw.recipient ?? raw.to ?? raw.phone ?? undefined) as string | undefined;
  // Build timestamp: handle ISO strings, numeric Unix timestamps, and embedded message timestamps
  const rawTs =
    raw.created_at ?? raw.timestamp ?? raw.createdAt ??
    raw.updated_at ?? raw.updatedAt ?? raw.date ?? raw.time ??
    (raw.message && typeof raw.message === 'object'
      ? (raw.message as Record<string, any>).created_at ??
        (raw.message as Record<string, any>).timestamp ??
        (raw.message as Record<string, any>).additional_kwargs?.created_at
      : undefined);
  let timestamp: string;
  if (rawTs == null) {
    timestamp = '2000-01-01T00:00:00.000Z';
  } else if (typeof rawTs === 'number') {
    const ms = rawTs > 1e10 ? rawTs : rawTs * 1000;
    timestamp = new Date(ms).toISOString();
  } else {
    timestamp = String(rawTs);
  }

  // n8n / LangChain format: { message: { type, data: { content } } }
  if (raw.message && typeof raw.message === "object") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg = raw.message as Record<string, any>;
    const type = String(msg.type ?? "").toLowerCase();
    const isHuman = type === "human" || type === "user";
    const isAgent = type === "agent" || type === "human_agent";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = msg.data as Record<string, any> | undefined;
    const text = String(data?.content ?? msg.content ?? msg.output ?? msg.text ?? msg.body ?? "");
    if (!text.trim()) return null;
    return { id, session_id, sender: isHuman ? "User" : isAgent ? "Agent" : "AI", message_text: text, timestamp, recipient };
  }

  // Normalized: { sender, message_text }
  if (raw.sender !== undefined && raw.message_text !== undefined) {
    const s = String(raw.sender).toLowerCase();
    const isHuman = ["user", "human", "customer"].includes(s);
    const isAgent = ["agent", "human_agent", "operator"].includes(s);
    const text = String(raw.message_text ?? "");
    if (!text.trim()) return null;
    return { id, session_id, sender: isHuman ? "User" : isAgent ? "Agent" : "AI", message_text: text, timestamp, recipient };
  }

  // Role-based: { role, content }
  if (raw.role !== undefined) {
    const role = String(raw.role).toLowerCase();
    const isHuman = ["user", "human", "customer"].includes(role);
    const text = String(raw.content ?? raw.text ?? raw.body ?? "");
    if (!text.trim()) return null;
    return { id, session_id, sender: isHuman ? "User" : "AI", message_text: text, timestamp, recipient };
  }

  // Generic fallback
  const typeStr = String(raw.type ?? raw.from ?? "").toLowerCase();
  const isHuman = ["user", "human", "customer", "inbound"].includes(typeStr);
  const text = String(raw.content ?? raw.text ?? raw.body ?? raw.message_text ?? raw.message ?? "");
  if (!text.trim() || text === "{}") return null;
  return { id, session_id, sender: isHuman ? "User" : "AI", message_text: text, timestamp, recipient };
}

function buildSessions(msgs: NormalizedMessage[]): SessionInfo[] {
  const map = new Map<string, { recipient: string; count: number; last_ts: string; last_id: string | number; last_text: string }>();
  for (const m of msgs) {
    const ex = map.get(m.session_id);
    if (!ex) {
      map.set(m.session_id, { recipient: m.recipient ?? m.session_id, count: 1, last_ts: m.timestamp, last_id: m.id, last_text: m.message_text || '' });
    } else {
      ex.count++;
      if (m.timestamp > ex.last_ts) { ex.last_ts = m.timestamp; ex.last_id = m.id; ex.recipient = m.recipient ?? ex.recipient; ex.last_text = m.message_text || ''; }
      else if (m.timestamp === ex.last_ts && String(m.id) > String(ex.last_id)) { ex.last_id = m.id; ex.last_text = m.message_text || ''; }
    }
  }
  const FALLBACK_TS = '2000-01-01T00:00:00.000Z';
  const sessions = Array.from(map.entries()).map(([session_id, info]) => ({
    session_id, recipient: info.recipient, last_message_at: info.last_ts, last_id: info.last_id, message_count: info.count, last_message_text: info.last_text,
  }));
  const allFallback = sessions.every(s => s.last_message_at === FALLBACK_TS);
  if (allFallback) {
    sessions.sort((a, b) => {
      const ia = typeof a.last_id === 'number' ? a.last_id : parseInt(String(a.last_id)) || 0;
      const ib = typeof b.last_id === 'number' ? b.last_id : parseInt(String(b.last_id)) || 0;
      return ib - ia;
    });
  } else {
    sessions.sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
  }
  return sessions.map(({ last_id: _lid, ...s }) => s);
}

// ─── Connection helpers ────────────────────────────────────────────────────────

function buildPgConnStr(c: SessionsCreds): string {
  if (c.dbType === "supabase" && c.supabaseUrl && c.dbPassword) {
    const match = c.supabaseUrl.trim().replace(/\/$/, "").match(/https:\/\/([^.]+)\.supabase\.co/i);
    if (!match) throw new Error("Invalid Supabase URL");
    return `postgresql://postgres:${encodeURIComponent(c.dbPassword)}@db.${match[1]}.supabase.co:5432/postgres`;
  }
  const user = encodeURIComponent(c.dbUsername || "postgres");
  const pass = c.dbPassword ? encodeURIComponent(c.dbPassword) : "";
  const host = c.host || "localhost";
  const port = c.port || "5432";
  const db = c.dbName || "postgres";
  return `postgresql://${user}:${pass}@${host}:${port}/${db}`;
}

async function pgQueryRaw(c: SessionsCreds, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const pool = new pg.Pool({ connectionString: buildPgConnStr(c), ssl: { rejectUnauthorized: false }, max: 1, idleTimeoutMillis: 5000, connectionTimeoutMillis: 8000 });
  try {
    const { rows } = await pool.query(sql, params);
    return rows as Record<string, unknown>[];
  } finally {
    await pool.end();
  }
}

async function mysqlQueryRaw(c: SessionsCreds, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const conn = await mysql.createConnection({ host: c.host || "localhost", port: c.port ? Number(c.port) : 3306, user: c.dbUsername || "root", password: c.dbPassword || "", database: c.dbName || "mydb", ssl: { rejectUnauthorized: false } });
  try {
    const [rows] = await conn.query(sql, params);
    return rows as Record<string, unknown>[];
  } finally {
    await conn.end();
  }
}

function mongoUri(c: SessionsCreds): string {
  if (c.connectionString) return c.connectionString;
  const user = c.dbUsername ? encodeURIComponent(c.dbUsername) : "";
  const pass = c.dbPassword ? encodeURIComponent(c.dbPassword) : "";
  const auth = user ? `${user}:${pass}@` : "";
  return `mongodb://${auth}${c.host || "localhost"}:${c.port || "27017"}/${c.dbName || ""}`;
}

function redisClient(c: SessionsCreds): Redis {
  if (c.connectionString) return new Redis(c.connectionString, { lazyConnect: true, maxRetriesPerRequest: 1 });
  return new Redis({ host: c.host || "localhost", port: c.port ? Number(c.port) : 6379, password: c.dbPassword || undefined, lazyConnect: true, maxRetriesPerRequest: 1 });
}

// ─── Fetch all messages (for session list + analytics) ────────────────────────

async function fetchAllMessages(c: SessionsCreds): Promise<NormalizedMessage[]> {
  const tbl = c.tableName || "sessions";

  if (c.dbType === "postgresql" || c.dbType === "supabase") {
    const rows = await pgQueryRaw(c, `SELECT * FROM ${tbl} ORDER BY id DESC LIMIT 2000`);
    return rows.map(normalizeRow).filter(Boolean) as NormalizedMessage[];
  }

  if (c.dbType === "mysql") {
    const rows = await mysqlQueryRaw(c, `SELECT * FROM ${tbl} ORDER BY id DESC LIMIT 2000`);
    return rows.map(normalizeRow).filter(Boolean) as NormalizedMessage[];
  }

  if (c.dbType === "mongodb") {
    const client = new MongoClient(mongoUri(c), { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    try {
      const db = client.db(c.dbName || "meta_automation");
      const rows = await db.collection(tbl).find({}).sort({ _id: -1 }).limit(2000).toArray();
      return rows.map((r) => normalizeRow({ ...r, id: String(r._id ?? "") })).filter(Boolean) as NormalizedMessage[];
    } finally {
      await client.close();
    }
  }

  if (c.dbType === "redis") {
    const r = redisClient(c);
    await r.connect();
    try {
      const msgs: NormalizedMessage[] = [];
      const sessionKeys = await r.smembers("sessions_index").catch(() => [] as string[]);
      if (sessionKeys.length > 0) {
        for (const sid of sessionKeys.slice(0, 200)) {
          const items = await r.lrange(`session:${sid}`, 0, -1).catch(() => [] as string[]);
          for (const item of items) {
            try {
              const parsed = JSON.parse(item);
              const norm = normalizeRow({ ...parsed, session_id: parsed.session_id ?? sid });
              if (norm) msgs.push(norm);
            } catch { /* skip */ }
          }
        }
      } else {
        const keys = await r.keys("session:*").catch(() => [] as string[]);
        for (const key of keys.slice(0, 200)) {
          const sid = key.replace(/^session:/, "");
          const items = await r.lrange(key, 0, -1).catch(() => [] as string[]);
          for (const item of items) {
            try {
              const parsed = JSON.parse(item);
              const norm = normalizeRow({ ...parsed, session_id: parsed.session_id ?? sid });
              if (norm) msgs.push(norm);
            } catch { /* skip */ }
          }
        }
      }
      return msgs;
    } finally {
      r.disconnect();
    }
  }

  return [];
}

// ─── Fetch messages for one session ──────────────────────────────────────────

async function fetchSessionMessages(c: SessionsCreds, sessionId: string): Promise<NormalizedMessage[]> {
  const tbl = c.tableName || "sessions";

  if (c.dbType === "postgresql" || c.dbType === "supabase") {
    const rows = await pgQueryRaw(c, `SELECT * FROM ${tbl} WHERE session_id = $1 ORDER BY id ASC LIMIT 500`, [sessionId]);
    return rows.map(normalizeRow).filter(Boolean) as NormalizedMessage[];
  }

  if (c.dbType === "mysql") {
    const rows = await mysqlQueryRaw(c, `SELECT * FROM ${tbl} WHERE session_id = ? ORDER BY id ASC LIMIT 500`, [sessionId]);
    return rows.map(normalizeRow).filter(Boolean) as NormalizedMessage[];
  }

  if (c.dbType === "mongodb") {
    const client = new MongoClient(mongoUri(c), { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    try {
      const db = client.db(c.dbName || "meta_automation");
      const rows = await db.collection(tbl).find({ session_id: sessionId }).sort({ _id: 1 }).limit(500).toArray();
      return rows.map((r) => normalizeRow({ ...r, id: String(r._id ?? "") })).filter(Boolean) as NormalizedMessage[];
    } finally {
      await client.close();
    }
  }

  if (c.dbType === "redis") {
    const r = redisClient(c);
    await r.connect();
    try {
      const items = await r.lrange(`session:${sessionId}`, 0, -1).catch(() => [] as string[]);
      return items.map((item) => {
        try {
          const parsed = JSON.parse(item);
          return normalizeRow({ ...parsed, session_id: parsed.session_id ?? sessionId });
        } catch { return null; }
      }).filter(Boolean) as NormalizedMessage[];
    } finally {
      r.disconnect();
    }
  }

  return [];
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /api/sessions/list — all sessions grouped
router.post("/sessions/list", async (req: Request, res: Response) => {
  const { creds, filterDate } = req.body as { creds: SessionsCreds; filterDate?: string };
  if (!creds?.dbType) return void res.status(400).json({ error: "Missing creds.dbType" });

  try {
    let msgs = await fetchAllMessages(creds);
    if (filterDate) {
      msgs = msgs.filter((m) => {
        try { return m.timestamp.startsWith(filterDate); } catch { return true; }
      });
    }
    const sessions = buildSessions(msgs);
    res.json({ sessions });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// POST /api/sessions/messages — messages for a specific session
router.post("/sessions/messages", async (req: Request, res: Response) => {
  const { creds, sessionId } = req.body as { creds: SessionsCreds; sessionId: string };
  if (!creds?.dbType) return void res.status(400).json({ error: "Missing creds.dbType" });
  if (!sessionId) return void res.status(400).json({ error: "Missing sessionId" });

  try {
    const messages = await fetchSessionMessages(creds, sessionId);
    res.json({ messages });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("does not exist") || msg.includes("42P01") || msg.toLowerCase().includes("no collection")) {
      return void res.status(404).json({ error: "TABLE_NOT_FOUND" });
    }
    res.status(500).json({ error: msg });
  }
});

// POST /api/sessions/analytics — total counts
router.post("/sessions/analytics", async (req: Request, res: Response) => {
  const { creds } = req.body as { creds: SessionsCreds };
  if (!creds?.dbType) return void res.status(400).json({ error: "Missing creds.dbType" });

  try {
    const msgs = await fetchAllMessages(creds);
    const sessions = new Set(msgs.map((m) => m.session_id));
    res.json({
      total_sessions: sessions.size,
      total_messages: msgs.length,
      human_messages: msgs.filter((m) => m.sender === "User").length,
      ai_messages: msgs.filter((m) => m.sender === "AI").length,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// POST /api/sessions/insert — insert an agent reply message
router.post("/sessions/insert", async (req: Request, res: Response) => {
  const { creds, message } = req.body as {
    creds: SessionsCreds;
    message: { session_id: string; message_text: string; recipient?: string; timestamp?: string };
  };
  if (!creds?.dbType) return void res.status(400).json({ error: "Missing creds.dbType" });
  if (!message?.session_id || !message?.message_text) return void res.status(400).json({ error: "Missing message fields" });

  const tbl = creds.tableName || "sessions";
  const ts = message.timestamp || new Date().toISOString();

  try {
    if (creds.dbType === "postgresql" || creds.dbType === "supabase") {
      // Try n8n format first, then normalized
      try {
        await pgQueryRaw(creds, `INSERT INTO ${tbl} (session_id, message, recipient) VALUES ($1, $2::jsonb, $3)`, [
          message.session_id,
          JSON.stringify({ type: "ai", data: { content: message.message_text, additional_kwargs: {} } }),
          message.recipient ?? null,
        ]);
      } catch {
        await pgQueryRaw(creds, `INSERT INTO ${tbl} (session_id, sender, message_text, recipient, created_at) VALUES ($1, $2, $3, $4, $5)`, [
          message.session_id, "agent", message.message_text, message.recipient ?? null, ts,
        ]);
      }
      return void res.json({ ok: true });
    }

    if (creds.dbType === "mysql") {
      try {
        await mysqlQueryRaw(creds, `INSERT INTO ${tbl} (session_id, message, recipient) VALUES (?, ?, ?)`, [
          message.session_id,
          JSON.stringify({ type: "ai", data: { content: message.message_text } }),
          message.recipient ?? null,
        ]);
      } catch {
        await mysqlQueryRaw(creds, `INSERT INTO ${tbl} (session_id, sender, message_text, recipient, created_at) VALUES (?, ?, ?, ?, ?)`, [
          message.session_id, "agent", message.message_text, message.recipient ?? null, ts,
        ]);
      }
      return void res.json({ ok: true });
    }

    if (creds.dbType === "mongodb") {
      const client = new MongoClient(mongoUri(creds), { serverSelectionTimeoutMS: 8000 });
      await client.connect();
      try {
        const db = client.db(creds.dbName || "meta_automation");
        await db.collection(tbl).insertOne({
          session_id: message.session_id,
          message: { type: "ai", data: { content: message.message_text } },
          recipient: message.recipient ?? null,
          created_at: ts,
        });
        return void res.json({ ok: true });
      } finally {
        await client.close();
      }
    }

    if (creds.dbType === "redis") {
      const r = redisClient(creds);
      await r.connect();
      try {
        const payload = JSON.stringify({ session_id: message.session_id, message: { type: "ai", data: { content: message.message_text } }, recipient: message.recipient, created_at: ts });
        await r.rpush(`session:${message.session_id}`, payload);
        await r.sadd("sessions_index", message.session_id);
        return void res.json({ ok: true });
      } finally {
        r.disconnect();
      }
    }

    res.status(400).json({ error: "Unsupported dbType" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// POST /api/sessions/validate — test connection + table existence
router.post("/sessions/validate", async (req: Request, res: Response) => {
  const { creds } = req.body as { creds: SessionsCreds };
  if (!creds?.dbType) return void res.status(400).json({ error: "Missing creds.dbType" });

  const tbl = creds.tableName || "sessions";

  try {
    if (creds.dbType === "postgresql" || creds.dbType === "supabase") {
      try {
        await pgQueryRaw(creds, `SELECT 1 FROM ${tbl} LIMIT 1`);
        return void res.json({ status: "ok" });
      } catch (e: unknown) {
        const msg = String(e instanceof Error ? e.message : e);
        if (msg.includes("does not exist") || msg.includes("42P01")) return void res.json({ status: "table-missing" });
        throw e;
      }
    }

    if (creds.dbType === "mysql") {
      try {
        await mysqlQueryRaw(creds, `SELECT 1 FROM ${tbl} LIMIT 1`);
        return void res.json({ status: "ok" });
      } catch (e: unknown) {
        const msg = String(e instanceof Error ? e.message : e);
        if (msg.includes("doesn't exist") || msg.includes("ER_NO_SUCH_TABLE")) return void res.json({ status: "table-missing" });
        throw e;
      }
    }

    if (creds.dbType === "mongodb") {
      const client = new MongoClient(mongoUri(creds), { serverSelectionTimeoutMS: 8000 });
      await client.connect();
      try {
        const db = client.db(creds.dbName || "meta_automation");
        const collections = await db.listCollections({ name: tbl }).toArray();
        if (collections.length === 0) return void res.json({ status: "table-missing" });
        return void res.json({ status: "ok" });
      } finally {
        await client.close();
      }
    }

    if (creds.dbType === "redis") {
      const r = redisClient(creds);
      await r.connect();
      try {
        await r.ping();
        return void res.json({ status: "ok" });
      } finally {
        r.disconnect();
      }
    }

    res.status(400).json({ error: "Unsupported dbType" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg, status: "fail" });
  }
});

export default router;
