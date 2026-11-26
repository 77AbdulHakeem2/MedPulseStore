import Decimal from 'decimal.js';
import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  auditLogs,
  categories,
  notifications,
  productPrices,
  productProviderMappings,
  providerCredentials,
  providerProducts,
  providers,
  storeProducts,
} from '../db/schema.ts';
import { matchProductToStoreCategory } from '../lib/offerClassifier.ts';
import { syncAllNonManualProductPrices, syncStoredEffectiveRetailPrice } from './catalogService.ts';
import { decryptSecret, generateUniqueRef } from './crypto.ts';
import { collectDisappearedProviderOfferIds } from './orderEngine.ts';
import { evaluateSyncPriceUpdate, formatMoney } from './pricing.ts';
import {
  normalizeOriginalTelegramHtmlForPreview,
  processSupplierProductDescription,
  registerDynamicSupplierIdentities,
} from './productDescriptionEngine.ts';
import { resolveProviderAdapter } from './providers/index.ts';
import { sanitizeCustomerProductDescription } from './sanitizer.ts';

export interface SingleProviderSyncParams {
  providerId: number;
  allowSandboxFallback?: boolean;
  autoCreateStoreProducts?: boolean;
  actorUserId?: number | null;
  actorRole?: string | null;
  writeAuditLog?: boolean;
  networkTimeoutMs?: number;
  onInvalidateCache?: (providerId: number) => void;
}

export interface SingleProviderSyncResult {
  ok: boolean;
  providerId: number;
  providerName: string;
  mode: 'live' | 'sandbox' | 'no_key';
  skipped?: boolean;
  newlyCreatedHidden: number;
  updatedCount: number;
  restockedOffersCount: number;
  depletedOffersCount: number;
  priceHikeAlerts: number;
  error?: string;
  messageAr: string;
}

export interface SyncAllProvidersResult {
  ok: boolean;
  totalEnabledProviders: number;
  syncedProvidersCount: number;
  failedProvidersCount: number;
  skippedNoKeyCount: number;
  failedProviders: Array<{ providerId: number; providerName: string; error: string }>;
  newlyCreatedHiddenCount: number;
  updatedOffersCount: number;
  restockedOffersCount: number;
  depletedOffersCount: number;
  restoredProductsCount: number;
  hiddenOutOfStockProductsCount: number;
  priceHikeAlerts: number;
  messageAr: string;
}

function toSafeSyncInt(value: unknown, fallback: number, min = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.trunc(n));
}

async function snapshotStoreProductsStockPresence(): Promise<Map<number, boolean>> {
  const rows = await db
    .select({
      storeProductId: productProviderMappings.storeProductId,
      isActiveMapping: productProviderMappings.isActive,
      isVerifiedCompatible: productProviderMappings.isVerifiedCompatible,
      stockCount: providerProducts.stockCount,
      isActiveAtProvider: providerProducts.isActiveAtProvider,
      providerEnabled: providers.isEnabled,
      providerStatus: providers.status,
    })
    .from(productProviderMappings)
    .innerJoin(providerProducts, eq(productProviderMappings.providerProductId, providerProducts.id))
    .innerJoin(providers, eq(providerProducts.providerId, providers.id));

  const map = new Map<number, boolean>();
  for (const r of rows) {
    const active =
      r.isActiveMapping &&
      r.isActiveAtProvider &&
      r.isVerifiedCompatible !== false &&
      r.providerEnabled &&
      r.providerStatus === 'connected' &&
      Number(r.stockCount || 0) > 0;
    if (active) {
      map.set(r.storeProductId, true);
    } else if (!map.has(r.storeProductId)) {
      map.set(r.storeProductId, false);
    }
  }
  return map;
}

/**
 * Synchronizes stock, availability, pricing, and descriptions for a single provider
 * WITHOUT ever mutating `storeProducts.categoryId`, `storeProducts.sortOrder`,
 * `storeProducts.isVisible`, or manual retail pricing.
 */
export async function syncSingleProviderCatalog(
  params: SingleProviderSyncParams
): Promise<SingleProviderSyncResult> {
  const {
    providerId,
    allowSandboxFallback = false,
    autoCreateStoreProducts = false,
    actorUserId = null,
    actorRole = null,
    writeAuditLog = false,
    networkTimeoutMs,
    onInvalidateCache,
  } = params;

  const [prov] = await db.select().from(providers).where(eq(providers.id, providerId)).limit(1);
  if (!prov) {
    return {
      ok: false,
      providerId,
      providerName: `#${providerId}`,
      mode: 'no_key',
      newlyCreatedHidden: 0,
      updatedCount: 0,
      restockedOffersCount: 0,
      depletedOffersCount: 0,
      priceHikeAlerts: 0,
      error: 'الخادم غير موجود.',
      messageAr: 'الخادم غير موجود.',
    };
  }

  const [cred] = await db
    .select()
    .from(providerCredentials)
    .where(eq(providerCredentials.providerId, providerId))
    .limit(1);

  if (!cred && !allowSandboxFallback) {
    return {
      ok: true,
      providerId,
      providerName: prov.name,
      mode: 'no_key',
      skipped: true,
      newlyCreatedHidden: 0,
      updatedCount: 0,
      restockedOffersCount: 0,
      depletedOffersCount: 0,
      priceHikeAlerts: 0,
      messageAr: `تم تخطي ${prov.name} (لا يوجد مفتاح API).`,
    };
  }

  const adapter = resolveProviderAdapter({
    code: prov.code,
    name: prov.name,
    baseUrl: prov.baseUrl,
    docsUrl: prov.docsUrl,
    authType: prov.authType,
    authHeader: prov.authHeader,
    rateLimitPerMin: prov.rateLimitPerMin,
  });

  let importedItems: Array<{
    externalProductId: string;
    externalVariantId: string;
    rawName: string;
    rawDescription: string;
    wholesalePrice: string;
    stockCount: number;
    minQty?: number;
    maxQty?: number;
    deliveryType: string;
    durationLabel: string;
    warrantyDays: number;
    pricingTiers?: Array<{ minQty: number; maxQty: number | null; price: string }>;
  }> = [];

  let mode: 'live' | 'sandbox' = 'sandbox';
  if (cred) {
    mode = 'live';
    const rawKey = decryptSecret(cred.encryptedApiKey);
    const fetchPairPromise = Promise.allSettled([
      adapter.fetchProducts(rawKey),
      adapter.testConnection(rawKey),
    ]);
    const [itemsResult, balanceResult] = networkTimeoutMs
      ? await Promise.race([
          fetchPairPromise,
          new Promise<[PromiseRejectedResult, PromiseRejectedResult]>((resolve) =>
            setTimeout(() => {
              const timeoutErr = new Error('انتهت مهلة الاتصال بالخادم أثناء تحديث الكتالوج.');
              resolve([
                { status: 'rejected', reason: timeoutErr },
                { status: 'rejected', reason: timeoutErr },
              ]);
            }, networkTimeoutMs)
          ),
        ])
      : await fetchPairPromise;

    if (balanceResult.status === 'fulfilled' && balanceResult.value.connected) {
      await db
        .update(providers)
        .set({
          status: 'connected',
          lastError: null,
          cachedBalance: new Decimal(balanceResult.value.balance || '0').toFixed(4),
          updatedAt: new Date(),
        })
        .where(eq(providers.id, providerId));
    }

    if (itemsResult.status === 'rejected') {
      const errMsg = itemsResult.reason?.message || 'فشل الاتصال بالخادم أثناء تحديث المنتجات.';
      await db
        .update(providers)
        .set({
          status: 'error',
          lastError: String(errMsg).slice(0, 500),
          updatedAt: new Date(),
        })
        .where(eq(providers.id, providerId));
      throw new Error(errMsg);
    }

    importedItems = itemsResult.value;
    if (balanceResult.status === 'fulfilled' && !balanceResult.value.connected && Array.isArray(importedItems)) {
      await db
        .update(providers)
        .set({
          status: 'connected',
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(providers.id, providerId));
    }
  } else {
    const existingProvProds = await db
      .select()
      .from(providerProducts)
      .where(eq(providerProducts.providerId, providerId));
    importedItems = existingProvProds.map((ep) => ({
      externalProductId: ep.externalProductId,
      externalVariantId: ep.externalVariantId,
      rawName: ep.rawName,
      rawDescription: ep.rawDescription || '',
      wholesalePrice: ep.wholesalePrice,
      stockCount: Math.max(10, ep.stockCount),
      deliveryType: ep.deliveryType,
      durationLabel: ep.durationLabel || '',
      warrantyDays: ep.warrantyDays,
    }));
    const discoverySlug = `${prov.code}_canva_pro_12m`;
    if (!importedItems.some((it) => it.externalProductId === discoverySlug)) {
      importedItems.push({
        externalProductId: discoverySlug,
        externalVariantId: '',
        rawName: `Canva Pro Education — 12M (${prov.name})`,
        rawDescription: '',
        wholesalePrice: '0.8500',
        stockCount: 160,
        deliveryType: 'link',
        durationLabel: '12 شهر',
        warrantyDays: 365,
      });
    }
  }

  registerDynamicSupplierIdentities([prov]);

  const allCats = autoCreateStoreProducts
    ? await db.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.id))
    : [];

  const preloadedExisting = await db
    .select()
    .from(providerProducts)
    .where(eq(providerProducts.providerId, providerId));
  const existingByExternalKey = new Map<string, typeof providerProducts.$inferSelect>();
  for (const row of preloadedExisting) {
    existingByExternalKey.set(`${row.externalProductId}\u0000${row.externalVariantId || ''}`, row);
  }

  let newlyCreatedHidden = 0;
  let updatedCount = 0;
  let restockedOffersCount = 0;
  let depletedOffersCount = 0;
  let priceHikeAlerts = 0;

  for (const item of importedItems) {
    const rawTrimmed = (item.rawDescription || '').trim();
    const processedSync = processSupplierProductDescription(rawTrimmed, {
      extraSupplierNames: [prov.name, prov.code],
    });
    const cleanedSupplierDesc =
      processedSync.telegramHtml || (rawTrimmed ? normalizeOriginalTelegramHtmlForPreview(rawTrimmed) : '');

    const lookupKey = `${item.externalProductId}\u0000${item.externalVariantId || ''}`;
    const existingMatch = existingByExternalKey.get(lookupKey);

    if (existingMatch) {
      const prev = existingMatch;
      const oldW = prev.wholesalePrice;
      const safeStock = toSafeSyncInt(item.stockCount, 0, 0);
      const safeMinQty = toSafeSyncInt(item.minQty, prev.minQty || 1, 1);
      const safeMaxQty = Math.max(safeMinQty, toSafeSyncInt(item.maxQty, prev.maxQty || 100, 1));
      const wasAvailable = prev.stockCount > 0 && prev.isActiveAtProvider;
      const isNowAvailable = safeStock > 0;
      if (!wasAvailable && isNowAvailable) restockedOffersCount += 1;
      if (wasAvailable && !isNowAvailable) depletedOffersCount += 1;

      const prevCleanedDesc = sanitizeCustomerProductDescription(prev.rawDescription);
      await db
        .update(providerProducts)
        .set({
          rawName: item.rawName,
          rawDescription: cleanedSupplierDesc || prev.rawDescription || '',
          previousWholesalePrice: oldW,
          wholesalePrice: new Decimal(item.wholesalePrice).toFixed(4),
          stockCount: safeStock,
          isActiveAtProvider: true,
          minQty: safeMinQty,
          maxQty: safeMaxQty,
          durationLabel: item.durationLabel || prev.durationLabel,
          pricingTiersJson: item.pricingTiers ?? prev.pricingTiersJson,
          lastSyncedAt: new Date(),
        })
        .where(eq(providerProducts.id, prev.id));
      updatedCount += 1;

      // Update linked store product pricing/description WITHOUT touching categoryId, sortOrder, or isVisible
      const linked = await db
        .select({ sp: storeProducts, pr: productPrices })
        .from(productProviderMappings)
        .innerJoin(storeProducts, eq(productProviderMappings.storeProductId, storeProducts.id))
        .innerJoin(productPrices, eq(productPrices.storeProductId, storeProducts.id))
        .where(eq(productProviderMappings.providerProductId, prev.id));

      for (const l of linked) {
        const spDescAr = (l.sp.descriptionAr || '').trim();
        const spDescEn = (l.sp.descriptionEn || '').trim();
        const mirrorsPrevSupplierDesc =
          !spDescAr ||
          spDescAr === (prev.rawDescription || '').trim() ||
          spDescAr === prevCleanedDesc;
        if (cleanedSupplierDesc && mirrorsPrevSupplierDesc && spDescAr !== cleanedSupplierDesc) {
          await db
            .update(storeProducts)
            .set({
              descriptionAr: cleanedSupplierDesc,
              descriptionEn:
                !spDescEn || spDescEn === spDescAr || spDescEn === prevCleanedDesc
                  ? cleanedSupplierDesc
                  : l.sp.descriptionEn,
              updatedAt: new Date(),
            })
            .where(eq(storeProducts.id, l.sp.id));
        }

        const evalRes = evaluateSyncPriceUpdate({
          oldWholesale: oldW,
          newWholesale: item.wholesalePrice,
          rule: {
            pricingMode: l.pr.pricingMode as any,
            retailPrice: l.pr.retailPrice,
            fixedMargin: l.pr.fixedMargin,
            percentMargin: l.pr.percentMargin,
            paymentFeePercent: l.pr.paymentFeePercent,
            extraFixedCost: l.pr.extraFixedCost,
            lockManualPrice: l.pr.lockManualPrice,
          },
        });
        if (evalRes.wholesaleIncreased) {
          priceHikeAlerts += 1;
          await db.insert(notifications).values({
            audience: 'admin',
            eventType: 'wholesale_price_increase',
            severity: 'warning',
            titleAr: `تنبيه ارتفاع سعر الجملة: ${l.sp.titleAr}`,
            bodyAr: `ارتفع سعر الجملة من $${formatMoney(oldW, 2)} إلى $${formatMoney(item.wholesalePrice, 2)} (+$${formatMoney(evalRes.delta, 2)}). سعر البيع الحالي: $${formatMoney(evalRes.preservedRetailPrice, 2)}.`,
          });
        }
        if (l.pr.pricingMode !== 'manual') {
          await syncStoredEffectiveRetailPrice(l.sp.id);
        }
      }
    } else {
      const safeStock = toSafeSyncInt(item.stockCount, 0, 0);
      const safeMinQty = toSafeSyncInt(item.minQty, 1, 1);
      const safeMaxQty = Math.max(safeMinQty, toSafeSyncInt(item.maxQty, 100, 1));
      const [newPP] = await db
        .insert(providerProducts)
        .values({
          providerId,
          externalProductId: item.externalProductId,
          externalVariantId: item.externalVariantId || '',
          rawName: item.rawName,
          rawDescription: cleanedSupplierDesc,
          wholesalePrice: new Decimal(item.wholesalePrice).toFixed(4),
          currency: 'USD',
          stockCount: safeStock,
          minQty: safeMinQty,
          maxQty: safeMaxQty,
          deliveryType: item.deliveryType,
          durationLabel: item.durationLabel,
          warrantyDays: toSafeSyncInt(item.warrantyDays, 0, 0),
        })
        .returning();

      if (autoCreateStoreProducts) {
        const cleanTitle = item.rawName.replace(/\(.*?\)/g, '').trim();
        const matchedCat = matchProductToStoreCategory(cleanTitle, cleanedSupplierDesc || '', allCats);
        const sku = generateUniqueRef('SKU').slice(0, 16);
        const [newSP] = await db
          .insert(storeProducts)
          .values({
            sku,
            categoryId: matchedCat?.categoryId ?? null,
            titleAr: cleanTitle,
            titleEn: cleanTitle,
            descriptionAr: cleanedSupplierDesc,
            descriptionEn: cleanedSupplierDesc,
            warrantyLabelAr: item.warrantyDays > 0 ? `ضمان ${item.warrantyDays} يومًا` : 'ضمان التشغيل الفوري',
            warrantyLabelEn: item.warrantyDays > 0 ? `${item.warrantyDays}-day warranty` : 'Instant Activation Warranty',
            warrantyDays: item.warrantyDays,
            durationLabel: item.durationLabel || 'حسب الباقة',
            deliveryType: item.deliveryType,
            isVisible: false,
            isPaused: false,
          })
          .returning();

        await db.insert(productProviderMappings).values({
          storeProductId: newSP.id,
          providerProductId: newPP.id,
          roleType: 'primary',
          priority: 1,
          isVerifiedCompatible: true,
        });

        const suggestedRetail = new Decimal(item.wholesalePrice).plus('2.00').toFixed(4);
        await db.insert(productPrices).values({
          storeProductId: newSP.id,
          pricingMode: 'manual',
          retailPrice: suggestedRetail,
          agentPrice: suggestedRetail,
          fixedMargin: '2.0000',
          percentMargin: '100.0000',
          paymentFeePercent: '1.5000',
          lockManualPrice: true,
        });
      }

      newlyCreatedHidden += 1;
      if (safeStock > 0) restockedOffersCount += 1;
    }
  }

  if (mode === 'live' && importedItems.length > 0 && !(importedItems as any).__partial) {
    const allStoredForProv = await db
      .select({
        id: providerProducts.id,
        externalProductId: providerProducts.externalProductId,
        externalVariantId: providerProducts.externalVariantId,
        stockCount: providerProducts.stockCount,
        isActiveAtProvider: providerProducts.isActiveAtProvider,
      })
      .from(providerProducts)
      .where(eq(providerProducts.providerId, providerId));
    const disappearedIds = collectDisappearedProviderOfferIds(
      allStoredForProv,
      importedItems,
      Boolean((importedItems as any).__partial)
    );
    if (disappearedIds.length > 0) {
      await db
        .update(providerProducts)
        .set({ stockCount: 0, isActiveAtProvider: false, lastSyncedAt: new Date() })
        .where(inArray(providerProducts.id, disappearedIds));
      depletedOffersCount += disappearedIds.length;
    }
  }

  await db
    .update(providers)
    .set({ lastSyncAt: new Date(), updatedAt: new Date() })
    .where(eq(providers.id, providerId));

  onInvalidateCache?.(providerId);

  if (writeAuditLog && actorUserId) {
    await db.insert(auditLogs).values({
      actorUserId,
      actorRole: actorRole || 'system',
      action: 'PROVIDER_PRODUCTS_SYNCED',
      entityType: 'provider',
      entityId: String(providerId),
      detailsJson: {
        mode,
        newlyCreatedHidden,
        updatedCount,
        restockedOffersCount,
        depletedOffersCount,
        priceHikeAlerts,
      },
    });
  }

  return {
    ok: true,
    providerId,
    providerName: prov.name,
    mode,
    newlyCreatedHidden,
    updatedCount,
    restockedOffersCount,
    depletedOffersCount,
    priceHikeAlerts,
    messageAr: `تمت المزامنة مع ${prov.name}: ${newlyCreatedHidden} عرض جديد، ${updatedCount} عرض محدث (عاد للمخزون ${restockedOffersCount}، نفد ${depletedOffersCount}) مع الحفاظ على أقسام وترتيب المتجر.`,
  };
}

/**
 * Synchronizes ALL enabled servers/providers concurrently (bounded pool) and computes
 * exact store product stock transitions (auto-hidden on 0, auto-restored to previous category & sortOrder on > 0).
 */
export async function syncAllProvidersCatalog(options: {
  actorUserId?: number | null;
  actorRole?: string | null;
  writeAuditLog?: boolean;
  onInvalidateCache?: (providerId: number) => void;
} = {}): Promise<SyncAllProvidersResult> {
  const beforeStockMap = await snapshotStoreProductsStockPresence();

  const enabledProviders = await db
    .select()
    .from(providers)
    .where(eq(providers.isEnabled, true))
    .orderBy(asc(providers.priority), asc(providers.id));

  const creds = await db.select({ providerId: providerCredentials.providerId }).from(providerCredentials);
  const keyedProviderIds = new Set(creds.map((c) => c.providerId));

  const targetProviders = enabledProviders.filter((p) => keyedProviderIds.has(p.id));
  const skippedNoKeyCount = enabledProviders.length - targetProviders.length;

  let syncedProvidersCount = 0;
  const failedProviders: Array<{ providerId: number; providerName: string; error: string }> = [];
  let newlyCreatedHiddenCount = 0;
  let updatedOffersCount = 0;
  let restockedOffersCount = 0;
  let depletedOffersCount = 0;
  let priceHikeAlerts = 0;

  const CONCURRENCY = 10;
  let cursor = 0;

  const worker = async () => {
    while (cursor < targetProviders.length) {
      const idx = cursor;
      cursor += 1;
      const prov = targetProviders[idx];
      try {
        const res = await syncSingleProviderCatalog({
          providerId: prov.id,
          allowSandboxFallback: false,
          autoCreateStoreProducts: false,
          writeAuditLog: false,
          networkTimeoutMs: 15_000,
          onInvalidateCache: options.onInvalidateCache,
        });
        if (res.ok && !res.skipped) {
          syncedProvidersCount += 1;
          newlyCreatedHiddenCount += res.newlyCreatedHidden;
          updatedOffersCount += res.updatedCount;
          restockedOffersCount += res.restockedOffersCount;
          depletedOffersCount += res.depletedOffersCount;
          priceHikeAlerts += res.priceHikeAlerts;
        }
      } catch (err: any) {
        failedProviders.push({
          providerId: prov.id,
          providerName: prov.name,
          error: err?.message || 'فشل الاتصال بالخادم',
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, Math.max(1, targetProviders.length)) }, () => worker())
  );

  await syncAllNonManualProductPrices();

  const afterStockMap = await snapshotStoreProductsStockPresence();
  let restoredProductsCount = 0;
  let hiddenOutOfStockProductsCount = 0;
  const allProductIds = new Set([...beforeStockMap.keys(), ...afterStockMap.keys()]);
  for (const spId of allProductIds) {
    const prevHas = beforeStockMap.get(spId) ?? false;
    const nextHas = afterStockMap.get(spId) ?? false;
    if (!prevHas && nextHas) restoredProductsCount += 1;
    if (prevHas && !nextHas) hiddenOutOfStockProductsCount += 1;
  }

  if (options.writeAuditLog && options.actorUserId) {
    await db.insert(auditLogs).values({
      actorUserId: options.actorUserId,
      actorRole: options.actorRole || 'system',
      action: 'ALL_PROVIDERS_CATALOG_SYNCED',
      entityType: 'provider',
      entityId: 'all',
      detailsJson: {
        totalEnabledProviders: enabledProviders.length,
        syncedProvidersCount,
        failedProvidersCount: failedProviders.length,
        skippedNoKeyCount,
        updatedOffersCount,
        restockedOffersCount,
        depletedOffersCount,
        restoredProductsCount,
        hiddenOutOfStockProductsCount,
      },
    });
  }

  const parts: string[] = [
    `تم تحديث ${syncedProvidersCount} من أصل ${targetProviders.length} خادم متصل`,
    `تحديث ${updatedOffersCount} عرض`,
  ];
  if (restockedOffersCount > 0 || restoredProductsCount > 0) {
    parts.push(`عادت ${restoredProductsCount} منتجات (و${restockedOffersCount} عرض) إلى أقسامها وترتيبها السابق بعد توفر المخزون`);
  }
  if (depletedOffersCount > 0 || hiddenOutOfStockProductsCount > 0) {
    parts.push(`إخفاء ${hiddenOutOfStockProductsCount} منتج لنفاد المخزون مؤقتًا`);
  }
  if (failedProviders.length > 0) {
    parts.push(`تعذر الاتصال بـ ${failedProviders.length} خادم`);
  }

  return {
    ok: failedProviders.length < Math.max(1, targetProviders.length) || targetProviders.length === 0,
    totalEnabledProviders: enabledProviders.length,
    syncedProvidersCount,
    failedProvidersCount: failedProviders.length,
    skippedNoKeyCount,
    failedProviders,
    newlyCreatedHiddenCount,
    updatedOffersCount,
    restockedOffersCount,
    depletedOffersCount,
    restoredProductsCount,
    hiddenOutOfStockProductsCount,
    priceHikeAlerts,
    messageAr: `${parts.join(' · ')}.`,
  };
}
