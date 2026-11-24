import { asc, eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  categories,
  customerProductOverrides,
  productPrices,
  productProviderMappings,
  providerProducts,
  providers,
  storeProducts,
  users,
} from '../db/schema.ts';
import {
  resolveProductEffectivePricingAndStock,
  type PricingRuleInput,
  type ProviderOfferCandidate,
  type ResolvedProductPricingAndStock,
  type SelectionStrategy,
} from './pricing.ts';
import { toCustomerProductDTO, type CustomerProductDTO } from './sanitizer.ts';
import { applyCustomerProductOverride, normalizeUserPricingTier } from './customerOverridesEngine.ts';
import type { SupportedLang } from '../i18n/index.ts';

function toPricingRuleInput(
  price: typeof productPrices.$inferSelect | null | undefined
): PricingRuleInput | null {
  if (!price) return null;
  return {
    pricingMode: (price.pricingMode as PricingRuleInput['pricingMode']) || 'manual',
    retailPrice: price.retailPrice || '0.0000',
    agentPrice: price.agentPrice || null,
    fixedMargin: price.fixedMargin || '0.0000',
    percentMargin: price.percentMargin || '0.0000',
    paymentFeePercent: price.paymentFeePercent || '1.5000',
    extraFixedCost: price.extraFixedCost || '0.0000',
    promoPrice: price.promoPrice || null,
    promoEndsAt: price.promoEndsAt || null,
    bulkTiersJson: price.bulkTiersJson || null,
    lockManualPrice: price.lockManualPrice ?? true,
  };
}

/**
 * Loads live candidates per storeProductId from PostgreSQL.
 */
async function loadCandidatesByStoreProduct(storeProductId?: number) {
  const baseQuery = db
    .select({
      mapping: productProviderMappings,
      providerProduct: providerProducts,
      provider: providers,
    })
    .from(productProviderMappings)
    .innerJoin(providerProducts, eq(productProviderMappings.providerProductId, providerProducts.id))
    .innerJoin(providers, eq(providerProducts.providerId, providers.id));

  const rows =
    storeProductId !== undefined
      ? await baseQuery
          .where(eq(productProviderMappings.storeProductId, storeProductId))
          .orderBy(asc(productProviderMappings.priority), asc(productProviderMappings.id))
      : await baseQuery.orderBy(asc(productProviderMappings.priority), asc(productProviderMappings.id));

  const map = new Map<number, { strategy: SelectionStrategy; candidates: ProviderOfferCandidate[] }>();
  for (const m of rows) {
    const entry = map.get(m.mapping.storeProductId) || {
      strategy: (m.mapping.selectionStrategy as SelectionStrategy) || 'priority',
      candidates: [],
    };
    entry.candidates.push({
      mappingId: m.mapping.id,
      providerId: m.provider.id,
      providerCode: m.provider.code,
      providerName: m.provider.name,
      providerStatus: m.provider.status,
      providerEnabled: m.provider.isEnabled,
      providerBalance: m.provider.cachedBalance,
      providerProductId: m.providerProduct.id,
      externalProductId: m.providerProduct.externalProductId,
      externalVariantId: m.providerProduct.externalVariantId,
      wholesalePrice: m.providerProduct.wholesalePrice,
      stockCount: m.providerProduct.stockCount,
      roleType: m.mapping.roleType,
      priority: m.mapping.priority,
      isVerifiedCompatible: m.mapping.isVerifiedCompatible,
      isActive: m.mapping.isActive && m.providerProduct.isActiveAtProvider,
      durationLabel: m.providerProduct.durationLabel || '',
      deliveryType: m.providerProduct.deliveryType,
      warrantyDays: m.providerProduct.warrantyDays,
    });
    map.set(m.mapping.storeProductId, entry);
  }
  return map;
}

/**
 * Single Source of Truth for the Buyer Bot and Public Web Storefront:
 * - Always computes the final live retail price dynamically from Admin pricing rules
 *   (manual, fixed_margin, percent_margin, promo) & active provider wholesale price.
 * - When `userId` is provided, applies that specific customer's isolated overrides
 *   (custom price and/or per-customer hidden status) without ever affecting any other customer.
 * - Sums live stock across ALL active connected linked providers (no cap).
 * - Automatically hides any product whose combined stock is 0 and restores it automatically when restocked.
 */
export async function getLiveCustomerCatalog(
  lang: SupportedLang,
  userId?: number
): Promise<CustomerProductDTO[]> {
  const validUserId = typeof userId === 'number' && Number.isInteger(userId) && userId > 0 ? userId : null;

  const [rows, candidatesMap, userOverrides, userTierRow] = await Promise.all([
    db
      .select({
        product: storeProducts,
        price: productPrices,
        category: categories,
      })
      .from(storeProducts)
      .leftJoin(productPrices, eq(productPrices.storeProductId, storeProducts.id))
      .leftJoin(categories, eq(storeProducts.categoryId, categories.id))
      .orderBy(asc(storeProducts.sortOrder), asc(storeProducts.id)),
    loadCandidatesByStoreProduct(),
    validUserId !== null
      ? db
          .select({
            storeProductId: customerProductOverrides.storeProductId,
            customPriceUsd: customerProductOverrides.customPriceUsd,
            isHidden: customerProductOverrides.isHidden,
          })
          .from(customerProductOverrides)
          .where(eq(customerProductOverrides.userId, validUserId))
      : Promise.resolve([]),
    validUserId !== null
      ? db
          .select({ pricingTier: users.pricingTier })
          .from(users)
          .where(eq(users.id, validUserId))
          .limit(1)
      : Promise.resolve([]),
  ]);

  const userPricingTier = normalizeUserPricingTier(userTierRow[0]?.pricingTier);
  const overrideMap = new Map(userOverrides.map((ov) => [ov.storeProductId, ov]));

  return rows
    .map((r) => {
      const entry = candidatesMap.get(r.product.id);
      const resolved = resolveProductEffectivePricingAndStock({
        rule: toPricingRuleInput(r.price),
        candidates: entry?.candidates || [],
        strategy: entry?.strategy || 'priority',
        quantity: 1,
      });

      const applied = applyCustomerProductOverride({
        officialUnitPrice: resolved.effectiveUnitRetail,
        officialAgentUnitPrice: resolved.effectiveAgentUnitPrice,
        officialPromoPrice: resolved.activePromoPrice,
        userPricingTier,
        override: overrideMap.get(r.product.id) || null,
      });

      if (applied.hidden) {
        return null;
      }

      return toCustomerProductDTO({
        id: r.product.id,
        sku: r.product.sku,
        categoryId: r.product.categoryId,
        categoryNameAr: r.category?.nameAr || 'منتجات رقمية',
        categoryNameEn: r.category?.nameEn || 'Digital Products',
        titleAr: r.product.titleAr,
        titleEn: r.product.titleEn,
        descriptionAr: r.product.descriptionAr,
        descriptionEn: r.product.descriptionEn,
        iconEmoji: r.product.iconEmoji,
        iconCustomEmojiId: r.product.iconCustomEmojiId,
        imageUrl: r.product.imageUrl,
        warrantyLabelAr: r.product.warrantyLabelAr,
        warrantyLabelEn: r.product.warrantyLabelEn,
        durationLabel: r.product.durationLabel,
        deliveryType: r.product.deliveryType,
        isVisible: r.product.isVisible,
        isPaused: r.product.isPaused,
        autoHideOutOfStock: r.product.autoHideOutOfStock,
        isFeaturedOffer: r.product.isFeaturedOffer,
        retailPrice: applied.effectiveUnitPrice,
        promoPrice: applied.effectivePromoPrice,
        availableStock: resolved.totalStock,
        lang,
      });
    })
    .filter((dto): dto is CustomerProductDTO => dto !== null);
}

/**
 * Returns a map of live resolved pricing & stock for all store products (used by Admin Telegram Bot).
 */
export async function getLiveProductPricingMap(): Promise<Map<number, ResolvedProductPricingAndStock>> {
  const rows = await db
    .select({ productId: storeProducts.id, price: productPrices })
    .from(storeProducts)
    .leftJoin(productPrices, eq(productPrices.storeProductId, storeProducts.id));

  const candidatesMap = await loadCandidatesByStoreProduct();
  const result = new Map<number, ResolvedProductPricingAndStock>();

  for (const r of rows) {
    const entry = candidatesMap.get(r.productId);
    result.set(
      r.productId,
      resolveProductEffectivePricingAndStock({
        rule: toPricingRuleInput(r.price),
        candidates: entry?.candidates || [],
        strategy: entry?.strategy || 'priority',
        quantity: 1,
      })
    );
  }
  return result;
}

/**
 * Synchronizes `product_prices.retail_price` in PostgreSQL for dynamic pricing modes
 * (`fixed_margin` / `percent_margin`) so no stale retail price remains stored in the DB.
 * NEVER overwrites manual retail prices (`pricingMode === 'manual'`).
 */
export async function syncStoredEffectiveRetailPrice(storeProductId: number): Promise<string | null> {
  const [priceRow] = await db
    .select()
    .from(productPrices)
    .where(eq(productPrices.storeProductId, storeProductId))
    .limit(1);

  if (!priceRow) return null;

  const candidatesMap = await loadCandidatesByStoreProduct(storeProductId);
  const entry = candidatesMap.get(storeProductId);
  const resolved = resolveProductEffectivePricingAndStock({
    rule: toPricingRuleInput(priceRow),
    candidates: entry?.candidates || [],
    strategy: entry?.strategy || 'priority',
    quantity: 1,
  });

  if (priceRow.pricingMode !== 'manual' && resolved.breakdown.appliedTier !== 'promo') {
    if (priceRow.retailPrice !== resolved.effectiveUnitRetail) {
      await db
        .update(productPrices)
        .set({
          retailPrice: resolved.effectiveUnitRetail,
          updatedAt: new Date(),
        })
        .where(eq(productPrices.id, priceRow.id));
    }
  }

  return resolved.effectiveUnitRetail;
}

/**
 * Synchronizes all non-manual (`fixed_margin` / `percent_margin`) store products' cached retail_price.
 */
export async function syncAllNonManualProductPrices(): Promise<number> {
  const rows = await db.select().from(productPrices);
  const nonManual = rows.filter((r) => r.pricingMode !== 'manual');
  if (nonManual.length === 0) return 0;

  const candidatesMap = await loadCandidatesByStoreProduct();
  let updated = 0;

  for (const priceRow of nonManual) {
    const entry = candidatesMap.get(priceRow.storeProductId);
    const resolved = resolveProductEffectivePricingAndStock({
      rule: toPricingRuleInput(priceRow),
      candidates: entry?.candidates || [],
      strategy: entry?.strategy || 'priority',
      quantity: 1,
    });
    if (resolved.breakdown.appliedTier !== 'promo' && priceRow.retailPrice !== resolved.effectiveUnitRetail) {
      await db
        .update(productPrices)
        .set({
          retailPrice: resolved.effectiveUnitRetail,
          updatedAt: new Date(),
        })
        .where(eq(productPrices.id, priceRow.id));
      updated += 1;
    }
  }

  return updated;
}
