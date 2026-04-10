/**
 * POST /api/ai-status
 *
 * Checks the ai_control table for a given session_id and returns
 * whether AI is enabled. Designed to be called from n8n workflows
 * as a drop-in replacement for the Supabase Edge Function.
 *
 * Request body (Supabase):
 *   { session_id: string, supabase_url: string, anon_key: string }
 *
 * Request body (non-Supabase via proxy creds):
 *   { session_id: string, creds: { dbType, host, port, dbUsername, dbPassword, dbName, connectionString } }
 *
 * Response:
 *   { ai_enabled: boolean, session_id: string }
 */

import { Router, type Request, type Response } from "express";
import pg from "pg";
import mysql from "mysql2/promise";
import { MongoClient } from "mongodb";
import { createClient as createRedis } from "redis";
import { getServerDbConfig } from "../lib/server-db-config";

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

type NonSupaCreds = {
  dbType: "postgresql" | "mysql" | "mongodb" | "redis";
  host?: string;
  port?: string;
  dbUsername?: string;
  dbPassword?: string;
  dbName?: string;
  connectionString?: string;
};

async function checkSupabase(supabaseUrl: string, anonKey: string, sessionId: string): Promise<boolean> {
  const url = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/ai_control?session_id=eq.${encodeURIComponent(sessionId)}&select=ai_enabled&limit=1`;
  const res = await fetch(url, {
    headers: {
      "apikey": anonKey,
      "Authorization": `Bearer ${anonKey}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) return true; // default AI ON on error
  const rows = await res.json() as Array<{ ai_enabled: boolean }>;
  if (!rows || rows.length === 0) return true; // row not found → AI ON
  return rows[0].ai_enabled ?? true;
}

async function checkPostgres(creds: NonSupaCreds, sessionId: string): Promise<boolean> {
  const client = new pg.Client({
    host: creds.host,
    port: creds.port ? parseInt(creds.port) : 5432,
    user: creds.dbUsername,
    password: creds.dbPassword,
    database: creds.dbName,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
  });
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT ai_enabled FROM ai_control WHERE session_id = $1 LIMIT 1",
      [sessionId],
    );
    return rows[0]?.ai_enabled ?? true;
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkMysql(creds: NonSupaCreds, sessionId: string): Promise<boolean> {
  const conn = await mysql.createConnection({
    host: creds.host,
    port: creds.port ? parseInt(creds.port) : 3306,
    user: creds.dbUsername,
    password: creds.dbPassword,
    database: creds.dbName,
    connectTimeout: 8000,
    ssl: {},
  });
  try {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT ai_enabled FROM ai_control WHERE session_id = ? LIMIT 1",
      [sessionId],
    );
    return rows[0]?.ai_enabled ?? true;
  } finally {
    await conn.end().catch(() => {});
  }
}

async function checkMongo(creds: NonSupaCreds, sessionId: string): Promise<boolean> {
  const uri = creds.connectionString ||
    `mongodb://${creds.dbUsername}:${creds.dbPassword}@${creds.host}:${creds.port || 27017}/${creds.dbName}`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  try {
    const db = client.db(creds.dbName);
    const doc = await db.collection("ai_control").findOne({ session_id: sessionId }, { projection: { ai_enabled: 1 } });
    return doc?.ai_enabled ?? true;
  } finally {
    await client.close().catch(() => {});
  }
}

async function checkRedis(creds: NonSupaCreds, sessionId: string): Promise<boolean> {
  const url = creds.connectionString || `redis://${creds.host}:${creds.port || 6379}`;
  const client = createRedis({ url, socket: { connectTimeout: 8000 } });
  await client.connect();
  try {
    const val = await client.get(`ai_control:${sessionId}`);
    if (val === null) return true; // not set → AI ON
    return val !== "false";
  } finally {
    await client.disconnect().catch(() => {});
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────

router.post("/ai-status", async (req: Request, res: Response) => {
  const { session_id, supabase_url, anon_key, creds } = req.body as {
    session_id?: string;
    supabase_url?: string;
    anon_key?: string;
    creds?: NonSupaCreds;
  };

  if (!session_id) {
    return void res.status(400).json({ error: "session_id is required" });
  }

  // Resolve effective credentials:
  // 1. Use what was passed in the request (explicit)
  // 2. Fall back to server-stored credentials (saved from dashboard)
  let effectiveUrl = supabase_url;
  let effectiveKey = anon_key;
  let effectiveCreds = creds;

  if (!effectiveUrl && !effectiveCreds) {
    const stored = getServerDbConfig();
    if (stored) {
      if (stored.dbType === "supabase" && stored.supabase_url) {
        effectiveUrl = stored.supabase_url;
        effectiveKey = stored.anon_key || stored.service_role_key;
      } else if (stored.dbType !== "supabase") {
        effectiveCreds = {
          dbType: stored.dbType as NonSupaCreds["dbType"],
          host: stored.host,
          port: stored.port,
          dbUsername: stored.dbUsername,
          dbPassword: stored.dbPassword,
          dbName: stored.dbName,
          connectionString: stored.connectionString,
        };
      }
    }
  }

  try {
    let aiEnabled = true;

    if (effectiveUrl && effectiveKey) {
      aiEnabled = await checkSupabase(effectiveUrl, effectiveKey, session_id);
    } else if (effectiveCreds?.dbType === "postgresql") {
      aiEnabled = await checkPostgres(effectiveCreds, session_id);
    } else if (effectiveCreds?.dbType === "mysql") {
      aiEnabled = await checkMysql(effectiveCreds, session_id);
    } else if (effectiveCreds?.dbType === "mongodb") {
      aiEnabled = await checkMongo(effectiveCreds, session_id);
    } else if (effectiveCreds?.dbType === "redis") {
      aiEnabled = await checkRedis(effectiveCreds, session_id);
    } else {
      // No credentials at all — default AI ON and let the workflow continue
      return void res.json({ ai_enabled: true, session_id, note: "no_db_config" });
    }

    res.json({ ai_enabled: aiEnabled, session_id });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg, ai_enabled: true }); // default AI ON on error
  }
});

export default router;
