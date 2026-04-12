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

export function detectPlatform(recipient: string, conns: PlatformConnection[]): Platform {
  if (!recipient) return 'unknown';

  const cached = getStoredPlatform(recipient);
  if (cached) return cached;

  const activeWa = conns.find(c => c.platform === 'whatsapp' && c.is_active);
  const activeFb = conns.find(c => c.platform === 'facebook' && c.is_active);
  const activeIg = conns.find(c => c.platform === 'instagram' && c.is_active);

  // Phone number heuristic: starts with + or is a long numeric string (10-15 digits)
  const stripped = recipient.replace(/[\s\-().]/g, '');
  const isPhoneNumber = /^\+?\d{10,15}$/.test(stripped);

  let result: Platform;

  if (isPhoneNumber && activeWa) {
    result = 'whatsapp';
  } else if (!isPhoneNumber && activeFb && !activeIg) {
    result = 'facebook';
  } else if (!isPhoneNumber && activeIg && !activeFb) {
    result = 'instagram';
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
