import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import type { Collection } from "mongodb";
import type { Redis } from "ioredis";
import {
  getPgPool,
  getMysqlPool,
  getMongoClient,
  getRedisClient,
  type SessionsCreds,
} from "../lib/connection-pool";

const router = Router();

// ── Credential type ───────────────────────────────────────────────────────────

export type DbCreds = {
  dbType: "postgresql" | "mysql" | "mongodb" | "redis";
  host?: string;
  port?: string;
  dbUsername?: string;
  dbPassword?: string;
  dbName?: string;
  connectionString?: string;
};

function asSC(c: DbCreds): SessionsCreds {
  return { ...c };
}

// ── Invite record ─────────────────────────────────────────────────────────────

type InviteRecord = {
  id: string;
  email: string;
  role: string;
  permissions: string[];
  token: string;
  status: string;
  created_by: string;
  submitted_name: string | null;
  submitted_email: string | null;
  submitted_password_hash?: string | null;
  submitted_at: string | null;
  last_login_at?: string | null;
  subadmin_db_creds?: string | null;
  created_at: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// PostgreSQL helpers (pooled)
// ─────────────────────────────────────────────────────────────────────────────

async function pgQuery<T>(c: DbCreds, sql: string, params: unknown[] = []): Promise<T[]> {
  const pool = getPgPool(asSC(c));
  const { rows } = await pool.query(sql, params);
  return rows as T[];
}

const PG_INIT_SQL = `
CREATE TABLE IF NOT EXISTS team_invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT,
  role        TEXT NOT NULL DEFAULT 'viewer',
  permissions TEXT NOT NULL DEFAULT '[]',
  token       UUID UNIQUE DEFAULT gen_random_uuid(),
  status      TEXT NOT NULL DEFAULT 'pending',
  created_by  TEXT NOT NULL DEFAULT '',
  submitted_name          TEXT,
  submitted_email         TEXT,
  submitted_password_hash TEXT,
  submitted_at            TIMESTAMPTZ,
  last_login_at           TIMESTAMPTZ,
  subadmin_db_creds       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

const PG_MIGRATE_SQL = `
DO $$ BEGIN
  ALTER TABLE team_invites ADD COLUMN last_login_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE team_invites ADD COLUMN subadmin_db_creds TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
`;

// ─────────────────────────────────────────────────────────────────────────────
// MySQL helpers (pooled)
// ─────────────────────────────────────────────────────────────────────────────

async function mysqlQuery<T>(c: DbCreds, sql: string, params: unknown[] = []): Promise<T[]> {
  const pool = getMysqlPool(asSC(c));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [rows] = await pool.execute(sql, params as any[]);
  return rows as T[];
}

const MYSQL_INIT_SQL = `
CREATE TABLE IF NOT EXISTS team_invites (
  id                      VARCHAR(36)  PRIMARY KEY,
  email                   TEXT,
  role                    VARCHAR(32)  NOT NULL DEFAULT 'viewer',
  permissions             TEXT         NOT NULL DEFAULT '[]',
  token                   VARCHAR(36)  UNIQUE NOT NULL,
  status                  VARCHAR(32)  NOT NULL DEFAULT 'pending',
  created_by              VARCHAR(255) NOT NULL DEFAULT '',
  submitted_name          TEXT,
  submitted_email         TEXT,
  submitted_password_hash TEXT,
  submitted_at            DATETIME(6),
  last_login_at           DATETIME(6),
  subadmin_db_creds       TEXT,
  created_at              DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
`;

const MYSQL_MIGRATE_SQLS = [
  `ALTER TABLE team_invites ADD COLUMN IF NOT EXISTS last_login_at DATETIME(6)`,
  `ALTER TABLE team_invites ADD COLUMN IF NOT EXISTS subadmin_db_creds TEXT`,
];

// ─────────────────────────────────────────────────────────────────────────────
// MongoDB helpers (pooled — no client.close())
// ─────────────────────────────────────────────────────────────────────────────

async function mongoOp<T>(c: DbCreds, fn: (col: Collection) => Promise<T>): Promise<T> {
  const client = await getMongoClient(asSC(c));
  const db = client.db(c.dbName || "meta_automation");
  await db.collection("team_invites").createIndex({ token: 1 }, { unique: true }).catch(() => null);
  await db.collection("team_invites").createIndex({ created_by: 1 }).catch(() => null);
  return fn(db.collection("team_invites"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Redis helpers (pooled — no connect/disconnect)
// ─────────────────────────────────────────────────────────────────────────────

const REDIS_KEY = (token: string) => `team_invite:${token}`;
const REDIS_IDX  = (userId: string) => `team_invite_idx:${userId}`;
const REDIS_ALL  = "team_invite_all";

async function redisOp<T>(c: DbCreds, fn: (r: Redis) => Promise<T>): Promise<T> {
  const r = getRedisClient(asSC(c));
  return fn(r);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared normalise helpers
// ─────────────────────────────────────────────────────────────────────────────

function parsePerms(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return []; }
  }
  return [];
}

function normRow(r: Record<string, unknown>): InviteRecord {
  return {
    id:                      String(r.id ?? ""),
    email:                   String(r.email ?? ""),
    role:                    String(r.role ?? "viewer"),
    permissions:             parsePerms(r.permissions),
    token:                   String(r.token ?? ""),
    status:                  String(r.status ?? "pending"),
    created_by:              String(r.created_by ?? ""),
    submitted_name:          r.submitted_name ? String(r.submitted_name) : null,
    submitted_email:         r.submitted_email ? String(r.submitted_email) : null,
    submitted_at:            r.submitted_at ? String(r.submitted_at) : null,
    last_login_at:           r.last_login_at ? String(r.last_login_at) : null,
    subadmin_db_creds:       r.subadmin_db_creds ? String(r.subadmin_db_creds) : null,
    created_at:              r.created_at ? String(r.created_at) : new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /api/member-auth/init
// ─────────────────────────────────────────────────────────────────────────────

router.post("/member-auth/init", async (req: Request, res: Response) => {
  const creds: DbCreds = req.body.creds;
  if (!creds?.dbType) return void res.status(400).json({ error: "Missing creds.dbType" });

  try {
    if (creds.dbType === "postgresql") {
      await pgQuery(creds, PG_INIT_SQL);
      await pgQuery(creds, PG_MIGRATE_SQL);
    } else if (creds.dbType === "mysql") {
      await mysqlQuery(creds, MYSQL_INIT_SQL);
      for (const sql of MYSQL_MIGRATE_SQLS) { try { await mysqlQuery(creds, sql); } catch { /* column may already exist */ } }
    } else if (creds.dbType === "mongodb") {
      await mongoOp(creds, async (col) => { await col.countDocuments({}); });
    } else if (creds.dbType === "redis") {
      await redisOp(creds, async (r) => { await r.ping(); });
    }
    res.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /api/member-auth/invites/list
// ─────────────────────────────────────────────────────────────────────────────

router.post("/member-auth/invites/list", async (req: Request, res: Response) => {
  const { creds, userId }: { creds: DbCreds; userId: string } = req.body;
  if (!creds?.dbType) return void res.status(400).json({ error: "Missing creds" });

  try {
    let rows: InviteRecord[] = [];

    if (creds.dbType === "postgresql") {
      const raw = await pgQuery<Record<string, unknown>>(
        creds,
        "SELECT * FROM team_invites WHERE created_by = $1 ORDER BY created_at DESC",
        [userId],
      );
      rows = raw.map(normRow);
    } else if (creds.dbType === "mysql") {
      const raw = await mysqlQuery<Record<string, unknown>>(
        creds,
        "SELECT * FROM team_invites WHERE created_by = ? ORDER BY created_at DESC",
        [userId],
      );
      rows = raw.map(normRow);
    } else if (creds.dbType === "mongodb") {
      rows = await mongoOp(creds, async (col) => {
        const docs = await col.find({ created_by: userId }).sort({ created_at: -1 }).toArray();
        return docs.map((d) => normRow({ ...d, id: String(d._id ?? d.id ?? "") }));
      });
    } else if (creds.dbType === "redis") {
      rows = await redisOp(creds, async (r) => {
        const tokens = await r.smembers(REDIS_IDX(userId));
        const list: InviteRecord[] = [];
        for (const tok of tokens) {
          const raw = await r.get(REDIS_KEY(tok));
          if (raw) {
            try { list.push(normRow(JSON.parse(raw))); } catch { /* skip */ }
          }
        }
        return list.sort((a, b) => b.created_at.localeCompare(a.created_at));
      });
    }

    res.json({ invites: rows });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /api/member-auth/invites/create
// ─────────────────────────────────────────────────────────────────────────────

router.post("/member-auth/invites/create", async (req: Request, res: Response) => {
  const { creds, invite }: { creds: DbCreds; invite: Partial<InviteRecord> } = req.body;
  if (!creds?.dbType) return void res.status(400).json({ error: "Missing creds" });

  const id     = randomUUID();
  const token  = randomUUID();
  const perms  = JSON.stringify(invite.permissions ?? []);
  const email  = invite.email ?? "";
  const role   = invite.role ?? "viewer";
  const userId = invite.created_by ?? "";
  const now    = new Date().toISOString();

  try {
    let record: InviteRecord | null = null;

    if (creds.dbType === "postgresql") {
      await pgQuery(creds, PG_INIT_SQL);
      await pgQuery(creds, PG_MIGRATE_SQL);
      const rows = await pgQuery<Record<string, unknown>>(
        creds,
        "INSERT INTO team_invites (id,email,role,permissions,token,status,created_by,created_at) VALUES ($1,$2,$3,$4,$5,'pending',$6,NOW()) RETURNING *",
        [id, email, role, perms, token, userId],
      );
      record = rows[0] ? normRow(rows[0]) : null;
    } else if (creds.dbType === "mysql") {
      await mysqlQuery(creds, MYSQL_INIT_SQL);
      for (const sql of MYSQL_MIGRATE_SQLS) { try { await mysqlQuery(creds, sql); } catch { /* column may already exist */ } }
      await mysqlQuery(
        creds,
        "INSERT INTO team_invites (id,email,role,permissions,token,status,created_by,created_at) VALUES (?,?,?,?,?,'pending',?,NOW(6))",
        [id, email, role, perms, token, userId],
      );
      const rows = await mysqlQuery<Record<string, unknown>>(creds, "SELECT * FROM team_invites WHERE id=?", [id]);
      record = rows[0] ? normRow(rows[0]) : null;
    } else if (creds.dbType === "mongodb") {
      record = await mongoOp(creds, async (col) => {
        const doc = { id, email, role, permissions: invite.permissions ?? [], token, status: "pending", created_by: userId, created_at: now, submitted_name: null, submitted_email: null, submitted_at: null };
        await col.insertOne(doc);
        return normRow(doc);
      });
    } else if (creds.dbType === "redis") {
      record = await redisOp(creds, async (r) => {
        const doc: InviteRecord = { id, email, role, permissions: invite.permissions ?? [], token, status: "pending", created_by: userId, submitted_name: null, submitted_email: null, submitted_at: null, created_at: now };
        await r.set(REDIS_KEY(token), JSON.stringify(doc));
        await r.sadd(REDIS_IDX(userId), token);
        await r.sadd(REDIS_ALL, token);
        return doc;
      });
    }

    res.json({ invite: record });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /api/member-auth/invites/update
// ─────────────────────────────────────────────────────────────────────────────

router.post("/member-auth/invites/update", async (req: Request, res: Response) => {
  const { creds, id, update }: { creds: DbCreds; id: string; update: Partial<InviteRecord> } = req.body;
  if (!creds?.dbType) return void res.status(400).json({ error: "Missing creds" });

  const fields = Object.entries(update).filter(([k]) => ["status"].includes(k));
  if (fields.length === 0) return void res.status(400).json({ error: "Nothing to update" });

  try {
    if (creds.dbType === "postgresql") {
      const setClauses = fields.map(([k], i) => `${k} = $${i + 2}`).join(", ");
      await pgQuery(creds, `UPDATE team_invites SET ${setClauses} WHERE id = $1`, [id, ...fields.map(([, v]) => v)]);
    } else if (creds.dbType === "mysql") {
      const setClauses = fields.map(([k]) => `${k} = ?`).join(", ");
      await mysqlQuery(creds, `UPDATE team_invites SET ${setClauses} WHERE id = ?`, [...fields.map(([, v]) => v), id]);
    } else if (creds.dbType === "mongodb") {
      await mongoOp(creds, async (col) => {
        await col.updateOne({ id }, { $set: Object.fromEntries(fields) });
      });
    } else if (creds.dbType === "redis") {
      await redisOp(creds, async (r) => {
        const allTokens = await r.smembers(REDIS_ALL);
        for (const tok of allTokens) {
          const raw = await r.get(REDIS_KEY(tok));
          if (!raw) continue;
          const doc = JSON.parse(raw) as InviteRecord;
          if (doc.id === id) {
            const updated = { ...doc, ...Object.fromEntries(fields) };
            await r.set(REDIS_KEY(tok), JSON.stringify(updated));
            break;
          }
        }
      });
    }

    res.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /api/member-auth/invites/delete
// ─────────────────────────────────────────────────────────────────────────────

router.post("/member-auth/invites/delete", async (req: Request, res: Response) => {
  const { creds, id }: { creds: DbCreds; id: string } = req.body;
  if (!creds?.dbType) return void res.status(400).json({ error: "Missing creds" });

  try {
    if (creds.dbType === "postgresql") {
      await pgQuery(creds, "DELETE FROM team_invites WHERE id = $1", [id]);
    } else if (creds.dbType === "mysql") {
      await mysqlQuery(creds, "DELETE FROM team_invites WHERE id = ?", [id]);
    } else if (creds.dbType === "mongodb") {
      await mongoOp(creds, async (col) => {
        await col.deleteOne({ id });
      });
    } else if (creds.dbType === "redis") {
      await redisOp(creds, async (r) => {
        const allTokens = await r.smembers(REDIS_ALL);
        for (const tok of allTokens) {
          const raw = await r.get(REDIS_KEY(tok));
          if (!raw) continue;
          const doc = JSON.parse(raw) as InviteRecord;
          if (doc.id === id) {
            await r.del(REDIS_KEY(tok));
            await r.srem(REDIS_IDX(doc.created_by), tok);
            await r.srem(REDIS_ALL, tok);
            break;
          }
        }
      });
    }

    res.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /api/member-auth/token
// ─────────────────────────────────────────────────────────────────────────────

router.post("/member-auth/token", async (req: Request, res: Response) => {
  const { creds, token }: { creds: DbCreds; token: string } = req.body;
  if (!creds?.dbType) return void res.status(400).json({ error: "Missing creds" });

  try {
    let invite: InviteRecord | null = null;

    if (creds.dbType === "postgresql") {
      const rows = await pgQuery<Record<string, unknown>>(
        creds, "SELECT * FROM team_invites WHERE token = $1 AND status = 'pending'", [token],
      );
      invite = rows[0] ? normRow(rows[0]) : null;
    } else if (creds.dbType === "mysql") {
      const rows = await mysqlQuery<Record<string, unknown>>(
        creds, "SELECT * FROM team_invites WHERE token = ? AND status = 'pending'", [token],
      );
      invite = rows[0] ? normRow(rows[0]) : null;
    } else if (creds.dbType === "mongodb") {
      invite = await mongoOp(creds, async (col) => {
        const doc = await col.findOne({ token, status: "pending" });
        return doc ? normRow({ ...doc, id: String(doc._id ?? doc.id ?? "") }) : null;
      });
    } else if (creds.dbType === "redis") {
      invite = await redisOp(creds, async (r) => {
        const raw = await r.get(REDIS_KEY(token));
        if (!raw) return null;
        const doc = JSON.parse(raw) as InviteRecord;
        return doc.status === "pending" ? doc : null;
      });
    }

    res.json({ invite });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /api/member-auth/submit
// ─────────────────────────────────────────────────────────────────────────────

router.post("/member-auth/submit", async (req: Request, res: Response) => {
  const { creds, token, name, email, passwordHash }: { creds: DbCreds; token: string; name: string; email: string; passwordHash: string } = req.body;
  if (!creds?.dbType) return void res.status(400).json({ error: "Missing creds" });

  try {
    let result: "ok" | "not_found" = "not_found";
    const now = new Date().toISOString();

    if (creds.dbType === "postgresql") {
      const rows = await pgQuery<{ id: string }>(
        creds, "SELECT id FROM team_invites WHERE token = $1 AND status = 'pending'", [token],
      );
      if (rows[0]) {
        await pgQuery(
          creds,
          "UPDATE team_invites SET submitted_name=$1, submitted_email=$2, submitted_password_hash=$3, submitted_at=NOW() WHERE id=$4",
          [name, email.toLowerCase().trim(), passwordHash, rows[0].id],
        );
        result = "ok";
      }
    } else if (creds.dbType === "mysql") {
      const rows = await mysqlQuery<{ id: string }>(
        creds, "SELECT id FROM team_invites WHERE token = ? AND status = 'pending'", [token],
      );
      if (rows[0]) {
        await mysqlQuery(
          creds,
          "UPDATE team_invites SET submitted_name=?, submitted_email=?, submitted_password_hash=?, submitted_at=NOW(6) WHERE id=?",
          [name, email.toLowerCase().trim(), passwordHash, rows[0].id],
        );
        result = "ok";
      }
    } else if (creds.dbType === "mongodb") {
      result = await mongoOp(creds, async (col) => {
        const r = await col.findOneAndUpdate(
          { token, status: "pending" },
          { $set: { submitted_name: name, submitted_email: email.toLowerCase().trim(), submitted_password_hash: passwordHash, submitted_at: now } },
          { returnDocument: "after" },
        );
        return r ? "ok" : "not_found";
      });
    } else if (creds.dbType === "redis") {
      result = await redisOp(creds, async (r) => {
        const raw = await r.get(REDIS_KEY(token));
        if (!raw) return "not_found";
        const doc = JSON.parse(raw) as InviteRecord;
        if (doc.status !== "pending") return "not_found";
        const updated = { ...doc, submitted_name: name, submitted_email: email.toLowerCase().trim(), submitted_password_hash: passwordHash, submitted_at: now };
        await r.set(REDIS_KEY(token), JSON.stringify(updated));
        return "ok";
      });
    }

    res.json({ result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /api/member-auth/login
// ─────────────────────────────────────────────────────────────────────────────

router.post("/member-auth/login", async (req: Request, res: Response) => {
  const { creds, email, passwordHash }: { creds: DbCreds; email: string; passwordHash: string } = req.body;
  if (!creds?.dbType) return void res.status(400).json({ error: "Missing creds" });

  try {
    type MemberResult = { id: string; role: string; permissions: string[]; submitted_name: string | null; submitted_email: string | null; last_login_at: string | null; subadmin_db_creds: string | null };
    let member: MemberResult | null = null;
    const normEmail = email.toLowerCase().trim();
    const loginNow = new Date().toISOString();

    if (creds.dbType === "postgresql") {
      const rows = await pgQuery<Record<string, unknown>>(
        creds,
        "UPDATE team_invites SET last_login_at=NOW() WHERE submitted_email=$1 AND submitted_password_hash=$2 AND status='accepted' RETURNING id,role,permissions,submitted_name,submitted_email,last_login_at,subadmin_db_creds",
        [normEmail, passwordHash],
      );
      if (rows[0]) {
        member = {
          id: String(rows[0].id),
          role: String(rows[0].role),
          permissions: parsePerms(rows[0].permissions),
          submitted_name: rows[0].submitted_name ? String(rows[0].submitted_name) : null,
          submitted_email: rows[0].submitted_email ? String(rows[0].submitted_email) : null,
          last_login_at: rows[0].last_login_at ? String(rows[0].last_login_at) : loginNow,
          subadmin_db_creds: rows[0].subadmin_db_creds ? String(rows[0].subadmin_db_creds) : null,
        };
      }
    } else if (creds.dbType === "mysql") {
      await mysqlQuery(creds, "UPDATE team_invites SET last_login_at=NOW(6) WHERE submitted_email=? AND submitted_password_hash=? AND status='accepted'", [normEmail, passwordHash]);
      const rows = await mysqlQuery<Record<string, unknown>>(
        creds,
        "SELECT id,role,permissions,submitted_name,submitted_email,last_login_at,subadmin_db_creds FROM team_invites WHERE submitted_email=? AND submitted_password_hash=? AND status='accepted'",
        [normEmail, passwordHash],
      );
      if (rows[0]) {
        member = {
          id: String(rows[0].id),
          role: String(rows[0].role),
          permissions: parsePerms(rows[0].permissions),
          submitted_name: rows[0].submitted_name ? String(rows[0].submitted_name) : null,
          submitted_email: rows[0].submitted_email ? String(rows[0].submitted_email) : null,
          last_login_at: rows[0].last_login_at ? String(rows[0].last_login_at) : loginNow,
          subadmin_db_creds: rows[0].subadmin_db_creds ? String(rows[0].subadmin_db_creds) : null,
        };
      }
    } else if (creds.dbType === "mongodb") {
      member = await mongoOp(creds, async (col) => {
        const updated = await col.findOneAndUpdate(
          { submitted_email: normEmail, submitted_password_hash: passwordHash, status: "accepted" },
          { $set: { last_login_at: loginNow } },
          { returnDocument: "after" },
        );
        const doc = updated as Record<string, unknown> | null;
        if (!doc) return null;
        return {
          id: String(doc._id ?? doc.id ?? ""),
          role: String(doc.role ?? "viewer"),
          permissions: parsePerms(doc.permissions),
          submitted_name: doc.submitted_name ? String(doc.submitted_name) : null,
          submitted_email: doc.submitted_email ? String(doc.submitted_email) : null,
          last_login_at: loginNow,
          subadmin_db_creds: null,
        };
      });
    } else if (creds.dbType === "redis") {
      member = await redisOp(creds, async (r) => {
        const allTokens = await r.smembers(REDIS_ALL);
        for (const tok of allTokens) {
          const raw = await r.get(REDIS_KEY(tok));
          if (!raw) continue;
          const doc = JSON.parse(raw) as InviteRecord & { submitted_password_hash?: string };
          if (doc.submitted_email === normEmail && doc.submitted_password_hash === passwordHash && doc.status === "accepted") {
            const updated = { ...doc, last_login_at: loginNow };
            await r.set(REDIS_KEY(tok), JSON.stringify(updated));
            return {
              id: doc.id,
              role: doc.role,
              permissions: doc.permissions,
              submitted_name: doc.submitted_name,
              submitted_email: doc.submitted_email,
              last_login_at: loginNow,
              subadmin_db_creds: null,
            };
          }
        }
        return null;
      });
    }

    res.json({ member });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
