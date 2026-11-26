import Decimal from 'decimal.js';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export type PricingMode = 'manual' | 'fixed_margin' | 'percent_margin';

export interface BulkTier {
  minQty: number;
  unitPrice: string;
}

export interface PricingRuleInput {
  pricingMode: PricingMode;
  retailPrice: string;
  agentPrice?: string | null;
  fixedMargin: string;
  percentMargin: string;
  paymentFeePercent: string;
  extraFixedCost: string;
  promoPrice?: string | null;
  promoEndsAt?: Date | string | null;
  bulkTiersJson?: BulkTier[] | null;
  lockManualPrice?: boolean;
}

export interface ProfitBreakdown {
  unitRetail: string;
  unitWholesale: string;
  quantity: number;
  subtotalRetail: string;
  totalWholesale: string;
  paymentFee: string;
  extraCost: string;
  netProfit: string;
  marginPercent: string;
  appliedTier: 'promo' | 'bulk' | 'manual' | 'fixed_margin' | 'percent_margin';
}

export function toDecimal(value: string | number | Decimal | null | undefined, fallback = '0'): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(fallback);
  try {
    return new Decimal(value);
  } catch {
    return new Decimal(fallback);
  }
}

export function formatMoney(value: string | number | Decimal, decimals = 2): string {
  return toDecimal(value).toFixed(decimals);
}

export function computeRetailUnitPrice(
  rule: PricingRuleInput,
  wholesaleUnitPrice: string | number | Decimal,
  quantity = 1,
  now: Date = new Date()
): { unitRetail: Decimal; appliedTier: ProfitBreakdown['appliedTier'] } {
  const wholesale = toDecimal(wholesaleUnitPrice);

  // 1. Active promotional offer takes precedence if valid and unexpired
  if (rule.promoPrice !== null && rule.promoPrice !== undefined && rule.promoPrice !== '') {
    const promo = toDecimal(rule.promoPrice);
    const endsAt = rule.promoEndsAt ? new Date(rule.promoEndsAt) : null;
    if (promo.gt(0) && (!endsAt || endsAt.getTime() > now.getTime())) {
      return { unitRetail: promo.toDecimalPlaces(2, Decimal.ROUND_HALF_UP), appliedTier: 'promo' };
    }
  }

  // 2. Bulk quantity tier pricing
  if (Array.isArray(rule.bulkTiersJson) && rule.bulkTiersJson.length > 0 && quantity > 1) {
    const matched = [...rule.bulkTiersJson]
      .filter((t) => quantity >= t.minQty && toDecimal(t.unitPrice).gt(0))
      .sort((a, b) => b.minQty - a.minQty)[0];
    if (matched) {
      return {
        unitRetail: toDecimal(matched.unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
        appliedTier: 'bulk',
      };
    }
  }

  // 3. Base mode calculation — always rounded to 2-decimal USD cents so charged price
  // matches displayed customer price ($1.13 instead of hidden $1.1340 sub-cent drift)
  if (rule.pricingMode === 'manual') {
    return {
      unitRetail: toDecimal(rule.retailPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
      appliedTier: 'manual',
    };
  }

  if (rule.pricingMode === 'fixed_margin') {
    return {
      unitRetail: wholesale.plus(toDecimal(rule.fixedMargin)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
      appliedTier: 'fixed_margin',
    };
  }

  // percent_margin
  const multiplier = new Decimal(1).plus(toDecimal(rule.percentMargin).div(100));
  return {
    unitRetail: wholesale.times(multiplier).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
    appliedTier: 'percent_margin',
  };
}

export function computeProfitBreakdown(
  rule: PricingRuleInput,
  wholesaleUnitPrice: string | number | Decimal,
  quantity = 1,
  now: Date = new Date()
): ProfitBreakdown {
  const qty = Math.max(1, Math.floor(quantity));
  const wholesaleUnit = toDecimal(wholesaleUnitPrice);
  const { unitRetail, appliedTier } = computeRetailUnitPrice(rule, wholesaleUnit, qty, now);

  const subtotalRetail = unitRetail.times(qty);
  const totalWholesale = wholesaleUnit.times(qty);
  const paymentFee = subtotalRetail.times(toDecimal(rule.paymentFeePercent).div(100));
  const extraCost = toDecimal(rule.extraFixedCost).times(qty);
  const netProfit = subtotalRetail.minus(totalWholesale).minus(paymentFee).minus(extraCost);
  const marginPercent = subtotalRetail.gt(0)
    ? netProfit.div(subtotalRetail).times(100)
    : new Decimal(0);

  return {
    unitRetail: unitRetail.toFixed(4),
    unitWholesale: wholesaleUnit.toFixed(4),
    quantity: qty,
    subtotalRetail: subtotalRetail.toFixed(4),
    totalWholesale: totalWholesale.toFixed(4),
    paymentFee: paymentFee.toFixed(4),
    extraCost: extraCost.toFixed(4),
    netProfit: netProfit.toFixed(4),
    marginPercent: marginPercent.toFixed(2),
    appliedTier,
  };
}

/**
 * Manual price preservation rule:
 * When syncing provider prices, NEVER overwrite a manual retail price.
 * Instead detect if wholesale price increased so admin gets alerted.
 */
export function evaluateSyncPriceUpdate(params: {
  oldWholesale: string;
  newWholesale: string;
  rule: PricingRuleInput;
}): {
  wholesaleIncreased: boolean;
  delta: string;
  preservedRetailPrice: string;
  marginNegativeWarning: boolean;
} {
  const oldW = toDecimal(params.oldWholesale);
  const newW = toDecimal(params.newWholesale);
  const delta = newW.minus(oldW);
  const wholesaleIncreased = delta.gt(0);

  // If manual price lock is active (or pricingMode === 'manual'), retailPrice MUST remain unchanged
  const preservedRetailPrice =
    params.rule.pricingMode === 'manual' || params.rule.lockManualPrice
      ? toDecimal(params.rule.retailPrice).toFixed(4)
      : computeRetailUnitPrice(params.rule, newW, 1).unitRetail.toFixed(4);

  const profitCheck = computeProfitBreakdown(
    { ...params.rule, retailPrice: preservedRetailPrice },
    newW,
    1
  );

  return {
    wholesaleIncreased,
    delta: delta.toFixed(4),
    preservedRetailPrice,
    marginNegativeWarning: toDecimal(profitCheck.netProfit).lte(0),
  };
}

// Multi-provider selection & safe failover logic
export interface ProviderOfferCandidate {
  mappingId: number;
  providerId: number;
  providerCode: string;
  providerName: string;
  providerStatus: 'connected' | 'disconnected' | 'error' | 'disabled' | string;
  providerEnabled: boolean;
  providerBalance: string;
  providerProductId: number;
  externalProductId: string;
  externalVariantId?: string;
  wholesalePrice: string;
  stockCount: number;
  roleType: 'primary' | 'backup' | string;
  priority: number;
  isVerifiedCompatible: boolean;
  isActive: boolean;
  durationLabel?: string;
  deliveryType?: string;
  warrantyDays?: number;
}

export type SelectionStrategy = 'priority' | 'lowest_price' | 'highest_stock';

export type ProviderRoutingState =
  | 'active_now'
  | 'standby'
  | 'out_of_stock'
  | 'low_balance'
  | 'offline'
  | 'paused';

export interface EvaluatedProviderQueueItem extends ProviderOfferCandidate {
  rank: number;
  routingState: ProviderRoutingState;
  isActiveRoutingTarget: boolean;
}

/**
 * Returns ALL eligible provider candidates ranked in exact execution order:
 * - For 'priority' (default): strictly follows admin-defined priority (1 -> 2 -> 3 -> ...),
 *   so when #1 runs out of stock, orders automatically route to #2, then #3, and when #1
 *   is restocked it automatically reclaims #1 without losing its saved order!
 */
export function rankEligibleProviders(
  candidates: ProviderOfferCandidate[],
  strategy: SelectionStrategy = 'priority',
  quantity = 1
): ProviderOfferCandidate[] {
  const qty = Math.max(1, Math.floor(quantity || 1));
  const eligible = candidates.filter((c) => {
    if (!c.isActive || !c.isVerifiedCompatible) return false;
    if (!c.providerEnabled || c.providerStatus !== 'connected') return false;
    if (c.stockCount < qty) return false;
    const totalCost = toDecimal(c.wholesalePrice).times(qty);
    if (toDecimal(c.providerBalance).lt(totalCost)) return false;
    return true;
  });

  eligible.sort((a, b) => {
    if (strategy === 'lowest_price') {
      const diff = toDecimal(a.wholesalePrice).comparedTo(toDecimal(b.wholesalePrice));
      if (diff !== 0) return diff;
      return a.priority - b.priority;
    }
    if (strategy === 'highest_stock') {
      if (b.stockCount !== a.stockCount) return b.stockCount - a.stockCount;
      return a.priority - b.priority;
    }
    // default 'priority': strict admin priority order (1 -> 2 -> 3), then primary role, then lowest wholesale
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.roleType !== b.roleType) {
      return a.roleType === 'primary' ? -1 : 1;
    }
    return toDecimal(a.wholesalePrice).comparedTo(toDecimal(b.wholesalePrice));
  });

  return eligible;
}

export function selectOptimalProvider(
  candidates: ProviderOfferCandidate[],
  strategy: SelectionStrategy = 'priority',
  quantity = 1
): ProviderOfferCandidate | null {
  return rankEligibleProviders(candidates, strategy, quantity)[0] ?? null;
}

/**
 * Evaluates the full provider priority queue for a store product so Admin UI and Order Engine
 * share 100% identical visibility into which provider is currently active (#1/#2/#3) and why.
 */
export function evaluateProviderPriorityQueue(
  candidates: ProviderOfferCandidate[],
  strategy: SelectionStrategy = 'priority',
  quantity = 1
): EvaluatedProviderQueueItem[] {
  const qty = Math.max(1, Math.floor(quantity || 1));
  const orderedAll = [...candidates].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.roleType !== b.roleType) return a.roleType === 'primary' ? -1 : 1;
    return a.mappingId - b.mappingId;
  });

  const eligibleRanked = rankEligibleProviders(orderedAll, strategy, qty);
  const activeMappingId = eligibleRanked[0]?.mappingId ?? null;
  const eligibleSet = new Set(eligibleRanked.map((c) => c.mappingId));

  return orderedAll.map((c, idx) => {
    let routingState: ProviderRoutingState;
    if (!c.isActive || !c.isVerifiedCompatible) {
      routingState = 'paused';
    } else if (!c.providerEnabled || c.providerStatus !== 'connected') {
      routingState = 'offline';
    } else if (c.stockCount < qty) {
      routingState = 'out_of_stock';
    } else if (toDecimal(c.providerBalance).lt(toDecimal(c.wholesalePrice).times(qty))) {
      routingState = 'low_balance';
    } else if (c.mappingId === activeMappingId) {
      routingState = 'active_now';
    } else if (eligibleSet.has(c.mappingId)) {
      routingState = 'standby';
    } else {
      routingState = 'offline';
    }

    return {
      ...c,
      rank: idx + 1,
      routingState,
      isActiveRoutingTarget: c.mappingId === activeMappingId,
    };
  });
}

export interface ResolvedProductPricingAndStock {
  evaluatedQueue: EvaluatedProviderQueueItem[];
  activeTarget: EvaluatedProviderQueueItem | null;
  referenceProvider: EvaluatedProviderQueueItem | null;
  referenceWholesale: string;
  totalStock: number;
  breakdown: ProfitBreakdown;
  effectiveUnitRetail: string;
  effectiveUnitRetailFormatted: string;
  effectiveAgentUnitPrice: string;
  effectiveAgentUnitPriceFormatted: string;
  agentBreakdown: ProfitBreakdown;
  activePromoPrice: string | null;
}

/**
 * Single Source of Truth for a store product's effective retail price & combined live stock:
 * - Sums stock across ALL active, verified, enabled, connected providers linked to the product (no cap).
 * - Selects the active routing provider's wholesale price (falling back to highest-priority stocked
 *   connected provider, then Priority #1) to compute fixed_margin / percent_margin retail prices.
 * - Guarantees 100% identical pricing across Admin Dashboard, Admin Bot, Buyer Bot, Web Store, and Order Engine.
 */
export function resolveProductEffectivePricingAndStock(params: {
  rule: PricingRuleInput | null;
  candidates: ProviderOfferCandidate[];
  strategy?: SelectionStrategy;
  quantity?: number;
  now?: Date;
}): ResolvedProductPricingAndStock {
  const strategy = params.strategy || 'priority';
  const qty = Math.max(1, Math.floor(params.quantity || 1));
  const now = params.now || new Date();

  const evaluatedQueue = evaluateProviderPriorityQueue(params.candidates, strategy, qty);
  const activeTarget = evaluatedQueue.find((e) => e.isActiveRoutingTarget) || null;
  const firstStockedConnected =
    evaluatedQueue.find(
      (e) =>
        e.isActive &&
        e.isVerifiedCompatible &&
        e.providerEnabled &&
        e.providerStatus === 'connected' &&
        e.stockCount > 0
    ) || null;
  const firstMapped = evaluatedQueue[0] || null;
  const referenceProvider = activeTarget || firstStockedConnected || firstMapped;

  const totalStock = evaluatedQueue.reduce(
    (sum, c) =>
      c.isActive &&
      c.isVerifiedCompatible &&
      c.providerEnabled &&
      c.providerStatus === 'connected' &&
      c.stockCount > 0
        ? sum + Math.floor(c.stockCount)
        : sum,
    0
  );

  const referenceWholesale = referenceProvider?.wholesalePrice || '0.0000';
  const normalizedRule: PricingRuleInput = params.rule || {
    pricingMode: 'manual',
    retailPrice: '0.0000',
    fixedMargin: '0.0000',
    percentMargin: '0.0000',
    paymentFeePercent: '1.5000',
    extraFixedCost: '0.0000',
    promoPrice: null,
    promoEndsAt: null,
    bulkTiersJson: null,
    lockManualPrice: true,
  };

  const breakdown = computeProfitBreakdown(normalizedRule, referenceWholesale, qty, now);
  const activePromoPrice =
    breakdown.appliedTier === 'promo' ? formatMoney(breakdown.unitRetail, 2) : null;

  const rawAgentPrice = normalizedRule.agentPrice;
  const parsedAgentPrice =
    rawAgentPrice !== null && rawAgentPrice !== undefined && String(rawAgentPrice).trim() !== ''
      ? toDecimal(rawAgentPrice)
      : null;
  const hasExplicitAgentPrice = parsedAgentPrice !== null && parsedAgentPrice.isFinite() && parsedAgentPrice.gt(0);

  const agentBreakdown = hasExplicitAgentPrice
    ? computeProfitBreakdown(
        {
          pricingMode: 'manual',
          retailPrice: parsedAgentPrice!.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(4),
          fixedMargin: '0.0000',
          percentMargin: '0.0000',
          paymentFeePercent: normalizedRule.paymentFeePercent,
          extraFixedCost: normalizedRule.extraFixedCost,
          promoPrice: null,
          promoEndsAt: null,
          bulkTiersJson: null,
          lockManualPrice: true,
        },
        referenceWholesale,
        qty,
        now
      )
    : breakdown;

  return {
    evaluatedQueue,
    activeTarget,
    referenceProvider,
    referenceWholesale,
    totalStock,
    breakdown,
    effectiveUnitRetail: breakdown.unitRetail,
    effectiveUnitRetailFormatted: formatMoney(breakdown.unitRetail, 2),
    effectiveAgentUnitPrice: agentBreakdown.unitRetail,
    effectiveAgentUnitPriceFormatted: formatMoney(agentBreakdown.unitRetail, 2),
    agentBreakdown,
    activePromoPrice,
  };
}

export interface ProviderAttemptResult {
  status: 'completed' | 'pending' | 'failed' | 'uncertain';
  uncertainState: boolean;
  deterministicFailureCode?: string;
}

/**
 * STRICT ANTI-DOUBLE-BUY GUARD:
 * NEVER switch to a backup provider if the primary order outcome is uncertain
 * (e.g., network timeout after POST) or still pending!
 * Only allow backup failover on a confirmed deterministic pre-fulfillment rejection.
 */
export function canSafelyFailoverToBackup(attempt: ProviderAttemptResult): boolean {
  if (attempt.uncertainState) return false;
  if (attempt.status === 'uncertain' || attempt.status === 'pending' || attempt.status === 'completed') {
    return false;
  }
  const safeDeterministicCodes = new Set([
    'OUT_OF_STOCK',
    'INSUFFICIENT_BALANCE',
    'PRODUCT_NOT_FOUND',
    'PRODUCT_UNAVAILABLE',
    'PRICE_CHANGED',
    'DELIVERY_FAILED_REFUNDED',
    'PROVIDER_OFFLINE_BEFORE_SEND',
  ]);
  return Boolean(attempt.deterministicFailureCode && safeDeterministicCodes.has(attempt.deterministicFailureCode));
}

export function classifyProviderAttemptFailureAction(deterministicFailureCode?: string): {
  zeroStock: boolean;
  deactivateOffer: boolean;
  notifyAdminMissingOffer: boolean;
} {
  const code = (deterministicFailureCode || '').trim().toUpperCase();
  if (code === 'PRODUCT_NOT_FOUND') {
    return { zeroStock: true, deactivateOffer: true, notifyAdminMissingOffer: true };
  }
  if (code === 'OUT_OF_STOCK' || code === 'PRODUCT_UNAVAILABLE') {
    return { zeroStock: true, deactivateOffer: false, notifyAdminMissingOffer: false };
  }
  return { zeroStock: false, deactivateOffer: false, notifyAdminMissingOffer: false };
}

export function collectDisappearedProviderOfferIds(
  existingRows: Array<{
    id: number;
    externalProductId: string;
    externalVariantId: string | null;
    stockCount: number;
    isActiveAtProvider: boolean;
  }>,
  fetchedLiveItems: Array<{ externalProductId: string; externalVariantId?: string | null }>,
  isPartialFetch = false
): number[] {
  if (isPartialFetch || fetchedLiveItems.length === 0) return [];
  const liveKeys = new Set(
    fetchedLiveItems.map((it) => `${it.externalProductId}::${it.externalVariantId || ''}`)
  );
  return existingRows
    .filter((row) => {
      const key = `${row.externalProductId}::${row.externalVariantId || ''}`;
      return !liveKeys.has(key) && (row.stockCount > 0 || row.isActiveAtProvider);
    })
    .map((row) => row.id);
}

export function applyCouponDiscount(
  subtotalRetail: string,
  coupon: {
    discountType: 'percent' | 'fixed' | string;
    discountValue: string;
    minOrderAmount: string;
    isActive: boolean;
    maxUses: number;
    usedCount: number;
    expiresAt?: Date | string | null;
  } | null,
  now: Date = new Date()
): { valid: boolean; discountAmount: string; finalTotal: string; reasonAr?: string } {
  const subtotal = toDecimal(subtotalRetail);
  if (!coupon) {
    return { valid: true, discountAmount: '0.0000', finalTotal: subtotal.toFixed(4) };
  }
  if (!coupon.isActive) {
    return { valid: false, discountAmount: '0.0000', finalTotal: subtotal.toFixed(4), reasonAr: 'كوبون الخصم غير مفعل حاليًا.' };
  }
  if (coupon.usedCount >= coupon.maxUses) {
    return { valid: false, discountAmount: '0.0000', finalTotal: subtotal.toFixed(4), reasonAr: 'تم استنفاد الحد الأقصى لاستخدام الكوبون.' };
  }
  if (coupon.expiresAt && new Date(coupon.expiresAt).getTime() < now.getTime()) {
    return { valid: false, discountAmount: '0.0000', finalTotal: subtotal.toFixed(4), reasonAr: 'انتهت صلاحية كوبون الخصم.' };
  }
  if (subtotal.lt(toDecimal(coupon.minOrderAmount))) {
    return {
      valid: false,
      discountAmount: '0.0000',
      finalTotal: subtotal.toFixed(4),
      reasonAr: `الحد الأدنى لاستخدام الكوبون هو $${formatMoney(coupon.minOrderAmount)}.`,
    };
  }

  let discount =
    coupon.discountType === 'percent'
      ? subtotal.times(toDecimal(coupon.discountValue).div(100)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      : toDecimal(coupon.discountValue).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  if (discount.gt(subtotal)) discount = subtotal;
  const finalTotal = subtotal.minus(discount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  return {
    valid: true,
    discountAmount: discount.toFixed(4),
    finalTotal: finalTotal.toFixed(4),
  };
}
