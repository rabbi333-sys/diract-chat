import { createClient, Session, User } from '@supabase/supabase-js';

const MEMBER_AUTH_STORAGE_KEY = 'meta_member_auth';
const MEMBER_SETUP_KEY = 'meta_member_setup'; // flag: browser is set up as a member workspace

// ── Credential helpers ──────────────────────────────────────────────────────

function getStoredCreds(): { url: string; anonKey: string; serviceKey?: string } | null {
  try {
    const raw = localStorage.getItem('chat_monitor_db_settings');
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    if (!cfg?.supabase_url) return null;
    // anon_key is the anon key; service_role_key may be the service key or a fallback
    const anonKey = cfg.anon_key ?? cfg.service_role_key;
    if (!anonKey) return null;
    return { url: cfg.supabase_url, anonKey, serviceKey: cfg.service_role_key };
  } catch {
    return null;
  }
}

// ── External Supabase client (persists member session under custom storageKey) ─

export function getMemberClient() {
  const creds = getStoredCreds();
  if (!creds) return null;
  return createClient(creds.url, creds.anonKey, {
    auth: {
      storageKey: MEMBER_AUTH_STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
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

// ── Session helpers (async) ─────────────────────────────────────────────────

export async function getMemberSession(): Promise<Session | null> {
  const client = getMemberClient();
  if (!client) return null;
  try {
    const { data } = await client.auth.getSession();
    return data?.session ?? null;
  } catch {
    return null;
  }
}

export async function getMemberUser(): Promise<User | null> {
  const client = getMemberClient();
  if (!client) return null;
  try {
    const { data } = await client.auth.getUser();
    return data?.user ?? null;
  } catch {
    return null;
  }
}

// ── Sign in ─────────────────────────────────────────────────────────────────

export async function signInMember(email: string, password: string) {
  const client = getMemberClient();
  if (!client) throw new Error('No workspace configured. Please use your invite link first.');
  return client.auth.signInWithPassword({ email, password });
}

// ── Sign out ────────────────────────────────────────────────────────────────

export async function signOutMember(): Promise<void> {
  try {
    const client = getMemberClient();
    if (client) await client.auth.signOut();
  } catch { /* ignore */ }
  // Clear all member-related local state
  clearMemberSetup();
  try {
    [
      'meta_guest_session',
      'chat_monitor_db_settings',
      'chat_monitor_platform_connections',
      'chat_monitor_n8n_settings',
      'meta_db_connections',
      'meta_db_active_id',
    ].forEach(k => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

// ── Admin: create a member user (service role key required) ─────────────────

export async function createMemberUser(opts: {
  url: string;
  serviceKey: string;
  email: string;
  password: string;
  role: string;
  permissions: string[];
  displayName?: string;
}) {
  const admin = createClient(opts.url, opts.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return admin.auth.admin.createUser({
    email: opts.email,
    password: opts.password,
    email_confirm: true, // skip email verification
    user_metadata: {
      role: opts.role,
      permissions: opts.permissions,
      display_name: opts.displayName ?? opts.email.split('@')[0],
      is_member: true,
    },
  });
}

// ── Admin: delete a member user (service role key required) ─────────────────

export async function deleteMemberUser(url: string, serviceKey: string, userId: string) {
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return admin.auth.admin.deleteUser(userId);
}
