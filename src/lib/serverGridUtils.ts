export type ServerGridStatusFilter = 'all' | 'connected' | 'disconnected' | 'has_offers';

export interface ServerIconVisual {
  monogram: string;
  bgClass: string;
  textClass: string;
  borderClass: string;
}

const SERVER_ICON_PALETTES: Array<{ bgClass: string; textClass: string; borderClass: string }> = [
  { bgClass: 'bg-slate-900', textClass: 'text-white', borderClass: 'border-slate-800' },
  { bgClass: 'bg-emerald-700', textClass: 'text-white', borderClass: 'border-emerald-800/40' },
  { bgClass: 'bg-sky-700', textClass: 'text-white', borderClass: 'border-sky-800/40' },
  { bgClass: 'bg-indigo-700', textClass: 'text-white', borderClass: 'border-indigo-800/40' },
  { bgClass: 'bg-teal-700', textClass: 'text-white', borderClass: 'border-teal-800/40' },
  { bgClass: 'bg-amber-700', textClass: 'text-white', borderClass: 'border-amber-800/40' },
  { bgClass: 'bg-cyan-700', textClass: 'text-white', borderClass: 'border-cyan-800/40' },
  { bgClass: 'bg-violet-700', textClass: 'text-white', borderClass: 'border-violet-800/40' },
  { bgClass: 'bg-zinc-800', textClass: 'text-white', borderClass: 'border-zinc-700' },
  { bgClass: 'bg-rose-700', textClass: 'text-white', borderClass: 'border-rose-800/40' },
];

/**
 * Generates a deterministic 2-character app-icon monogram and curated visual palette
 * for any server based on its code and display name.
 */
export function getServerAppIconStyle(code: string, name: string): ServerIconVisual {
  const cleanName = (name || code || 'SV').trim();
  const words = cleanName
    .replace(/[^a-zA-Z0-9\u0600-\u06FF\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  let monogram = 'SV';
  if (words.length >= 2) {
    monogram = `${words[0][0] || ''}${words[1][0] || ''}`.toUpperCase();
  } else if (words.length === 1) {
    monogram = words[0].slice(0, 2).toUpperCase();
  }

  const hashSource = (code || cleanName).toLowerCase();
  let hash = 0;
  for (let i = 0; i < hashSource.length; i += 1) {
    hash = (hash * 31 + hashSource.charCodeAt(i)) >>> 0;
  }
  const palette = SERVER_ICON_PALETTES[hash % SERVER_ICON_PALETTES.length];
  return {
    monogram,
    ...palette,
  };
}

/**
 * Extracts a clean, compact hostname (without protocol or trailing path) for compact tile display.
 */
export function extractServerHostLabel(baseUrl: string): string {
  const raw = (baseUrl || '').trim();
  if (!raw) return '—';
  try {
    const parsed = new URL(raw);
    return parsed.host;
  } catch {
    return raw.replace(/^https?:\/\//i, '').split('/')[0] || raw;
  }
}

export interface FilterableServerItem {
  id: number;
  code: string;
  name: string;
  baseUrl: string;
  docsUrl: string;
  status: string;
  isEnabled: boolean;
  productsCount: number;
}

/**
 * Client-side search and status filter for the compact server app-icon grid.
 */
export function filterServersForGrid<T extends FilterableServerItem>(
  servers: T[],
  options: { search?: string; statusFilter?: ServerGridStatusFilter }
): T[] {
  const query = (options.search || '').trim().toLowerCase();
  const statusFilter = options.statusFilter || 'all';

  return servers.filter((srv) => {
    if (statusFilter === 'connected') {
      if (!(srv.isEnabled && srv.status === 'connected')) return false;
    } else if (statusFilter === 'disconnected') {
      if (srv.isEnabled && srv.status === 'connected') return false;
    } else if (statusFilter === 'has_offers') {
      if (srv.productsCount <= 0) return false;
    }

    if (query) {
      const hay = `${srv.name} ${srv.code} ${srv.baseUrl} ${srv.docsUrl}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
}
