/**
 * Server-side database credential store.
 * Persists to a JSON file so it survives restarts.
 * The frontend pushes the active connection via POST /api/db-config
 * so n8n can call /api/ai-status with just session_id.
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
const CONFIG_FILE = path.join(DATA_DIR, "db-config.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function getServerDbConfig(): ServerDbConfig | null {
  try {
    ensureDataDir();
    if (!fs.existsSync(CONFIG_FILE)) return null;
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    return JSON.parse(raw) as ServerDbConfig;
  } catch {
    return null;
  }
}

export function saveServerDbConfig(config: ServerDbConfig): void {
  ensureDataDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

export function clearServerDbConfig(): void {
  try {
    if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
  } catch { /* ignore */ }
}
