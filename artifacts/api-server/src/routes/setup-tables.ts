import { Router, type Request, type Response } from "express";
import pg from "pg";

const router = Router();

function buildConnStr(supabaseUrl: string, dbPassword: string): string {
  const url = supabaseUrl.trim().replace(/\/$/, "");
  const match = url.match(/https:\/\/([^.]+)\.supabase\.co/i);
  if (!match) throw new Error("Invalid Supabase URL — expected https://<ref>.supabase.co");
  const ref = match[1];
  return `postgresql://postgres:${encodeURIComponent(dbPassword)}@db.${ref}.supabase.co:5432/postgres`;
}

const SETUP_STATEMENTS: { label: string; sql: string }[] = [
  {
    label: "sessions",
    sql: `
CREATE TABLE IF NOT EXISTS sessions (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT        NOT NULL,
  message       JSONB       NOT NULL,
  recipient     TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_recipient  ON sessions(recipient);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);
ALTER TABLE sessions REPLICA IDENTITY FULL;`,
  },
  {
    label: "orders",
    sql: `
CREATE TABLE IF NOT EXISTS orders (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          TEXT,
  recipient_id        TEXT,
  customer_name       TEXT,
  customer_phone      TEXT,
  customer_address    TEXT,
  product_name        TEXT        NOT NULL,
  sku                 TEXT,
  quantity            INT         NOT NULL DEFAULT 1,
  unit_price          NUMERIC,
  total_price         NUMERIC,
  amount_to_collect   NUMERIC,
  payment_status      TEXT                 DEFAULT 'unpaid',
  status              TEXT        NOT NULL DEFAULT 'pending',
  source              TEXT,
  merchant_order_id   TEXT,
  consignment_id      TEXT,
  notes               TEXT,
  reason_for_cancel   TEXT,
  order_data          JSONB,
  pathao              NUMERIC,
  steadfast           NUMERIC,
  paperfly            NUMERIC,
  redex               NUMERIC,
  total_parcels       NUMERIC,
  total_delivered     NUMERIC,
  total_cancel        NUMERIC,
  order_receive_ratio TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_session_id   ON orders(session_id);
CREATE INDEX IF NOT EXISTS idx_orders_recipient_id ON orders(recipient_id);
CREATE INDEX IF NOT EXISTS idx_orders_status       ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at   ON orders(created_at DESC);
ALTER TABLE orders REPLICA IDENTITY FULL;`,
  },
  {
    label: "handoff_requests",
    sql: `
CREATE TABLE IF NOT EXISTS handoff_requests (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  TEXT,
  recipient   TEXT,
  reason      TEXT        NOT NULL DEFAULT 'Human requested',
  message     TEXT,
  priority    TEXT        NOT NULL DEFAULT 'normal',
  status      TEXT        NOT NULL DEFAULT 'pending',
  agent_data  JSONB,
  notes       TEXT,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_handoff_status     ON handoff_requests(status);
CREATE INDEX IF NOT EXISTS idx_handoff_session_id ON handoff_requests(session_id);
CREATE INDEX IF NOT EXISTS idx_handoff_created_at ON handoff_requests(created_at DESC);
ALTER TABLE handoff_requests REPLICA IDENTITY FULL;`,
  },
  {
    label: "ai_control",
    sql: `
CREATE TABLE IF NOT EXISTS ai_control (
  session_id  TEXT        PRIMARY KEY,
  ai_enabled  BOOLEAN     NOT NULL DEFAULT TRUE,
  user_id     TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE ai_control REPLICA IDENTITY FULL;`,
  },
  {
    label: "failed_automations",
    sql: `
CREATE TABLE IF NOT EXISTS failed_automations (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     TEXT,
  user_id        TEXT,
  recipient      TEXT,
  workflow_name  TEXT,
  error_message  TEXT        NOT NULL,
  error_details  JSONB,
  severity       TEXT        DEFAULT 'error',
  source         TEXT,
  resolved       BOOLEAN     DEFAULT FALSE,
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_failed_resolved   ON failed_automations(resolved);
CREATE INDEX IF NOT EXISTS idx_failed_created_at ON failed_automations(created_at DESC);
ALTER TABLE failed_automations REPLICA IDENTITY FULL;`,
  },
  {
    label: "app_owner",
    sql: `
CREATE TABLE IF NOT EXISTS app_owner (
  user_id    TEXT        PRIMARY KEY,
  claimed_at TIMESTAMPTZ DEFAULT NOW()
);`,
  },
  {
    label: "team_invites",
    sql: `
CREATE TABLE IF NOT EXISTS team_invites (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by       TEXT         NOT NULL DEFAULT '',
  email            TEXT,
  role             TEXT         NOT NULL DEFAULT 'agent',
  permissions      TEXT[]       NOT NULL DEFAULT '{}',
  token            TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
  status           TEXT         NOT NULL DEFAULT 'pending',
  accepted_user_id TEXT,
  submitted_name          TEXT,
  submitted_email         TEXT,
  submitted_password_hash TEXT,
  submitted_at            TIMESTAMPTZ,
  last_login_at           TIMESTAMPTZ,
  subadmin_db_creds       TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_invites_token ON team_invites(token);
CREATE INDEX        IF NOT EXISTS idx_team_invites_email ON team_invites(email);`,
  },
  {
    label: "api_keys",
    sql: `
CREATE TABLE IF NOT EXISTS api_keys (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    TEXT        NOT NULL,
  label      TEXT,
  api_key    TEXT        NOT NULL DEFAULT concat('sk-', gen_random_uuid()::text),
  is_active  BOOLEAN     DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key     ON api_keys(api_key);
CREATE INDEX        IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);`,
  },
  {
    label: "recipient_names",
    sql: `
CREATE TABLE IF NOT EXISTS recipient_names (
  recipient_id TEXT        PRIMARY KEY,
  name         TEXT        NOT NULL,
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);`,
  },
  {
    label: "claim_owner_if_unclaimed (RPC)",
    sql: `
CREATE OR REPLACE FUNCTION claim_owner_if_unclaimed()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO current_count FROM public.app_owner;
  IF current_count = 0 THEN
    INSERT INTO public.app_owner (user_id, claimed_at)
    VALUES (auth.uid()::text, NOW())
    ON CONFLICT (user_id) DO NOTHING;
    RETURN true;
  END IF;
  RETURN false;
END;
$$;`,
  },
];

router.post("/setup-tables", async (req: Request, res: Response) => {
  const { supabaseUrl, dbPassword } = req.body as { supabaseUrl?: string; dbPassword?: string };
  if (!supabaseUrl || !dbPassword) {
    return void res.status(400).json({ error: "supabaseUrl and dbPassword are required" });
  }

  let connStr: string;
  try {
    connStr = buildConnStr(supabaseUrl, dbPassword);
  } catch (err: unknown) {
    return void res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }

  const pool = new pg.Pool({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 5000,
  });

  const tablesCreated: string[] = [];
  const errors: { label: string; error: string }[] = [];

  const client = await pool.connect().catch((e: unknown) => {
    throw new Error("Could not connect to PostgreSQL: " + (e instanceof Error ? e.message : String(e)));
  });

  try {
    for (const stmt of SETUP_STATEMENTS) {
      try {
        await client.query(stmt.sql);
        tablesCreated.push(stmt.label);
      } catch (err: unknown) {
        errors.push({ label: stmt.label, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  res.json({
    success: errors.length === 0,
    tablesCreated,
    errors,
  });
});

export default router;
