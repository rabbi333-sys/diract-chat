import { createClient } from '@supabase/supabase-js';

const MEMBER_SETUP_KEY = 'meta_member_setup';
const MEMBER_SESSION_KEY = 'meta_member_session';

export type MemberSession = {
  email: string;
  role: string;
  permissions: string[];
  displayName: string;
  inviteId: string;
  isSelfDb?: boolean;
  selfDbCreds?: Record<string, string> | null;
};

// ── Password hashing (Web Crypto SHA-256, browser-native) ───────────────────

export async function hashPassword(password: string): Promise<string> {
  const buf = new TextEncoder().encode(password);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Credential helpers ──────────────────────────────────────────────────────

function getStoredCreds(): { url: string; anonKey: string } | null {
  try {
    const raw = localStorage.getItem('chat_monitor_db_settings');
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    if (!cfg?.supabase_url) return null;
    const anonKey = cfg.anon_key ?? cfg.service_role_key;
    if (!anonKey) return null;
    return { url: cfg.supabase_url, anonKey };
  } catch {
    return null;
  }
}

// ── External Supabase client (kept for dashboard data fetching) ──────────────

export function getMemberClient() {
  const creds = getStoredCreds();
  if (!creds) return null;
  return createClient(creds.url, creds.anonKey, {
    auth: {
      storageKey: 'meta_member_auth',
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

// ── Setup flag ──────────────────────────────────────────────────────────────

export function hasMemberSetup(): boolean {
  return localStorage.getItem(MEMBER_SETUP_KEY) === 'true';
}

export function setMemberSetup(): void {
  localStorage.setItem(MEMBER_SETUP_KEY, 'true');
}

export function clearMemberSetup(): void {
  localStorage.removeItem(MEMBER_SETUP_KEY);
}

// ── Custom session (stored in localStorage) ─────────────────────────────────

function getMemberSessionSync(): MemberSession | null {
  try {
    const raw = localStorage.getItem(MEMBER_SESSION_KEY);
    return raw ? (JSON.parse(raw) as MemberSession) : null;
  } catch {
    return null;
  }
}

export async function getMemberSession(): Promise<MemberSession | null> {
  return getMemberSessionSync();
}

export function setMemberSession(session: MemberSession): void {
  localStorage.setItem(MEMBER_SESSION_KEY, JSON.stringify(session));
  setMemberSetup();
}

export async function getMemberUser(): Promise<{
  id: string;
  email: string;
  user_metadata: Record<string, unknown>;
} | null> {
  const session = getMemberSessionSync();
  if (!session) return null;
  return {
    id: session.inviteId,
    email: session.email,
    user_metadata: {
      role: session.role,
      permissions: session.permissions,
      display_name: session.displayName,
      is_member: true,
    },
  };
}

// ── Sign in (uses SECURITY DEFINER RPC — no direct table access needed) ────
// The RPC `member_login_by_credentials` validates email + password hash
// server-side and returns a minimal session payload. This bypasses RLS
// without requiring the service role key on the client.

export async function signInMember(
  email: string,
  password: string,
): Promise<{ error: { message: string } | null }> {
  const creds = getStoredCreds();
  if (!creds) {
    throw new Error('No workspace configured. Please use your invite link first.');
  }

  const hash = await hashPassword(password);
  const client = createClient(creds.url, creds.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client.rpc('member_login_by_credentials', {
    p_email: email.toLowerCase().trim(),
    p_password_hash: hash,
  });

  if (error) {
    // RPC doesn't exist yet — admin needs to run SQL setup
    if (error.message?.includes('function') || error.message?.includes('member_login')) {
      return {
        error: {
          message: 'Workspace database needs a one-time update. Ask your admin to run the SQL setup.',
        },
      };
    }
    return { error: { message: error.message } };
  }

  const rows = data as Array<{
    id: string;
    role: string;
    permissions: string[];
    submitted_name: string | null;
    submitted_email: string;
  }> | null;

  if (!rows || rows.length === 0) {
    return {
      error: {
        message: 'Invalid email or password, or your access has not been approved yet.',
      },
    };
  }

  const row = rows[0];
  const session: MemberSession = {
    email: row.submitted_email ?? email,
    role: row.role ?? 'viewer',
    permissions: row.permissions ?? [],
    displayName: row.submitted_name ?? email.split('@')[0],
    inviteId: row.id,
  };
  localStorage.setItem(MEMBER_SESSION_KEY, JSON.stringify(session));
  setMemberSetup(); // ensure setup flag is set on login
  return { error: null };
}

// ── Sign out ────────────────────────────────────────────────────────────────

export async function signOutMember(): Promise<void> {
  clearMemberSetup();
  try {
    [
      MEMBER_SESSION_KEY,
      'meta_member_auth',
      'meta_guest_session',
      'chat_monitor_db_settings',
      'chat_monitor_platform_connections',
      'chat_monitor_n8n_settings',
      'meta_db_connections',
      'meta_db_active_id',
      'meta_member_proxy_creds',
    ].forEach(k => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

