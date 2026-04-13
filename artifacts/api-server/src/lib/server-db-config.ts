/**
 * Server-side database credential store — per-user.
 *
 * Each user's config is stored separately so that User A saving a new config
 * does not overwrite User B's active connection.
 *
 * In-memory Map is the primary store (fast, no I/O per request).
 * Writes are serialized via a promise-chain mutex so that concurrent POST
 * /api/db-config calls for the same user cannot race or leave a partial state.
 */

import fs from "fs";
import path from "path";

export type ServerDbConfig = {
  dbType: "supabase" | "postgresql" | "mysql" | "mongodb" | "redis";
  // Supabase
  supabase_url?: string;
  anon_key?: string;
  service_role_key?: string;
  // PostgreSQL / MySQL
  host?: string;
  port?: string;
  dbUsername?: string;
  dbPassword?: string;
  dbName?: string;
  // MongoDB / Redis
  connectionString?: string;
};

const DATA_DIR = path.join(process.cwd(), "data");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function userConfigFile(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(DATA_DIR, `db-config-${safe}.json`);
}

// In-memory per-user config store (primary)
const configStore = new Map<string, ServerDbConfig>();

// Per-user write mutex — serializes concurrent saves for the same user.
// Each entry is a promise chain; new writes are appended to the chain.
const writeMutex = new Map<string, Promise<void>>();

function enqueueWrite(userId: string, fn: () => void): Promise<void> {
  const prev = writeMutex.get(userId) ?? Promise.resolve();
  const next = prev.then(fn).catch(() => {});
  writeMutex.set(userId, next);
  return next;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Returns all stored configs (used by public webhook to find a Supabase config). */
export function getAllServerDbConfigs(): ServerDbConfig[] {
  return Array.from(configStore.values());
}

export function getServerDbConfig(userId: string): ServerDbConfig | null {
  // Check in-memory store first
  const mem = configStore.get(userId);
  if (mem) return mem;

  // Fall back to disk (e.g. after a server restart)
  try {
    ensureDataDir();
    const file = userConfigFile(userId);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    const cfg = JSON.parse(raw) as ServerDbConfig;
    configStore.set(userId, cfg);
    return cfg;
  } catch {
    return null;
  }
}

export function saveServerDbConfig(userId: string, config: ServerDbConfig): Promise<void> {
  return enqueueWrite(userId, () => {
    configStore.set(userId, config);
    try {
      ensureDataDir();
      fs.writeFileSync(userConfigFile(userId), JSON.stringify(config, null, 2), "utf8");
    } catch { /* non-fatal: in-memory store already updated */ }
  });
}

export function clearServerDbConfig(userId: string): void {
  configStore.delete(userId);
  try {
    const file = userConfigFile(userId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch { /* ignore */ }
}
