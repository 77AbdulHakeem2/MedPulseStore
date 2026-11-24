import { classifyOperationStatusVisual } from './operationsUtils';

export type KpiTone = 'positive' | 'negative' | 'warning' | 'neutral';
export type KpiDirection = 'up' | 'down' | 'flat';

export interface KpiPolarityInput {
  value: number;
  previousValue?: number | null;
  /** true for revenue, profit, success rate, connected servers; false for failures, reversals, debt, blocked users */
  higherIsBetter: boolean;
  /** Optional threshold above which a lower-is-better metric is immediately negative (default 0) */
  adverseAbove?: number;
  /** Optional minimum healthy value for higher-is-better metrics when no previousValue exists */
  healthyAtLeast?: number;
}

export interface KpiPolarityResult {
  tone: KpiTone;
  direction: KpiDirection;
  deltaPercent: number | null;
  deltaFormatted: string | null;
}

/**
 * Meaning-aware KPI evaluation:
 * - Higher profit / revenue / connected ratio => positive (green); decrease => negative (red)
 * - Higher failed orders / reversals / pending recovery / blocked users => negative (red); zero or decrease => positive (green)
 */
export function evaluateKpiPolarity(input: KpiPolarityInput): KpiPolarityResult {
  const { value, previousValue, higherIsBetter, adverseAbove = 0, healthyAtLeast } = input;
  const safeVal = Number.isFinite(value) ? value : 0;

  if (previousValue !== undefined && previousValue !== null && Number.isFinite(previousValue)) {
    const diff = safeVal - previousValue;
    if (Math.abs(diff) < 1e-9) {
      // No period change — fall back to absolute health semantics
      if (!higherIsBetter) {
        return {
          tone: safeVal > adverseAbove ? 'negative' : 'positive',
          direction: 'flat',
          deltaPercent: 0,
          deltaFormatted: '0%',
        };
      }
      return {
        tone: safeVal > 0 ? 'positive' : safeVal < 0 ? 'negative' : 'neutral',
        direction: 'flat',
        deltaPercent: 0,
        deltaFormatted: '0%',
      };
    }

    const direction: KpiDirection = diff > 0 ? 'up' : 'down';
    const isGood = higherIsBetter ? diff > 0 : diff < 0;

    let deltaPercent: number | null = null;
    let deltaFormatted: string | null = null;
    if (Math.abs(previousValue) > 1e-9) {
      deltaPercent = Number(((diff / Math.abs(previousValue)) * 100).toFixed(1));
      const sign = deltaPercent > 0 ? '+' : '';
      deltaFormatted = `${sign}${deltaPercent}%`;
    } else if (diff > 0) {
      deltaPercent = 100;
      deltaFormatted = '+100%';
    } else {
      deltaPercent = -100;
      deltaFormatted = '-100%';
    }

    return {
      tone: isGood ? 'positive' : 'negative',
      direction,
      deltaPercent,
      deltaFormatted,
    };
  }

  // Snapshot evaluation (no prior baseline)
  if (!higherIsBetter) {
    if (safeVal > adverseAbove) {
      return { tone: 'negative', direction: 'up', deltaPercent: null, deltaFormatted: null };
    }
    return { tone: 'positive', direction: 'flat', deltaPercent: null, deltaFormatted: null };
  }

  if (safeVal < 0) {
    return { tone: 'negative', direction: 'down', deltaPercent: null, deltaFormatted: null };
  }
  if (healthyAtLeast !== undefined) {
    if (safeVal >= healthyAtLeast) {
      return { tone: 'positive', direction: 'up', deltaPercent: null, deltaFormatted: null };
    }
    return { tone: safeVal > 0 ? 'warning' : 'negative', direction: 'down', deltaPercent: null, deltaFormatted: null };
  }

  return {
    tone: safeVal > 0 ? 'positive' : 'neutral',
    direction: safeVal > 0 ? 'up' : 'flat',
    deltaPercent: null,
    deltaFormatted: null,
  };
}

export interface DashboardPeriodMetrics {
  netProfit: number;
  revenue: number;
  wholesale: number;
  profitMarginPercent: number;
  profit7d: number;
  profitPrev7d: number;
  profitPolarity: KpiPolarityResult;
  totalOrders: number;
  completedOrders: number;
  failedOrders: number;
  pendingOrders: number;
  successRatePercent: number;
  successRatePolarity: KpiPolarityResult;
  failedOrdersPolarity: KpiPolarityResult;
  connectedProviders: number;
  errorProviders: number;
  totalProviders: number;
  providerBalance: number;
  providerHealthPolarity: KpiPolarityResult;
  publishedProducts: number;
  hiddenProducts: number;
  outOfStockPublished: number;
  pendingDepositsCount: number;
  pendingDepositsAmount: number;
  pendingDepositsPolarity: KpiPolarityResult;
  totalCustomers: number;
  blockedCustomers: number;
}

export function computeDashboardPeriodMetrics(params: {
  overview?: any;
  orders: any[];
  deposits: any[];
  providers: any[];
  products: any[];
  customers: any[];
  now?: Date;
}): DashboardPeriodMetrics {
  const nowMs = (params.now || new Date()).getTime();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const start7d = nowMs - 7 * DAY_MS;
  const start14d = nowMs - 14 * DAY_MS;

  let completedOrders = 0;
  let failedOrders = 0;
  let pendingOrders = 0;
  let profit7d = 0;
  let profitPrev7d = 0;
  let hasPrev7dOrders = false;

  for (const o of params.orders || []) {
    const cat = classifyOperationStatusVisual(o.status).category;
    if (cat === 'success') completedOrders += 1;
    else if (cat === 'failed') failedOrders += 1;
    else pendingOrders += 1;

    const ts = o.createdAt ? new Date(o.createdAt).getTime() : NaN;
    if (!Number.isNaN(ts) && cat === 'success') {
      const profit = Number(o.netProfit || 0);
      if (ts >= start7d) {
        profit7d += profit;
      } else if (ts >= start14d && ts < start7d) {
        profitPrev7d += profit;
        hasPrev7dOrders = true;
      }
    }
  }

  const totalOrders = (params.orders || []).length;
  const decidedOrders = completedOrders + failedOrders;
  const successRatePercent = decidedOrders > 0 ? Number(((completedOrders / decidedOrders) * 100).toFixed(1)) : 100;

  const netProfit = Number(params.overview?.kpis?.totalNetProfit ?? 0);
  const revenue = Number(params.overview?.kpis?.totalRevenue ?? 0);
  const wholesale = Number(params.overview?.kpis?.totalWholesale ?? 0);
  const profitMarginPercent = revenue > 0 ? Number(((netProfit / revenue) * 100).toFixed(1)) : 0;

  const profitPolarity = evaluateKpiPolarity({
    value: hasPrev7dOrders ? profit7d : netProfit,
    previousValue: hasPrev7dOrders ? profitPrev7d : null,
    higherIsBetter: true,
  });

  const successRatePolarity = evaluateKpiPolarity({
    value: successRatePercent,
    higherIsBetter: true,
    healthyAtLeast: 90,
  });

  const failedOrdersPolarity = evaluateKpiPolarity({
    value: failedOrders,
    higherIsBetter: false,
    adverseAbove: 0,
  });

  const totalProviders = params.providers?.length ?? Number(params.overview?.kpis?.totalProviders ?? 0);
  const connectedProviders =
    params.providers?.filter((p) => p.isEnabled && p.status === 'connected').length ??
    Number(params.overview?.kpis?.connectedProviders ?? 0);
  const errorProviders = params.providers?.filter((p) => p.status === 'error').length ?? 0;
  const providerBalance = Number(params.overview?.kpis?.totalProviderBalance ?? 0);

  const providerHealthPolarity =
    errorProviders > 0
      ? ({ tone: 'negative', direction: 'down', deltaPercent: null, deltaFormatted: null } as KpiPolarityResult)
      : evaluateKpiPolarity({
          value: connectedProviders,
          higherIsBetter: true,
          healthyAtLeast: totalProviders > 0 ? 1 : 0,
        });

  const publishedProducts =
    params.products?.filter((p) => p.isVisible && !p.isPaused).length ??
    Number(params.overview?.kpis?.publishedProducts ?? 0);
  const hiddenProducts =
    params.products?.filter((p) => !p.isVisible || p.isPaused).length ??
    Number(params.overview?.kpis?.hiddenProducts ?? 0);
  const outOfStockPublished =
    params.products?.filter((p) => p.isVisible && !p.isPaused && Number(p.totalStock || 0) <= 0).length ?? 0;

  let pendingDepositsCount = 0;
  let pendingDepositsAmount = 0;
  for (const d of params.deposits || []) {
    const cat = classifyOperationStatusVisual(d.status).category;
    if (cat === 'pending') {
      pendingDepositsCount += 1;
      pendingDepositsAmount += Number(d.expectedAmount || 0);
    }
  }
  if (params.deposits.length === 0 && params.overview?.kpis?.pendingDepositsCount) {
    pendingDepositsCount = Number(params.overview.kpis.pendingDepositsCount);
  }

  const pendingDepositsPolarity: KpiPolarityResult =
    pendingDepositsCount > 0
      ? { tone: 'warning', direction: 'up', deltaPercent: null, deltaFormatted: null }
      : { tone: 'positive', direction: 'flat', deltaPercent: null, deltaFormatted: null };

  const totalCustomers = params.customers?.length || Number(params.overview?.kpis?.totalCustomers ?? 0);
  const blockedCustomers = params.customers?.filter((u) => u.isBlocked).length ?? 0;

  return {
    netProfit,
    revenue,
    wholesale,
    profitMarginPercent,
    profit7d: Number(profit7d.toFixed(2)),
    profitPrev7d: Number(profitPrev7d.toFixed(2)),
    profitPolarity,
    totalOrders,
    completedOrders,
    failedOrders,
    pendingOrders,
    successRatePercent,
    successRatePolarity,
    failedOrdersPolarity,
    connectedProviders,
    errorProviders,
    totalProviders,
    providerBalance,
    providerHealthPolarity,
    publishedProducts,
    hiddenProducts,
    outOfStockPublished,
    pendingDepositsCount,
    pendingDepositsAmount: Number(pendingDepositsAmount.toFixed(2)),
    pendingDepositsPolarity,
    totalCustomers,
    blockedCustomers,
  };
}

export interface DailyOrderBucket {
  dateKey: string;
  labelAr: string;
  labelEn: string;
  completedCount: number;
  failedCount: number;
  totalCount: number;
  revenue: number;
  netProfit: number;
}

const SHORT_MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Pure daily order/profit aggregation strictly from real orders array (zero mock data).
 * Returns chronological buckets covering the last `days` UTC dates ending at `now`.
 */
export function computeDailyOrderSeries(
  orders: any[],
  days = 7,
  now?: Date
): DailyOrderBucket[] {
  const safeDays = Math.max(1, Math.min(30, Math.floor(days)));
  const anchor = now ? new Date(now.getTime()) : new Date();
  const DAY_MS = 24 * 60 * 60 * 1000;

  // Build UTC midnight buckets from oldest -> newest
  const anchorUtcMidnight = Date.UTC(
    anchor.getUTCFullYear(),
    anchor.getUTCMonth(),
    anchor.getUTCDate()
  );

  const buckets: DailyOrderBucket[] = [];
  const byKey = new Map<string, DailyOrderBucket>();

  for (let i = safeDays - 1; i >= 0; i -= 1) {
    const d = new Date(anchorUtcMidnight - i * DAY_MS);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const key = `${yyyy}-${mm}-${dd}`;
    const bucket: DailyOrderBucket = {
      dateKey: key,
      labelAr: `${dd}/${mm}`,
      labelEn: `${SHORT_MONTHS_EN[d.getUTCMonth()]} ${d.getUTCDate()}`,
      completedCount: 0,
      failedCount: 0,
      totalCount: 0,
      revenue: 0,
      netProfit: 0,
    };
    buckets.push(bucket);
    byKey.set(key, bucket);
  }

  for (const o of orders || []) {
    if (!o?.createdAt) continue;
    const parsed = new Date(o.createdAt);
    if (Number.isNaN(parsed.getTime())) continue;
    const yyyy = parsed.getUTCFullYear();
    const mm = String(parsed.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(parsed.getUTCDate()).padStart(2, '0');
    const key = `${yyyy}-${mm}-${dd}`;
    const target = byKey.get(key);
    if (!target) continue;

    const cat = classifyOperationStatusVisual(o.status).category;
    target.totalCount += 1;
    if (cat === 'success') {
      target.completedCount += 1;
      target.revenue = Number((target.revenue + Number(o.totalRetail || 0)).toFixed(2));
      target.netProfit = Number((target.netProfit + Number(o.netProfit || 0)).toFixed(2));
    } else if (cat === 'failed') {
      target.failedCount += 1;
    }
  }

  return buckets;
}

