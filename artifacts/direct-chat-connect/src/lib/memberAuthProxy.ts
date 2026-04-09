/**
 * memberAuthProxy.ts
 * Frontend client for the member-auth API endpoints.
 * Used by non-Supabase database types (PostgreSQL, MySQL, MongoDB, Redis).
 * All DB credentials are sent in the request body; the API server connects
 * and performs the operation server-side.
 */

import type { MainDbConnection } from './db-config';

export type DbCreds = {
  dbType: 'postgresql' | 'mysql' | 'mongodb' | 'redis';
  host?: string;
  port?: string;
  dbUsername?: string;
  dbPassword?: string;
  dbName?: string;
  connectionString?: string;
};

export function buildCreds(conn: MainDbConnection): DbCreds {
  return {
    dbType: conn.dbType as DbCreds['dbType'],
    host: conn.host,
    port: conn.port,
    dbUsername: conn.dbUsername,
    dbPassword: conn.dbPassword,
    dbName: conn.dbName,
    connectionString: conn.connectionString,
  };
}

const API = '/api/member-auth';

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok || data.error) throw new Error((data.error as string) || `Request failed: ${res.status}`);
  return data as T;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProxyInvite = {
  id: string;
  email: string;
  role: string;
  permissions: string[];
  token: string;
  status: string;
  created_by: string;
  submitted_name: string | null;
  submitted_email: string | null;
  submitted_at: string | null;
  created_at: string;
};

export type ProxyMember = {
  id: string;
  role: string;
  permissions: string[];
  submitted_name: string | null;
  submitted_email: string | null;
};

// ── API calls ─────────────────────────────────────────────────────────────────

export async function proxyInit(creds: DbCreds): Promise<void> {
  await post('/init', { creds });
}

export async function proxyListInvites(creds: DbCreds, userId: string): Promise<ProxyInvite[]> {
  const { invites } = await post<{ invites: ProxyInvite[] }>('/invites/list', { creds, userId });
  return invites;
}

export async function proxyCreateInvite(
  creds: DbCreds,
  invite: { email: string; role: string; permissions: string[]; created_by: string }
): Promise<ProxyInvite> {
  const { invite: created } = await post<{ invite: ProxyInvite }>('/invites/create', { creds, invite });
  return created;
}

export async function proxyUpdateInvite(
  creds: DbCreds,
  id: string,
  update: { status: string }
): Promise<void> {
  await post('/invites/update', { creds, id, update });
}

export async function proxyDeleteInvite(creds: DbCreds, id: string): Promise<void> {
  await post('/invites/delete', { creds, id });
}

export async function proxyGetInviteByToken(
  creds: DbCreds,
  token: string
): Promise<ProxyInvite | null> {
  const { invite } = await post<{ invite: ProxyInvite | null }>('/token', { creds, token });
  return invite;
}

export async function proxySubmitInvite(
  creds: DbCreds,
  token: string,
  name: string,
  email: string,
  passwordHash: string
): Promise<'ok' | 'not_found'> {
  const { result } = await post<{ result: 'ok' | 'not_found' }>('/submit', { creds, token, name, email, passwordHash });
  return result;
}

export async function proxyLoginMember(
  creds: DbCreds,
  email: string,
  passwordHash: string
): Promise<ProxyMember | null> {
  const { member } = await post<{ member: ProxyMember | null }>('/login', { creds, email, passwordHash });
  return member;
}

// ── Invite-link encoding for non-Supabase connections ─────────────────────────
// The invite link encodes the DB connection details so the member's browser
// can pass them to the API server when submitting credentials.

export function encodeNonSupabaseCreds(conn: MainDbConnection): string {
  const obj: Record<string, string> = { d: conn.dbType };
  if (conn.host) obj.h = conn.host;
  if (conn.port) obj.o = conn.port;
  if (conn.dbName) obj.b = conn.dbName;
  if (conn.dbUsername) obj.U = conn.dbUsername;
  if (conn.dbPassword) obj.P = conn.dbPassword;
  if (conn.connectionString) obj.c = conn.connectionString;
  return btoa(JSON.stringify(obj));
}

export function decodeNonSupabaseCreds(encoded: string): DbCreds | null {
  try {
    const obj = JSON.parse(atob(encoded)) as Record<string, string>;
    if (!obj.d) return null;
    return {
      dbType: obj.d as DbCreds['dbType'],
      host: obj.h,
      port: obj.o,
      dbName: obj.b,
      dbUsername: obj.U,
      dbPassword: obj.P,
      connectionString: obj.c,
    };
  } catch {
    return null;
  }
}

// Key used to store non-Supabase member creds in localStorage for login reuse
export const MEMBER_PROXY_CREDS_KEY = 'meta_member_proxy_creds';

export function storeMemberProxyCreds(creds: DbCreds): void {
  localStorage.setItem(MEMBER_PROXY_CREDS_KEY, JSON.stringify(creds));
}

export function getStoredMemberProxyCreds(): DbCreds | null {
  try {
    const raw = localStorage.getItem(MEMBER_PROXY_CREDS_KEY);
    return raw ? JSON.parse(raw) as DbCreds : null;
  } catch { return null; }
}
