/**
 * Singleton connection pool manager.
 *
 * Instead of creating a new DB connection on every request, this module
 * maintains one live pool / client per unique database config.
 * Pools are reused across all requests until drainAllPools() is called
 * (e.g. when the user saves a new DB config).
 *
 * Supported: PostgreSQL (via pg), MySQL (via mysql2), MongoDB, Redis (ioredis)
 */

import pg from "pg";
import mysql from "mysql2/promise";
import { MongoClient } from "mongodb";
import Redis from "ioredis";

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

function pgKey(c: SessionsCreds): string {
  return `pg|${c.dbType}|${c.supabaseUrl ?? ""}|${c.host ?? ""}|${c.port ?? ""}|${c.dbUsername ?? ""}|${c.dbPassword ?? ""}|${c.dbName ?? ""}`;
}

function mysqlKey(c: SessionsCreds): string {
  return `mysql|${c.host ?? ""}|${c.port ?? ""}|${c.dbUsername ?? ""}|${c.dbPassword ?? ""}|${c.dbName ?? ""}`;
}

function mongoKey(c: SessionsCreds): string {
  return `mongo|${c.connectionString ?? ""}|${c.host ?? ""}|${c.port ?? ""}|${c.dbUsername ?? ""}|${c.dbPassword ?? ""}|${c.dbName ?? ""}`;
}

function redisKey(c: SessionsCreds): string {
  return `redis|${c.connectionString ?? ""}|${c.host ?? ""}|${c.port ?? ""}|${c.dbPassword ?? ""}|${c.dbName ?? ""}`;
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

const pgPools = new Map<string, pg.Pool>();
const mysqlPools = new Map<string, mysql.Pool>();
const mongoClients = new Map<string, MongoClient>();
const redisClients = new Map<string, Redis>();

export function getPgPool(c: SessionsCreds): pg.Pool {
  const key = pgKey(c);
  const existing = pgPools.get(key);
  if (existing) return existing;

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
  return pool;
}

export function getMysqlPool(c: SessionsCreds): mysql.Pool {
  const key = mysqlKey(c);
  const existing = mysqlPools.get(key);
  if (existing) return existing;

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
  return pool;
}

export async function getMongoClient(c: SessionsCreds): Promise<MongoClient> {
  const key = mongoKey(c);
  const existing = mongoClients.get(key);
  if (existing) return existing;

  const client = new MongoClient(mongoUri(c), { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  mongoClients.set(key, client);
  return client;
}

export function getRedisClient(c: SessionsCreds): Redis {
  const key = redisKey(c);
  const existing = redisClients.get(key);
  if (existing) return existing;

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
  return r;
}

export async function drainAllPools(): Promise<void> {
  const tasks: Promise<void>[] = [];

  for (const pool of pgPools.values()) tasks.push(pool.end().catch(() => {}));
  pgPools.clear();

  for (const pool of mysqlPools.values()) tasks.push(pool.end().catch(() => {}));
  mysqlPools.clear();

  for (const client of mongoClients.values()) tasks.push(client.close().catch(() => {}));
  mongoClients.clear();

  for (const r of redisClients.values()) r.disconnect();
  redisClients.clear();

  await Promise.all(tasks);
}
