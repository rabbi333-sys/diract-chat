/**
 * Singleton connection pool manager.
 *
 * Instead of creating a new DB connection on every request, this module
 * maintains one live pool / client per unique database config.
 * Pools are reused across all requests until drainUserPools(userId) is called
 * (e.g. when the user saves a new DB config).
 *
 * Supported: PostgreSQL (via pg), MySQL (via mysql2), MongoDB, Redis (ioredis)
 *
 * Race-condition safety:
 *   PostgreSQL / MySQL / Redis pool creation is synchronous in JS (no await gap),
 *   so the check-then-create pattern is already atomic in Node's single-threaded
 *   event loop. We nonetheless add in-flight Maps for future-proofing.
 *
 *   MongoDB.connect() IS async, so it uses a proper in-flight promise map
 *   (mongoInFlight) to ensure only one connection attempt per config key.
 */

import pg from "pg";
import mysql from "mysql2/promise";
import { MongoClient } from "mongodb";
import Redis from "ioredis";
import { createHash } from "crypto";

export type SessionsCreds = {
  dbType: "postgresql" | "mysql" | "mongodb" | "redis" | "supabase";
  host?: string;
  port?: string;
  dbUsername?: string;
  dbPassword?: string;
  dbName?: string;
  connectionString?: string;
  supabaseUrl?: string;
  tableName?: string;
};

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function pgKey(c: SessionsCreds): string {
  return hash(`pg|${c.dbType}|${c.supabaseUrl ?? ""}|${c.host ?? ""}|${c.port ?? ""}|${c.dbUsername ?? ""}|${c.dbPassword ?? ""}|${c.dbName ?? ""}`);
}

function mysqlKey(c: SessionsCreds): string {
  return hash(`mysql|${c.host ?? ""}|${c.port ?? ""}|${c.dbUsername ?? ""}|${c.dbPassword ?? ""}|${c.dbName ?? ""}`);
}

function mongoKey(c: SessionsCreds): string {
  return hash(`mongo|${c.connectionString ?? ""}|${c.host ?? ""}|${c.port ?? ""}|${c.dbUsername ?? ""}|${c.dbPassword ?? ""}|${c.dbName ?? ""}`);
}

function redisKey(c: SessionsCreds): string {
  return hash(`redis|${c.connectionString ?? ""}|${c.host ?? ""}|${c.port ?? ""}|${c.dbPassword ?? ""}|${c.dbName ?? ""}`);
}

export function buildPgConnStr(c: SessionsCreds): string {
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

export function mongoUri(c: SessionsCreds): string {
  if (c.connectionString) return c.connectionString;
  const user = c.dbUsername ? encodeURIComponent(c.dbUsername) : "";
  const pass = c.dbPassword ? encodeURIComponent(c.dbPassword) : "";
  const auth = user ? `${user}:${pass}@` : "";
  return `mongodb://${auth}${c.host || "localhost"}:${c.port || "27017"}/${c.dbName || ""}`;
}

// ── Pool stores ───────────────────────────────────────────────────────────────

const pgPools = new Map<string, pg.Pool>();
const mysqlPools = new Map<string, mysql.Pool>();
const mongoClients = new Map<string, MongoClient>();
const mongoInFlight = new Map<string, Promise<MongoClient>>();
const redisClients = new Map<string, Redis>();

// Per-user tracking: userId → Set of pool/client config keys
// Allows drainUserPools() to close only the pools owned by a specific user.
const userPgKeys    = new Map<string, Set<string>>();
const userMysqlKeys = new Map<string, Set<string>>();
const userMongoKeys = new Map<string, Set<string>>();
const userRedisKeys = new Map<string, Set<string>>();

function trackKey(map: Map<string, Set<string>>, userId: string | undefined, key: string) {
  if (!userId) return;
  let s = map.get(userId);
  if (!s) { s = new Set(); map.set(userId, s); }
  s.add(key);
}

// ── Pool accessors ────────────────────────────────────────────────────────────

export function getPgPool(c: SessionsCreds, userId?: string): pg.Pool {
  const key = pgKey(c);
  const existing = pgPools.get(key);
  if (existing) {
    trackKey(userPgKeys, userId, key);
    return existing;
  }

  const pool = new pg.Pool({
    connectionString: buildPgConnStr(c),
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
  });

  pool.on("error", (_err, _client) => {
    pgPools.delete(key);
  });

  pgPools.set(key, pool);
  trackKey(userPgKeys, userId, key);
  return pool;
}

export function getMysqlPool(c: SessionsCreds, userId?: string): mysql.Pool {
  const key = mysqlKey(c);
  const existing = mysqlPools.get(key);
  if (existing) {
    trackKey(userMysqlKeys, userId, key);
    return existing;
  }

  const pool = mysql.createPool({
    host: c.host || "localhost",
    port: c.port ? Number(c.port) : 3306,
    user: c.dbUsername || "root",
    password: c.dbPassword || "",
    database: c.dbName || "mydb",
    ssl: { rejectUnauthorized: false },
    connectionLimit: 10,
    waitForConnections: true,
    queueLimit: 0,
  });

  mysqlPools.set(key, pool);
  trackKey(userMysqlKeys, userId, key);
  return pool;
}

export function getMongoClient(c: SessionsCreds, userId?: string): Promise<MongoClient> {
  const key = mongoKey(c);
  const existing = mongoClients.get(key);
  if (existing) {
    trackKey(userMongoKeys, userId, key);
    return Promise.resolve(existing);
  }

  const inflight = mongoInFlight.get(key);
  if (inflight) {
    trackKey(userMongoKeys, userId, key);
    return inflight;
  }

  const p = (async () => {
    const client = new MongoClient(mongoUri(c), { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    mongoClients.set(key, client);
    mongoInFlight.delete(key);
    return client;
  })();

  mongoInFlight.set(key, p);
  p.catch(() => mongoInFlight.delete(key));
  trackKey(userMongoKeys, userId, key);
  return p;
}

export function getRedisClient(c: SessionsCreds, userId?: string): Redis {
  const key = redisKey(c);
  const existing = redisClients.get(key);
  if (existing) {
    trackKey(userRedisKeys, userId, key);
    return existing;
  }

  const dbIndex = c.dbName !== undefined && c.dbName !== "" && !isNaN(Number(c.dbName))
    ? Number(c.dbName)
    : 0;
  const r = c.connectionString
    ? new Redis(c.connectionString, { maxRetriesPerRequest: 1, enableReadyCheck: false })
    : new Redis({
        host: c.host || "localhost",
        port: c.port ? Number(c.port) : 6379,
        password: c.dbPassword || undefined,
        db: dbIndex,
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
      });

  r.on("error", () => {
    redisClients.delete(key);
  });

  redisClients.set(key, r);
  trackKey(userRedisKeys, userId, key);
  return r;
}

// ── Pool draining ─────────────────────────────────────────────────────────────

/** Drain only the pools that were created for a specific user's DB config. */
export async function drainUserPools(userId: string): Promise<void> {
  const tasks: Promise<void>[] = [];

  const pgKeys = userPgKeys.get(userId);
  if (pgKeys) {
    for (const key of pgKeys) {
      const pool = pgPools.get(key);
      if (pool) { tasks.push(pool.end().catch(() => {})); pgPools.delete(key); }
    }
    userPgKeys.delete(userId);
  }

  const mKeys = userMysqlKeys.get(userId);
  if (mKeys) {
    for (const key of mKeys) {
      const pool = mysqlPools.get(key);
      if (pool) { tasks.push(pool.end().catch(() => {})); mysqlPools.delete(key); }
    }
    userMysqlKeys.delete(userId);
  }

  const mgKeys = userMongoKeys.get(userId);
  if (mgKeys) {
    for (const key of mgKeys) {
      const client = mongoClients.get(key);
      if (client) { tasks.push(client.close().catch(() => {})); mongoClients.delete(key); }
      mongoInFlight.delete(key);
    }
    userMongoKeys.delete(userId);
  }

  const rKeys = userRedisKeys.get(userId);
  if (rKeys) {
    for (const key of rKeys) {
      const r = redisClients.get(key);
      if (r) { r.disconnect(); redisClients.delete(key); }
    }
    userRedisKeys.delete(userId);
  }

  await Promise.all(tasks);
}

/** Drain ALL pools across all users (used during server shutdown). */
export async function drainAllPools(): Promise<void> {
  const tasks: Promise<void>[] = [];

  for (const pool of pgPools.values()) tasks.push(pool.end().catch(() => {}));
  pgPools.clear();
  userPgKeys.clear();

  for (const pool of mysqlPools.values()) tasks.push(pool.end().catch(() => {}));
  mysqlPools.clear();
  userMysqlKeys.clear();

  for (const client of mongoClients.values()) tasks.push(client.close().catch(() => {}));
  mongoClients.clear();
  mongoInFlight.clear();
  userMongoKeys.clear();

  for (const r of redisClients.values()) r.disconnect();
  redisClients.clear();
  userRedisKeys.clear();

  await Promise.all(tasks);
}
