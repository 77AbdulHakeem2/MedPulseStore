export type OperationVisualCategory = 'success' | 'failed' | 'pending';

export type DatePreset = 'all' | 'today' | '7d' | '30d' | 'custom';

export interface StatusVisualMeta {
  category: OperationVisualCategory;
  labelAr: string;
}

/**
 * Classifies order & deposit statuses into clear visual buckets:
 * - success (emerald green)
 * - failed (rose red)
 * - pending (amber)
 */
export function classifyOperationStatusVisual(status?: string | null): StatusVisualMeta {
  const s = (status || '').trim().toLowerCase();
  switch (s) {
    case 'completed':
      return { category: 'success', labelAr: 'ناجحة ومكتملة' };
    case 'paid':
      return { category: 'success', labelAr: 'مدفوعة تلقائيًا' };
    case 'confirmed':
      return { category: 'success', labelAr: 'مؤكدة ومضافة' };
    case 'failed':
      return { category: 'failed', labelAr: 'فاشلة' };
    case 'rejected':
      return { category: 'failed', labelAr: 'مرفوضة' };
    case 'refunded':
      return { category: 'failed', labelAr: 'فاشلة ومسترجعة' };
    case 'expired':
      return { category: 'failed', labelAr: 'منتهية الصلاحية' };
    case 'manual_reconciliation':
      return { category: 'pending', labelAr: 'مراجعة يدوية' };
    case 'pending_delivery':
      return { category: 'pending', labelAr: 'بانتظار التسليم' };
    case 'pending_review':
      return { category: 'pending', labelAr: 'بانتظار المراجعة' };
    case 'processing':
      return { category: 'pending', labelAr: 'قيد التنفيذ' };
    case 'reserved':
      return { category: 'pending', labelAr: 'محجوزة' };
    default:
      return { category: 'pending', labelAr: 'قيد الانتظار' };
  }
}

/**
 * Converts a YYYY-MM-DD date string into inclusive UTC day start/end timestamps.
 */
export function parseDateRangeBounds(params: {
  fromDate?: string | null;
  toDate?: string | null;
  preset?: DatePreset;
  now?: Date;
}): { startMs: number | null; endMs: number | null } {
  const now = params.now || new Date();
  const preset = params.preset || 'custom';

  if (preset === 'all') {
    return { startMs: null, endMs: null };
  }

  if (preset === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return { startMs: start.getTime(), endMs: end.getTime() };
  }

  if (preset === '7d' || preset === '30d') {
    const days = preset === '7d' ? 6 : 29;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return { startMs: start.getTime(), endMs: end.getTime() };
  }

  let startMs: number | null = null;
  let endMs: number | null = null;

  if (params.fromDate && /^\d{4}-\d{2}-\d{2}$/.test(params.fromDate.trim())) {
    const [y, m, d] = params.fromDate.trim().split('-').map(Number);
    startMs = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  }
  if (params.toDate && /^\d{4}-\d{2}-\d{2}$/.test(params.toDate.trim())) {
    const [y, m, d] = params.toDate.trim().split('-').map(Number);
    endMs = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
  }

  return { startMs, endMs };
}

/**
 * Pure date-range and status filter for admin orders, deposits, and wallet ledger entries.
 */
export function filterOperationsByDateRange<T extends { createdAt?: string | Date | null; status?: string | null }>(
  items: T[],
  options: {
    preset?: DatePreset;
    fromDate?: string | null;
    toDate?: string | null;
    statusCategory?: 'all' | OperationVisualCategory;
    now?: Date;
  }
): T[] {
  const { startMs, endMs } = parseDateRangeBounds({
    fromDate: options.fromDate,
    toDate: options.toDate,
    preset: options.preset,
    now: options.now,
  });

  return items.filter((item) => {
    if (options.statusCategory && options.statusCategory !== 'all') {
      const visual = classifyOperationStatusVisual(item.status);
      if (visual.category !== options.statusCategory) return false;
    }

    if (startMs !== null || endMs !== null) {
      if (!item.createdAt) return false;
      const ts = item.createdAt instanceof Date ? item.createdAt.getTime() : new Date(item.createdAt).getTime();
      if (!Number.isFinite(ts)) return false;
      if (startMs !== null && ts < startMs) return false;
      if (endMs !== null && ts > endMs) return false;
    }

    return true;
  });
}

export function formatAdminDateTime(value?: string | Date | null): string {
  if (!value) return '—';
  const dt = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(dt.getTime())) return '—';
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  const hh = String(dt.getHours()).padStart(2, '0');
  const min = String(dt.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}
