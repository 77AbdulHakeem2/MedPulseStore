import Decimal from 'decimal.js';

export type UserPricingTier = 'customer' | 'agent';

export type AppliedPriceSource = 'custom_override' | 'agent_tier' | 'customer_tier';

export interface CustomerProductOverrideRecord {
  storeProductId: number;
  customPriceUsd: string | null;
  isHidden: boolean;
}

export interface AppliedCustomerOverrideResult {
  hidden: boolean;
  effectiveUnitPrice: string;
  effectivePromoPrice: string | null;
  hasCustomPrice: boolean;
  appliedPriceSource: AppliedPriceSource;
}

export interface CustomerSpendingOrderRow {
  status: string;
  totalRetail: string;
}

export interface CustomerSpendingSummary {
  totalSpentUsd: string;
  completedOrdersCount: number;
  refundedOrdersCount: number;
  failedOrdersCount: number;
  totalOrdersCount: number;
}

export function normalizeUserPricingTier(raw: unknown): UserPricingTier {
  return String(raw || '').trim().toLowerCase() === 'agent' ? 'agent' : 'customer';
}

export function isValidUserPricingTierInput(raw: unknown): raw is UserPricingTier {
  const s = String(raw || '').trim().toLowerCase();
  return s === 'customer' || s === 'agent';
}

function normalizeArabicDigits(input: string): string {
  return input
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * Validates and normalizes an optional custom product price (USD).
 * Empty / null / undefined clears the custom price (reverts to official store price).
 * Valid positive prices are rounded cleanly to 2 decimal places (stored as 4dp e.g. "0.8500")
 * so display prices and buyer balance checks always agree to the cent.
 */
export function parseAndValidateCustomPriceUsd(
  raw: unknown
): { ok: true; value: string | null } | { ok: false; errorAr: string } {
  if (raw === null || raw === undefined) {
    return { ok: true, value: null };
  }

  const cleaned = normalizeArabicDigits(String(raw))
    .replace(/[$€£﷼,\s]/g, '')
    .replace(/usdt|usd/gi, '')
    .trim();

  if (!cleaned) {
    return { ok: true, value: null };
  }

  let dec: Decimal;
  try {
    dec = new Decimal(cleaned);
  } catch {
    return { ok: false, errorAr: 'يرجى إدخال سعر رقمي صالح بالدولار (مثال: 0.90 أو 2.50).' };
  }

  if (!dec.isFinite() || dec.lte(0)) {
    return { ok: false, errorAr: 'يجب أن يكون السعر المخصص أكبر من 0.' };
  }

  if (dec.gt(100000)) {
    return { ok: false, errorAr: 'السعر المخصص يتجاوز الحد الأقصى المسموح به ($100,000).' };
  }

  const roundedCents = dec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (roundedCents.lte(0)) {
    return { ok: false, errorAr: 'أقل سعر مخصص مسموح به هو $0.01.' };
  }

  return { ok: true, value: roundedCents.toFixed(4) };
}

/**
 * Resolves the effective product visibility and price for a specific user.
 * Strict deterministic precedence:
 * 1. If hidden for this specific user -> hidden: true (excluded from catalog & blocked from purchase).
 * 2. If a valid per-user custom price override exists -> takes precedence over tier & promo prices.
 * 3. If user's pricingTier is 'agent' and product has a valid agent price -> uses agent price (no customer promo leak).
 * 4. Otherwise -> uses customer price & customer promo price.
 */
export function applyCustomerProductOverride(params: {
  officialUnitPrice: string;
  officialAgentUnitPrice?: string | null;
  officialPromoPrice: string | null;
  userPricingTier?: UserPricingTier | string | null;
  override?: CustomerProductOverrideRecord | null;
}): AppliedCustomerOverrideResult {
  const { officialUnitPrice, officialAgentUnitPrice, officialPromoPrice, userPricingTier, override } = params;
  const tier = normalizeUserPricingTier(userPricingTier);

  if (override?.isHidden) {
    return {
      hidden: true,
      effectiveUnitPrice: officialUnitPrice,
      effectivePromoPrice: officialPromoPrice,
      hasCustomPrice: false,
      appliedPriceSource: tier === 'agent' ? 'agent_tier' : 'customer_tier',
    };
  }

  if (
    override?.customPriceUsd !== null &&
    override?.customPriceUsd !== undefined &&
    String(override.customPriceUsd).trim() !== ''
  ) {
    try {
      const customDec = new Decimal(override.customPriceUsd);
      if (customDec.isFinite() && customDec.gt(0)) {
        return {
          hidden: false,
          effectiveUnitPrice: customDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(4),
          effectivePromoPrice: null,
          hasCustomPrice: true,
          appliedPriceSource: 'custom_override',
        };
      }
    } catch {
      // Fall through to tier price on malformed override
    }
  }

  if (
    tier === 'agent' &&
    officialAgentUnitPrice !== null &&
    officialAgentUnitPrice !== undefined &&
    String(officialAgentUnitPrice).trim() !== ''
  ) {
    try {
      const agentDec = new Decimal(officialAgentUnitPrice);
      if (agentDec.isFinite() && agentDec.gt(0)) {
        return {
          hidden: false,
          effectiveUnitPrice: agentDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(4),
          effectivePromoPrice: null,
          hasCustomPrice: false,
          appliedPriceSource: 'agent_tier',
        };
      }
    } catch {
      // Fall through to customer price on malformed agent price
    }
  }

  return {
    hidden: false,
    effectiveUnitPrice: officialUnitPrice,
    effectivePromoPrice: officialPromoPrice,
    hasCustomPrice: false,
    appliedPriceSource: 'customer_tier',
  };
}

/**
 * Computes exact customer lifetime spending from completed (successful) orders only.
 * Failed, cancelled, pending, and refunded orders are excluded from total spent.
 */
export function computeCustomerTotalSpending(
  orderRows: CustomerSpendingOrderRow[]
): CustomerSpendingSummary {
  let spent = new Decimal(0);
  let completedOrdersCount = 0;
  let refundedOrdersCount = 0;
  let failedOrdersCount = 0;

  for (const row of orderRows) {
    const st = (row.status || '').toLowerCase();
    if (st === 'completed') {
      completedOrdersCount += 1;
      try {
        const amt = new Decimal(row.totalRetail || '0');
        if (amt.isFinite() && amt.gt(0)) {
          spent = spent.plus(amt);
        }
      } catch {
        // Ignore malformed row
      }
    } else if (st === 'refunded') {
      refundedOrdersCount += 1;
    } else if (st === 'failed' || st === 'cancelled') {
      failedOrdersCount += 1;
    }
  }

  return {
    totalSpentUsd: spent.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    completedOrdersCount,
    refundedOrdersCount,
    failedOrdersCount,
    totalOrdersCount: orderRows.length,
  };
}

/**
 * Returns true when an override row has returned completely to defaults (official price + visible)
 * and should therefore be deleted from the database rather than keeping a no-op row.
 */
export function shouldDeleteOverrideRow(customPriceUsd: string | null, isHidden: boolean): boolean {
  return customPriceUsd === null && !isHidden;
}
