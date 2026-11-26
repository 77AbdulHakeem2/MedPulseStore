import Decimal from 'decimal.js';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  orders,
  orderItems,
  providerOrders,
  deliveries,
  storeProducts,
  productPrices,
  productProviderMappings,
  providerProducts,
  providers,
  providerCredentials,
  coupons,
  customerProductOverrides,
  notifications,
  auditLogs,
  settings,
} from '../db/schema.ts';
import { decryptSecret, encryptSecret, generateUniqueRef } from './crypto.ts';
import {
  applyCouponDiscount,
  canSafelyFailoverToBackup,
  classifyProviderAttemptFailureAction,
  collectDisappearedProviderOfferIds,
  computeProfitBreakdown,
  rankEligibleProviders,
  selectOptimalProvider,
  type ProviderOfferCandidate,
  type SelectionStrategy,
} from './pricing.ts';
import {
  buildCustomerDeliveryMessage,
  sanitizeErrorForCustomer,
} from './sanitizer.ts';
import {
  captureReservedWalletBalance,
  ensureUserWallet,
  refundReservedWalletBalance,
  reserveWalletBalance,
  resolveEffectiveOrderChargeUsd,
} from './walletEngine.ts';
import { resolveProviderAdapter, type ProviderOrderResponse } from './providers/index.ts';
import { awardReferralCommissionForOrder } from './referralEngine.ts';
import {
  fetchLiveYerExchangeRate,
  getCurrencyLocalDepositSettings,
  normalizeDisplayCurrency,
  type DisplayCurrency,
} from './currencyEngine.ts';
import { users } from '../db/schema.ts';
import { normalizeUserPricingTier } from './customerOverridesEngine.ts';

let orderTelegramNotifier: ((telegramUserId: string, text: string) => Promise<boolean>) | undefined;

export function registerOrderTelegramNotifier(
  fn: (telegramUserId: string, text: string) => Promise<boolean>
) {
  orderTelegramNotifier = fn;
}

export { classifyProviderAttemptFailureAction, collectDisappearedProviderOfferIds };

export interface PlaceStoreOrderInput {
  userId: number;
  storeProductId: number;
  quantity: number;
  idempotencyKey: string;
  couponCode?: string;
  customerLabel?: string;
}

export interface PlaceStoreOrderResult {
  ok: boolean;
  idempotentReplay?: boolean;
  orderNumber?: string;
  status?: string;
  totalRetail?: string;
  deliveryMessageAr?: string;
  deliveredItems?: string[];
  customerErrorAr?: string;
}

async function getStoreProfile() {
  const rows = await db.select().from(settings).where(eq(settings.key, 'store_profile')).limit(1);
  return (
    (rows[0]?.valueJson as {
      storeName?: string;
      supportHandle?: string;
      isStoreOpen?: boolean;
    }) || { storeName: 'متجر رَقْم', supportHandle: '@raqm_support', isStoreOpen: true }
  );
}

export async function placeCustomerOrder(input: PlaceStoreOrderInput): Promise<PlaceStoreOrderResult> {
  const qty = Math.max(1, Math.min(1000, Math.floor(input.quantity || 1)));
  const storeProfile = await getStoreProfile();

  const [buyerRow] = await db
    .select({
      preferredCurrency: users.preferredCurrency,
      languageCode: users.languageCode,
      pricingTier: users.pricingTier,
    })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  const buyerLang = buyerRow?.languageCode === 'en' ? 'en' : 'ar';
  const buyerPricingTier = normalizeUserPricingTier(buyerRow?.pricingTier);

  if (storeProfile.isStoreOpen === false) {
    return { ok: false, customerErrorAr: sanitizeErrorForCustomer('STORE_MAINTENANCE', buyerLang) };
  }

  // 1. Idempotency check: never purchase twice for the same idempotencyKey!
  const existingOrder = await db
    .select()
    .from(orders)
    .where(eq(orders.idempotencyKey, input.idempotencyKey))
    .limit(1);

  if (existingOrder.length > 0) {
    const ord = existingOrder[0];
    if (ord.userId !== input.userId) {
      return { ok: false, customerErrorAr: sanitizeErrorForCustomer('UNAUTHORIZED_ORDER_ACCESS', buyerLang) };
    }
    const deliv = await db.select().from(deliveries).where(eq(deliveries.orderId, ord.id)).limit(1);
    const items = deliv[0] ? (JSON.parse(decryptSecret(deliv[0].encryptedPayload)) as string[]) : [];
    return {
      ok: ord.status === 'completed' || ord.status === 'pending_delivery',
      idempotentReplay: true,
      orderNumber: ord.orderNumber,
      status: ord.status,
      totalRetail: new Decimal(ord.totalRetail).toFixed(2),
      deliveredItems: items,
      deliveryMessageAr: ord.customerMessageAr || undefined,
    };
  }

  // 2. Fetch store product & enforce visibility
  const [prod] = await db
    .select()
    .from(storeProducts)
    .where(eq(storeProducts.id, input.storeProductId))
    .limit(1);

  if (!prod || !prod.isVisible || prod.isPaused) {
    return { ok: false, customerErrorAr: sanitizeErrorForCustomer('PRODUCT_UNAVAILABLE_CUSTOMER', buyerLang) };
  }

  const [priceRule] = await db
    .select()
    .from(productPrices)
    .where(eq(productPrices.storeProductId, prod.id))
    .limit(1);

  if (!priceRule) {
    return { ok: false, customerErrorAr: sanitizeErrorForCustomer('PRODUCT_UNAVAILABLE_CUSTOMER', buyerLang) };
  }

  // 2b. Per-customer product visibility & custom price override (strictly isolated to input.userId)
  const [customerOverride] = await db
    .select({
      customPriceUsd: customerProductOverrides.customPriceUsd,
      isHidden: customerProductOverrides.isHidden,
    })
    .from(customerProductOverrides)
    .where(
      and(
        eq(customerProductOverrides.userId, input.userId),
        eq(customerProductOverrides.storeProductId, prod.id)
      )
    )
    .limit(1);

  if (customerOverride?.isHidden) {
    return { ok: false, customerErrorAr: sanitizeErrorForCustomer('PRODUCT_UNAVAILABLE_CUSTOMER', buyerLang) };
  }

  // 3. Load candidate provider mappings (Primary + Backup)
  const mappings = await db
    .select({
      mapping: productProviderMappings,
      providerProduct: providerProducts,
      provider: providers,
    })
    .from(productProviderMappings)
    .innerJoin(providerProducts, eq(productProviderMappings.providerProductId, providerProducts.id))
    .innerJoin(providers, eq(providerProducts.providerId, providers.id))
    .where(eq(productProviderMappings.storeProductId, prod.id));

  const candidates: ProviderOfferCandidate[] = mappings.map((m) => ({
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
  }));

  const strategy = (mappings[0]?.mapping.selectionStrategy as SelectionStrategy) || 'priority';
  const primaryCandidate = selectOptimalProvider(candidates, strategy, qty);

  if (!primaryCandidate) {
    return { ok: false, customerErrorAr: sanitizeErrorForCustomer('OUT_OF_STOCK_CUSTOMER', buyerLang) };
  }

  // 4. Resolve effective buyer pricing (customer override > agent tier > standard retail)

  const hasCustomerCustomPrice =
    customerOverride?.customPriceUsd !== null &&
    customerOverride?.customPriceUsd !== undefined &&
    String(customerOverride.customPriceUsd).trim() !== '' &&
    new Decimal(customerOverride.customPriceUsd).gt(0);

  const hasAgentPrice =
    buyerPricingTier === 'agent' &&
    priceRule.agentPrice !== null &&
    priceRule.agentPrice !== undefined &&
    String(priceRule.agentPrice).trim() !== '' &&
    new Decimal(priceRule.agentPrice).gt(0);

  const effectivePricingRule = hasCustomerCustomPrice
    ? {
        pricingMode: 'manual' as const,
        retailPrice: new Decimal(customerOverride!.customPriceUsd!)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
          .toFixed(4),
        fixedMargin: '0.0000',
        percentMargin: '0.0000',
        paymentFeePercent: priceRule.paymentFeePercent,
        extraFixedCost: priceRule.extraFixedCost,
        promoPrice: null,
        promoEndsAt: null,
        bulkTiersJson: null,
        lockManualPrice: true,
      }
    : hasAgentPrice
      ? {
          pricingMode: 'manual' as const,
          retailPrice: new Decimal(priceRule.agentPrice!)
            .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
            .toFixed(4),
          fixedMargin: '0.0000',
          percentMargin: '0.0000',
          paymentFeePercent: priceRule.paymentFeePercent,
          extraFixedCost: priceRule.extraFixedCost,
          promoPrice: null,
          promoEndsAt: null,
          bulkTiersJson: null,
          lockManualPrice: true,
        }
      : {
          pricingMode: priceRule.pricingMode as 'manual' | 'fixed_margin' | 'percent_margin',
          retailPrice: priceRule.retailPrice,
          fixedMargin: priceRule.fixedMargin,
          percentMargin: priceRule.percentMargin,
          paymentFeePercent: priceRule.paymentFeePercent,
          extraFixedCost: priceRule.extraFixedCost,
          promoPrice: priceRule.promoPrice,
          promoEndsAt: priceRule.promoEndsAt,
          bulkTiersJson: priceRule.bulkTiersJson,
          lockManualPrice: priceRule.lockManualPrice,
        };

  const breakdown = computeProfitBreakdown(
    effectivePricingRule,
    primaryCandidate.wholesalePrice,
    qty
  );

  let couponRow = null;
  if (input.couponCode && input.couponCode.trim()) {
    const found = await db
      .select()
      .from(coupons)
      .where(eq(coupons.code, input.couponCode.trim().toUpperCase()))
      .limit(1);
    couponRow = found[0] || null;
  }

  const couponEval = applyCouponDiscount(breakdown.subtotalRetail, couponRow);
  if (input.couponCode && (!couponRow || !couponEval.valid)) {
    return {
      ok: false,
      customerErrorAr: couponEval.reasonAr || 'كوبون الخصم غير صالح.',
    };
  }

  let finalTotalRetail = couponEval.finalTotal;

  // 5. Create Internal Order Row (snapshots prices & user display currency/rate at purchase time!)
  const buyerCurrency: DisplayCurrency = normalizeDisplayCurrency(buyerRow?.preferredCurrency);
  const currencyCfg = await getCurrencyLocalDepositSettings();
  let buyerExchangeRate: string | null = null;
  if (buyerCurrency === 'YER') {
    const liveRate = await fetchLiveYerExchangeRate({ forceFresh: false, settingsOverride: currencyCfg });
    if (liveRate.ok && liveRate.rate) {
      buyerExchangeRate = liveRate.rate;
    }
  }

  // Reconcile sub-cent USD / YER display rounding dust before reserving so a buyer whose
  // displayed balance covers the displayed price is never falsely rejected by 0.004 USD drift.
  const buyerWallet = await ensureUserWallet(input.userId);
  const chargeEval = resolveEffectiveOrderChargeUsd({
    availableBalanceUsd: buyerWallet.availableBalance,
    quotedTotalUsd: finalTotalRetail,
    preferredCurrency: buyerCurrency,
    exchangeRate: buyerExchangeRate,
    roundingMode: currencyCfg.roundingMode,
  });
  if (chargeEval.sufficient) {
    finalTotalRetail = chargeEval.effectiveChargeUsd;
  }

  const finalNetProfit = new Decimal(finalTotalRetail)
    .minus(breakdown.totalWholesale)
    .minus(breakdown.paymentFee)
    .minus(breakdown.extraCost)
    .toFixed(4);

  const orderNumber = generateUniqueRef('RQM');
  const [createdOrder] = await db
    .insert(orders)
    .values({
      orderNumber,
      idempotencyKey: input.idempotencyKey,
      userId: input.userId,
      status: 'reserved',
      subtotalRetail: breakdown.subtotalRetail,
      discountAmount: couponEval.discountAmount,
      totalRetail: finalTotalRetail,
      totalWholesaleSnapshot: breakdown.totalWholesale,
      paymentFeeSnapshot: breakdown.paymentFee,
      netProfitSnapshot: finalNetProfit,
      couponCode: couponRow?.code || null,
      displayCurrency: buyerCurrency,
      displayExchangeRate: buyerExchangeRate,
    })
    .returning();

  await db.insert(orderItems).values({
    orderId: createdOrder.id,
    storeProductId: prod.id,
    productTitleSnapshot: prod.titleAr,
    quantity: qty,
    unitRetailSnapshot: breakdown.unitRetail,
    unitWholesaleSnapshot: breakdown.unitWholesale,
    warrantyLabelSnapshot: prod.warrantyLabelAr,
  });

  // 6. Reserve customer wallet balance atomically
  try {
    await reserveWalletBalance({
      userId: input.userId,
      amount: finalTotalRetail,
      orderId: createdOrder.id,
      referenceCode: `RSV-${createdOrder.id}`,
      note: `حجز مبلغ الطلب ${orderNumber}`,
    });
  } catch (err: any) {
    const localizedErr = sanitizeErrorForCustomer(err, buyerLang);
    await db
      .update(orders)
      .set({ status: 'failed', customerMessageAr: localizedErr, updatedAt: new Date() })
      .where(eq(orders.id, createdOrder.id));
    return { ok: false, customerErrorAr: localizedErr };
  }

  // 7. Execute Provider Fulfillment strictly in Admin Priority Order (#1 -> #2 -> #3)
  // Auto-failover ONLY on confirmed deterministic pre-fulfillment rejection (never on uncertain/pending!)
  const orderedCandidates = rankEligibleProviders(candidates, strategy, qty);

  let finalProviderResult: ProviderOrderResponse | null = null;
  let usedCandidate = primaryCandidate;

  for (let i = 0; i < orderedCandidates.length; i++) {
    const candidate = orderedCandidates[i];
    usedCandidate = candidate;
    const extRef = `${orderNumber}-P${candidate.providerId}-A${i + 1}`;

    const [provOrderRow] = await db
      .insert(providerOrders)
      .values({
        orderId: createdOrder.id,
        providerId: candidate.providerId,
        externalRef: extRef,
        status: 'initiated',
        uncertainState: false,
      })
      .returning();

    const attempt = await dispatchToProvider(candidate, qty, extRef, input.customerLabel);

    await db
      .update(providerOrders)
      .set({
        providerOrderId: attempt.providerOrderId || null,
        status: attempt.status,
        uncertainState: attempt.uncertainState,
        chargedWholesale: attempt.chargedTotal || new Decimal(candidate.wholesalePrice).times(qty).toFixed(4),
        rawErrorSanitized: attempt.rawError?.slice(0, 240) || null,
        updatedAt: new Date(),
      })
      .where(eq(providerOrders.id, provOrderRow.id));

    finalProviderResult = attempt;

    if (attempt.status === 'completed' || attempt.status === 'pending') {
      break;
    }

    // Auto-zero stale stock on deterministic unavailability (OUT_OF_STOCK, PRODUCT_NOT_FOUND, PRODUCT_UNAVAILABLE)
    // and deactivate offer if upstream reports PRODUCT_NOT_FOUND so backup providers take over cleanly!
    const failAction = classifyProviderAttemptFailureAction(attempt.deterministicFailureCode);
    if (failAction.zeroStock) {
      await db
        .update(providerProducts)
        .set({
          stockCount: 0,
          lastSyncedAt: new Date(),
          ...(failAction.deactivateOffer ? { isActiveAtProvider: false } : {}),
        })
        .where(eq(providerProducts.id, candidate.providerProductId));
    }
    if (failAction.notifyAdminMissingOffer) {
      await db.insert(notifications).values({
        audience: 'admin',
        eventType: 'provider_offer_missing',
        severity: 'warning',
        titleAr: `عرض معطل لدى ${candidate.providerName} (${prod.titleAr})`,
        bodyAr: `المزود أبلغ أن المعرف ${candidate.externalProductId} غير موجود أو غير مفعل عبر API (PRODUCT_NOT_FOUND) أثناء الطلب ${orderNumber}. تم تصفير مخزونه تلقائيًا وتجربة المزود الاحتياطي.`,
      });
    }

    // CRITICAL ANTI-DOUBLE-BUY RULE: Never switch to backup if primary outcome is uncertain!
    if (!canSafelyFailoverToBackup(attempt)) {
      break;
    }
  }

  // 8. Finalize Order & Financial Settlement
  if (finalProviderResult?.status === 'completed') {
    await captureReservedWalletBalance({
      userId: input.userId,
      amount: finalTotalRetail,
      orderId: createdOrder.id,
      referenceCode: `CAP-${createdOrder.id}`,
      note: `إتمام خصم الطلب ${orderNumber}`,
    });

    if (couponRow) {
      await db
        .update(coupons)
        .set({ usedCount: couponRow.usedCount + 1 })
        .where(eq(coupons.id, couponRow.id));
    }

    // Decrement cached provider stock & balance
    const nextStock = Math.max(0, usedCandidate.stockCount - qty);
    await db
      .update(providerProducts)
      .set({ stockCount: nextStock })
      .where(eq(providerProducts.id, usedCandidate.providerProductId));

    const chargedW = finalProviderResult.chargedTotal || new Decimal(usedCandidate.wholesalePrice).times(qty).toFixed(4);
    const actualNetProfit = new Decimal(finalTotalRetail)
      .minus(chargedW)
      .minus(breakdown.paymentFee)
      .minus(breakdown.extraCost)
      .toFixed(4);
    const nextProvBalance = Decimal.max(
      0,
      new Decimal(usedCandidate.providerBalance).minus(chargedW)
    ).toFixed(4);
    await db
      .update(providers)
      .set({ cachedBalance: nextProvBalance })
      .where(eq(providers.id, usedCandidate.providerId));

    const deliveredItems =
      finalProviderResult.deliveredItems && finalProviderResult.deliveredItems.length > 0
        ? finalProviderResult.deliveredItems
        : [`RQM-KEY-${orderNumber.slice(-8)}`];

    const deliveryMessageAr = buildCustomerDeliveryMessage({
      storeName: storeProfile.storeName || 'متجر رَقْم',
      orderNumber,
      productTitleAr: prod.titleAr,
      quantity: qty,
      totalRetail: finalTotalRetail,
      deliveredItems,
      instructionsAr: prod.deliveryInstructionsAr || undefined,
      warrantyLabelAr: prod.warrantyLabelAr,
      supportHandle: storeProfile.supportHandle,
      lang: buyerRow?.languageCode === 'en' ? 'en' : 'ar',
      currency: buyerCurrency,
      exchangeRate: buyerExchangeRate,
      roundingMode: currencyCfg.roundingMode,
    });

    await db.insert(deliveries).values({
      orderId: createdOrder.id,
      ownerUserId: input.userId,
      deliveryType: prod.deliveryType,
      encryptedPayload: encryptSecret(JSON.stringify(deliveredItems)),
      customerInstructionsAr: prod.deliveryInstructionsAr || '',
      warrantyNoticeAr: prod.warrantyLabelAr,
    });

    await db
      .update(orders)
      .set({
        status: 'completed',
        totalWholesaleSnapshot: chargedW,
        netProfitSnapshot: actualNetProfit,
        customerMessageAr: deliveryMessageAr,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, createdOrder.id));

    await db.insert(notifications).values({
      audience: 'admin',
      eventType: 'order_success',
      severity: 'info',
      titleAr: `طلب مكتمل ${orderNumber}`,
      bodyAr: `تم تسليم ${prod.titleAr} (×${qty}) بصافي ربح $${new Decimal(actualNetProfit).toFixed(2)}.`,
    });

    // Atomic & idempotent referral commission credit for referred buyer (never blocks order delivery)
    try {
      await awardReferralCommissionForOrder({
        orderId: createdOrder.id,
        notifyTelegramUser: orderTelegramNotifier,
      });
    } catch (refErr) {
      console.error('Referral commission award error (non-fatal to delivery):', refErr);
    }

    return {
      ok: true,
      orderNumber,
      status: 'completed',
      totalRetail: new Decimal(finalTotalRetail).toFixed(2),
      deliveredItems,
      deliveryMessageAr,
    };
  }

  // Pending / Uncertain State -> Hold reserved funds, NEVER auto-failover or double-buy!
  if (finalProviderResult?.status === 'pending' || finalProviderResult?.uncertainState) {
    const newStatus = finalProviderResult.uncertainState ? 'manual_reconciliation' : 'pending_delivery';
    const customerMsg = 'تم استلام طلبك وجارٍ تجهيز التسليم حاليًا، سيصلك إشعار فور الجاهزية.';

    await db
      .update(orders)
      .set({ status: newStatus, customerMessageAr: customerMsg, updatedAt: new Date() })
      .where(eq(orders.id, createdOrder.id));

    await db.insert(notifications).values({
      audience: 'admin',
      eventType: 'stale_pending_order',
      severity: 'critical',
      titleAr: `طلب بحاجة للمتابعة ${orderNumber}`,
      bodyAr: finalProviderResult.uncertainState
        ? 'انقطع الاتصال بعد إرسال الطلب للمزود — تم إيقاف الإعادة التلقائية لمنع الشراء المكرر.'
        : 'الطلب قيد التجهيز عند المزود وسيتم تحديثه عند الاستلام.',
    });

    return {
      ok: true,
      orderNumber,
      status: newStatus,
      totalRetail: new Decimal(finalTotalRetail).toFixed(2),
      deliveryMessageAr: customerMsg,
    };
  }

  // Confirmed deterministic failure -> Refund customer wallet immediately!
  await refundReservedWalletBalance({
    userId: input.userId,
    amount: finalTotalRetail,
    orderId: createdOrder.id,
    referenceCode: `RFD-${createdOrder.id}`,
    note: `استرجاع تلقائي لفشل تنفيذ الطلب ${orderNumber}`,
  });

  const failureReasonInput =
    finalProviderResult?.deterministicFailureCode || finalProviderResult?.rawError || 'PROVIDER_ERROR';
  const safeErr = sanitizeErrorForCustomer(failureReasonInput, buyerLang);
  await db
    .update(orders)
    .set({ status: 'refunded', customerMessageAr: safeErr, updatedAt: new Date() })
    .where(eq(orders.id, createdOrder.id));

  await db.insert(notifications).values({
    audience: 'admin',
    eventType: 'order_failed',
    severity: 'critical',
    titleAr: `فشل تنفيذ الطلب ${orderNumber} وتمت إعادة الرصيد`,
    bodyAr: `المزود: ${usedCandidate.providerName} | المعرف: ${usedCandidate.externalProductId} | السبب الداخلي: ${finalProviderResult?.deterministicFailureCode || finalProviderResult?.rawError || 'غير معروف'}`,
  });

  await db.insert(auditLogs).values({
    actorUserId: input.userId,
    actorRole: 'system',
    action: 'ORDER_FAILED_REFUNDED',
    entityType: 'order',
    entityId: String(createdOrder.id),
    detailsJson: {
      orderNumber,
      providerCode: usedCandidate.providerCode,
      externalProductId: usedCandidate.externalProductId,
      code: finalProviderResult?.deterministicFailureCode,
    },
  });

  return { ok: false, orderNumber, status: 'refunded', customerErrorAr: safeErr };
}

async function dispatchToProvider(
  candidate: ProviderOfferCandidate,
  quantity: number,
  externalRef: string,
  customerLabel?: string
): Promise<ProviderOrderResponse> {
  // Check if a real encrypted API key is configured for this provider
  const creds = await db
    .select()
    .from(providerCredentials)
    .where(eq(providerCredentials.providerId, candidate.providerId))
    .limit(1);

  const [provRow] = await db
    .select()
    .from(providers)
    .where(eq(providers.id, candidate.providerId))
    .limit(1);

  const adapter = provRow
    ? resolveProviderAdapter({
        code: provRow.code,
        name: provRow.name,
        baseUrl: provRow.baseUrl,
        docsUrl: provRow.docsUrl,
        authType: provRow.authType,
        authHeader: provRow.authHeader,
        rateLimitPerMin: provRow.rateLimitPerMin,
      })
    : null;

  if (creds.length > 0 && adapter) {
    const apiKey = decryptSecret(creds[0].encryptedApiKey);
    return adapter.placeOrder(apiKey, {
      externalProductId: candidate.externalProductId,
      externalVariantId: candidate.externalVariantId,
      quantity,
      idempotencyRef: externalRef,
      expectedUnitPrice: candidate.wholesalePrice,
      customerLabel,
    });
  }

  // Sandbox Fulfillment Mode (when no real provider API key has been entered yet — zero real money spent!)
  const items = Array.from({ length: quantity }, (_, idx) => {
    const token = generateUniqueRef('ACT').slice(-10);
    if (candidate.deliveryType === 'link') {
      return `https://activate.raqm.store/redeem/${token}-${idx + 1}`;
    }
    if (candidate.deliveryType === 'account') {
      return `user_${token.toLowerCase()}@raqm-pass.test | Pass: Rqm#${token.slice(-6)}`;
    }
    return `RQM-${token}-${idx + 1}`;
  });

  return {
    status: 'completed',
    uncertainState: false,
    providerOrderId: `SBX-${externalRef}`,
    deliveredItems: items,
    chargedTotal: new Decimal(candidate.wholesalePrice).times(quantity).toFixed(4),
  };
}

export async function getCustomerOrdersWithSanitizedDeliveries(userId: number) {
  const userOrders = await db
    .select()
    .from(orders)
    .where(eq(orders.userId, userId))
    .orderBy(desc(orders.createdAt))
    .limit(30);

  if (userOrders.length === 0) return [];
  const orderIds = userOrders.map((o) => o.id);

  const itemsRows = await db.select().from(orderItems).where(inArray(orderItems.orderId, orderIds));
  const deliveryRows = await db
    .select()
    .from(deliveries)
    .where(and(inArray(deliveries.orderId, orderIds), eq(deliveries.ownerUserId, userId)));

  return userOrders.map((o) => {
    const items = itemsRows.filter((it) => it.orderId === o.id);
    const deliv = deliveryRows.find((d) => d.orderId === o.id);
    let decryptedItems: string[] = [];
    if (deliv) {
      try {
        decryptedItems = JSON.parse(decryptSecret(deliv.encryptedPayload));
      } catch {
        decryptedItems = [];
      }
    }
    // STRICT SANITIZATION: Never include wholesale, netProfit, or provider info!
    return {
      orderNumber: o.orderNumber,
      status: o.status,
      totalRetail: new Decimal(o.totalRetail).toFixed(2),
      discountAmount: new Decimal(o.discountAmount).toFixed(2),
      createdAt: o.createdAt,
      items: items.map((it) => ({
        titleAr: it.productTitleSnapshot,
        quantity: it.quantity,
        unitRetail: new Decimal(it.unitRetailSnapshot).toFixed(2),
        warrantyLabelAr: it.warrantyLabelSnapshot,
      })),
      delivery: deliv
        ? {
            deliveryType: deliv.deliveryType,
            payloadItems: decryptedItems,
            instructionsAr: deliv.customerInstructionsAr,
            warrantyNoticeAr: deliv.warrantyNoticeAr,
          }
        : null,
    };
  });
}
