import type { PlatformConnection } from '@/hooks/usePlatformConnections';

export type Platform = 'whatsapp' | 'facebook' | 'instagram' | 'unknown';

const LS_KEY = 'cm_platform_cache_v1';

function loadCache(): Record<string, Platform> {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
  catch { return {}; }
}

function saveCache(cache: Record<string, Platform>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(cache)); }
  catch {}
}

export function getStoredPlatform(recipient: string): Platform | null {
  const c = loadCache()[recipient];
  return c ?? null;
}

export function storePlatform(recipient: string, platform: Platform) {
  if (!recipient || platform === 'unknown') return;
  const cache = loadCache();
  cache[recipient] = platform;
  saveCache(cache);
}

export interface DetectPlatformOpts {
  sessionId?: string;
  dbPlatform?: string;
}

export function detectPlatform(
  recipient: string,
  conns: PlatformConnection[],
  opts?: DetectPlatformOpts
): Platform {
  if (!recipient) return 'unknown';

  // 1. DB-level platform field — highest authority (set by the workflow that received the message)
  if (opts?.dbPlatform) {
    const dbp = opts.dbPlatform.toLowerCase();
    if (dbp === 'whatsapp' || dbp.includes('whatsapp') || dbp.startsWith('wa')) {
      storePlatform(recipient, 'whatsapp');
      return 'whatsapp';
    }
    if (dbp === 'instagram' || dbp.includes('instagram') || dbp.startsWith('ig')) {
      storePlatform(recipient, 'instagram');
      return 'instagram';
    }
    if (dbp === 'facebook' || dbp.includes('facebook') || dbp.includes('messenger') || dbp.startsWith('fb')) {
      storePlatform(recipient, 'facebook');
      return 'facebook';
    }
  }

  // 2. localStorage cache from a previous successful send (already confirmed correct platform)
  const cached = getStoredPlatform(recipient);
  if (cached) return cached;

  const activeWa = conns.find(c => c.platform === 'whatsapp' && c.is_active);
  const activeFb = conns.find(c => c.platform === 'facebook' && c.is_active);
  const activeIg = conns.find(c => c.platform === 'instagram' && c.is_active);

  // 3. page_id matching — check if the session_id or recipient contains a configured page_id.
  // n8n workflows commonly embed the page_id in the session_id (e.g. "1234567890_psid" or "fb_1234567890").
  const sid = opts?.sessionId ?? '';
  const allMetaConns = conns.filter(c => (c.platform === 'facebook' || c.platform === 'instagram') && c.is_active);
  for (const conn of allMetaConns) {
    if (conn.page_id && conn.page_id.trim()) {
      const pid = conn.page_id.trim();
      if (sid.includes(pid) || recipient.includes(pid)) {
        const p: Platform = conn.platform;
        storePlatform(recipient, p);
        return p;
      }
    }
  }

  // 4. Session-ID prefix heuristics — n8n workflow naming conventions
  const sidLower = sid.toLowerCase();
  if (sidLower) {
    if (sidLower.startsWith('wa_') || sidLower.startsWith('whatsapp_') || sidLower.includes('_wa_')) {
      if (activeWa) { storePlatform(recipient, 'whatsapp'); return 'whatsapp'; }
    }
    if (sidLower.startsWith('ig_') || sidLower.startsWith('instagram_') || sidLower.includes('_ig_')) {
      if (activeIg) { storePlatform(recipient, 'instagram'); return 'instagram'; }
    }
    if (sidLower.startsWith('fb_') || sidLower.startsWith('facebook_') || sidLower.startsWith('messenger_') || sidLower.includes('_fb_')) {
      if (activeFb) { storePlatform(recipient, 'facebook'); return 'facebook'; }
    }
  }

  // 5. Phone-number heuristic: E.164 or 10-15 digit numeric string → WhatsApp
  const stripped = recipient.replace(/[\s\-().+]/g, '');
  const isPhoneNumber = /^\+?\d{10,15}$/.test(recipient.replace(/[\s\-()]/g, ''));

  let result: Platform;

  if (isPhoneNumber && activeWa) {
    result = 'whatsapp';
  } else if (isPhoneNumber) {
    result = 'unknown';
  } else if (!isPhoneNumber && activeFb && activeIg) {
    // Both Meta platforms active — use PSID digit-length as tiebreaker.
    // IG PSIDs assigned after ~2021 tend to be ≥ 17 digits; FB Messenger PSIDs tend to be ≤ 16 digits.
    result = stripped.length >= 17 ? 'instagram' : 'facebook';
  } else if (activeFb) {
    result = 'facebook';
  } else if (activeIg) {
    result = 'instagram';
  } else if (activeWa) {
    result = 'whatsapp';
  } else {
    result = 'unknown';
  }

  if (result !== 'unknown') storePlatform(recipient, result);
  return result;
}

export const PLATFORM_CONFIG = {
  whatsapp: {
    label: 'WhatsApp',
    color: '#25D366',
  },
  facebook: {
    label: 'Facebook',
    color: '#0082FB',
  },
  instagram: {
    label: 'Instagram',
    color: '#E1306C',
  },
} as const;
