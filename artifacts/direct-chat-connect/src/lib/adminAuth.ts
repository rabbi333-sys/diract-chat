/**
 * Admin credentials — stored in localStorage so the admin can change them
 * from the Account page without editing source code.
 *
 * Defaults (used on first run / if localStorage is cleared):
 *   Email:    rh7282991@gmail.com
 *   Password: 123456
 */
const DEFAULT_EMAIL        = "rh7282991@gmail.com";
const DEFAULT_PASSWORD_HASH = "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92";

const ADMIN_SESSION_KEY = "meta_admin_session";
const ADMIN_CREDS_KEY   = "meta_admin_credentials";

interface StoredCreds {
  email: string;
  passwordHash: string;
}

function getStoredCreds(): StoredCreds {
  try {
    const raw = localStorage.getItem(ADMIN_CREDS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredCreds>;
      if (parsed.email && parsed.passwordHash) return parsed as StoredCreds;
    }
  } catch { /* ignore */ }
  return { email: DEFAULT_EMAIL, passwordHash: DEFAULT_PASSWORD_HASH };
}

export function getAdminEmail(): string {
  return getStoredCreds().email;
}

export async function hashPassword(password: string): Promise<string> {
  const buf = new TextEncoder().encode(password);
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Returns true if email+password matches the stored admin credentials. */
export async function verifyAdminCredentials(email: string, password: string): Promise<boolean> {
  const creds = getStoredCreds();
  if (email.toLowerCase().trim() !== creds.email.toLowerCase()) return false;
  const hash = await hashPassword(password);
  return hash === creds.passwordHash;
}

/** Saves new admin email + pre-hashed password to localStorage. */
export function updateAdminCredentials(email: string, passwordHash: string): void {
  const creds: StoredCreds = { email: email.toLowerCase().trim(), passwordHash };
  localStorage.setItem(ADMIN_CREDS_KEY, JSON.stringify(creds));
}

export interface AdminSession {
  email: string;
  loggedInAt: number;
}

export function getAdminSession(): AdminSession | null {
  try {
    const raw = localStorage.getItem(ADMIN_SESSION_KEY);
    return raw ? (JSON.parse(raw) as AdminSession) : null;
  } catch {
    return null;
  }
}

export function setAdminSession(): void {
  const session: AdminSession = { email: getAdminEmail(), loggedInAt: Date.now() };
  localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
}

export function clearAdminSession(): void {
  localStorage.removeItem(ADMIN_SESSION_KEY);
}

export function isAdminLoggedIn(): boolean {
  return !!getAdminSession();
}
