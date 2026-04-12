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

  // 1. DB-level platform field is the most authoritative source
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

  // 2. Check localStorage cache (from previous successful sends)
  const cached = getStoredPlatform(recipient);
  if (cached) return cached;

  const activeWa = conns.find(c => c.platform === 'whatsapp' && c.is_active);
  const activeFb = conns.find(c => c.platform === 'facebook' && c.is_active);
  const activeIg = conns.find(c => c.platform === 'instagram' && c.is_active);

  // 3. Session-ID prefix heuristics — common naming conventions used by n8n workflows
  const sid = (opts?.sessionId ?? '').toLowerCase();
  if (sid) {
    if (sid.startsWith('wa_') || sid.startsWith('whatsapp_') || sid.includes('_wa_') || sid.includes('_whatsapp_')) {
      const p: Platform = activeWa ? 'whatsapp' : 'unknown';
      if (p !== 'unknown') { storePlatform(recipient, p); return p; }
    }
    if ((sid.startsWith('ig_') || sid.startsWith('instagram_') || sid.includes('_ig_') || sid.includes('_instagram_')) && activeIg) {
      storePlatform(recipient, 'instagram');
      return 'instagram';
    }
    if ((sid.startsWith('fb_') || sid.startsWith('facebook_') || sid.startsWith('messenger_') || sid.includes('_fb_') || sid.includes('_facebook_')) && activeFb) {
      storePlatform(recipient, 'facebook');
      return 'facebook';
    }
  }

  // 4. Phone-number heuristic: E.164 or long numeric string → WhatsApp
  const stripped = recipient.replace(/[\s\-().]/g, '');
  const isPhoneNumber = /^\+?\d{10,15}$/.test(stripped);

  let result: Platform;

  if (isPhoneNumber && activeWa) {
    result = 'whatsapp';
  } else if (isPhoneNumber && !activeWa) {
    // Phone number but no WA connection — could still be WA but undetectable
    result = 'unknown';
  } else if (!isPhoneNumber && activeFb && activeIg) {
    // Both Meta platforms active — use digit count as tiebreaker:
    // Instagram PSIDs tend to be ≥ 17 digits; Facebook PSIDs tend to be < 17 digits
    const digits = stripped.replace(/\D/g, '');
    result = digits.length >= 17 ? 'instagram' : 'facebook';
  } else if (!isPhoneNumber && activeFb) {
    result = 'facebook';
  } else if (!isPhoneNumber && activeIg) {
    result = 'instagram';
  } else if (activeWa) {
    result = 'whatsapp';
  } else if (activeFb) {
    result = 'facebook';
  } else if (activeIg) {
    result = 'instagram';
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
