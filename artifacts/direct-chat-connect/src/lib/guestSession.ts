const GUEST_KEY = 'meta_guest_session';

export interface GuestSession {
  token: string;
  role: string;
  permissions: string[];
  email: string;
  name?: string;
  /** Supabase URL of the admin's project — used for token re-validation */
  dbUrl?: string;
  /** Anon key of the admin's project — used with get_invite_by_token RPC */
  dbAnonKey?: string;
}

export function getGuestSession(): GuestSession | null {
  try {
    const raw = localStorage.getItem(GUEST_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as GuestSession;
  } catch {
    return null;
  }
}

export function setGuestSession(session: GuestSession): void {
  localStorage.setItem(GUEST_KEY, JSON.stringify(session));
}

export function clearGuestSession(): void {
  localStorage.removeItem(GUEST_KEY);
}

export function isGuestSessionActive(): boolean {
  return !!getGuestSession();
}
