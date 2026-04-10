/**
 * Hard-coded admin credentials.
 * To change the admin email/password, update ADMIN_EMAIL and ADMIN_PASSWORD_HASH below.
 *
 * ADMIN_PASSWORD_HASH is the SHA-256 hash of the password.
 * To generate a new hash:  echo -n "yourpassword" | sha256sum
 *
 * Current credentials:
 *   Email:    rh7282991@gmail.com
 *   Password: 123456
 */
const ADMIN_EMAIL = "rh7282991@gmail.com";
const ADMIN_PASSWORD_HASH = "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92";

const ADMIN_SESSION_KEY = "meta_admin_session";

export interface AdminSession {
  email: string;
  loggedInAt: number;
}

async function hashPassword(password: string): Promise<string> {
  const buf = new TextEncoder().encode(password);
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Returns true if email+password matches the hardcoded admin credentials. */
export async function verifyAdminCredentials(email: string, password: string): Promise<boolean> {
  if (email.toLowerCase().trim() !== ADMIN_EMAIL.toLowerCase()) return false;
  const hash = await hashPassword(password);
  return hash === ADMIN_PASSWORD_HASH;
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
  const session: AdminSession = { email: ADMIN_EMAIL, loggedInAt: Date.now() };
  localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
}

export function clearAdminSession(): void {
  localStorage.removeItem(ADMIN_SESSION_KEY);
}

export function isAdminLoggedIn(): boolean {
  return !!getAdminSession();
}
