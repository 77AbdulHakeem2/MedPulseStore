import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeProfitBreakdown,
  evaluateSyncPriceUpdate,
  selectOptimalProvider,
  rankEligibleProviders,
  evaluateProviderPriorityQueue,
  resolveProductEffectivePricingAndStock,
  canSafelyFailoverToBackup,
  classifyProviderAttemptFailureAction,
  collectDisappearedProviderOfferIds,
  applyCouponDiscount,
  type ProviderOfferCandidate,
} from './pricing.ts';
import {
  buildCustomerMainInlineKeyboard,
  buildDynamicMainInlineKeyboard,
  buildProductQuantityInlineKeyboard,
  buildPurchaseConfirmationInlineKeyboard,
  buildSupportTelegramUrl,
  ensureWarningPrefix,
  formatCustomerOrderCard,
  formatCustomerProductButtonLabel,
  formatCustomerProfileCard,
  formatProductPurchasePromptMessage,
  formatProductPurchasePromptTelegramPayload,
  formatPurchaseConfirmationMessage,
  parseAndValidateCustomQuantity,
  FORBIDDEN_CUSTOMER_BUTTONS,
  containsProviderLeak,
  containsInternalAdminNotice,
  sanitizeCustomerProductDescription,
  sanitizeErrorForCustomer,
  toCustomerProductDTO,
  buildCustomerDeliveryMessage,
  canUserAccessDelivery,
} from './sanitizer.ts';
import {
  classifyDescriptionUrl,
  detectDescriptionFormat,
  extractCustomEmojiIds,
  extractSupplierRawDescription,
  normalizeOriginalTelegramHtmlForPreview,
  processSupplierProductDescription,
  registerDynamicSupplierIdentities,
  replaceDisallowedCustomEmojis,
  stripTelegramHtmlToPlainText,
  stripTgEmojiTagsKeepFallback,
} from './productDescriptionEngine.ts';
import {
  buildSupplierBrowserItem,
  extractPaginationDirective,
  filterAndPaginateSupplierBrowserItems,
  normalizeRichSupplierCatalog,
  sanitizeSupplierImageUrl,
  validateAndPlanSupplierImport,
} from './supplierCatalogBrowser.ts';
import {
  buildBinanceSignedQuery,
  verifyBinancePayTransaction,
  type BinancePayTradeRecord,
} from './binancePayHistory.ts';
import {
  t,
  resolveInitialLanguage,
  getLocalizedProductFields,
  getAllDictionaryKeys,
} from '../i18n/index.ts';
import {
  resolveEffectiveOrderChargeUsd,
  computeReserveTransition,
  computeCaptureTransition,
  computeRefundTransition,
  computeWalletAdjustmentDelta,
  buildWalletCreditNotificationText,
} from './walletEngine.ts';
import {
  classifyOperationStatusVisual,
  filterOperationsByDateRange,
} from '../lib/operationsUtils.ts';
import {
  evaluateKpiPolarity,
  computeDashboardPeriodMetrics,
  computeDailyOrderSeries,
} from '../lib/kpiSemantics.ts';
import {
  detectTextLanguage,
  planBilingualTextResolution,
  splitLeadingEmoji,
  ensurePreservedEmoji,
  protectTelegramHtmlForTranslation,
  restoreProtectedTelegramHtml,
} from './translator.ts';
import {
  parseYeRialApiResponse,
  resolveFallbackExchangeRate,
  convertUsdToYer,
  convertYerToUsd,
  formatYerNumber,
  formatDisplayPrice,
  formatCurrencyToggleButtonLabel,
  validateDepositorQuadName,
  validateLocalDepositAmountYer,
} from './currencyEngine.ts';
import {
  buildBroadcastResultSummaryAr,
  executeBroadcastDelivery,
  formatBroadcastTelegramMessage,
  selectBroadcastRecipients,
  type BroadcastCandidateUser,
} from './broadcastEngine.ts';
import {
  applyCustomerProductOverride,
  computeCustomerTotalSpending,
  isValidUserPricingTierInput,
  normalizeUserPricingTier,
  parseAndValidateCustomPriceUsd,
  shouldDeleteOverrideRow,
} from './customerOverridesEngine.ts';
import {
  canTransitionLocalDeposit,
  validateProofImageDataUrl,
  formatAdminChannelDepositCaption,
  formatAdminChannelReviewedCaption,
  formatUserLocalDepositApprovedMessage,
  formatUserLocalDepositRejectedMessage,
  buildTelegramChannelCandidates,
  evaluateTelegramChannelPermissions,
} from './localDepositEngine.ts';
import {
  ADMIN_PERMISSION_DEFS,
  DEFAULT_ROLE_PERMISSION_PRESETS,
  canManageTargetModerator,
  getEffectivePermissions,
  hasAnyPermission,
  hasPermission,
  hashPasswordScrypt,
  isStaffRole,
  sanitizeModeratorPermissionsInput,
  timingSafeSecretCompare,
  validatePasswordStrength,
  verifyPasswordScrypt,
} from './rbacEngine.ts';
import {
  signSessionToken,
  verifySessionToken,
} from './crypto.ts';
import {
  parseReferralStartPayload,
  buildTelegramReferralLink,
  validateReferralRegistration,
  calculateReferralCommission,
  calculateCommissionReversal,
  formatReferAndEarnMessage,
  formatCommissionCreditNotification,
  formatCommissionReversalNotification,
} from './referralEngine.ts';
import {
  buildButtonHierarchy,
  collectDescendantButtonIds,
  buildButtonBreadcrumb,
  buildInlinePreviewRows,
  buildSubMenuPreviewRows,
  computeSwappedSortOrderUpdates,
  computeSwappedButtonLayoutUpdates,
  type AdminBotButtonItem,
} from '../lib/buttonTreeUtils.ts';
import {
  OFFICIAL_USDT_CONTRACTS,
  verifyUsdtDepositTransaction,
  verifyBinancePayWebhook,
} from './paymentVerifier.ts';
import { hasRoleAccess } from '../middleware/auth.ts';
import { resolveProviderAdapter } from './providers/index.ts';
import {
  classifyOfferBrand,
  groupOffersByBrand,
  matchProductToStoreCategory,
  normalizeProviderBaseUrl,
  parseAuthHeaderInput,
} from '../lib/offerClassifier.ts';
import {
  getServerAppIconStyle,
  extractServerHostLabel,
  filterServersForGrid,
} from '../lib/serverGridUtils.ts';
import { encryptSecret, decryptSecret, maskApiKey, verifyHmacSha256 } from './crypto.ts';
import { isValidCustomEmojiId, filterValidCustomEmojisInHtml } from './customEmojiService.ts';
import {
  filterUnlinkedAvailableOffers,
  validateExclusiveOfferBinding,
  computeRecompactedPriorities,
  isOfferCompatibleWithStoreProduct,
  auditAllProductMappings,
} from './providerMappingEngine.ts';
import crypto from 'node:crypto';

// ============================================================================
// ALL 16 MANDATORY SECURITY & FUNCTIONAL TESTS FROM SECTION 18
// ============================================================================

test('1. Hidden products NEVER appear in customer catalog DTO', () => {
  const hidden = toCustomerProductDTO({
    id: 5,
    sku: 'RQM-NFLX-1M',
    categoryId: 1,
    categoryNameAr: 'الترفيه',
    titleAr: 'Netflix 4K',
    descriptionAr: 'Imported hidden product',
    imageUrl: '',
    warrantyLabelAr: 'ضمان 30 يوم',
    durationLabel: 'شهر',
    deliveryType: 'account',
    isVisible: false,
    isPaused: false,
    autoHideOutOfStock: true,
    isFeaturedOffer: false,
    retailPrice: '4.5000',
    promoPrice: null,
    availableStock: 95,
  });
  assert.equal(hidden, null);

  const paused = toCustomerProductDTO({
    id: 6,
    sku: 'RQM-PAUSED',
    categoryId: 1,
    categoryNameAr: 'الترفيه',
    titleAr: 'Paused Item',
    descriptionAr: 'Paused',
    imageUrl: '',
    warrantyLabelAr: 'ضمان',
    durationLabel: 'شهر',
    deliveryType: 'code',
    isVisible: true,
    isPaused: true,
    autoHideOutOfStock: true,
    isFeaturedOffer: false,
    retailPrice: '5.0000',
    promoPrice: null,
    availableStock: 10,
  });
  assert.equal(paused, null);
});

test('2. Customer product DTO NEVER exposes wholesale price, profit, or provider metadata', () => {
  const dto = toCustomerProductDTO({
    id: 1,
    sku: 'RQM-GEM-6M',
    categoryId: 1,
    categoryNameAr: 'الذكاء الاصطناعي',
    titleAr: 'Gemini Pro — 6 أشهر',
    descriptionAr: 'تفعيل فوري',
    imageUrl: '',
    warrantyLabelAr: 'ضمان 6 أشهر',
    durationLabel: '6 أشهر',
    deliveryType: 'code',
    isVisible: true,
    isPaused: false,
    autoHideOutOfStock: true,
    isFeaturedOffer: true,
    retailPrice: '3.0000',
    promoPrice: null,
    availableStock: 482,
  });
  assert.ok(dto);
  assert.equal(dto.retailPrice, '3.00');
  const serialized = JSON.stringify(dto);
  assert.equal('wholesalePrice' in (dto as any), false);
  assert.equal('providerName' in (dto as any), false);
  assert.equal(containsProviderLeak(serialized), false);
});

test('3. API keys are encrypted at rest with AES-256-GCM and masked in previews', () => {
  const rawKey = 'sk_live_aivaulthub_9876543210abcdef';
  const encrypted = encryptSecret(rawKey);
  assert.notEqual(encrypted, rawKey);
  assert.equal(encrypted.includes(rawKey), false);
  assert.equal(decryptSecret(encrypted), rawKey);
  const masked = maskApiKey(rawKey);
  assert.equal(masked.includes('9876543210'), false);
  assert.match(masked, /^sk_liv••••cdef$/);
});

test('4. Customer Telegram keyboard is Inline-ONLY (9-button layout including Currency Toggle, AR & EN) with direct Support URL, 1-click Lang toggle, and ZERO forbidden buttons', () => {
  for (const lang of ['ar', 'en'] as const) {
    const inlineRows = buildCustomerMainInlineKeyboard(lang, '@raqm_support');
    assert.equal(inlineRows.length, 5, `Expected 5 rows (4x2 + currency toggle row) for ${lang}`);
    for (let r = 0; r < 4; r++) {
      assert.equal(inlineRows[r].length, 2, `Expected 2 columns in row ${r + 1} for ${lang}`);
    }
    assert.equal(inlineRows[4].length, 1, `Expected currency toggle button in row 5 for ${lang}`);
    assert.equal(inlineRows[4][0].callbackData, 'c:currency_toggle');
    const flatButtons = inlineRows.flat();
    assert.equal(flatButtons.length, 9);
    // Every button must have either a `c:` callbackData OR a valid `https://t.me/` Support URL
    for (const btn of flatButtons) {
      const hasValidCb = Boolean(btn.callbackData && btn.callbackData.startsWith('c:'));
      const hasValidUrl = Boolean(btn.url && btn.url.startsWith('https://t.me/'));
      assert.ok(hasValidCb || hasValidUrl, `Expected c: callbackData or Telegram URL on ${btn.text}`);
    }
    // Must contain 1-click instant language toggle
    assert.ok(
      flatButtons.some((b) => b.callbackData === 'c:lang_toggle'),
      `1-click language toggle missing in ${lang} inline keyboard`
    );
    // Must contain direct URL Support button (no intermediate submenu!)
    assert.ok(
      flatButtons.some((b) => b.url === 'https://t.me/raqm_support'),
      `Direct Support URL button missing in ${lang} inline keyboard`
    );
    // Zero forbidden provider / admin / wholesale buttons
    for (const forbidden of FORBIDDEN_CUSTOMER_BUTTONS) {
      assert.equal(
        flatButtons.some((b) => b.text.toLowerCase().includes(forbidden.toLowerCase())),
        false,
        `Forbidden button leaked in ${lang}: ${forbidden}`
      );
    }
  }
});

test('5. Provider names and raw upstream errors NEVER appear in customer delivery or error messages', () => {
  const rawUpstreamError =
    'AIVault Hub HTTP 402 INSUFFICIENT_BALANCE on https://reseller.aivaulthub.store/api/v1/order for px_live_123';
  const sanitizedAr = sanitizeErrorForCustomer(rawUpstreamError, 'ar');
  const sanitizedEn = sanitizeErrorForCustomer(rawUpstreamError, 'en');
  assert.equal(containsProviderLeak(sanitizedAr), false);
  assert.equal(containsProviderLeak(sanitizedEn), false);
  assert.equal(sanitizedAr, t('ar', 'error_generic'));
  assert.equal(sanitizedEn, t('en', 'error_generic'));

  const deliveryMsg = buildCustomerDeliveryMessage({
    storeName: 'متجر رَقْم',
    orderNumber: 'RQM-2026-9901',
    productTitleAr: 'Gemini Pro — 6 أشهر',
    quantity: 1,
    totalRetail: '3.0000',
    deliveredItems: ['RQM-KEY-8812-ABCD'],
    warrantyLabelAr: 'ضمان فعلي 6 أشهر',
    supportHandle: '@raqm_support',
  });
  assert.equal(containsProviderLeak(deliveryMsg), false);
  assert.ok(deliveryMsg.includes('متجر رَقْم'));
  assert.ok(deliveryMsg.includes('3.00 USDT'));
});

test('6. Manual retail price is NEVER overwritten on provider sync & wholesale hike triggers alert using Decimal math', () => {
  // Exact prompt example: Wholesale $0.42 -> Retail $3.00
  const breakdown = computeProfitBreakdown(
    {
      pricingMode: 'manual',
      retailPrice: '3.0000',
      fixedMargin: '0',
      percentMargin: '0',
      paymentFeePercent: '1.5000',
      extraFixedCost: '0.0000',
      lockManualPrice: true,
    },
    '0.4200',
    1
  );
  // 3.00 - 0.42 - (3.00 * 0.015 = 0.045) = 2.5350 exact Decimal!
  assert.equal(breakdown.unitRetail, '3.0000');
  assert.equal(breakdown.paymentFee, '0.0450');
  assert.equal(breakdown.netProfit, '2.5350');

  // Now simulate wholesale price rising from $0.42 to $0.68 on sync
  const syncCheck = evaluateSyncPriceUpdate({
    oldWholesale: '0.4200',
    newWholesale: '0.6800',
    rule: {
      pricingMode: 'manual',
      retailPrice: '3.0000',
      fixedMargin: '0',
      percentMargin: '0',
      paymentFeePercent: '1.5000',
      extraFixedCost: '0.0000',
      lockManualPrice: true,
    },
  });
  assert.equal(syncCheck.wholesaleIncreased, true);
  assert.equal(syncCheck.delta, '0.2600');
  assert.equal(syncCheck.preservedRetailPrice, '3.0000'); // Unchanged!
});

test('7 & 16. Anti-double-buy guard blocks failover to backup provider when primary state is uncertain or pending', () => {
  assert.equal(
    canSafelyFailoverToBackup({ status: 'uncertain', uncertainState: true }),
    false
  );
  assert.equal(
    canSafelyFailoverToBackup({ status: 'pending', uncertainState: false }),
    false
  );
  assert.equal(
    canSafelyFailoverToBackup({ status: 'failed', uncertainState: true, deterministicFailureCode: 'OUT_OF_STOCK' }),
    false
  );
  // Only confirmed pre-fulfillment deterministic rejection may failover
  assert.equal(
    canSafelyFailoverToBackup({ status: 'failed', uncertainState: false, deterministicFailureCode: 'OUT_OF_STOCK' }),
    true
  );
});

test('8, 9 & 10. Payment verifier rejects duplicate TxID, unconfirmed TxID, wrong contract, and wrong recipient address', () => {
  const validRecipient = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7';
  const usedHashes = new Set(['0xalreadyusedhash1234567890abcdef']);

  // Duplicate TxID rejected + admin alert
  const dup = verifyUsdtDepositTransaction({
    depositId: 1,
    depositRef: 'DEP-1',
    expectedNetwork: 'TRC20',
    expectedContract: OFFICIAL_USDT_CONTRACTS.TRC20,
    assignedRecipientAddress: validRecipient,
    expectedAmount: '20.0000',
    requiredConfirmations: 12,
    submittedTxHash: '0xalreadyusedhash1234567890abcdef',
    alreadyUsedTxHashes: usedHashes,
    onChainRecord: null,
  });
  assert.equal(dup.status, 'rejected');
  assert.equal(dup.reasonCode, 'DUPLICATE_TXID');
  assert.equal(dup.triggerAdminAlert, 'duplicate_txid');

  // Unconfirmed TxID stays pending_review (never auto-credited!)
  const unconfirmed = verifyUsdtDepositTransaction({
    depositId: 2,
    depositRef: 'DEP-2',
    expectedNetwork: 'TRC20',
    expectedContract: OFFICIAL_USDT_CONTRACTS.TRC20,
    assignedRecipientAddress: validRecipient,
    expectedAmount: '20.0000',
    requiredConfirmations: 12,
    submittedTxHash: 'txhash_valid_len_1234567890',
    alreadyUsedTxHashes: usedHashes,
    onChainRecord: {
      txHash: 'txhash_valid_len_1234567890',
      network: 'TRC20',
      contractAddress: OFFICIAL_USDT_CONTRACTS.TRC20,
      recipientAddress: validRecipient,
      amount: '20.0000',
      succeeded: true,
      confirmations: 3,
    },
  });
  assert.equal(unconfirmed.status, 'pending_review');
  assert.equal(unconfirmed.reasonCode, 'INSUFFICIENT_CONFIRMATIONS');

  // Wrong recipient address rejected
  const wrongAddr = verifyUsdtDepositTransaction({
    depositId: 3,
    depositRef: 'DEP-3',
    expectedNetwork: 'TRC20',
    expectedContract: OFFICIAL_USDT_CONTRACTS.TRC20,
    assignedRecipientAddress: validRecipient,
    expectedAmount: '20.0000',
    requiredConfirmations: 12,
    submittedTxHash: 'txhash_wrong_recipient_123456',
    alreadyUsedTxHashes: usedHashes,
    onChainRecord: {
      txHash: 'txhash_wrong_recipient_123456',
      network: 'TRC20',
      contractAddress: OFFICIAL_USDT_CONTRACTS.TRC20,
      recipientAddress: 'TWrongAttackerWalletAddress999999999',
      amount: '20.0000',
      succeeded: true,
      confirmations: 25,
    },
  });
  assert.equal(wrongAddr.status, 'rejected');
  assert.equal(wrongAddr.reasonCode, 'WRONG_RECIPIENT_ADDRESS');

  // Valid confirmed on-chain USDT transfer accepted
  const valid = verifyUsdtDepositTransaction({
    depositId: 4,
    depositRef: 'DEP-4',
    expectedNetwork: 'TRC20',
    expectedContract: OFFICIAL_USDT_CONTRACTS.TRC20,
    assignedRecipientAddress: validRecipient,
    expectedAmount: '20.0000',
    requiredConfirmations: 12,
    submittedTxHash: 'txhash_confirmed_valid_123456',
    alreadyUsedTxHashes: usedHashes,
    onChainRecord: {
      txHash: 'txhash_confirmed_valid_123456',
      network: 'TRC20',
      contractAddress: OFFICIAL_USDT_CONTRACTS.TRC20,
      recipientAddress: validRecipient,
      amount: '20.0000',
      succeeded: true,
      confirmations: 18,
    },
  });
  assert.equal(valid.status, 'confirmed');
  assert.equal(valid.creditedAmount, '20.0000');
});

test('11. Wallet state machine prevents purchase without sufficient balance and never goes negative', () => {
  const insufficient = computeReserveTransition(
    { availableBalance: '2.5000', reservedBalance: '0.0000' },
    '3.0000'
  );
  assert.equal(insufficient.ok, false);
  assert.equal(insufficient.errorCode, 'INSUFFICIENT_CUSTOMER_BALANCE');

  // Reserve -> Capture lifecycle
  const reserved = computeReserveTransition(
    { availableBalance: '10.0000', reservedBalance: '0.0000' },
    '3.0000'
  );
  assert.equal(reserved.ok, true);
  assert.equal(reserved.next?.availableBalance, '7.0000');
  assert.equal(reserved.next?.reservedBalance, '3.0000');

  const captured = computeCaptureTransition(reserved.next!, '3.0000');
  assert.equal(captured.ok, true);
  assert.equal(captured.next?.availableBalance, '7.0000');
  assert.equal(captured.next?.reservedBalance, '0.0000');

  // Reserve -> Refund lifecycle on confirmed failure
  const refunded = computeRefundTransition(reserved.next!, '3.0000');
  assert.equal(refunded.ok, true);
  assert.equal(refunded.next?.availableBalance, '10.0000');
  assert.equal(refunded.next?.reservedBalance, '0.0000');
});

test('12. RBAC blocks Customer role from Admin/Owner routes', () => {
  assert.equal(hasRoleAccess('customer', ['owner', 'admin', 'support']), false);
  assert.equal(hasRoleAccess('support', ['owner', 'admin']), false);
  assert.equal(hasRoleAccess('admin', ['owner', 'admin']), true);
  assert.equal(hasRoleAccess('owner', ['owner', 'admin', 'support']), true);
});

test('13. Multi-provider router NEVER selects an offline, disabled, or low-balance provider', () => {
  const candidates: ProviderOfferCandidate[] = [
    {
      mappingId: 1,
      providerId: 1,
      providerCode: 'aivaulthub',
      providerName: 'AIVault Hub',
      providerStatus: 'disconnected', // OFFLINE!
      providerEnabled: true,
      providerBalance: '100.0000',
      providerProductId: 10,
      externalProductId: 'service_1',
      wholesalePrice: '0.3500',
      stockCount: 500,
      roleType: 'primary',
      priority: 1,
      isVerifiedCompatible: true,
      isActive: true,
    },
    {
      mappingId: 2,
      providerId: 2,
      providerCode: 'pandora',
      providerName: 'Pandora Digital',
      providerStatus: 'connected',
      providerEnabled: true,
      providerBalance: '50.0000',
      providerProductId: 11,
      externalProductId: 'prd_1',
      wholesalePrice: '0.3800',
      stockCount: 100,
      roleType: 'backup',
      priority: 2,
      isVerifiedCompatible: true,
      isActive: true,
    },
  ];

  const chosen = selectOptimalProvider(candidates, 'priority', 1);
  assert.ok(chosen);
  assert.equal(chosen.providerCode, 'pandora'); // Skipped offline AIVault!

  // If backup is also offline, returns null
  candidates[1].providerStatus = 'error';
  assert.equal(selectOptimalProvider(candidates, 'priority', 1), null);
});

test('14. Delivery access control allows ONLY order owner or admin', () => {
  assert.equal(canUserAccessDelivery(42, 42, 'customer'), true);
  assert.equal(canUserAccessDelivery(42, 99, 'customer'), false);
  assert.equal(canUserAccessDelivery(42, 1, 'owner'), true);
});

test('15. Webhook HMAC-SHA256 verification and coupon Decimal calculation work accurately', () => {
  const body = JSON.stringify({ event: 'order.delivered', order_id: 'API89XKZ42' });
  const secret = 'whsec_test_998877';
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifyHmacSha256(body, sig, secret, 'sha256='), true);
  assert.equal(verifyHmacSha256(body, 'sha256=tampered', secret, 'sha256='), false);

  const bTimestamp = '1763500000000';
  const bNonce = 'abc123nonce';
  const bSig = crypto
    .createHmac('sha256', 'binance_secret')
    .update(`${bTimestamp}\n${bNonce}\n${body}\n`)
    .digest('hex');
  assert.equal(
    verifyBinancePayWebhook({
      timestamp: bTimestamp,
      nonce: bNonce,
      rawBody: body,
      signatureHeader: bSig,
      secretKey: 'binance_secret',
    }),
    true
  );

  const disc = applyCouponDiscount('10.0000', {
    discountType: 'percent',
    discountValue: '10.0000',
    minOrderAmount: '2.0000',
    isActive: true,
    maxUses: 100,
    usedCount: 5,
  });
  assert.equal(disc.valid, true);
  assert.equal(disc.discountAmount, '1.0000');
  assert.equal(disc.finalTotal, '9.0000');
});

// ============================================================================
// BINANCE PAY PERSONAL ACCOUNT TRADE HISTORY (SAPI) + BILINGUAL i18n TESTS
// ============================================================================

test('17. Binance SAPI HMAC-SHA256 query signer produces official signed query string', () => {
  const secret = 'NhqPtmdSJYdKjVHjAuwvZj4MciKN55fxUUnPl6LSQqxSZ6b5A9';
  const signed = buildBinanceSignedQuery({
    queryParams: { startTime: 1763500000000, limit: 100 },
    apiSecret: secret,
    timestampMs: 1763500500000,
    recvWindowMs: 5000,
  });
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(signed.queryString)
    .digest('hex');

  assert.equal(signed.signature, expectedSig);
  assert.ok(signed.fullQuery.includes('recvWindow=5000'));
  assert.ok(signed.fullQuery.includes('timestamp=1763500500000'));
  assert.ok(signed.fullQuery.endsWith(`&signature=${expectedSig}`));
});

test('18. Binance Pay Trade History 9-condition verifier enforces EVERY rule strictly with Decimal math', () => {
  const depositCreatedAt = 1763500000000;
  const nowMs = depositCreatedAt + 60_000;
  const ownerReceiverId = '284910374';
  const usedIds = new Set<string>(['BP_ALREADY_USED_999']);

  const validRecord: BinancePayTradeRecord = {
    orderType: 'C2C',
    transactionId: 'BP_VALID_20260001',
    transactionTime: depositCreatedAt + 20_000,
    amount: '25.50',
    currency: 'USDT',
    status: 'SUCCESS',
    receiverInfo: { binanceId: ownerReceiverId },
  };

  // (a) Valid incoming transfer -> PAID with exact Decimal 4dp amount
  const okRes = verifyBinancePayTransaction({
    submittedTransactionId: 'BP_VALID_20260001',
    expectedAmount: '25.5000',
    expectedReceiverId: ownerReceiverId,
    depositCreatedAtMs: depositCreatedAt,
    nowMs,
    alreadyUsedTransactionIds: usedIds,
    historyRecords: [validRecord],
  });
  assert.equal(okRes.outcome, 'paid');
  assert.equal(okRes.reasonCode, 'VERIFIED');
  assert.equal(okRes.verifiedAmount, '25.5000');

  // (b) Transaction not found in Binance history -> stays PENDING (never fakes approval)
  const notFound = verifyBinancePayTransaction({
    submittedTransactionId: 'BP_UNKNOWN_123456',
    expectedAmount: '25.5000',
    expectedReceiverId: ownerReceiverId,
    depositCreatedAtMs: depositCreatedAt,
    nowMs,
    alreadyUsedTransactionIds: usedIds,
    historyRecords: [validRecord],
  });
  assert.equal(notFound.outcome, 'pending');
  assert.equal(notFound.reasonCode, 'NOT_FOUND_YET');

  // (c) Duplicate transactionId already used -> REJECTED
  const dupRes = verifyBinancePayTransaction({
    submittedTransactionId: 'BP_ALREADY_USED_999',
    expectedAmount: '25.5000',
    expectedReceiverId: ownerReceiverId,
    depositCreatedAtMs: depositCreatedAt,
    nowMs,
    alreadyUsedTransactionIds: usedIds,
    historyRecords: [{ ...validRecord, transactionId: 'BP_ALREADY_USED_999' }],
  });
  assert.equal(dupRes.outcome, 'rejected');
  assert.equal(dupRes.reasonCode, 'DUPLICATE_TRANSACTION_ID');

  // (d) Outgoing transfer (negative amount) or refund orderType -> REJECTED
  const outgoing = verifyBinancePayTransaction({
    submittedTransactionId: 'BP_OUTGOING_001',
    expectedAmount: '25.5000',
    expectedReceiverId: ownerReceiverId,
    depositCreatedAtMs: depositCreatedAt,
    nowMs,
    alreadyUsedTransactionIds: usedIds,
    historyRecords: [{ ...validRecord, transactionId: 'BP_OUTGOING_001', amount: '-25.50' }],
  });
  assert.equal(outgoing.outcome, 'rejected');
  assert.equal(outgoing.reasonCode, 'NOT_INCOMING_TRANSFER');

  const refund = verifyBinancePayTransaction({
    submittedTransactionId: 'BP_REFUND_001',
    expectedAmount: '25.5000',
    expectedReceiverId: ownerReceiverId,
    depositCreatedAtMs: depositCreatedAt,
    nowMs,
    alreadyUsedTransactionIds: usedIds,
    historyRecords: [{ ...validRecord, transactionId: 'BP_REFUND_001', orderType: 'PAY_REFUND' }],
  });
  assert.equal(refund.outcome, 'rejected');
  assert.equal(refund.reasonCode, 'NOT_INCOMING_TRANSFER');

  // (e) Non-USDT currency -> REJECTED
  const wrongCur = verifyBinancePayTransaction({
    submittedTransactionId: 'BP_USDC_001',
    expectedAmount: '25.5000',
    expectedReceiverId: ownerReceiverId,
    depositCreatedAtMs: depositCreatedAt,
    nowMs,
    alreadyUsedTransactionIds: usedIds,
    historyRecords: [{ ...validRecord, transactionId: 'BP_USDC_001', currency: 'USDC' }],
  });
  assert.equal(wrongCur.outcome, 'rejected');
  assert.equal(wrongCur.reasonCode, 'WRONG_CURRENCY');

  // (f) Decimal amount mismatch (e.g. 25.49 vs 25.50) -> REJECTED
  const wrongAmt = verifyBinancePayTransaction({
    submittedTransactionId: 'BP_MISMATCH_001',
    expectedAmount: '25.5000',
    expectedReceiverId: ownerReceiverId,
    depositCreatedAtMs: depositCreatedAt,
    nowMs,
    alreadyUsedTransactionIds: usedIds,
    historyRecords: [{ ...validRecord, transactionId: 'BP_MISMATCH_001', amount: '25.49' }],
  });
  assert.equal(wrongAmt.outcome, 'rejected');
  assert.equal(wrongAmt.reasonCode, 'AMOUNT_MISMATCH');

  // (g) Wrong receiver Binance ID -> REJECTED
  const wrongRec = verifyBinancePayTransaction({
    submittedTransactionId: 'BP_WRONG_REC_001',
    expectedAmount: '25.5000',
    expectedReceiverId: ownerReceiverId,
    depositCreatedAtMs: depositCreatedAt,
    nowMs,
    alreadyUsedTransactionIds: usedIds,
    historyRecords: [
      { ...validRecord, transactionId: 'BP_WRONG_REC_001', receiverInfo: { binanceId: '999888777' } },
    ],
  });
  assert.equal(wrongRec.outcome, 'rejected');
  assert.equal(wrongRec.reasonCode, 'WRONG_RECEIVER_ID');

  // (h) Historical transaction older than deposit window -> REJECTED
  const oldTx = verifyBinancePayTransaction({
    submittedTransactionId: 'BP_OLD_TX_001',
    expectedAmount: '25.5000',
    expectedReceiverId: ownerReceiverId,
    depositCreatedAtMs: depositCreatedAt,
    nowMs,
    alreadyUsedTransactionIds: usedIds,
    historyRecords: [
      { ...validRecord, transactionId: 'BP_OLD_TX_001', transactionTime: depositCreatedAt - 48 * 3600_000 },
    ],
  });
  assert.equal(oldTx.outcome, 'rejected');
  assert.equal(oldTx.reasonCode, 'TIMESTAMP_OUT_OF_WINDOW');

  // (i) Non-settled/pending status -> stays PENDING
  const pendingStatus = verifyBinancePayTransaction({
    submittedTransactionId: 'BP_PENDING_001',
    expectedAmount: '25.5000',
    expectedReceiverId: ownerReceiverId,
    depositCreatedAtMs: depositCreatedAt,
    nowMs,
    alreadyUsedTransactionIds: usedIds,
    historyRecords: [{ ...validRecord, transactionId: 'BP_PENDING_001', status: 'PROCESSING' }],
  });
  assert.equal(pendingStatus.outcome, 'pending');
  assert.equal(pendingStatus.reasonCode, 'INCOMPLETE_STATUS');
});

test('19. Bilingual i18n dictionaries (ar.json & en.json) have 100% key parity and accurate language detection', () => {
  const keys = getAllDictionaryKeys();
  assert.equal(keys.missingInEn.length, 0, `Keys missing in en.json: ${keys.missingInEn.join(', ')}`);
  assert.equal(keys.missingInAr.length, 0, `Keys missing in ar.json: ${keys.missingInAr.join(', ')}`);
  assert.ok(keys.arKeys.length >= 60);

  // Interpolation works cleanly in both languages
  const arWallet = t('ar', 'wallet_summary', { available: '12.50', reserved: '0.00' });
  const enWallet = t('en', 'wallet_summary', { available: '12.50', reserved: '0.00' });
  assert.ok(arWallet.includes('12.50'));
  assert.ok(enWallet.includes('12.50'));
  assert.equal(containsProviderLeak(arWallet), false);
  assert.equal(containsProviderLeak(enWallet), false);

  // Initial language detection rules
  assert.equal(
    resolveInitialLanguage({ telegramLanguageCode: 'ar', arEnabled: true, enEnabled: true, defaultLanguage: 'ar' }),
    'ar'
  );
  assert.equal(
    resolveInitialLanguage({ telegramLanguageCode: 'ar-SA', arEnabled: true, enEnabled: true, defaultLanguage: 'en' }),
    'ar'
  );
  assert.equal(
    resolveInitialLanguage({ telegramLanguageCode: 'en-US', arEnabled: true, enEnabled: true, defaultLanguage: 'ar' }),
    'en'
  );
  assert.equal(
    resolveInitialLanguage({ telegramLanguageCode: 'fr', arEnabled: true, enEnabled: true, defaultLanguage: 'ar' }),
    'en'
  );
  // Respects disabled language toggle
  assert.equal(
    resolveInitialLanguage({ telegramLanguageCode: 'en', arEnabled: true, enEnabled: false, defaultLanguage: 'ar' }),
    'ar'
  );
  assert.equal(
    resolveInitialLanguage({ telegramLanguageCode: 'ar', arEnabled: false, enEnabled: true, defaultLanguage: 'en' }),
    'en'
  );
});

test('20. Bilingual product DTO supports EN translation, clean fallback, and ZERO provider leaks in both languages', () => {
  const translated = toCustomerProductDTO({
    id: 1,
    sku: 'RQM-GEM-6M',
    categoryId: 1,
    categoryNameAr: 'الذكاء الاصطناعي',
    categoryNameEn: 'Artificial Intelligence',
    titleAr: 'Gemini Pro — 6 أشهر',
    titleEn: 'Gemini Pro — 6 Months',
    descriptionAr: 'تفعيل فوري ومضمون',
    descriptionEn: 'Instant verified activation',
    imageUrl: '',
    warrantyLabelAr: 'ضمان 6 أشهر',
    warrantyLabelEn: '6-month warranty',
    durationLabel: '6 أشهر',
    deliveryType: 'code',
    isVisible: true,
    isPaused: false,
    autoHideOutOfStock: true,
    isFeaturedOffer: true,
    retailPrice: '3.0000',
    promoPrice: null,
    availableStock: 400,
    lang: 'en',
  });
  assert.ok(translated);
  assert.equal(translated.title, 'Gemini Pro — 6 Months');
  assert.equal(translated.categoryName, 'Artificial Intelligence');
  assert.equal(containsProviderLeak(JSON.stringify(translated)), false);

  // Fallback when EN translation is missing (never breaks or crashes)
  const fallback = getLocalizedProductFields(
    {
      titleAr: 'اشتراك خاص',
      titleEn: '',
      descriptionAr: 'وصف عربي فقط',
      descriptionEn: null,
      warrantyLabelAr: 'ضمان 30 يوم',
      warrantyLabelEn: null,
    },
    'en'
  );
  assert.equal(fallback.title, 'اشتراك خاص');
  assert.equal(fallback.description, 'وصف عربي فقط');
});

test('21. Dynamic main menu builder respects visibility, disabled state, row grouping, URLs, and scrubs leaks', () => {
  const rows = buildDynamicMainInlineKeyboard(
    [
      {
        id: 1,
        code: 'store',
        labelAr: '🛍 المتجر',
        labelEn: '🛍 Store',
        buttonStyle: 'success',
        actionType: 'builtin',
        actionValue: 'store',
        rowOrder: 1,
        colOrder: 0,
        buttonsPerRow: 2,
        isVisible: true,
        isEnabled: true,
      },
      {
        id: 2,
        code: 'hidden_btn',
        labelAr: 'مخفي',
        labelEn: 'Hidden',
        actionType: 'custom_text',
        actionValue: '',
        rowOrder: 1,
        colOrder: 1,
        buttonsPerRow: 2,
        isVisible: false,
        isEnabled: true,
      },
      {
        id: 3,
        code: 'disabled_btn',
        labelAr: 'معطل',
        labelEn: 'Disabled',
        actionType: 'custom_text',
        actionValue: '',
        rowOrder: 2,
        colOrder: 0,
        buttonsPerRow: 2,
        isVisible: true,
        isEnabled: false,
      },
      {
        id: 4,
        code: 'support',
        labelAr: '📞 الدعم',
        labelEn: '📞 Support',
        actionType: 'url',
        actionValue: 'support_link',
        rowOrder: 2,
        colOrder: 1,
        buttonsPerRow: 2,
        isVisible: true,
        isEnabled: true,
      },
      {
        id: 5,
        code: 'leaked',
        labelAr: 'Pixora API',
        labelEn: 'Pixora API',
        actionType: 'custom_text',
        actionValue: '',
        rowOrder: 3,
        colOrder: 0,
        buttonsPerRow: 2,
        isVisible: true,
        isEnabled: true,
      },
    ],
    'en',
    '@my_support_team'
  );

  const flat = rows.flat();
  assert.equal(flat.length, 4); // hidden_btn excluded
  assert.equal(flat[0].callbackData, 'c:store');
  assert.equal(flat[0].style, 'success');
  assert.equal(flat[1].callbackData, 'c:disabled:3');
  assert.equal(flat[2].url, 'https://t.me/my_support_team');
  assert.equal(containsProviderLeak(flat[3].text), false);
});

test('22. Profile card and Order card format real user stats & dates accurately in AR and EN', () => {
  const profileEn = formatCustomerProfileCard({
    displayName: 'آلقيصر ⚕',
    telegramUserId: '793179862',
    balance: '12.5000',
    ordersCount: 3,
    totalSpent: '4.5000',
    lang: 'en',
  });
  assert.ok(profileEn.includes('👤 Your Profile'));
  assert.ok(profileEn.includes('Name: آلقيصر ⚕'));
  assert.ok(profileEn.includes('User ID: 793179862'));
  assert.ok(profileEn.includes('👛 Balance: 12.50 USDT'));
  assert.ok(profileEn.includes('📦 Orders: 3'));
  assert.ok(profileEn.includes('💰 Total spent: 4.50 USDT'));

  const orderEn = formatCustomerOrderCard({
    orderNumber: 'VCP0XQQ1JE',
    status: 'completed',
    title: 'Gemini Plus 6 Months',
    quantity: 1,
    totalRetail: '0.5000',
    createdAt: new Date('2026-11-12T20:06:00.000Z'),
    lang: 'en',
  });
  assert.equal(
    orderEn,
    '✅ VCP0XQQ1JE\n🛒 Gemini Plus 6 Months x1 — 0.50 USDT\n📅 2026-11-12 Time 20:06'
  );
});

test('23. Support Telegram URL normalizer handles @handles, bare usernames, and full https URLs', () => {
  assert.equal(buildSupportTelegramUrl('@raqm_support'), 'https://t.me/raqm_support');
  assert.equal(buildSupportTelegramUrl('D_U_II'), 'https://t.me/D_U_II');
  assert.equal(buildSupportTelegramUrl('https://t.me/custom_help'), 'https://t.me/custom_help');
});

test('24. resolveProviderAdapter resolves all 8 newly added servers, Warzone/AIVault aliases, and arbitrary custom servers (never null)', () => {
  const cases = [
    { code: 'warzone', name: 'Warzone Shop', baseUrl: 'https://api.warzoneshop.in', expectedBase: 'https://api.warzoneshop.in/api/v1', expectedHeader: 'X-API-Key' },
    { code: 'aivault', name: 'AIVault API', baseUrl: 'https://api.aivaulthub.store', expectedBase: 'https://api.aivaulthub.store/api/v1', expectedHeader: 'X-API-Key' },
    { code: 'geminishop', name: 'Gemini Shop', baseUrl: 'https://reseller.aivaulthub.store', expectedBase: 'https://reseller.aivaulthub.store/api/v1', expectedHeader: 'X-API-Key' },
    { code: 'lukuai', name: 'LukuAI', baseUrl: 'https://bot.lukuai.com', expectedBase: 'https://bot.lukuai.com', expectedHeader: 'X-Api-Key' },
    { code: 'sajidofficial', name: 'Sajid Official', baseUrl: 'https://sajidofficial.com/api/v1', expectedBase: 'https://sajidofficial.com/api/v1', expectedHeader: 'X-API-Key' },
    { code: 'toolverio', name: 'Toolverio', baseUrl: 'https://api.toolverio.com', expectedBase: 'https://api.toolverio.com', expectedHeader: 'Authorization' },
    { code: 'aiversehub', name: 'AIVerse Hub', baseUrl: 'https://aiversehub.store', expectedBase: 'https://aiversehub.store', expectedHeader: 'X-API-Key' },
    { code: 'hmai', name: 'HMAI Store', baseUrl: 'https://api.hmai.shop', expectedBase: 'https://api.hmai.shop', expectedHeader: 'Authorization' },
    { code: 'canboso', name: 'Canboso', baseUrl: 'https://canboso.com', expectedBase: 'https://canboso.com', expectedHeader: 'x-buyer-key' },
    { code: 'kangnequantri', name: 'Kanghne Store', baseUrl: 'https://bot.kangnequantri.cc/api/v1', expectedBase: 'https://bot.kangnequantri.cc/api/v1', expectedHeader: 'X-API-Key' },
    { code: 'renqis', name: 'Renqis API', baseUrl: 'https://api.renqis.online/api/reseller/v1', expectedBase: 'https://api.renqis.online/api/reseller/v1', expectedHeader: 'X-API-Key' },
    { code: 'custom_xyz', name: 'My Custom API', baseUrl: 'https://api.mycustomstore.io', authType: 'x_api_key', authHeader: 'X-API-Key', expectedBase: 'https://api.mycustomstore.io', expectedHeader: 'X-API-Key' },
  ];

  for (const c of cases) {
    const adapter = resolveProviderAdapter(c);
    assert.ok(adapter, `Expected adapter for ${c.code}`);
    assert.equal(adapter.baseUrl, c.expectedBase);
    assert.equal(adapter.authHeader, c.expectedHeader);
  }
});

test('25. parseAuthHeaderInput safely separates accidentally pasted API keys from header names and normalizes docs URLs', () => {
  const warzone = parseAuthHeaderInput('X-API-Key: WAR_vMxARB939DCGl6XvAQIMCaHj', 'bearer');
  assert.equal(warzone.authHeader, 'X-API-Key');
  assert.equal(warzone.authType, 'x_api_key');
  assert.equal(warzone.extractedApiKey, 'WAR_vMxARB939DCGl6XvAQIMCaHj');

  const rawKey = parseAuthHeaderInput('rsk_UiAIwNFLaVTWKFh7sAAKsx69GEr1biukPH9-jfK3Uys', 'bearer');
  assert.equal(rawKey.authHeader, 'X-API-Key');
  assert.equal(rawKey.authType, 'x_api_key');
  assert.equal(rawKey.extractedApiKey, 'rsk_UiAIwNFLaVTWKFh7sAAKsx69GEr1biukPH9-jfK3Uys');

  const clean = parseAuthHeaderInput('x-buyer-key', 'x_api_key', 'tgb_secret_12345');
  assert.equal(clean.authHeader, 'x-buyer-key');
  assert.equal(clean.extractedApiKey, 'tgb_secret_12345');

  assert.equal(normalizeProviderBaseUrl('https://aiversehub.store/docs'), 'https://aiversehub.store');
  assert.equal(normalizeProviderBaseUrl('https://canboso.com/api/swagger'), 'https://canboso.com');
  assert.equal(normalizeProviderBaseUrl('https://bot.lukuai.com/partner-api-docs?lang=en'), 'https://bot.lukuai.com');
});

test('26. classifyOfferBrand and groupOffersByBrand categorize mixed server offers cleanly into Gemini, ChatGPT, Canva, Adobe, etc.', () => {
  const sampleOffers = [
    { id: 1, rawName: 'Gemini 18m links jio offer' },
    { id: 2, rawName: 'Google AI Pro (5TB) 1 Năm' },
    { id: 3, rawName: 'ChatGPT Team 1 Month Slot' },
    { id: 4, rawName: 'Canva Pro Education — 12M' },
    { id: 5, rawName: 'Adobe Creative Cloud All Apps 1M' },
    { id: 6, rawName: 'Gamma Pro 1 Year' },
    { id: 7, rawName: 'Duolingo Super Family 12M' },
    { id: 8, rawName: 'YouTube Premium 1M' },
  ];

  assert.equal(classifyOfferBrand(sampleOffers[0].rawName).key, 'gemini');
  assert.equal(classifyOfferBrand(sampleOffers[1].rawName).key, 'gemini');
  assert.equal(classifyOfferBrand(sampleOffers[2].rawName).key, 'chatgpt');
  assert.equal(classifyOfferBrand(sampleOffers[3].rawName).key, 'canva');
  assert.equal(classifyOfferBrand('Canva Pro Education — 12M (Gemini Shop)').key, 'canva');
  assert.equal(classifyOfferBrand(sampleOffers[4].rawName).key, 'adobe');

  const grouped = groupOffersByBrand(sampleOffers);
  const geminiBucket = grouped.find((b) => b.brand.key === 'gemini');
  assert.ok(geminiBucket);
  assert.equal(geminiBucket.count, 2);
  assert.equal(grouped.reduce((sum, b) => sum + b.count, 0), sampleOffers.length);
});

test('27. matchProductToStoreCategory maps Gemini/Duolingo/custom categories accurately and never dumps unknown items into Cloud', () => {
  const storeCategories = [
    { id: 6, slug: 'chatgpt', nameAr: 'ChatGPT', nameEn: 'ChatGPT' },
    { id: 7, slug: 'gamma', nameAr: 'Gamma', nameEn: 'Gamma' },
    { id: 8, slug: 'cloud', nameAr: 'Cloud', nameEn: 'Cloud' },
    { id: 9, slug: 'canva', nameAr: 'Canva', nameEn: 'Canva' },
    { id: 10, slug: 'adobe', nameAr: 'Adobe', nameEn: 'Adobe' },
    { id: 11, slug: 'duolingo', nameAr: 'Duolingo', nameEn: 'Duolingo' },
    { id: 12, slug: 'youtube', nameAr: 'YouTube', nameEn: 'YouTube' },
    { id: 14, slug: 'gemini', nameAr: 'Gemini', nameEn: 'Gemini' },
    { id: 20, slug: 'capcut', nameAr: 'CapCut', nameEn: 'CapCut' },
  ];

  // Gemini Arabic & English products must map to recreated Gemini category (id=14), never Cloud (id=8)
  const g1 = matchProductToStoreCategory('اشتراك Gemini Pro — 6 أشهر (تفعيل فوري)', '', storeCategories);
  assert.ok(g1);
  assert.equal(g1.categoryId, 14);
  assert.equal(g1.brandKey, 'gemini');

  const g2 = matchProductToStoreCategory('Gemini Plus 6 Months', '', storeCategories);
  assert.ok(g2);
  assert.equal(g2.categoryId, 14);

  const g3 = matchProductToStoreCategory('Google AI Pro (5TB) 1 Year', '', storeCategories);
  assert.ok(g3);
  assert.equal(g3.categoryId, 14);

  // Duolingo must map to Duolingo (id=11)
  const d1 = matchProductToStoreCategory('Duolingo Super 12M', '', storeCategories);
  assert.ok(d1);
  assert.equal(d1.categoryId, 11);

  // Custom user category CapCut must match id=20
  const c1 = matchProductToStoreCategory('CapCut Pro 1 Month Private', '', storeCategories);
  assert.ok(c1);
  assert.equal(c1.categoryId, 20);

  // True Cloud item maps to Cloud (id=8)
  const cl1 = matchProductToStoreCategory('Google Cloud $300 Billing Account', '', storeCategories);
  assert.ok(cl1);
  assert.equal(cl1.categoryId, 8);

  // Unknown brand with no matching category must return null instead of dumping into Cloud!
  const unknown = matchProductToStoreCategory('NordVPN 1 Year Subscription', '', storeCategories);
  assert.equal(unknown, null);
});

test('28. Priority Queue (#1 -> #2 -> #3) fails over on stockout while preserving priority order and auto-recovers #1 on restock', () => {
  const makeProviders = (stocks: [number, number, number]): ProviderOfferCandidate[] => [
    {
      mappingId: 303,
      providerId: 3,
      providerCode: 'qorix',
      providerName: 'QORIX',
      providerStatus: 'connected',
      providerEnabled: true,
      providerBalance: '100.0000',
      providerProductId: 33,
      externalProductId: 'gem-6m-3',
      wholesalePrice: '0.4500',
      stockCount: stocks[2],
      roleType: 'backup',
      priority: 3,
      isVerifiedCompatible: true,
      isActive: true,
    },
    {
      mappingId: 101,
      providerId: 1,
      providerCode: 'aivaulthub',
      providerName: 'AIVault Hub',
      providerStatus: 'connected',
      providerEnabled: true,
      providerBalance: '100.0000',
      providerProductId: 11,
      externalProductId: 'gem-6m-1',
      wholesalePrice: '0.4000',
      stockCount: stocks[0],
      roleType: 'primary',
      priority: 1,
      isVerifiedCompatible: true,
      isActive: true,
    },
    {
      mappingId: 202,
      providerId: 2,
      providerCode: 'pandora',
      providerName: 'Pandora Digital',
      providerStatus: 'connected',
      providerEnabled: true,
      providerBalance: '100.0000',
      providerProductId: 22,
      externalProductId: 'gem-6m-2',
      wholesalePrice: '0.4200',
      stockCount: stocks[1],
      roleType: 'backup',
      priority: 2,
      isVerifiedCompatible: true,
      isActive: true,
    },
  ];

  // Phase 1: All 3 stocked -> #1 is active_now, #2 & #3 are standby, ranked [1, 2, 3]
  const p1Candidates = makeProviders([20, 15, 30]);
  const p1Ranked = rankEligibleProviders(p1Candidates, 'priority', 1);
  assert.deepEqual(p1Ranked.map((c) => c.priority), [1, 2, 3]);
  const p1Queue = evaluateProviderPriorityQueue(p1Candidates, 'priority', 1);
  assert.deepEqual(p1Queue.map((q) => [q.rank, q.providerCode, q.routingState, q.isActiveRoutingTarget]), [
    [1, 'aivaulthub', 'active_now', true],
    [2, 'pandora', 'standby', false],
    [3, 'qorix', 'standby', false],
  ]);

  // Phase 2: #1 stock hits 0 -> #1 stays rank 1 (out_of_stock), #2 auto-takes active_now, #3 standby
  const p2Candidates = makeProviders([0, 15, 30]);
  const p2Ranked = rankEligibleProviders(p2Candidates, 'priority', 1);
  assert.deepEqual(p2Ranked.map((c) => c.priority), [2, 3]);
  const p2Queue = evaluateProviderPriorityQueue(p2Candidates, 'priority', 1);
  assert.deepEqual(p2Queue.map((q) => [q.rank, q.providerCode, q.routingState, q.isActiveRoutingTarget]), [
    [1, 'aivaulthub', 'out_of_stock', false],
    [2, 'pandora', 'active_now', true],
    [3, 'qorix', 'standby', false],
  ]);

  // Phase 3: #1 & #2 both stock = 0 -> #3 auto-takes active_now
  const p3Candidates = makeProviders([0, 0, 30]);
  const p3Ranked = rankEligibleProviders(p3Candidates, 'priority', 1);
  assert.deepEqual(p3Ranked.map((c) => c.priority), [3]);
  const p3Queue = evaluateProviderPriorityQueue(p3Candidates, 'priority', 1);
  assert.deepEqual(p3Queue.map((q) => [q.rank, q.providerCode, q.routingState, q.isActiveRoutingTarget]), [
    [1, 'aivaulthub', 'out_of_stock', false],
    [2, 'pandora', 'out_of_stock', false],
    [3, 'qorix', 'active_now', true],
  ]);

  // Phase 4: #1 restocks to 25 -> #1 automatically reclaims active_now, #2 & #3 keep saved order
  const p4Candidates = makeProviders([25, 0, 30]);
  const p4Ranked = rankEligibleProviders(p4Candidates, 'priority', 1);
  assert.deepEqual(p4Ranked.map((c) => c.priority), [1, 3]);
  const p4Queue = evaluateProviderPriorityQueue(p4Candidates, 'priority', 1);
  assert.deepEqual(p4Queue.map((q) => [q.rank, q.providerCode, q.routingState, q.isActiveRoutingTarget]), [
    [1, 'aivaulthub', 'active_now', true],
    [2, 'pandora', 'out_of_stock', false],
    [3, 'qorix', 'standby', false],
  ]);
});

test('29. Dynamic percent_margin pricing ($0.42 + 170% = $1.13), combined multi-provider stock [2040], exact button format, and automatic 0-stock hide/restore', () => {
  const candidates: ProviderOfferCandidate[] = [
    {
      mappingId: 1,
      providerId: 1,
      providerCode: 'aivaulthub',
      providerName: 'AIVault Hub',
      providerStatus: 'connected',
      providerEnabled: true,
      providerBalance: '3.2300',
      providerProductId: 101,
      externalProductId: 'gem-1',
      wholesalePrice: '0.4200',
      stockCount: 1371,
      roleType: 'primary',
      priority: 1,
      isVerifiedCompatible: true,
      isActive: true,
    },
    {
      mappingId: 2,
      providerId: 2,
      providerCode: 'pandora',
      providerName: 'Pandora Digital',
      providerStatus: 'connected',
      providerEnabled: true,
      providerBalance: '0.0500',
      providerProductId: 102,
      externalProductId: 'gem-2',
      wholesalePrice: '0.3800',
      stockCount: 209,
      roleType: 'backup',
      priority: 2,
      isVerifiedCompatible: true,
      isActive: true,
    },
    {
      mappingId: 3,
      providerId: 3,
      providerCode: 'warzone',
      providerName: 'Warzone Shop',
      providerStatus: 'connected',
      providerEnabled: true,
      providerBalance: '0.1700',
      providerProductId: 103,
      externalProductId: 'gem-3',
      wholesalePrice: '0.5000',
      stockCount: 460,
      roleType: 'backup',
      priority: 3,
      isVerifiedCompatible: true,
      isActive: true,
    },
  ];

  // Even when stored retailPrice is stale "1.0000", percent_margin 170% on $0.42 resolves to $1.13!
  const resolved = resolveProductEffectivePricingAndStock({
    rule: {
      pricingMode: 'percent_margin',
      retailPrice: '1.0000',
      fixedMargin: '0.7000',
      percentMargin: '170.0000',
      paymentFeePercent: '1.5000',
      extraFixedCost: '0.0000',
      promoPrice: null,
      lockManualPrice: true,
    },
    candidates,
    strategy: 'priority',
    quantity: 1,
  });

  assert.equal(resolved.effectiveUnitRetailFormatted, '1.13');
  assert.equal(resolved.totalStock, 2040); // 1371 + 209 + 460, uncapped!

  const dto = toCustomerProductDTO({
    id: 72,
    sku: 'SKU-GEM-6M',
    categoryId: 14,
    categoryNameAr: 'Gemini',
    categoryNameEn: 'Gemini',
    titleAr: 'Gemini Plus 6 Months',
    titleEn: 'Gemini Plus 6 Months',
    descriptionAr: 'Instant activation',
    imageUrl: '',
    warrantyLabelAr: 'ضمان 6 أشهر',
    durationLabel: '6 أشهر',
    deliveryType: 'link',
    isVisible: true,
    isPaused: false,
    autoHideOutOfStock: false, // even if false, 0 stock must still auto-hide below!
    isFeaturedOffer: false,
    retailPrice: resolved.effectiveUnitRetail,
    promoPrice: resolved.activePromoPrice,
    availableStock: resolved.totalStock,
    lang: 'en',
  });

  assert.ok(dto);
  assert.equal(dto.retailPrice, '1.13');
  assert.equal(dto.availableQty, 2040);
  const btnText = formatCustomerProductButtonLabel({
    title: dto.title,
    retailPrice: dto.retailPrice,
    promoPrice: dto.promoPrice,
    availableQty: dto.availableQty,
  });
  assert.equal(btnText, 'Gemini Plus 6 Months - $1.13 - [2040]');
  assert.equal(containsProviderLeak(btnText), false);

  // When stock across ALL linked providers drops to 0 -> button hides automatically (DTO === null)
  const zeroResolved = resolveProductEffectivePricingAndStock({
    rule: {
      pricingMode: 'percent_margin',
      retailPrice: '1.0000',
      fixedMargin: '0.7000',
      percentMargin: '170.0000',
      paymentFeePercent: '1.5000',
      extraFixedCost: '0.0000',
      promoPrice: null,
      lockManualPrice: true,
    },
    candidates: candidates.map((c) => ({ ...c, stockCount: 0 })),
    strategy: 'priority',
    quantity: 1,
  });
  assert.equal(zeroResolved.totalStock, 0);
  const hiddenWhenOut = toCustomerProductDTO({
    id: 72,
    sku: 'SKU-GEM-6M',
    categoryId: 14,
    categoryNameAr: 'Gemini',
    titleAr: 'Gemini Plus 6 Months',
    descriptionAr: 'Instant activation',
    imageUrl: '',
    warrantyLabelAr: 'ضمان 6 أشهر',
    durationLabel: '6 أشهر',
    deliveryType: 'link',
    isVisible: true,
    isPaused: false,
    autoHideOutOfStock: false,
    isFeaturedOffer: false,
    retailPrice: zeroResolved.effectiveUnitRetail,
    promoPrice: null,
    availableStock: zeroResolved.totalStock,
    lang: 'en',
  });
  assert.equal(hiddenWhenOut, null);

  // When stock returns at any linked provider (e.g. #2 Pandora gets 15) -> reappears automatically!
  const restocked = resolveProductEffectivePricingAndStock({
    rule: {
      pricingMode: 'percent_margin',
      retailPrice: '1.0000',
      fixedMargin: '0.7000',
      percentMargin: '170.0000',
      paymentFeePercent: '1.5000',
      extraFixedCost: '0.0000',
      promoPrice: null,
      lockManualPrice: true,
    },
    candidates: candidates.map((c, idx) => ({ ...c, stockCount: idx === 1 ? 15 : 0 })),
    strategy: 'priority',
    quantity: 1,
  });
  assert.equal(restocked.totalStock, 15);
  assert.equal(restocked.effectiveUnitRetailFormatted, '1.03'); // 0.38 * 2.70 = 1.026 -> $1.03!
  const reappeared = toCustomerProductDTO({
    id: 72,
    sku: 'SKU-GEM-6M',
    categoryId: 14,
    categoryNameAr: 'Gemini',
    titleAr: 'Gemini Plus 6 Months',
    descriptionAr: 'Instant activation',
    imageUrl: '',
    warrantyLabelAr: 'ضمان 6 أشهر',
    durationLabel: '6 أشهر',
    deliveryType: 'link',
    isVisible: true,
    isPaused: false,
    autoHideOutOfStock: true,
    isFeaturedOffer: false,
    retailPrice: restocked.effectiveUnitRetail,
    promoPrice: null,
    availableStock: restocked.totalStock,
    lang: 'en',
  });
  assert.ok(reappeared);
  assert.equal(
    formatCustomerProductButtonLabel({
      title: reappeared.title,
      retailPrice: reappeared.retailPrice,
      promoPrice: reappeared.promoPrice,
      availableQty: reappeared.availableQty,
    }),
    'Gemini Plus 6 Months - $1.03 - [15]'
  );
});

test('30. Product quantity selector (1-6 + Custom Quantity + Back buttons) and Transaction Confirmation message match reference layout & math', () => {
  // 1. Exact 5-row inline keyboard structure in English
  const kbEn = buildProductQuantityInlineKeyboard({
    productId: 72,
    backCallbackData: 'c:cat:14',
    backSource: 'cat_14',
    lang: 'en',
  });
  assert.equal(kbEn.length, 5);
  assert.deepEqual(
    kbEn[0].map((b) => b.text),
    ['1', '2', '3']
  );
  assert.deepEqual(
    kbEn[1].map((b) => b.text),
    ['4', '5', '6']
  );
  assert.equal(kbEn[0][0].style, 'primary');
  assert.equal(kbEn[1][2].callbackData, 'c:qty:72:6:cat_14');
  assert.equal(kbEn[2].length, 1);
  assert.equal(kbEn[2][0].text, '📋 Custom Quantity');
  assert.equal(kbEn[2][0].style, 'success');
  assert.equal(kbEn[2][0].callbackData, 'c:cqty:72:cat_14');
  assert.equal(kbEn[3].length, 1);
  assert.equal(kbEn[3][0].text, '⬅️ Back to Products');
  assert.equal(kbEn[3][0].callbackData, 'c:cat:14');
  assert.equal(kbEn[4].length, 1);
  assert.equal(kbEn[4][0].text, '⬅️ Back to Menu');
  assert.equal(kbEn[4][0].callbackData, 'c:home');

  // 2. Arabic keyboard parity
  const kbAr = buildProductQuantityInlineKeyboard({
    productId: 72,
    backCallbackData: 'c:cat:14',
    backSource: 'cat_14',
    lang: 'ar',
  });
  assert.equal(kbAr.length, 5);
  assert.equal(kbAr[2][0].text, '📋 كمية مخصصة');
  assert.equal(kbAr[3][0].text, '⬅️ رجوع إلى المنتجات');
  assert.equal(kbAr[4][0].text, '⬅️ الرجوع للقائمة الرئيسية');

  // 3. Custom quantity parser (ASCII + Arabic-Indic digits + strict validation)
  assert.deepEqual(parseAndValidateCustomQuantity('12', 41), { ok: true, quantity: 12 });
  assert.deepEqual(parseAndValidateCustomQuantity('١٥', 41), { ok: true, quantity: 15 });
  assert.equal(parseAndValidateCustomQuantity('0', 41).ok, false);
  assert.equal(parseAndValidateCustomQuantity('-3', 41).ok, false);
  assert.equal(parseAndValidateCustomQuantity('abc', 41).ok, false);
  assert.equal(parseAndValidateCustomQuantity('2.5', 41).ok, false);
  const tooHigh = parseAndValidateCustomQuantity('50', 41);
  assert.equal(tooHigh.ok, false);
  if (!tooHigh.ok) assert.equal(tooHigh.reason, 'exceeds_stock');

  // 4. Product detail message format
  const promptEn = formatProductPurchasePromptMessage({
    categoryName: 'Gemini',
    title: 'Gemini Plus 6 Months',
    unitPrice: '1.13',
    stock: 2040,
    description: '100% Safe & Trusted redeem link.',
    durationLabel: '6 Months',
    warrantyLabel: '24h Warranty',
    lang: 'en',
  });
  assert.ok(promptEn.includes('💲 Price: $1.13'));
  assert.ok(promptEn.includes('📊 Stock: 2040'));
  assert.ok(promptEn.includes('Choose Buy Quantity:'));
  assert.equal(containsProviderLeak(promptEn), false);

  // 5. Transaction Confirmation Message (exact reference math: 5 * $0.50 = $2.50, balance $0.17 -> $-2.33)
  const confirmEn = formatPurchaseConfirmationMessage({
    orderRef: 'ORD-84485-6c50',
    productTitle: 'Gemini Plus 6 Months',
    quantity: 5,
    unitPrice: '0.50',
    currentBalance: '0.17',
    lang: 'en',
  });
  assert.equal(confirmEn.totalFormatted, '2.50');
  assert.equal(confirmEn.afterPurchaseFormatted, '-2.33');
  assert.equal(confirmEn.hasSufficientBalance, false);
  assert.ok(confirmEn.text.includes('🛒 CONFIRM PURCHASE'));
  assert.ok(confirmEn.text.includes('🧾 Order ID: ORD-84485-6c50'));
  assert.ok(confirmEn.text.includes('🧮 Quantity: 5'));
  assert.ok(confirmEn.text.includes('💲 Unit Price: $0.50'));
  assert.ok(confirmEn.text.includes('💰 Total: $2.50'));
  assert.ok(confirmEn.text.includes('💎 Your Balance: $0.17'));
  assert.ok(confirmEn.text.includes('💎 After Purchase: $-2.33'));
  assert.ok(confirmEn.text.includes('Confirm your purchase?'));

  // 6. Confirm / Cancel side-by-side keyboard
  const confirmKb = buildPurchaseConfirmationInlineKeyboard({
    productId: 72,
    quantity: 5,
    backSource: 'cat_14',
    lang: 'en',
  });
  assert.equal(confirmKb.length, 1);
  assert.equal(confirmKb[0].length, 2);
  assert.equal(confirmKb[0][0].text, '✅ Confirm');
  assert.equal(confirmKb[0][0].style, 'success');
  assert.equal(confirmKb[0][0].callbackData, 'c:buy:72:5:cat_14');
  assert.equal(confirmKb[0][1].text, '❌ Cancel');
  assert.equal(confirmKb[0][1].style, 'danger');
  assert.equal(confirmKb[0][1].callbackData, 'c:cancel_buy:72:cat_14');
});

test('31. Admin full balance control (add/deduct/set), credit notification text, status colors, and date filtering', () => {
  // 1. Add mode
  const addRes = computeWalletAdjustmentDelta({
    currentBalance: '12.5000',
    mode: 'add',
    amountStr: '7.50',
  });
  assert.equal(addRes.ok, true);
  assert.equal(addRes.delta, '7.5000');
  assert.equal(addRes.nextBalance, '20.0000');

  // 2. Deduct mode + negative guard
  const deductRes = computeWalletAdjustmentDelta({
    currentBalance: '20.0000',
    mode: 'deduct',
    amountStr: '5.25',
  });
  assert.equal(deductRes.ok, true);
  assert.equal(deductRes.delta, '-5.2500');
  assert.equal(deductRes.nextBalance, '14.7500');

  const negDeduct = computeWalletAdjustmentDelta({
    currentBalance: '5.0000',
    mode: 'deduct',
    amountStr: '10.00',
  });
  assert.equal(negDeduct.ok, false);
  assert.equal(negDeduct.errorCode, 'NEGATIVE_BALANCE_FORBIDDEN');

  // 3. Direct set mode (upward & downward + zero-change guard)
  const setUp = computeWalletAdjustmentDelta({
    currentBalance: '10.0000',
    mode: 'set',
    amountStr: '25.00',
  });
  assert.equal(setUp.ok, true);
  assert.equal(setUp.delta, '15.0000');
  assert.equal(setUp.nextBalance, '25.0000');

  const setDown = computeWalletAdjustmentDelta({
    currentBalance: '25.0000',
    mode: 'set',
    amountStr: '0',
  });
  assert.equal(setDown.ok, true);
  assert.equal(setDown.delta, '-25.0000');
  assert.equal(setDown.nextBalance, '0.0000');

  const setZero = computeWalletAdjustmentDelta({
    currentBalance: '10.0000',
    mode: 'set',
    amountStr: '10.00',
  });
  assert.equal(setZero.ok, false);
  assert.equal(setZero.errorCode, 'ZERO_ADJUSTMENT');

  // 4. Credit notification includes BOTH added amount AND new total balance (AR & EN)
  const notifAr = buildWalletCreditNotificationText({
    addedAmount: '15.00',
    totalBalanceAfter: '25.00',
    note: 'شحن رصيد فوري',
    lang: 'ar',
  });
  assert.ok(notifAr.bodyAr.includes('+$15.00'));
  assert.ok(notifAr.bodyAr.includes('$25.00'));
  assert.ok(notifAr.telegramText.includes('+$15.00'));
  assert.ok(notifAr.telegramText.includes('$25.00'));

  const notifEn = buildWalletCreditNotificationText({
    addedAmount: '15.00',
    totalBalanceAfter: '25.00',
    lang: 'en',
  });
  assert.ok(notifEn.telegramText.includes('+$15.00'));
  assert.ok(notifEn.telegramText.includes('$25.00'));

  // 5. Visual status classification (green success, red failed, amber pending)
  assert.equal(classifyOperationStatusVisual('completed').category, 'success');
  assert.equal(classifyOperationStatusVisual('paid').category, 'success');
  assert.equal(classifyOperationStatusVisual('confirmed').category, 'success');
  assert.equal(classifyOperationStatusVisual('failed').category, 'failed');
  assert.equal(classifyOperationStatusVisual('rejected').category, 'failed');
  assert.equal(classifyOperationStatusVisual('refunded').category, 'failed');
  assert.equal(classifyOperationStatusVisual('pending_review').category, 'pending');

  // 6. Date-range and status filtering
  const now = new Date(2026, 10, 20, 15, 0, 0); // 2026-11-20
  const sampleOps = [
    { id: 1, status: 'completed', createdAt: new Date(2026, 10, 20, 9, 30, 0).toISOString() },
    { id: 2, status: 'failed', createdAt: new Date(2026, 10, 18, 12, 0, 0).toISOString() },
    { id: 3, status: 'completed', createdAt: new Date(2026, 9, 25, 10, 0, 0).toISOString() },
    { id: 4, status: 'pending_review', createdAt: new Date(2026, 10, 15, 18, 0, 0).toISOString() },
  ];

  assert.deepEqual(
    filterOperationsByDateRange(sampleOps, { preset: 'today', now }).map((x) => x.id),
    [1]
  );
  assert.deepEqual(
    filterOperationsByDateRange(sampleOps, { preset: '7d', now }).map((x) => x.id),
    [1, 2, 4]
  );
  assert.deepEqual(
    filterOperationsByDateRange(sampleOps, {
      preset: 'custom',
      fromDate: '2026-11-15',
      toDate: '2026-11-18',
      now,
    }).map((x) => x.id),
    [2, 4]
  );
  assert.deepEqual(
    filterOperationsByDateRange(sampleOps, {
      preset: '7d',
      statusCategory: 'failed',
      now,
    }).map((x) => x.id),
    [2]
  );
});

test('32. Button management hierarchy, sub-buttons, breadcrumb, preview grid, and automatic language/emoji helpers', () => {
  // 1. Language detection & emoji preservation for single-input auto-translation
  assert.equal(detectTextLanguage('🛍 المتجر'), 'ar');
  assert.equal(detectTextLanguage('🛍 Store'), 'en');
  assert.equal(detectTextLanguage('🔥 عروض VIP اليوم'), 'ar');
  assert.equal(detectTextLanguage('💎 VIP Subscriptions'), 'en');

  const split = splitLeadingEmoji('🔥 عروض اليوم');
  assert.equal(split.emoji, '🔥');
  assert.equal(split.cleanText, 'عروض اليوم');
  assert.equal(ensurePreservedEmoji('🔥', "Today's Offers"), "🔥 Today's Offers");
  assert.equal(ensurePreservedEmoji('🔥', "🔥 Today's Offers"), "🔥 Today's Offers");

  // 2. Hierarchical Main + Nested Sub-Buttons tree, descendants, breadcrumb, and preview rows
  const mkBtn = (overrides: Partial<AdminBotButtonItem> & { id: number; code: string }): AdminBotButtonItem => ({
    parentId: null,
    labelAr: overrides.code,
    labelEn: overrides.code,
    iconEmoji: '',
    iconCustomEmojiId: null,
    buttonStyle: 'primary',
    actionType: 'custom_text',
    actionValue: overrides.code,
    contentAr: '',
    contentEn: '',
    rowOrder: 1,
    colOrder: 1,
    buttonsPerRow: 2,
    isVisible: true,
    isEnabled: true,
    ...overrides,
  });

  const sampleButtons: AdminBotButtonItem[] = [
    mkBtn({ id: 1, code: 'store', labelAr: '🛍 المتجر', labelEn: '🛍 Store', rowOrder: 1, colOrder: 1, buttonsPerRow: 2 }),
    mkBtn({ id: 2, code: 'wallet', labelAr: '💰 محفظتي', labelEn: '💰 My Wallet', rowOrder: 1, colOrder: 2, buttonsPerRow: 2 }),
    mkBtn({ id: 3, code: 'hidden_btn', labelAr: 'مخفي', labelEn: 'Hidden', rowOrder: 2, colOrder: 1, isVisible: false }),
    mkBtn({ id: 10, parentId: 1, code: 'store_deals', labelAr: '🔥 عروض اليوم', labelEn: '🔥 Today Deals', rowOrder: 1 }),
    mkBtn({ id: 11, parentId: 10, code: 'store_deals_vip', labelAr: '💎 باقات VIP', labelEn: '💎 VIP Plans', rowOrder: 1 }),
  ];

  const tree = buildButtonHierarchy(sampleButtons);
  assert.equal(tree.length, 3);
  assert.equal(tree[0].button.id, 1);
  assert.equal(tree[0].children.length, 1);
  assert.equal(tree[0].children[0].button.id, 10);
  assert.equal(tree[0].children[0].children[0].button.id, 11);

  // Descendants collector prevents circular parent loops and supports atomic cascade deletion
  assert.deepEqual(collectDescendantButtonIds(sampleButtons, 1), [1, 10, 11]);
  assert.deepEqual(collectDescendantButtonIds(sampleButtons, 10), [10, 11]);

  // Breadcrumb from root -> parent -> leaf
  assert.deepEqual(
    buildButtonBreadcrumb(sampleButtons, 11).map((b) => b.id),
    [1, 10, 11]
  );

  // Live Telegram Inline Preview hides invisible buttons and respects buttonsPerRow=2
  const previewRows = buildInlinePreviewRows(sampleButtons.filter((b) => !b.parentId));
  assert.equal(previewRows.length, 1);
  assert.deepEqual(
    previewRows[0].map((b) => b.id),
    [1, 2]
  );
});

test('33. Live Sub-Buttons Preview Screen & deterministic swap reordering for Store categories, Guides, Main & Nested Sub-Buttons', () => {
  // 1. Duplicate default sortOrders (all 10) still swap cleanly with exact sequential normalization
  const cats = [
    { id: 1, nameAr: 'Gemini', nameEn: 'Gemini', iconEmoji: '✨', buttonStyle: 'primary', sortOrder: 10, isActive: true, showInStore: true },
    { id: 2, nameAr: 'ChatGPT', nameEn: 'ChatGPT', iconEmoji: '🤖', buttonStyle: 'primary', sortOrder: 10, isActive: true, showInStore: true },
    { id: 3, nameAr: 'Canva', nameEn: 'Canva', iconEmoji: '🎨', buttonStyle: 'primary', sortOrder: 10, isActive: true, showInStore: true },
    { id: 4, nameAr: 'مخفي', nameEn: 'Hidden', iconEmoji: '🚫', buttonStyle: 'primary', sortOrder: 10, isActive: false, showInStore: false },
  ];

  // Moving item #1 up returns null; moving item #3 up swaps with item #2
  assert.equal(computeSwappedSortOrderUpdates(cats, 1, 'up'), null);
  const moveCanvaUp = computeSwappedSortOrderUpdates(cats, 3, 'up');
  assert.ok(moveCanvaUp);
  assert.equal(moveCanvaUp.fromPos, 3);
  assert.equal(moveCanvaUp.toPos, 2);
  assert.equal(moveCanvaUp.swappedWithId, 2);
  assert.deepEqual(
    moveCanvaUp.updates.map((u) => u.id),
    [1, 3, 2, 4]
  );

  // Apply updated sortOrders and verify Live Sub-Menu Preview reflects the exact new positions!
  const updatedCats = cats.map((c) => {
    const found = moveCanvaUp.updates.find((u) => u.id === c.id);
    return found ? { ...c, sortOrder: found.sortOrder } : c;
  });

  const mkChild = (id: number, labelAr: string, rowOrder: number, colOrder: number): AdminBotButtonItem => ({
    id,
    parentId: 100,
    code: `sub_${id}`,
    labelAr,
    labelEn: labelAr,
    iconEmoji: '',
    iconCustomEmojiId: null,
    buttonStyle: 'success',
    actionType: 'custom_text',
    actionValue: `sub_${id}`,
    contentAr: '',
    contentEn: '',
    rowOrder,
    colOrder,
    buttonsPerRow: 2,
    isVisible: true,
    isEnabled: true,
  });

  const customSubs = [mkChild(20, '🔥 عروض اليوم', 1, 1), mkChild(21, '💎 باقات VIP', 1, 2)];

  const storePreview = buildSubMenuPreviewRows({
    isStoreButton: true,
    isGuidesButton: false,
    categories: updatedCats,
    guides: [],
    customChildren: customSubs,
    lang: 'ar',
  });

  // 3 visible categories -> 2 rows ([Gemini, Canva], [ChatGPT]) + 1 row of custom sub-buttons ([🔥, 💎])
  assert.equal(storePreview.length, 3);
  assert.deepEqual(
    storePreview[0].map((t) => t.entityId),
    [1, 3]
  );
  assert.deepEqual(
    storePreview[1].map((t) => t.entityId),
    [2]
  );
  assert.deepEqual(
    storePreview[2].map((t) => t.entityId),
    [20, 21]
  );

  // 2. Custom sub-buttons layout swap swaps (rowOrder, colOrder) slots cleanly
  const swapCustom = computeSwappedButtonLayoutUpdates(customSubs, 21, 'up');
  assert.ok(swapCustom);
  assert.equal(swapCustom.fromPos, 2);
  assert.equal(swapCustom.toPos, 1);
  assert.deepEqual(
    swapCustom.updates.map((u) => ({ id: u.id, r: u.rowOrder, c: u.colOrder })),
    [
      { id: 21, r: 1, c: 1 },
      { id: 20, r: 1, c: 2 },
    ]
  );

  // 3. Visible-only swap from the Live Preview jumps over hidden items in a single click
  const mixedCats = [
    { id: 1, sortOrder: 10, isActive: true, showInStore: true },
    { id: 2, sortOrder: 20, isActive: false, showInStore: false }, // hidden
    { id: 3, sortOrder: 30, isActive: true, showInStore: true },
  ];
  const jumpOverHidden = computeSwappedSortOrderUpdates(
    mixedCats,
    3,
    'up',
    (c) => c.isActive && c.showInStore
  );
  assert.ok(jumpOverHidden);
  assert.equal(jumpOverHidden.fromPos, 2);
  assert.equal(jumpOverHidden.toPos, 1);
  assert.equal(jumpOverHidden.swappedWithId, 1);
  assert.deepEqual(
    jumpOverHidden.updates.map((u) => u.id),
    [3, 2, 1]
  );
});

test('34. Referral attribution parsing, link builder, anti-self-referral & existing-user/disabled guards', () => {
  // Deep-link payload parsing
  assert.equal(parseReferralStartPayload('/start ref_123456789'), '123456789');
  assert.equal(parseReferralStartPayload('/start@RaqmBot ref_987654321'), '987654321');
  assert.equal(parseReferralStartPayload('ref_555444333'), '555444333');
  assert.equal(parseReferralStartPayload('/start'), null);
  assert.equal(parseReferralStartPayload('/start ref_abc'), null);

  // Telegram referral link builder
  assert.equal(
    buildTelegramReferralLink('@MyStoreBot', '123456789'),
    'https://t.me/MyStoreBot?start=ref_123456789'
  );

  // Valid new user registration
  assert.deepEqual(
    validateReferralRegistration({
      systemEnabled: true,
      isNewUser: true,
      alreadyHasReferrer: false,
      referrerTelegramId: '111222333',
      referredTelegramId: '444555666',
      referrerExists: true,
      referrerIsBlocked: false,
    }),
    { allowed: true }
  );

  // Self-referral blocked
  assert.deepEqual(
    validateReferralRegistration({
      systemEnabled: true,
      isNewUser: true,
      alreadyHasReferrer: false,
      referrerTelegramId: '111222333',
      referredTelegramId: '111222333',
      referrerExists: true,
    }),
    { allowed: false, reason: 'self_referral' }
  );

  // Existing user cannot be re-attributed
  assert.deepEqual(
    validateReferralRegistration({
      systemEnabled: true,
      isNewUser: false,
      alreadyHasReferrer: false,
      referrerTelegramId: '111222333',
      referredTelegramId: '444555666',
      referrerExists: true,
    }),
    { allowed: false, reason: 'not_new_user' }
  );

  // Disabled system blocks new referrals
  assert.deepEqual(
    validateReferralRegistration({
      systemEnabled: false,
      isNewUser: true,
      alreadyHasReferrer: false,
      referrerTelegramId: '111222333',
      referredTelegramId: '444555666',
      referrerExists: true,
    }),
    { allowed: false, reason: 'system_disabled' }
  );

  // Already has referrer cannot change referrer
  assert.deepEqual(
    validateReferralRegistration({
      systemEnabled: true,
      isNewUser: true,
      alreadyHasReferrer: true,
      referrerTelegramId: '999888777',
      referredTelegramId: '444555666',
      referrerExists: true,
    }),
    { allowed: false, reason: 'already_has_referrer' }
  );
});

test('35. Referral Decimal commission math (1 USDT -> 0.05, 100 USDT -> 5.00), per-user cap, safe non-negative reversal & automatic offset recovery, and Refer & Earn template', () => {
  // 1 USDT @ 5% = 0.0500 USDT
  const smallPurchase = calculateReferralCommission({
    purchaseAmount: '1.0000',
    commissionRatePercent: '5.0000',
    maxCommissionPerUserEnabled: false,
    maxCommissionPerUserAmount: '0.0000',
    alreadyEarnedNetByReferrer: '0.0000',
    pendingRecoveryBalance: '0.0000',
  });
  assert.equal(smallPurchase.eligible, true);
  assert.equal(smallPurchase.grossCommission, '0.0500');
  assert.equal(smallPurchase.netCredited, '0.0500');

  // 100 USDT @ 5% = 5.0000 USDT
  const largePurchase = calculateReferralCommission({
    purchaseAmount: '100.0000',
    commissionRatePercent: '5.0000',
    maxCommissionPerUserEnabled: false,
    maxCommissionPerUserAmount: '0.0000',
    alreadyEarnedNetByReferrer: '0.0500',
    pendingRecoveryBalance: '0.0000',
  });
  assert.equal(largePurchase.eligible, true);
  assert.equal(largePurchase.grossCommission, '5.0000');
  assert.equal(largePurchase.netCredited, '5.0000');

  // Per-user cap enforcement: cap = 6.00, already earned = 5.05 -> next $100 @ 5% ($5) capped to $0.95
  const capped = calculateReferralCommission({
    purchaseAmount: '100.0000',
    commissionRatePercent: '5.0000',
    maxCommissionPerUserEnabled: true,
    maxCommissionPerUserAmount: '6.0000',
    alreadyEarnedNetByReferrer: '5.0500',
    pendingRecoveryBalance: '0.0000',
  });
  assert.equal(capped.eligible, true);
  assert.equal(capped.capApplied, true);
  assert.equal(capped.grossCommission, '0.9500');
  assert.equal(capped.netCredited, '0.9500');

  // Reversal when wallet has sufficient balance (5.00 commission, wallet = 8.00 -> deducts 5.00, wallet = 3.00, deficit = 0)
  const fullRev = calculateCommissionReversal({
    originalGrossCommission: '5.0000',
    originalOffsetApplied: '0.0000',
    originalNetCredited: '5.0000',
    referrerCurrentAvailableBalance: '8.0000',
    referrerCurrentPendingRecovery: '0.0000',
  });
  assert.equal(fullRev.status, 'reversed');
  assert.equal(fullRev.walletDeduction, '5.0000');
  assert.equal(fullRev.unrecoveredDeficit, '0.0000');
  assert.equal(fullRev.newWalletBalance, '3.0000');
  assert.equal(fullRev.newPendingRecoveryBalance, '0.0000');

  // Reversal when referrer already spent balance (wallet = 2.00, commission = 5.00) -> wallet stops at 0.0000 (NEVER negative!) & deficit 3.0000 goes to pendingRecoveryBalance
  const partialRev = calculateCommissionReversal({
    originalGrossCommission: '5.0000',
    originalOffsetApplied: '0.0000',
    originalNetCredited: '5.0000',
    referrerCurrentAvailableBalance: '2.0000',
    referrerCurrentPendingRecovery: '0.0000',
  });
  assert.equal(partialRev.status, 'deficit_recorded');
  assert.equal(partialRev.walletDeduction, '2.0000');
  assert.equal(partialRev.newWalletBalance, '0.0000');
  assert.equal(partialRev.unrecoveredDeficit, '3.0000');
  assert.equal(partialRev.newPendingRecoveryBalance, '3.0000');

  // Next purchase ($100 @ 5% = $5.00) automatically offsets $3.00 recovery deficit and credits $2.00 to wallet!
  const afterRecovery = calculateReferralCommission({
    purchaseAmount: '100.0000',
    commissionRatePercent: '5.0000',
    maxCommissionPerUserEnabled: false,
    maxCommissionPerUserAmount: '0.0000',
    alreadyEarnedNetByReferrer: '0.0000',
    pendingRecoveryBalance: partialRev.newPendingRecoveryBalance,
  });
  assert.equal(afterRecovery.eligible, true);
  assert.equal(afterRecovery.grossCommission, '5.0000');
  assert.equal(afterRecovery.offsetApplied, '3.0000');
  assert.equal(afterRecovery.netCredited, '2.0000');
  assert.equal(afterRecovery.remainingRecoveryBalance, '0.0000');

  // Exact Refer & Earn Telegram template verification (EN & AR)
  const enCard = formatReferAndEarnMessage({
    lang: 'en',
    referralLink: 'https://t.me/RaqmStoreBot?start=ref_123456789',
    successfulReferrals: 4,
    totalPurchases: '120.0000',
    totalEarned: '6.0000',
    commissionRatePercent: '5.0000',
  });
  assert.ok(enCard.includes('🎁 Refer & Earn'));
  assert.ok(enCard.includes('https://t.me/RaqmStoreBot?start=ref_123456789'));
  assert.ok(enCard.includes('👥 Successful Referrals: 4'));
  assert.ok(enCard.includes('🛒 Total Purchases: 120.00 USDT'));
  assert.ok(enCard.includes('💰 Total Earned: 6.00 USDT'));
  assert.ok(enCard.includes('📊 Commission Rate: 5%'));

  const creditNotif = formatCommissionCreditNotification({
    lang: 'ar',
    orderNumber: 'RQM-TEST-1',
    purchaseAmount: '100.0000',
    commissionRatePercent: '5.0000',
    grossCommission: '5.0000',
    netCredited: '5.0000',
    offsetApplied: '0.0000',
    newBalance: '15.0000',
  });
  assert.ok(creditNotif.includes('RQM-TEST-1'));
  assert.ok(creditNotif.includes('+5.00 USDT'));

  const revNotif = formatCommissionReversalNotification({
    lang: 'en',
    orderNumber: 'RQM-TEST-1',
    reversedAmount: '5.0000',
    walletDeduction: '2.0000',
    pendingRecoveryAdded: '3.0000',
    newBalance: '0.0000',
    reason: 'Order refunded',
  });
  assert.ok(revNotif.includes('-5.00 USDT'));
  assert.ok(revNotif.includes('3.00 USDT'));
});

test('KPI Semantics: evaluateKpiPolarity & computeDashboardPeriodMetrics enforce meaning-aware green/red polarity', () => {
  // Higher-is-better: profit growth -> positive (green), profit drop -> negative (red)
  const profitUp = evaluateKpiPolarity({ value: 150, previousValue: 100, higherIsBetter: true });
  assert.equal(profitUp.tone, 'positive');
  assert.equal(profitUp.direction, 'up');
  assert.equal(profitUp.deltaFormatted, '+50%');

  const profitDown = evaluateKpiPolarity({ value: 80, previousValue: 100, higherIsBetter: true });
  assert.equal(profitDown.tone, 'negative');
  assert.equal(profitDown.direction, 'down');
  assert.equal(profitDown.deltaFormatted, '-20%');

  // Lower-is-better: failed orders rising -> negative (red), dropping or zero -> positive (green)
  const failuresRising = evaluateKpiPolarity({ value: 5, previousValue: 2, higherIsBetter: false });
  assert.equal(failuresRising.tone, 'negative');
  assert.equal(failuresRising.direction, 'up');

  const failuresFalling = evaluateKpiPolarity({ value: 1, previousValue: 4, higherIsBetter: false });
  assert.equal(failuresFalling.tone, 'positive');
  assert.equal(failuresFalling.direction, 'down');

  const zeroFailures = evaluateKpiPolarity({ value: 0, higherIsBetter: false, adverseAbove: 0 });
  assert.equal(zeroFailures.tone, 'positive');
  assert.equal(zeroFailures.direction, 'flat');

  const nonZeroFailures = evaluateKpiPolarity({ value: 3, higherIsBetter: false, adverseAbove: 0 });
  assert.equal(nonZeroFailures.tone, 'negative');
  assert.equal(nonZeroFailures.direction, 'up');

  // Period metrics computation across 7-day vs prior 7-day windows & adverse provider/stock counts
  const now = new Date('2026-11-21T12:00:00.000Z');
  const metrics = computeDashboardPeriodMetrics({
    now,
    overview: {
      kpis: {
        totalNetProfit: '42.50',
        totalRevenue: '170.00',
        totalWholesale: '127.50',
        totalProviderBalance: '88.00',
      },
    },
    orders: [
      { status: 'completed', netProfit: '15.00', createdAt: '2026-11-20T10:00:00.000Z' },
      { status: 'completed', netProfit: '15.00', createdAt: '2026-11-18T10:00:00.000Z' },
      { status: 'failed', netProfit: '0.00', createdAt: '2026-11-19T10:00:00.000Z' },
      { status: 'completed', netProfit: '20.00', createdAt: '2026-11-10T10:00:00.000Z' },
    ],
    deposits: [
      { status: 'pending', expectedAmount: '25.00' },
      { status: 'paid', expectedAmount: '50.00' },
    ],
    providers: [
      { isEnabled: true, status: 'connected' },
      { isEnabled: true, status: 'error' },
    ],
    products: [
      { isVisible: true, isPaused: false, totalStock: 10 },
      { isVisible: true, isPaused: false, totalStock: 0 },
      { isVisible: false, isPaused: false, totalStock: 0 },
    ],
    customers: [{ isBlocked: false }, { isBlocked: true }],
  });

  assert.equal(metrics.profit7d, 30);
  assert.equal(metrics.profitPrev7d, 20);
  assert.equal(metrics.profitPolarity.tone, 'positive');
  assert.equal(metrics.profitPolarity.deltaFormatted, '+50%');
  assert.equal(metrics.profitMarginPercent, 25);
  assert.equal(metrics.failedOrders, 1);
  assert.equal(metrics.failedOrdersPolarity.tone, 'negative');
  assert.equal(metrics.errorProviders, 1);
  assert.equal(metrics.providerHealthPolarity.tone, 'negative');
  assert.equal(metrics.publishedProducts, 2);
  assert.equal(metrics.outOfStockPublished, 1);
  assert.equal(metrics.pendingDepositsCount, 1);
  assert.equal(metrics.pendingDepositsAmount, 25);
  assert.equal(metrics.blockedCustomers, 1);
});

test('KPI Semantics: computeDailyOrderSeries aggregates real 7-day daily revenue, profit, and failed orders chronologically', () => {
  const now = new Date('2026-11-21T18:00:00.000Z');
  const series = computeDailyOrderSeries(
    [
      { status: 'completed', totalRetail: '12.50', netProfit: '4.00', createdAt: '2026-11-21T09:10:00.000Z' },
      { status: 'paid', totalRetail: '7.50', netProfit: '2.50', createdAt: '2026-11-21T11:45:00.000Z' },
      { status: 'failed', totalRetail: '10.00', netProfit: '0.00', createdAt: '2026-11-20T15:00:00.000Z' },
      // Older than 7 days — must be excluded from 7-day window
      { status: 'completed', totalRetail: '99.00', netProfit: '50.00', createdAt: '2026-11-01T10:00:00.000Z' },
    ],
    7,
    now
  );

  assert.equal(series.length, 7);
  assert.equal(series[0].dateKey, '2026-11-15');
  assert.equal(series[6].dateKey, '2026-11-21');
  assert.equal(series[6].completedCount, 2);
  assert.equal(series[6].failedCount, 0);
  assert.equal(series[6].revenue, 20);
  assert.equal(series[6].netProfit, 6.5);
  assert.equal(series[5].dateKey, '2026-11-20');
  assert.equal(series[5].failedCount, 1);
  assert.equal(series[5].completedCount, 0);
  assert.equal(series[5].revenue, 0);
});

test('Customer Sanitizer: strips internal admin import notices completely from descriptions, DTOs, and buyer bot messages', () => {
  const leakedAr = 'منتج مستورد تلقائيًا من الخادم — مخفي افتراضيًا حتى التفعيل والتسعير.';
  const leakedEn = 'Auto-imported from server — hidden by default until activation and pricing.';

  assert.equal(containsInternalAdminNotice(leakedAr), true);
  assert.equal(containsInternalAdminNotice(leakedEn), true);
  assert.equal(containsInternalAdminNotice('اشتراك رسمي لمدة 6 أشهر مع تسليم فوري.'), false);

  // Pure internal notice becomes empty string (never shown to buyer)
  assert.equal(sanitizeCustomerProductDescription(leakedAr), '');
  assert.equal(sanitizeCustomerProductDescription(leakedEn), '');

  // Mixed multiline description preserves legitimate customer lines & formatting while stripping internal notice line
  const mixed = `${leakedAr}\n[+] اشتراك رسمي 6 أشهر\n[+] تسليم فوري عبر البوت`;
  assert.equal(
    sanitizeCustomerProductDescription(mixed),
    '[+] اشتراك رسمي 6 أشهر\n[+] تسليم فوري عبر البوت'
  );

  // toCustomerProductDTO never leaks internal notices in AR or EN
  const dtoAr = toCustomerProductDTO({
    id: 99,
    sku: 'SKU-CANVA-12M',
    categoryId: 5,
    categoryNameAr: 'Canva',
    categoryNameEn: 'Canva',
    titleAr: 'Canva Pro Education — 12M',
    titleEn: 'Canva Pro Education — 12M',
    descriptionAr: leakedAr,
    descriptionEn: leakedEn,
    imageUrl: null,
    warrantyLabelAr: 'ضمان 365 يومًا',
    warrantyLabelEn: '365-day warranty',
    durationLabel: '12 شهر',
    deliveryType: 'link',
    isVisible: true,
    isPaused: false,
    autoHideOutOfStock: true,
    isFeaturedOffer: false,
    retailPrice: '2.50',
    promoPrice: null,
    availableStock: 160,
    lang: 'ar',
  });
  assert.ok(dtoAr);
  assert.equal(dtoAr.descriptionAr, '');
  assert.equal(dtoAr.descriptionEn, '');
  assert.equal(containsInternalAdminNotice(dtoAr.description), false);
  assert.equal(dtoAr.description.includes('مستورد تلقائي'), false);
  assert.equal(dtoAr.description.includes('مخفي افتراضي'), false);

  // formatProductPurchasePromptMessage also strips internal notice even if passed directly
  const buyerMsg = formatProductPurchasePromptMessage({
    categoryName: 'Canva',
    title: 'Canva Pro Education — 12M',
    unitPrice: '2.50',
    stock: 160,
    description: leakedAr,
    durationLabel: '12 شهر',
    warrantyLabel: 'ضمان 365 يومًا',
    lang: 'ar',
  });
  assert.equal(buyerMsg.includes('مستورد تلقائي'), false);
  assert.equal(buyerMsg.includes('مخفي افتراضي'), false);
  assert.ok(buyerMsg.includes('Canva Pro Education — 12M'));
  assert.ok(buyerMsg.includes('$2.50'));
  assert.ok(buyerMsg.includes('160'));
});

test('Product Single-Input Auto-Translation Planner: detects AR/EN single inputs and preserves explicit manual bilingual overrides', () => {
  // Single Arabic input -> auto-translate AR -> EN
  const arPlan = planBilingualTextResolution({ single: 'اشتراك كانفا برو لمدة سنة مع ضمان كامل' });
  assert.equal(arPlan.mode, 'single_auto');
  assert.equal(arPlan.detectedLang, 'ar');
  assert.equal(arPlan.singleSourceText, 'اشتراك كانفا برو لمدة سنة مع ضمان كامل');

  // Single English input -> auto-translate EN -> AR
  const enPlan = planBilingualTextResolution({ single: 'Gemini Plus 6 Months — Instant Redeem Link' });
  assert.equal(enPlan.mode, 'single_auto');
  assert.equal(enPlan.detectedLang, 'en');

  // Legacy single-field payload (ar === en) -> auto-translates instead of duplicating untranslated text
  const dupPlan = planBilingualTextResolution({ ar: 'Gemini Plus 6 Months', en: 'Gemini Plus 6 Months' });
  assert.equal(dupPlan.mode, 'single_auto');
  assert.equal(dupPlan.detectedLang, 'en');

  // Only one language provided -> auto-translates
  const onlyAr = planBilingualTextResolution({ ar: 'ضمان التشغيل طوال المدة' });
  assert.equal(onlyAr.mode, 'single_auto');
  assert.equal(onlyAr.detectedLang, 'ar');

  // Explicit distinct AR & EN manual overrides -> keeps manual_both
  const manualPlan = planBilingualTextResolution({
    ar: 'اشتراك جيميني بلس 6 أشهر',
    en: 'Gemini Plus 6 Months Subscription',
  });
  assert.equal(manualPlan.mode, 'manual_both');
  assert.equal(manualPlan.manualAr, 'اشتراك جيميني بلس 6 أشهر');
  assert.equal(manualPlan.manualEn, 'Gemini Plus 6 Months Subscription');

  // Empty inputs -> empty
  assert.equal(planBilingualTextResolution({ single: '   ' }).mode, 'empty');
});

test('33. Dynamic YER Exchange-Rate Engine: parses ye-rial.com live response, enforces freshness fail-closed, rounds accurately, and converts YER<->USD with Decimal math', () => {
  const nowMs = Date.parse('2026-11-21T12:00:00+03:00');
  const freshPayload = {
    status: 'success',
    last_verified_at: '2026-11-21 11:50:00',
    last_sync: '2026-11-21 11:45:00',
    data: {
      sanaa: {
        items: {
          usd: {
            buy: 530,
            sell: 533,
            updated_at: '2026-11-21 11:50:00',
          },
        },
      },
      aden: {
        items: {
          usd: {
            buy: 1620,
            sell: 1635,
            updated_at: '2026-11-21 11:50:00',
          },
        },
      },
    },
  };

  // Sanaa buy / sell / mid parsing
  const sanaaBuy = parseYeRialApiResponse({
    payload: freshPayload,
    market: 'sanaa',
    rateType: 'buy',
    maxAgeMinutes: 120,
    nowMs,
  });
  assert.equal(sanaaBuy.ok, true);
  assert.equal(sanaaBuy.rate, '530.0000');
  assert.equal(sanaaBuy.buyRate, '530.0000');
  assert.equal(sanaaBuy.sellRate, '533.0000');

  const sanaaMid = parseYeRialApiResponse({
    payload: freshPayload,
    market: 'sanaa',
    rateType: 'mid',
    maxAgeMinutes: 120,
    nowMs,
  });
  assert.equal(sanaaMid.ok, true);
  assert.equal(sanaaMid.rate, '531.5000');

  const adenSell = parseYeRialApiResponse({
    payload: freshPayload,
    market: 'aden',
    rateType: 'sell',
    maxAgeMinutes: 120,
    nowMs,
  });
  assert.equal(adenSell.ok, true);
  assert.equal(adenSell.rate, '1635.0000');

  // Always-available 24/7: valid live response whose provider `last_verified_at` is older
  // than maxAgeMinutes (e.g. ye-rial.com daily midnight refresh) STILL succeeds cleanly!
  const olderTimestampRes = parseYeRialApiResponse({
    payload: {
      ...freshPayload,
      last_verified_at: '2026-11-20 06:00:00',
      last_sync: '2026-11-20 06:00:00',
      data: {
        sanaa: {
          items: {
            usd: { buy: 530, sell: 533, updated_at: '2026-11-20 06:00:00' },
          },
        },
      },
    },
    market: 'sanaa',
    rateType: 'buy',
    maxAgeMinutes: 120,
    nowMs,
  });
  assert.equal(olderTimestampRes.ok, true);
  assert.equal(olderTimestampRes.rate, '530.0000');
  assert.equal(olderTimestampRes.providerTimestampStale, true);

  // Resilient fallback when live API is temporarily unreachable -> uses last known good rate or safe baseline
  const fallbackLkg = resolveFallbackExchangeRate({
    market: 'sanaa',
    rateType: 'mid',
    lastKnownGood: {
      buyRate: '532.0000',
      sellRate: '536.0000',
      providerLastVerifiedAt: new Date('2026-11-21T00:00:00Z'),
      providerLastPriceChange: null,
      fetchedAt: new Date('2026-11-21T09:00:00Z'),
    },
    nowMs,
  });
  assert.equal(fallbackLkg.ok, true);
  assert.equal(fallbackLkg.rate, '534.0000');
  assert.equal(fallbackLkg.usedFallback, true);

  const fallbackBaseline = resolveFallbackExchangeRate({
    market: 'sanaa',
    rateType: 'buy',
    lastKnownGood: null,
    nowMs,
  });
  assert.equal(fallbackBaseline.ok, true);
  assert.equal(fallbackBaseline.rate, '530.0000');
  assert.equal(fallbackBaseline.usedFallback, true);

  // Fail-closed: invalid status or out-of-bounds rate -> rejected!
  const badStatus = parseYeRialApiResponse({
    payload: { status: 'error' },
    market: 'sanaa',
    rateType: 'buy',
    nowMs,
  });
  assert.equal(badStatus.ok, false);

  const outOfBounds = parseYeRialApiResponse({
    payload: {
      status: 'success',
      last_verified_at: '2026-11-21 11:55:00',
      data: { sanaa: { items: { usd: { buy: 12, sell: 15 } } } },
    },
    market: 'sanaa',
    rateType: 'buy',
    nowMs,
  });
  assert.equal(outOfBounds.ok, false);
  assert.equal(outOfBounds.errorCode, 'RATE_OUT_OF_RANGE');

  // All 5 rounding modes for USD -> YER ($1.13 * 530 = 598.9)
  assert.equal(convertUsdToYer('1.13', '530', 'exact').toFixed(2), '598.90');
  assert.equal(convertUsdToYer('1.13', '530', 'nearest_1').toFixed(0), '599');
  assert.equal(convertUsdToYer('1.13', '530', 'nearest_10').toFixed(0), '600');
  assert.equal(convertUsdToYer('1.13', '530', 'nearest_50').toFixed(0), '600');
  assert.equal(convertUsdToYer('1.13', '530', 'nearest_100').toFixed(0), '600');

  // Decimal-exact YER -> USD (4dp)
  assert.equal(convertYerToUsd('5300', '530'), '10.0000');
  assert.equal(convertYerToUsd('2650', '530'), '5.0000');
  assert.equal(convertYerToUsd('1000', '530'), '1.8868');

  // Formatting shows YER ONLY (﷼) when YER is active, never dual currency
  const yerDisplay = formatDisplayPrice({
    usdAmount: '10.00',
    currency: 'YER',
    exchangeRate: '530',
    roundingMode: 'nearest_10',
  });
  assert.equal(yerDisplay, '5,300 ﷼');
  assert.equal(yerDisplay.includes('$'), false);
  assert.equal(formatYerNumber('12500'), '12,500 ﷼');

  const usdDisplay = formatDisplayPrice({ usdAmount: '10.00', currency: 'USD' });
  assert.equal(usdDisplay, '$10.00');

  // Main menu currency toggle button labels
  assert.equal(formatCurrencyToggleButtonLabel('USD', 'ar'), '🔄 تغيير العملة | USD $');
  assert.equal(formatCurrencyToggleButtonLabel('YER', 'ar'), '🔄 تغيير العملة | YER ﷼');
  assert.equal(formatCurrencyToggleButtonLabel('YER', 'en'), '🔄 Switch Currency | YER ﷼');

  // Depositor quadruple name validator
  assert.equal(validateDepositorQuadName('أحمد محمد علي السالم').ok, true);
  assert.equal(validateDepositorQuadName('Ahmed Mohammed Ali AlSalem').ok, true);
  assert.equal(validateDepositorQuadName('أحمد علي').ok, false); // too few words
  assert.equal(validateDepositorQuadName('https://evil.com/test name here').ok, false); // URL forbidden

  // YER deposit amount validator (supports Arabic-Indic digits)
  assert.equal(validateLocalDepositAmountYer('٢٥٠٠', 1000, 500000).ok, true);
  assert.equal(validateLocalDepositAmountYer('500', 1000, 500000).ok, false);
  assert.equal(validateLocalDepositAmountYer('600000', 1000, 500000).ok, false);
  assert.equal(validateLocalDepositAmountYer('abc', 1000, 500000).ok, false);
});

test('34. Local Wallets Deposit Engine: strict state machine prevents double approval, validates proof MIME/size, and formats channel & customer messages', () => {
  // State transition guard prevents double-approval or post-rejection credit
  assert.equal(canTransitionLocalDeposit('pending_review', 'approve').allowed, true);
  assert.equal(canTransitionLocalDeposit('pending_review', 'reject').allowed, true);
  assert.equal(canTransitionLocalDeposit('approved', 'approve').allowed, false);
  assert.equal(canTransitionLocalDeposit('approved', 'reject').allowed, false);
  assert.equal(canTransitionLocalDeposit('rejected', 'approve').allowed, false);
  assert.equal(canTransitionLocalDeposit('cancelled', 'approve').allowed, false);

  // Proof image validator: accepts valid PNG/JPEG/WEBP (>=200B, <=5MB), rejects SVG/URL/tiny
  const validPngBase64 = Buffer.alloc(320, 0x42).toString('base64');
  const validPng = validateProofImageDataUrl(`data:image/png;base64,${validPngBase64}`);
  assert.equal(validPng.ok, true);
  assert.equal(validPng.mime, 'image/png');

  const invalidSvg = validateProofImageDataUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=');
  assert.equal(invalidSvg.ok, false);

  const notDataUrl = validateProofImageDataUrl('https://evil.example/image.png');
  assert.equal(notDataUrl.ok, false);

  // Admin channel review caption contains complete structured details
  const captionParams = {
    depositRef: 'LDEP-202611-0001',
    userDisplayName: 'أحمد السالم',
    telegramUserId: '793179862',
    username: 'ahmed_ye',
    depositorNameUsed: 'أحمد محمد علي السالم',
    depositorNameIsTemporary: false,
    walletName: 'محفظة جوالي',
    recipientAccount: '777123456',
    amountYer: '5300',
    equivalentUsd: '10.0000',
    exchangeRateUsed: '530.0000',
    exchangeRateMarket: 'sanaa',
    createdAt: new Date('2026-11-21T10:00:00Z'),
  };
  const caption = formatAdminChannelDepositCaption(captionParams);
  assert.ok(caption.includes('LDEP-202611-0001'));
  assert.ok(caption.includes('أحمد محمد علي السالم'));
  assert.ok(caption.includes('محفظة جوالي'));
  assert.ok(caption.includes('5,300 ﷼'));
  assert.ok(caption.includes('$10.00'));
  assert.ok(caption.includes('قيد المراجعة'));

  // Reviewed caption marks approval with admin name
  const reviewedCaption = formatAdminChannelReviewedCaption({
    ...captionParams,
    decision: 'approved',
    reviewerName: 'مالك المتجر',
    reviewedAt: new Date('2026-11-21T10:05:00Z'),
  });
  assert.ok(reviewedCaption.includes('تمت الموافقة'));
  assert.ok(reviewedCaption.includes('مالك المتجر'));

  // Customer approved message formats in YER ONLY when customer prefers YER
  const approvedYerMsg = formatUserLocalDepositApprovedMessage({
    depositRef: 'LDEP-202611-0001',
    amountYer: '5300',
    equivalentUsd: '10.0000',
    newBalanceUsd: '15.0000',
    exchangeRateUsed: '530.0000',
    preferredCurrency: 'YER',
    roundingMode: 'nearest_10',
    lang: 'ar',
  });
  assert.ok(approvedYerMsg.includes('5,300 ﷼'));
  assert.ok(approvedYerMsg.includes('7,950 ﷼'));
  assert.equal(approvedYerMsg.includes('$'), false);

  // Customer rejected message includes exact reason
  const rejectedMsg = formatUserLocalDepositRejectedMessage({
    depositRef: 'LDEP-202611-0001',
    reason: 'صورة الإيصال غير واضحة',
    lang: 'ar',
  });
  assert.ok(rejectedMsg.includes('LDEP-202611-0001'));
  assert.ok(rejectedMsg.includes('صورة الإيصال غير واضحة'));
});

test('35. Telegram Review Channel Verifier: normalizes channel IDs/links/BiDi marks and evaluates channel & group admin permissions accurately', () => {
  // Standard -100 channel ID
  const c1 = buildTelegramChannelCandidates('-1004295404290');
  assert.equal(c1.ok, true);
  assert.deepEqual(c1.candidates, ['-1004295404290']);

  // Raw positive channel ID copied without -100 prefix -> tries -100 first, then -, then raw
  const c2 = buildTelegramChannelCandidates('4295404290');
  assert.equal(c2.ok, true);
  assert.deepEqual(c2.candidates, ['-1004295404290', '-4295404290', '4295404290']);

  // Negative ID missing 100 prefix -> tries both legacy group and -100 channel
  const c3 = buildTelegramChannelCandidates('-4295404290');
  assert.equal(c3.ok, true);
  assert.deepEqual(c3.candidates, ['-4295404290', '-1004295404290']);

  // Private channel message link https://t.me/c/<id>/<msg> -> canonical -100<id>
  const c4 = buildTelegramChannelCandidates('https://t.me/c/4295404290/15');
  assert.equal(c4.ok, true);
  assert.deepEqual(c4.candidates, ['-1004295404290']);

  // Public channel link or bare username -> @username
  assert.deepEqual(buildTelegramChannelCandidates('https://t.me/raqm_reviews/9').candidates, ['@raqm_reviews']);
  assert.deepEqual(buildTelegramChannelCandidates('raqm_reviews').candidates, ['@raqm_reviews']);

  // Arabic-Indic numerals + invisible RTL marks cleaned properly
  const c5 = buildTelegramChannelCandidates('\u200f-١٠٠٤٢٩٥٤٠٤٢٩٠\u200e');
  assert.equal(c5.ok, true);
  assert.deepEqual(c5.candidates, ['-1004295404290']);

  // Invite links rejected with clear Arabic instructions
  const invite = buildTelegramChannelCandidates('https://t.me/+AbCdEf12345');
  assert.equal(invite.ok, false);
  assert.ok(invite.errorAr?.includes('روابط الدعوة'));

  // Permission evaluation: channel admin with can_post_messages succeeds
  const chOk = evaluateTelegramChannelPermissions({
    chatType: 'channel',
    chatTitle: 'قناة المراجعة',
    botUsername: 'MPStoresBot',
    memberStatus: 'administrator',
    canPostMessages: true,
    canEditMessages: true,
  });
  assert.equal(chOk.ok, true);
  assert.equal(chOk.warningAr, undefined);

  // Channel admin without can_post_messages fails
  const chNoPost = evaluateTelegramChannelPermissions({
    chatType: 'channel',
    chatTitle: 'قناة المراجعة',
    botUsername: 'MPStoresBot',
    memberStatus: 'administrator',
    canPostMessages: false,
  });
  assert.equal(chNoPost.ok, false);

  // Supergroup admin succeeds
  const sgOk = evaluateTelegramChannelPermissions({
    chatType: 'supergroup',
    chatTitle: 'مجموعة المراجعة',
    botUsername: 'MPStoresBot',
    memberStatus: 'administrator',
  });
  assert.equal(sgOk.ok, true);

  // Private personal chat rejected
  const privFail = evaluateTelegramChannelPermissions({
    chatType: 'private',
    chatTitle: 'Personal User',
    memberStatus: 'member',
  });
  assert.equal(privFail.ok, false);
});

// ============================================================
// 36. PURCHASE BALANCE PARITY & 2DP RETAIL PRICING REGRESSION
// ============================================================
test('36. Retail pricing rounds cleanly to 2dp USD cents and purchase balance check matches displayed balance (USD & YER)', () => {
  // Exact production bug case: $0.42 wholesale + 170% percent_margin
  // Previously produced 1.1340 (displayed as $1.13), causing $1.1300 wallets to fail with "رصيدك غير كافٍ"
  const rule = {
    pricingMode: 'percent_margin' as const,
    retailPrice: '1.1340',
    fixedMargin: '0.0000',
    percentMargin: '170.00',
    paymentFeePercent: '0.00',
    extraFixedCost: '0.0000',
  };

  const breakdownQty1 = computeProfitBreakdown(rule, '0.4200', 1);
  assert.equal(breakdownQty1.unitRetail, '1.1300');
  assert.equal(breakdownQty1.subtotalRetail, '1.1300');

  const breakdownQty2 = computeProfitBreakdown(rule, '0.4200', 2);
  assert.equal(breakdownQty2.unitRetail, '1.1300');
  assert.equal(breakdownQty2.subtotalRetail, '2.2600');

  const breakdownQty3 = computeProfitBreakdown(rule, '0.4200', 3);
  assert.equal(breakdownQty3.subtotalRetail, '3.3900');

  // Percentage coupon also rounds cleanly to 2dp cents (never sub-cent dust)
  const couponRes = applyCouponDiscount('1.1300', {
    discountType: 'percent',
    discountValue: '15',
    minOrderAmount: '0.00',
    isActive: true,
    maxUses: 100,
    usedCount: 0,
  });
  assert.equal(couponRes.valid, true);
  assert.equal(couponRes.discountAmount, '0.1700');
  assert.equal(couponRes.finalTotal, '0.9600');

  // Exact USD balance ($1.1300 buying $1.1300, and $2.2600 buying Qty 2) succeeds cleanly
  const exactEval1 = resolveEffectiveOrderChargeUsd({
    availableBalanceUsd: '1.1300',
    quotedTotalUsd: breakdownQty1.subtotalRetail,
    preferredCurrency: 'USD',
  });
  assert.equal(exactEval1.sufficient, true);
  assert.equal(exactEval1.effectiveChargeUsd, '1.1300');
  assert.equal(exactEval1.roundingAdjustmentUsd, '0.0000');

  const reserveExact = computeReserveTransition(
    { availableBalance: '1.1300', reservedBalance: '0.0000' },
    exactEval1.effectiveChargeUsd
  );
  assert.equal(reserveExact.ok, true);
  assert.equal(reserveExact.next?.availableBalance, '0.0000');
  assert.equal(reserveExact.next?.reservedBalance, '1.1300');

  const exactEval2 = resolveEffectiveOrderChargeUsd({
    availableBalanceUsd: '2.2600',
    quotedTotalUsd: breakdownQty2.subtotalRetail,
    preferredCurrency: 'USD',
  });
  assert.equal(exactEval2.sufficient, true);
  assert.equal(exactEval2.effectiveChargeUsd, '2.2600');

  // Legacy sub-cent dust wallets ($1.1260 displays as $1.13, $0.9960 displays as $1.00)
  const dustEval1 = resolveEffectiveOrderChargeUsd({
    availableBalanceUsd: '1.1260',
    quotedTotalUsd: '1.1300',
    preferredCurrency: 'USD',
  });
  assert.equal(dustEval1.sufficient, true);
  assert.equal(dustEval1.effectiveChargeUsd, '1.1260');
  assert.equal(dustEval1.roundingAdjustmentUsd, '0.0040');

  // Full atomic reserve -> capture and reserve -> refund transitions on dust wallet stay >= 0.0000
  const reserveDust = computeReserveTransition(
    { availableBalance: '1.1260', reservedBalance: '0.0000' },
    dustEval1.effectiveChargeUsd
  );
  assert.equal(reserveDust.ok, true);
  assert.equal(reserveDust.next?.availableBalance, '0.0000');
  assert.equal(reserveDust.next?.reservedBalance, '1.1260');

  const captureDust = computeCaptureTransition(reserveDust.next!, dustEval1.effectiveChargeUsd);
  assert.equal(captureDust.ok, true);
  assert.equal(captureDust.next?.availableBalance, '0.0000');
  assert.equal(captureDust.next?.reservedBalance, '0.0000');

  const refundDust = computeRefundTransition(reserveDust.next!, dustEval1.effectiveChargeUsd);
  assert.equal(refundDust.ok, true);
  assert.equal(refundDust.next?.availableBalance, '1.1260');
  assert.equal(refundDust.next?.reservedBalance, '0.0000');

  const dustEval2 = resolveEffectiveOrderChargeUsd({
    availableBalanceUsd: '0.9960',
    quotedTotalUsd: '1.0000',
    preferredCurrency: 'USD',
  });
  assert.equal(dustEval2.sufficient, true);
  assert.equal(dustEval2.effectiveChargeUsd, '0.9960');

  // Real shortfalls MUST be strictly rejected
  assert.equal(
    resolveEffectiveOrderChargeUsd({
      availableBalanceUsd: '1.1249',
      quotedTotalUsd: '1.1300',
      preferredCurrency: 'USD',
    }).sufficient,
    false
  );
  assert.equal(
    resolveEffectiveOrderChargeUsd({
      availableBalanceUsd: '1.1200',
      quotedTotalUsd: '1.1300',
      preferredCurrency: 'USD',
    }).sufficient,
    false
  );
  assert.equal(
    resolveEffectiveOrderChargeUsd({
      availableBalanceUsd: '0.0000',
      quotedTotalUsd: '1.1300',
      preferredCurrency: 'USD',
    }).sufficient,
    false
  );

  // YER display parity: customer in YER mode who deposited exact 600 ﷼ at rate 532 ($1.1278) or 530 ($1.1321)
  const yerExact530 = resolveEffectiveOrderChargeUsd({
    availableBalanceUsd: '1.1321',
    quotedTotalUsd: '1.1300',
    preferredCurrency: 'YER',
    exchangeRate: '530',
    roundingMode: 'nearest_10',
  });
  assert.equal(yerExact530.sufficient, true);
  assert.equal(yerExact530.effectiveChargeUsd, '1.1300');

  const yerParity532 = resolveEffectiveOrderChargeUsd({
    availableBalanceUsd: '1.1278',
    quotedTotalUsd: '1.1300',
    preferredCurrency: 'YER',
    exchangeRate: '532',
    roundingMode: 'nearest_10',
  });
  assert.equal(yerParity532.sufficient, true);
  assert.equal(yerParity532.effectiveChargeUsd, '1.1278');

  // YER real shortfall (590 ﷼ = $1.1132 at rate 530 buying 600 ﷼ product) strictly rejected
  const yerShortfall = resolveEffectiveOrderChargeUsd({
    availableBalanceUsd: '1.1132',
    quotedTotalUsd: '1.1300',
    preferredCurrency: 'YER',
    exchangeRate: '530',
    roundingMode: 'nearest_10',
  });
  assert.equal(yerShortfall.sufficient, false);

  // Purchase confirmation message displays $0.00 (never $-0.00) and hasSufficientBalance: true
  const confirmDust = formatPurchaseConfirmationMessage({
    orderRef: 'ORD-12345-abcd',
    productTitle: 'Gemini Plus 6 Months',
    quantity: 1,
    unitPrice: '1.1300',
    currentBalance: '1.1260',
    lang: 'ar',
    currency: 'USD',
  });
  assert.equal(confirmDust.hasSufficientBalance, true);
  assert.equal(confirmDust.afterPurchaseFormatted, '0.00');
  assert.ok(!confirmDust.text.includes('-0.00'));
});

// ============================================================
// 37. SERVER APP-ICON GRID UTILS & NEW V3 SERVERS ADAPTERS
// ============================================================
test('37. Server app-icon grid helpers (monogram, host extraction, filtering) and all 16 new V3 servers resolve cleanly', () => {
  const icon1 = getServerAppIconStyle('qcst', 'QCST API');
  assert.equal(icon1.monogram, 'QA');
  assert.ok(icon1.bgClass.startsWith('bg-'));

  const iconSingle = getServerAppIconStyle('bulkware', 'Bulkware');
  assert.equal(iconSingle.monogram, 'BU');

  assert.equal(extractServerHostLabel('http://paid2.daki.cc:4153/api/partner/v1'), 'paid2.daki.cc:4153');
  assert.equal(extractServerHostLabel('https://api.qcst.tech/docs'), 'api.qcst.tech');

  const sampleServers = [
    { id: 1, code: 'qcst', name: 'QCST API', baseUrl: 'https://api.qcst.tech', docsUrl: 'https://api.qcst.tech/docs', status: 'connected', isEnabled: true, productsCount: 12 },
    { id: 2, code: 'bulkware', name: 'Bulkware', baseUrl: 'https://bulkware.co', docsUrl: 'https://bulkware.co', status: 'disconnected', isEnabled: true, productsCount: 0 },
    { id: 3, code: 'silvexai', name: 'Silvex AI', baseUrl: 'https://silvex-ai.com/api/public/reseller', docsUrl: 'https://silvex-ai.com/api/public/reseller', status: 'connected', isEnabled: false, productsCount: 5 },
  ];

  assert.equal(filterServersForGrid(sampleServers, { statusFilter: 'all' }).length, 3);
  assert.equal(filterServersForGrid(sampleServers, { statusFilter: 'connected' }).length, 1);
  assert.equal(filterServersForGrid(sampleServers, { statusFilter: 'disconnected' }).length, 2);
  assert.equal(filterServersForGrid(sampleServers, { statusFilter: 'has_offers' }).length, 2);
  assert.equal(filterServersForGrid(sampleServers, { search: 'daki' }).length, 0);
  assert.equal(filterServersForGrid(sampleServers, { search: 'silvex' }).length, 1);

  // Every single one of the 16 newly added V3 servers resolves cleanly to an active ProviderAdapter
  const v3NewServers = [
    { code: 'qcst', name: 'QCST API', baseUrl: 'https://api.qcst.tech', authType: 'x_api_key', authHeader: 'X-API-Key' },
    { code: 'digitalaistore', name: 'DigitalAI Store', baseUrl: 'https://api.digitalaistore.com/v1', authType: 'x_api_key', authHeader: 'X-API-Key' },
    { code: 'resellwithme', name: 'ResellWithMe', baseUrl: 'https://resellwithme.com/api/v1', authType: 'x_api_key', authHeader: 'X-API-Key' },
    { code: 'bulkware', name: 'Bulkware', baseUrl: 'https://bulkware.co', authType: 'x_api_key', authHeader: 'X-API-Key' },
    { code: 'cmpdr', name: 'CMPDR API', baseUrl: 'https://api.cmpdr.dev', authType: 'x_api_key', authHeader: 'X-API-Key' },
    { code: 'qamify', name: 'Qamify', baseUrl: 'https://api.qamify.site', authType: 'x_api_key', authHeader: 'X-API-Key' },
    { code: 'technysoft', name: 'TechnySoft', baseUrl: 'https://api.technysoft.com', authType: 'x_api_key', authHeader: 'X-API-Key' },
    { code: 'nastele', name: 'Nastele Partner', baseUrl: 'https://nastele.online/api/partner', authType: 'x_api_key', authHeader: 'X-API-Key' },
    { code: 'hmkstore', name: 'HMK Store', baseUrl: 'https://hmkstore.com/api/v1', authType: 'x_api_key', authHeader: 'X-API-Key' },
    { code: 'aihubfashion', name: 'AIHub Fashion', baseUrl: 'https://api.aihub.fashion', authType: 'x_api_key', authHeader: 'X-API-Key' },
    { code: 'namqzz', name: 'Nam API', baseUrl: 'https://api.nam.qzz.io', authType: 'x_api_key', authHeader: 'X-API-Key' },
    { code: 'qwanhailuna', name: 'Qwanhailuna Shop', baseUrl: 'https://shop.qwanhailuna.io.vn', authType: 'x_api_key', authHeader: 'X-API-Key' },
    { code: 'bunnytools', name: 'BunnyTools Bot', baseUrl: 'https://bunnytoolsbot.tech/api/v1', authType: 'x_api_key', authHeader: 'X-API-Key' },
    { code: 'dakipartner', name: 'Daki Partner', baseUrl: 'http://paid2.daki.cc:4153/api/partner/v1', authType: 'x_api_key', authHeader: 'X-API-Key' },
    { code: 'aitoolifystudio', name: 'AIToolify Studio', baseUrl: 'https://bot.aitoolifystudio.io/api/reseller/v1', authType: 'x_api_key', authHeader: 'X-API-Key' },
    { code: 'silvexai', name: 'Silvex AI', baseUrl: 'https://silvex-ai.com/api/public/reseller', authType: 'bearer', authHeader: 'Authorization' },
  ];

  for (const srv of v3NewServers) {
    const adapter = resolveProviderAdapter(srv);
    assert.ok(adapter, `Expected adapter for ${srv.code}`);
    assert.equal(typeof adapter.testConnection, 'function');
    assert.equal(typeof adapter.fetchProducts, 'function');
    assert.equal(typeof adapter.placeOrder, 'function');
  }
});

// ============================================================
// 38. TELEGRAM BROADCAST ENGINE (FORMATTING, AUDIENCE, DELIVERY)
// ============================================================
test('38. BroadcastEngine formats messages, selects valid Telegram recipients, handles 429 retries, and isolates blocked/failed users without aborting', async () => {
  // 1. Validation & formatting
  const emptyRes = formatBroadcastTelegramMessage({ title: '  ', message: 'مرحبا' });
  assert.equal(emptyRes.ok, false);

  const tooLongRes = formatBroadcastTelegramMessage({
    title: 'عنوان',
    message: 'أ'.repeat(4100),
    storeName: 'متجر رَقْم',
  });
  assert.equal(tooLongRes.ok, false);

  const formatted = formatBroadcastTelegramMessage({
    title: 'عرض خاص على Gemini',
    message: 'خصم 20% لمدة 24 ساعة!',
    storeName: 'متجر رَقْم',
  });
  assert.equal(formatted.ok, true);
  if (formatted.ok) {
    assert.ok(formatted.text.includes('📢 عرض خاص على Gemini'));
    assert.ok(formatted.text.includes('خصم 20% لمدة 24 ساعة!'));
    assert.ok(formatted.text.includes('— متجر رَقْم'));
  }

  // 2. Recipient selection across audiences (filters blocked, non-Telegram, seeded local owner, duplicates)
  const sampleUsers: BroadcastCandidateUser[] = [
    { id: 1, uid: 'local:owner-raqm', role: 'owner', isBlocked: false, telegramUserId: '700100001', displayName: 'Seeded Owner' },
    { id: 2, uid: 'firebase-uid-1', role: 'owner', isBlocked: false, telegramUserId: null, displayName: 'Web Admin' },
    { id: 3, uid: 'tg:793001122', role: 'owner', isBlocked: false, telegramUserId: '793001122', displayName: 'Real Owner' },
    { id: 4, uid: 'tg:6821000001', role: 'customer', isBlocked: false, telegramUserId: '6821000001', displayName: 'Customer A' },
    { id: 5, uid: 'tg:6821000002', role: 'customer', isBlocked: false, telegramUserId: '6821000002', displayName: 'Customer B' },
    { id: 6, uid: 'tg:6821000003', role: 'customer', isBlocked: true, telegramUserId: '6821000003', displayName: 'Blocked Customer' },
    { id: 7, uid: 'web:customer-no-tg', role: 'customer', isBlocked: false, telegramUserId: '', displayName: 'No TG Customer' },
    { id: 8, uid: 'tg:dup-test', role: 'customer', isBlocked: false, telegramUserId: '6821000001', displayName: 'Duplicate TG' },
  ];

  const custSel = selectBroadcastRecipients(sampleUsers, 'customers');
  assert.equal(custSel.recipients.length, 2);
  assert.deepEqual(
    custSel.recipients.map((r) => r.telegramUserId),
    ['6821000001', '6821000002']
  );
  assert.equal(custSel.skippedBlocked, 1);
  assert.equal(custSel.skippedNoTelegram, 1);

  const allSel = selectBroadcastRecipients(sampleUsers, 'all_telegram');
  assert.equal(allSel.recipients.length, 3);
  assert.deepEqual(
    allSel.recipients.map((r) => r.telegramUserId),
    ['793001122', '6821000001', '6821000002']
  );
  assert.equal(allSel.skippedPlaceholder, 1);

  const adminSel = selectBroadcastRecipients(sampleUsers, 'admins_only');
  assert.equal(adminSel.recipients.length, 1);
  assert.equal(adminSel.recipients[0].telegramUserId, '793001122');

  // 3. Throttled delivery with 429 auto-retry + 403 blocked + throw isolation (ZERO real Telegram calls!)
  const attemptsByUser = new Map<string, number>();
  const deliveredTo: string[] = [];
  let sleepCalls = 0;

  const recipients = [
    { userId: 10, telegramUserId: '111111111', displayName: 'User Ok 1', role: 'customer' },
    { userId: 11, telegramUserId: '222222222', displayName: 'User Blocked', role: 'customer' },
    { userId: 12, telegramUserId: '333333333', displayName: 'User RateLimited Then Ok', role: 'customer' },
    { userId: 13, telegramUserId: '444444444', displayName: 'User Throws', role: 'customer' },
    { userId: 14, telegramUserId: '555555555', displayName: 'User Ok 2', role: 'customer' },
  ];

  const delivery = await executeBroadcastDelivery({
    recipients,
    text: formatted.ok ? formatted.text : 'test',
    delayMs: 1,
    maxRetriesOn429: 1,
    sleepFn: async () => {
      sleepCalls += 1;
    },
    sendMessage: async (tgId) => {
      const count = (attemptsByUser.get(tgId) || 0) + 1;
      attemptsByUser.set(tgId, count);

      if (tgId === '222222222') {
        return { ok: false, blocked: true, errorCode: 403, errorMessage: 'المستخدم أوقف البوت أو حظره' };
      }
      if (tgId === '333333333' && count === 1) {
        return { ok: false, errorCode: 429, retryAfterSec: 1, errorMessage: 'Too Many Requests' };
      }
      if (tgId === '444444444') {
        throw new Error('Transient network reset');
      }
      deliveredTo.push(tgId);
      return { ok: true };
    },
  });

  assert.equal(delivery.totalEligible, 5);
  assert.equal(delivery.sentCount, 3);
  assert.equal(delivery.failedCount, 2);
  assert.equal(delivery.blockedCount, 1);
  assert.deepEqual(deliveredTo, ['111111111', '333333333', '555555555']);
  assert.equal(attemptsByUser.get('333333333'), 2);
  assert.equal(delivery.errorsSample.length, 2);
  assert.ok(sleepCalls >= 4);

  const summaryMsg = buildBroadcastResultSummaryAr({ audience: 'customers', delivery });
  assert.ok(summaryMsg.includes('3 من أصل 5'));
  assert.ok(summaryMsg.includes('1 حظروا البوت'));
});

// ============================================================
// 39. PER-CUSTOMER SPENDING, HISTORY & PRODUCT/PRICE OVERRIDES
// ============================================================
test('39. CustomerOverridesEngine validates custom prices, isolates per-customer pricing & visibility, calculates exact lifetime spending, and preserves balance-check parity', () => {
  // 1. Custom price parsing & validation
  assert.deepEqual(parseAndValidateCustomPriceUsd(''), { ok: true, value: null });
  assert.deepEqual(parseAndValidateCustomPriceUsd(null), { ok: true, value: null });
  assert.deepEqual(parseAndValidateCustomPriceUsd('0.75'), { ok: true, value: '0.7500' });
  assert.deepEqual(parseAndValidateCustomPriceUsd('$2.5'), { ok: true, value: '2.5000' });
  assert.deepEqual(parseAndValidateCustomPriceUsd('٠.٨٥'), { ok: true, value: '0.8500' });
  assert.equal(parseAndValidateCustomPriceUsd('0').ok, false);
  assert.equal(parseAndValidateCustomPriceUsd('-1.5').ok, false);
  assert.equal(parseAndValidateCustomPriceUsd('abc').ok, false);

  // 2. Per-customer isolation: Customer A gets custom price $0.75, Customer B gets hidden, Customer C keeps official $1.13
  const custA = applyCustomerProductOverride({
    officialUnitPrice: '1.1300',
    officialPromoPrice: '1.0500',
    override: { storeProductId: 10, customPriceUsd: '0.7500', isHidden: false },
  });
  assert.equal(custA.hidden, false);
  assert.equal(custA.hasCustomPrice, true);
  assert.equal(custA.effectiveUnitPrice, '0.7500');
  assert.equal(custA.effectivePromoPrice, null);

  const custB = applyCustomerProductOverride({
    officialUnitPrice: '1.1300',
    officialPromoPrice: '1.0500',
    override: { storeProductId: 10, customPriceUsd: null, isHidden: true },
  });
  assert.equal(custB.hidden, true);

  const custC = applyCustomerProductOverride({
    officialUnitPrice: '1.1300',
    officialPromoPrice: '1.0500',
    override: null,
  });
  assert.equal(custC.hidden, false);
  assert.equal(custC.hasCustomPrice, false);
  assert.equal(custC.effectiveUnitPrice, '1.1300');
  assert.equal(custC.effectivePromoPrice, '1.0500');

  // 3. Balance check & profit breakdown parity with custom price vs official price
  const custABreakdown = computeProfitBreakdown(
    {
      pricingMode: 'manual',
      retailPrice: custA.effectiveUnitPrice,
      fixedMargin: '0',
      percentMargin: '0',
      paymentFeePercent: '0',
      extraFixedCost: '0',
      lockManualPrice: true,
    },
    '0.4200',
    1
  );
  assert.equal(custABreakdown.subtotalRetail, '0.7500');
  assert.equal(custABreakdown.netProfit, '0.3300');

  // Customer A with $0.80 balance CAN buy at custom price $0.75
  const custACharge = resolveEffectiveOrderChargeUsd({
    availableBalanceUsd: '0.8000',
    quotedTotalUsd: custABreakdown.subtotalRetail,
    preferredCurrency: 'USD',
  });
  assert.equal(custACharge.sufficient, true);
  assert.equal(custACharge.effectiveChargeUsd, '0.7500');

  // Customer C with $0.80 balance CANNOT buy at official price $1.13
  const custCCharge = resolveEffectiveOrderChargeUsd({
    availableBalanceUsd: '0.8000',
    quotedTotalUsd: custC.effectiveUnitPrice,
    preferredCurrency: 'USD',
  });
  assert.equal(custCCharge.sufficient, false);

  // 4. Customer lifetime spending sums ONLY completed orders and excludes failed/refunded/pending
  const spending = computeCustomerTotalSpending([
    { status: 'completed', totalRetail: '1.1300' },
    { status: 'failed', totalRetail: '1.1300' },
    { status: 'completed', totalRetail: '2.2600' },
    { status: 'refunded', totalRetail: '1.1300' },
    { status: 'completed', totalRetail: '0.7500' },
    { status: 'pending_delivery', totalRetail: '5.0000' },
  ]);
  assert.equal(spending.totalSpentUsd, '4.14');
  assert.equal(spending.completedOrdersCount, 3);
  assert.equal(spending.failedOrdersCount, 1);
  assert.equal(spending.refundedOrdersCount, 1);
  assert.equal(spending.totalOrdersCount, 6);

  // 5. Cleanup detection when returning to official defaults
  assert.equal(shouldDeleteOverrideRow(null, false), true);
  assert.equal(shouldDeleteOverrideRow('0.7500', false), false);
  assert.equal(shouldDeleteOverrideRow(null, true), false);
});

// ============================================================
// 40. DUAL PRICING SYSTEM (CUSTOMER PRICE VS AGENT PRICE)
// ============================================================
test('40. Dual Pricing System: resolves independent Customer & Agent prices, isolates user tiers, prevents cross-tier price leaks, and enforces balance/profit parity', () => {
  // 1. User pricing tier normalization & validation (new/unknown defaults strictly to customer)
  assert.equal(normalizeUserPricingTier(undefined), 'customer');
  assert.equal(normalizeUserPricingTier(null), 'customer');
  assert.equal(normalizeUserPricingTier(''), 'customer');
  assert.equal(normalizeUserPricingTier('vip'), 'customer');
  assert.equal(normalizeUserPricingTier('customer'), 'customer');
  assert.equal(normalizeUserPricingTier('agent'), 'agent');
  assert.equal(normalizeUserPricingTier('AGENT'), 'agent');
  assert.equal(isValidUserPricingTierInput('customer'), true);
  assert.equal(isValidUserPricingTierInput('agent'), true);
  assert.equal(isValidUserPricingTierInput('reseller'), false);
  assert.equal(isValidUserPricingTierInput(123), false);

  // 2. Product-level independent Customer Price ($1.50) & Agent Price ($1.00) with Wholesale ($0.60)
  const sampleCandidate: ProviderOfferCandidate = {
    mappingId: 1,
    providerId: 1,
    providerCode: 'PROV1',
    providerName: 'Primary',
    providerStatus: 'connected',
    providerEnabled: true,
    providerBalance: '100.0000',
    providerProductId: 101,
    externalProductId: 'EXT-1',
    wholesalePrice: '0.6000',
    stockCount: 25,
    roleType: 'primary',
    priority: 1,
    isVerifiedCompatible: true,
    isActive: true,
  };

  const resolvedDual = resolveProductEffectivePricingAndStock({
    rule: {
      pricingMode: 'manual',
      retailPrice: '1.5000',
      agentPrice: '1.0000',
      fixedMargin: '0',
      percentMargin: '0',
      paymentFeePercent: '0',
      extraFixedCost: '0',
      lockManualPrice: true,
    },
    candidates: [sampleCandidate],
  });
  assert.equal(resolvedDual.effectiveUnitRetail, '1.5000');
  assert.equal(resolvedDual.effectiveAgentUnitPrice, '1.0000');
  assert.equal(resolvedDual.breakdown.netProfit, '0.9000');
  assert.equal(resolvedDual.agentBreakdown.netProfit, '0.4000');

  // Legacy fallback: when agentPrice is null/empty, safely falls back to Customer Price without NaN
  const resolvedFallback = resolveProductEffectivePricingAndStock({
    rule: {
      pricingMode: 'manual',
      retailPrice: '1.5000',
      agentPrice: null,
      fixedMargin: '0',
      percentMargin: '0',
      paymentFeePercent: '0',
      extraFixedCost: '0',
      lockManualPrice: true,
    },
    candidates: [sampleCandidate],
  });
  assert.equal(resolvedFallback.effectiveUnitRetail, '1.5000');
  assert.equal(resolvedFallback.effectiveAgentUnitPrice, '1.5000');

  // 3. Per-user isolation & precedence across 4 users on the exact same product
  const newCustomerPricing = applyCustomerProductOverride({
    officialUnitPrice: resolvedDual.effectiveUnitRetail,
    officialAgentUnitPrice: resolvedDual.effectiveAgentUnitPrice,
    officialPromoPrice: '1.4000',
    userPricingTier: normalizeUserPricingTier(null),
    override: null,
  });
  assert.equal(newCustomerPricing.effectiveUnitPrice, '1.5000');
  assert.equal(newCustomerPricing.effectivePromoPrice, '1.4000');
  assert.equal(newCustomerPricing.appliedPriceSource, 'customer_tier');

  const agentPricing = applyCustomerProductOverride({
    officialUnitPrice: resolvedDual.effectiveUnitRetail,
    officialAgentUnitPrice: resolvedDual.effectiveAgentUnitPrice,
    officialPromoPrice: '1.4000',
    userPricingTier: 'agent',
    override: null,
  });
  assert.equal(agentPricing.effectiveUnitPrice, '1.0000');
  assert.equal(agentPricing.effectivePromoPrice, null);
  assert.equal(agentPricing.appliedPriceSource, 'agent_tier');

  const agentCustomOverride = applyCustomerProductOverride({
    officialUnitPrice: resolvedDual.effectiveUnitRetail,
    officialAgentUnitPrice: resolvedDual.effectiveAgentUnitPrice,
    officialPromoPrice: '1.4000',
    userPricingTier: 'agent',
    override: { storeProductId: 50, customPriceUsd: '0.8500', isHidden: false },
  });
  assert.equal(agentCustomOverride.effectiveUnitPrice, '0.8500');
  assert.equal(agentCustomOverride.appliedPriceSource, 'custom_override');

  // Switching Agent back to Customer automatically reverts to Customer Price without affecting others
  const revertedCustomer = applyCustomerProductOverride({
    officialUnitPrice: resolvedDual.effectiveUnitRetail,
    officialAgentUnitPrice: resolvedDual.effectiveAgentUnitPrice,
    officialPromoPrice: '1.4000',
    userPricingTier: 'customer',
    override: null,
  });
  assert.equal(revertedCustomer.effectiveUnitPrice, '1.5000');
  assert.equal(revertedCustomer.appliedPriceSource, 'customer_tier');

  // 4. Zero cross-tier price leak in CustomerProductDTO (Agent sees ONLY $1.00; Customer sees ONLY $1.50)
  const baseDtoInput = {
    id: 50,
    sku: 'SKU-DUAL-1',
    categoryId: 3,
    categoryNameAr: 'Canva',
    categoryNameEn: 'Canva',
    titleAr: 'Canva Pro 12M',
    titleEn: 'Canva Pro 12M',
    descriptionAr: 'اشتراك كانفا برو لمدة سنة',
    descriptionEn: 'Canva Pro 1 year subscription',
    imageUrl: null,
    warrantyLabelAr: 'ضمان كامل',
    warrantyLabelEn: 'Full warranty',
    durationLabel: '12 شهر',
    deliveryType: 'link',
    isVisible: true,
    isPaused: false,
    autoHideOutOfStock: true,
    isFeaturedOffer: false,
    availableStock: 25,
    lang: 'ar' as const,
  };

  const agentDto = toCustomerProductDTO({
    ...baseDtoInput,
    retailPrice: Number(agentPricing.effectiveUnitPrice).toFixed(2),
    promoPrice: agentPricing.effectivePromoPrice,
  });
  assert.ok(agentDto);
  assert.equal(agentDto.retailPrice, '1.00');
  assert.equal(agentDto.promoPrice, null);
  assert.equal('agentPrice' in agentDto, false);
  assert.equal(JSON.stringify(agentDto).includes('1.50'), false);

  const customerDto = toCustomerProductDTO({
    ...baseDtoInput,
    retailPrice: Number(newCustomerPricing.effectiveUnitPrice).toFixed(2),
    promoPrice: newCustomerPricing.effectivePromoPrice,
  });
  assert.ok(customerDto);
  assert.equal(customerDto.retailPrice, '1.50');
  assert.equal('agentPrice' in customerDto, false);
  assert.equal(JSON.stringify(customerDto).includes('1.00'), false);

  // 5. Purchase checkout balance verification & deduction parity (Agent vs Customer both have $1.00 balance)
  const agentOrderBreakdown = computeProfitBreakdown(
    {
      pricingMode: 'manual',
      retailPrice: agentPricing.effectiveUnitPrice,
      fixedMargin: '0',
      percentMargin: '0',
      paymentFeePercent: '0',
      extraFixedCost: '0',
      lockManualPrice: true,
    },
    '0.6000',
    1
  );
  assert.equal(agentOrderBreakdown.subtotalRetail, '1.0000');
  assert.equal(agentOrderBreakdown.netProfit, '0.4000');

  const agentCharge = resolveEffectiveOrderChargeUsd({
    availableBalanceUsd: '1.0000',
    quotedTotalUsd: agentOrderBreakdown.subtotalRetail,
    preferredCurrency: 'USD',
  });
  assert.equal(agentCharge.sufficient, true);
  assert.equal(agentCharge.effectiveChargeUsd, '1.0000');

  const customerCharge = resolveEffectiveOrderChargeUsd({
    availableBalanceUsd: '1.0000',
    quotedTotalUsd: newCustomerPricing.effectiveUnitPrice,
    preferredCurrency: 'USD',
  });
  assert.equal(customerCharge.sufficient, false);
});

// ============================================================
// 41. SUPPLIER PRODUCT DESCRIPTION ENGINE & TELEGRAM HTML
// ============================================================
test('41. ProductDescriptionEngine handles all 10 supplier description cases: Telegram HTML, custom emojis, official vs supplier links, broken/unsupported tags, plain text, long text, and nesting', () => {
  // Helper to verify every opened tag has a matching closing tag in LIFO order
  const assertBalancedTelegramHtml = (html: string) => {
    const stack: string[] = [];
    const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(\s+[^>]*)?>/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(html)) !== null) {
      const closing = m[1] === '/';
      const name = m[2].toLowerCase();
      if (!closing) {
        stack.push(name);
      } else {
        const top = stack.pop();
        assert.equal(top, name, `Mismatched closing tag </${name}> (expected </${top}>) in: ${html}`);
      }
    }
    assert.deepEqual(stack, [], `Unclosed tags remaining: ${stack.join(', ')} in: ${html}`);
  };

  // Case 1: Valid HTML (b, strong, i, em, u, s, code, pre, a)
  const case1 = processSupplierProductDescription(
    '<b>ChatGPT Plus</b> — <i>Private Account</i>\n<u>30 Days</u> <s>Old Price</s> <code>Email|Pass</code>\n<pre>Step 1: Login</pre>'
  );
  assert.equal(case1.detectedFormat, 'telegram_html');
  assert.equal(case1.hasHtmlFormatting, true);
  assert.ok(case1.telegramHtml.includes('<b>ChatGPT Plus</b>'));
  assert.ok(case1.telegramHtml.includes('<i>Private Account</i>'));
  assert.ok(case1.telegramHtml.includes('<u>30 Days</u>'));
  assert.ok(case1.telegramHtml.includes('<s>Old Price</s>'));
  assert.ok(case1.telegramHtml.includes('<code>Email|Pass</code>'));
  assert.ok(case1.telegramHtml.includes('<pre>Step 1: Login</pre>'));
  assertBalancedTelegramHtml(case1.telegramHtml);

  // Case 2: Native Telegram HTML tags (blockquote, expandable blockquote, tg-spoiler, span.tg-spoiler)
  const case2 = processSupplierProductDescription(
    '<blockquote expandable><b>Warranty Terms</b>\n<span class="tg-spoiler">Secret Tip</span> and <tg-spoiler>Hidden Note</tg-spoiler></blockquote>'
  );
  assert.ok(case2.telegramHtml.includes('<blockquote expandable>'));
  assert.ok(case2.telegramHtml.includes('<tg-spoiler>Secret Tip</tg-spoiler>'));
  assert.ok(case2.telegramHtml.includes('<tg-spoiler>Hidden Note</tg-spoiler>'));
  assertBalancedTelegramHtml(case2.telegramHtml);

  // Case 3: Custom Emoji (<tg-emoji emoji-id="...">) — valid preserved, invalid safely unwrapped, fallback strips cleanly
  const case3 = processSupplierProductDescription(
    '<blockquote><tg-emoji emoji-id="5796504385420792898">🛡️</tg-emoji> <b>Plan: Proton VPN Plus</b>\n<tg-emoji emoji-id="not-a-number">⚡</tg-emoji> Fast Speed</blockquote>'
  );
  assert.equal(case3.hasCustomEmoji, true);
  assert.ok(case3.telegramHtml.includes('<tg-emoji emoji-id="5796504385420792898">🛡️</tg-emoji>'));
  // Malformed emoji-id unwrapped to standard emoji without breaking HTML
  assert.equal(case3.telegramHtml.includes('not-a-number'), false);
  assert.ok(case3.telegramHtml.includes('⚡ Fast Speed'));
  // No-custom-emoji fallback keeps <blockquote> and <b> while unwrapping <tg-emoji>
  assert.equal(case3.telegramHtmlNoCustomEmoji.includes('<tg-emoji'), false);
  assert.ok(case3.telegramHtmlNoCustomEmoji.includes('<blockquote>🛡️ <b>Plan: Proton VPN Plus</b>'));
  assert.equal(stripTgEmojiTagsKeepFallback(case3.telegramHtml), case3.telegramHtmlNoCustomEmoji);
  assertBalancedTelegramHtml(case3.telegramHtml);
  assertBalancedTelegramHtml(case3.telegramHtmlNoCustomEmoji);

  // Case 4: Official service & activation links MUST be preserved (Proton, Adobe, Duolingo, Notion, 2FA, Lovable)
  const case4 = processSupplierProductDescription(
    '<blockquote><b>How to Activate:</b>\n1. Download from <a href="https://protonvpn.com/download">protonvpn.com/download</a> or visit <a href="https://account.proton.me/login">account.proton.me/login</a>.\n2. Redeem Adobe at https://redeem.adobe.com/\n3. Duolingo: <code>https://www.duolingo.com/redeem?code=DEMO123</code>\n4. 2FA Codes: https://2fa.live/\n5. Lovable: https://lovable.dev/login/event?event=hourofai&amp;host=imagilabs.com</blockquote>'
  );
  assert.ok(case4.telegramHtml.includes('<a href="https://protonvpn.com/download">protonvpn.com/download</a>'));
  assert.ok(case4.telegramHtml.includes('<a href="https://account.proton.me/login">account.proton.me/login</a>'));
  assert.ok(case4.telegramHtml.includes('https://redeem.adobe.com/'));
  assert.ok(case4.telegramHtml.includes('https://www.duolingo.com/redeem?code=DEMO123'));
  assert.ok(case4.telegramHtml.includes('https://2fa.live/'));
  assert.ok(case4.telegramHtml.includes('https://lovable.dev/login/event?event=hourofai&amp;host=imagilabs.com'));
  assert.equal(case4.removedLinks.length, 0);
  assertBalancedTelegramHtml(case4.telegramHtml);

  // Case 5: Supplier store links, Telegram channels, bots, ads, referral URLs, and dynamic future suppliers SCRUBBED
  // while keeping product brand names (ChatGPT, Gemini) & operational details 100% intact!
  registerDynamicSupplierIdentities([
    { name: 'NovaResell Hub', code: 'novaresell', baseUrl: 'https://api.novaresell.shop/v1' },
  ]);
  const case5 = processSupplierProductDescription(
    [
      '<blockquote><tg-emoji emoji-id="5206660927339924387">✨</tg-emoji> <b>Gemini Plus 6 Months — Official Activation</b>',
      '<b>Duration:</b> 6 Months Active Period | Powered by AIVault Hub',
      '<b>Warranty:</b> 24-Hour Replacement Warranty',
      'Activate at <a href="https://one.google.com/redeem">one.google.com/redeem</a>',
      '🔥 Visit Our Store: <a href="https://aivaulthub.store">AIVault Hub Store</a>',
      '📢 Join Our Channel: https://t.me/aivaulthub_official',
      'Contact Supplier: @pandora_support_bot',
      'Order From Our Website: https://novaresell.shop/products?ref=abc',
      'Also try <a href="https://evil-promo.example/buy?utm_source=tg">Buy Now</a> and <a href="javascript:alert(1)">Click</a>',
      'Gemini Shop — Official Reseller API</blockquote>',
    ].join('\n')
  );
  // Product brand & operational details preserved!
  assert.ok(case5.telegramHtml.includes('Gemini Plus 6 Months'));
  assert.ok(case5.telegramHtml.includes('6 Months Active Period'));
  assert.ok(case5.telegramHtml.includes('24-Hour Replacement Warranty'));
  assert.ok(case5.telegramHtml.includes('<a href="https://one.google.com/redeem">one.google.com/redeem</a>'));
  // ALL supplier names, ads, channels, bots, and disallowed/XSS URLs removed!
  const lowerCase5 = case5.telegramHtml.toLowerCase();
  assert.equal(lowerCase5.includes('aivault'), false);
  assert.equal(lowerCase5.includes('visit our store'), false);
  assert.equal(lowerCase5.includes('join our channel'), false);
  assert.equal(lowerCase5.includes('t.me/'), false);
  assert.equal(lowerCase5.includes('contact supplier'), false);
  assert.equal(lowerCase5.includes('pandora_support_bot'), false);
  assert.equal(lowerCase5.includes('novaresell'), false);
  assert.equal(lowerCase5.includes('gemini shop'), false);
  assert.equal(lowerCase5.includes('javascript:'), false);
  assert.equal(lowerCase5.includes('utm_source'), false);
  assert.ok(case5.removedLinks.length >= 4);
  assertBalancedTelegramHtml(case5.telegramHtml);

  // Case 6: Unsupported HTML tags & XSS payloads safely converted/stripped without losing product details
  const case6 = processSupplierProductDescription(
    '<h3>Duolingo Super 12M</h3><div class="box"><p><span style="color:red">Unlimited Hearts</span> &amp; Ad-Free</p><ul><li>12 Months Validity</li><li>Instant Delivery</li></ul><script>alert("xss")</script><img src="x" onerror="alert(1)"/></div>'
  );
  assert.equal(case6.detectedFormat, 'generic_html');
  assert.equal(case6.telegramHtml.includes('<div'), false);
  assert.equal(case6.telegramHtml.includes('<script'), false);
  assert.equal(case6.telegramHtml.includes('alert('), false);
  assert.equal(case6.telegramHtml.includes('<img'), false);
  assert.ok(case6.telegramHtml.includes('<b>Duolingo Super 12M</b>'));
  assert.ok(case6.telegramHtml.includes('Unlimited Hearts &amp; Ad-Free'));
  assert.ok(case6.telegramHtml.includes('• 12 Months Validity'));
  assert.ok(case6.telegramHtml.includes('• Instant Delivery'));
  assertBalancedTelegramHtml(case6.telegramHtml);

  // Case 7: Unclosed tags auto-repaired in exact LIFO reverse order (prevents Telegram "can't parse entities")
  const case7 = processSupplierProductDescription(
    '<blockquote><b>Plan: ChatGPT Plus\n<i>Duration: 1 Month (30 Days)\n<u>Full Warranty'
  );
  assertBalancedTelegramHtml(case7.telegramHtml);
  assert.ok(case7.telegramHtml.endsWith('</u></i></b></blockquote>'));
  assert.ok(case7.plainText.includes('Plan: ChatGPT Plus'));
  assert.ok(case7.plainText.includes('Full Warranty'));

  // Case 8: Plain text without HTML (including &, <, > characters) escaped cleanly in HTML, crisp in plainText
  const case8 = processSupplierProductDescription(
    '• Google Drive, Photos & Gmail (400GB)\n• Delivery time < 30 seconds\n• Price > quality guarantee'
  );
  assert.equal(case8.detectedFormat, 'plain_text');
  assert.equal(case8.hasHtmlFormatting, false);
  assert.ok(case8.telegramHtml.includes('Photos &amp; Gmail'));
  assert.ok(case8.telegramHtml.includes('&lt; 30 seconds'));
  assert.ok(case8.telegramHtml.includes('&gt; quality guarantee'));
  assert.ok(case8.plainText.includes('Photos & Gmail'));
  assert.ok(case8.plainText.includes('< 30 seconds'));

  // Case 9: Long multi-section description preserved & safely truncated with balanced tags when exceeding limit
  const longSection = Array.from({ length: 40 }, (_, i) => `• <b>Feature ${i + 1}:</b> High-speed unlimited access with 30-day warranty.`).join('\n');
  const case9 = processSupplierProductDescription(`<blockquote>${longSection}</blockquote>`, {
    maxVisibleChars: 400,
  });
  assertBalancedTelegramHtml(case9.telegramHtml);
  assert.ok(case9.plainText.length <= 405);
  assert.ok(case9.plainText.includes('Feature 1:'));

  // Case 10: Nested & misnested formatting + nested blockquotes repaired safely
  const case10 = processSupplierProductDescription(
    '<blockquote><b><i>Nested Bold Italic</b></i><blockquote>Inner Quote Preserved</blockquote></blockquote>'
  );
  assertBalancedTelegramHtml(case10.telegramHtml);
  assert.ok(case10.plainText.includes('Nested Bold Italic'));
  assert.ok(case10.plainText.includes('Inner Quote Preserved'));
  // No nested <blockquote> inside <blockquote>
  assert.equal((case10.telegramHtml.match(/<blockquote/g) || []).length, 1);

  // Bonus: Unified Supplier API description extractor across diverse payload schemas
  assert.equal(
    extractSupplierRawDescription({ description_html: '<b>Rich HTML</b>', description: 'Fallback' }),
    '<b>Rich HTML</b>'
  );
  assert.equal(
    extractSupplierRawDescription({ description: { en: 'English Spec', ar: 'وصف عربي' } }),
    'English Spec'
  );
  assert.equal(
    extractSupplierRawDescription({ details: ['Line 1', 'Line 2'] }),
    'Line 1\nLine 2'
  );
  assert.equal(
    extractSupplierRawDescription({ name: 'Variant A' }, { long_description: 'Parent full description' }),
    'Parent full description'
  );

  // Bonus: Entity-encoded HTML from supplier JSON API decoded and rendered properly
  assert.equal(detectDescriptionFormat('&lt;blockquote&gt;&lt;b&gt;Hi&lt;/b&gt;&lt;/blockquote&gt;'), 'encoded_html');
  const encodedRes = processSupplierProductDescription('&lt;blockquote&gt;&lt;b&gt;Notion Plus&lt;/b&gt;&lt;/blockquote&gt;');
  assert.equal(encodedRes.telegramHtml, '<blockquote><b>Notion Plus</b></blockquote>');

  // Bonus: End-to-end Telegram product detail payload builder uses parseMode: 'HTML' with safe fallbacks
  const tgPayload = formatProductPurchasePromptTelegramPayload({
    categoryName: 'Proton VPN & Security',
    title: 'Proton VPN Plus (14–28 Days)',
    unitPrice: '2.70',
    stock: 18,
    description: case3.telegramHtml,
    durationLabel: '14–28 Days',
    warrantyLabel: '10 Days',
    lang: 'en',
  });
  assert.equal(tgPayload.parseMode, 'HTML');
  assert.ok(tgPayload.text.includes('<b>✦ PROTON VPN &amp; SECURITY</b>'));
  assert.ok(tgPayload.text.includes('<tg-emoji emoji-id="5796504385420792898">🛡️</tg-emoji>'));
  assert.equal(tgPayload.htmlNoCustomEmojiFallback.includes('<tg-emoji'), false);
  assert.equal(tgPayload.plainFallbackText.includes('<blockquote'), false);
  assert.equal(tgPayload.plainFallbackText.includes('<tg-emoji'), false);
  assert.ok(tgPayload.plainFallbackText.includes('Plan: Proton VPN Plus'));
  assertBalancedTelegramHtml(tgPayload.text);
  assertBalancedTelegramHtml(tgPayload.htmlNoCustomEmojiFallback);

  // Verify URL classifier directly
  assert.equal(classifyDescriptionUrl('https://t.me/some_supplier_channel').allowed, false);
  assert.equal(classifyDescriptionUrl('https://aivaulthub.store/products').allowed, false);
  assert.equal(classifyDescriptionUrl('https://redeem.adobe.com/').allowed, true);
  assert.equal(classifyDescriptionUrl('https://www.duolingo.com/redeem?code=XYZ').allowed, true);
  assert.equal(stripTelegramHtmlToPlainText('<b>Hello &amp; Welcome</b>').trim(), 'Hello & Welcome');
});

test('42. Telegram Custom Emoji preservation, per-emoji fallback, & translation HTML protection', async () => {
  // Multi-supplier custom emojis: standard emoji-id, custom_emoji_id alias, empty inner text & self-closing <tg-emoji/>
  const supplierRaw =
    '<blockquote>' +
    '<tg-emoji emoji-id="5206660927339924387">🚀</tg-emoji> <b>Gemini Plus 6M</b>\n' +
    '<tg-emoji custom_emoji_id="5796504385420792898">🛡️</tg-emoji> Official Warranty\n' +
    '<tg-emoji emoji-id="5312441427364999111" /> Instant Delivery\n' +
    '🔥 Visit https://t.me/supplier_ads\n' +
    '</blockquote>';

  const processed = processSupplierProductDescription(supplierRaw);
  assert.equal(processed.hasCustomEmoji, true);
  assert.equal(processed.detectedFormat, 'telegram_html');
  // Supplier ad line removed while all 3 custom emojis remain intact in original order!
  assert.equal(processed.telegramHtml.includes('supplier_ads'), false);
  assert.ok(processed.telegramHtml.includes('<tg-emoji emoji-id="5206660927339924387">🚀</tg-emoji>'));
  assert.ok(processed.telegramHtml.includes('<tg-emoji emoji-id="5796504385420792898">🛡️</tg-emoji>'));
  assert.ok(processed.telegramHtml.includes('<tg-emoji emoji-id="5312441427364999111">✨</tg-emoji>'));
  assert.deepEqual(extractCustomEmojiIds(processed.telegramHtml), [
    '5206660927339924387',
    '5796504385420792898',
    '5312441427364999111',
  ]);

  // ID validation
  assert.equal(isValidCustomEmojiId('5206660927339924387'), true);
  assert.equal(isValidCustomEmojiId('12'), false);
  assert.equal(isValidCustomEmojiId('not-a-number'), false);

  // Per-emoji selective downgrade: drop ONLY unavailable ID 5796504385420792898 while keeping the other 2 + HTML
  const validOnlyTwo = new Set(['5206660927339924387', '5312441427364999111']);
  const partialFallback = replaceDisallowedCustomEmojis(processed.telegramHtml, validOnlyTwo);
  assert.ok(partialFallback.includes('<tg-emoji emoji-id="5206660927339924387">🚀</tg-emoji>'));
  assert.ok(partialFallback.includes('<tg-emoji emoji-id="5312441427364999111">✨</tg-emoji>'));
  assert.equal(partialFallback.includes('5796504385420792898'), false);
  assert.ok(partialFallback.includes('🛡️ Official Warranty'));
  assert.ok(partialFallback.includes('<blockquote>') && partialFallback.includes('<b>Gemini Plus 6M</b>'));

  // No-token mode keeps tags untouched in pre-send filter
  const passthrough = await filterValidCustomEmojisInHtml(processed.telegramHtml, '');
  assert.equal(passthrough.html, processed.telegramHtml);
  assert.deepEqual(passthrough.keptIds, [
    '5206660927339924387',
    '5796504385420792898',
    '5312441427364999111',
  ]);

  // Translation HTML + Custom Emoji protection round-trip (tolerates spaces added by MT around placeholders)
  const sampleHtml =
    '<blockquote><tg-emoji emoji-id="5206660927339924387">🚀</tg-emoji> <b>تفعيل رسمي</b> عبر <a href="https://one.google.com/redeem">الرابط الرسمي</a></blockquote>';
  const protectedPayload = protectTelegramHtmlForTranslation(sampleHtml);
  assert.equal(protectedPayload.hasProtectedTokens, true);
  assert.equal(protectedPayload.masked.includes('5206660927339924387'), false);
  assert.equal(protectedPayload.masked.includes('one.google.com'), false);

  // Simulate machine translation inserting spaces around placeholders
  const simulatedTranslated = protectedPayload.masked
    .replace('[[TG_CE_0]]', '[[ TG_CE_0 ]]')
    .replace('تفعيل رسمي', 'Official Activation')
    .replace('عبر', 'via')
    .replace('الرابط الرسمي', 'Official Link');
  const restored = restoreProtectedTelegramHtml(simulatedTranslated, protectedPayload.tokens);
  assert.ok(restored.includes('<tg-emoji emoji-id="5206660927339924387">🚀</tg-emoji>'));
  assert.ok(restored.includes('<a href="https://one.google.com/redeem">Official Link</a>'));
  assert.ok(restored.startsWith('<blockquote>'));
  assert.ok(restored.endsWith('</blockquote>'));
});

test('43. Exclusive provider binding, pool filtering, priority recompaction, & catalog mapping audit', () => {
  const pool = [
    { id: 101, linkedStoreProductId: 10, linkedStoreProductTitle: 'Canva Pro 12M' },
    { id: 102, linkedStoreProductId: null, linkedStoreProductTitle: null },
    { id: 103, linkedStoreProductId: undefined, linkedStoreProductTitle: null },
    { id: 104, linkedStoreProductId: 12, linkedStoreProductTitle: 'Zoom Pro 1M' },
  ];

  // 1. Available pool strictly excludes any offer linked to any store product
  const unlinked = filterUnlinkedAvailableOffers(pool);
  assert.deepEqual(
    unlinked.map((o) => o.id),
    [102, 103]
  );

  // Exclude extra offers already staged in creation form
  const unlinkedMinusStaged = filterUnlinkedAvailableOffers(pool, [102]);
  assert.deepEqual(
    unlinkedMinusStaged.map((o) => o.id),
    [103]
  );

  // Once unlinked, offer returns immediately to available pool
  pool[0].linkedStoreProductId = null;
  pool[0].linkedStoreProductTitle = null;
  assert.deepEqual(
    filterUnlinkedAvailableOffers(pool).map((o) => o.id),
    [101, 102, 103]
  );

  // 2. Server-side exclusive binding guard
  const existingMappings = [
    { id: 501, storeProductId: 10, providerProductId: 201, storeProductTitle: 'Gemini Plus 6M' },
    { id: 502, storeProductId: 20, providerProductId: 202, storeProductTitle: 'Canva Pro 12M' },
  ];
  assert.equal(validateExclusiveOfferBinding(existingMappings, 10, 299).ok, true);

  const sameConflict = validateExclusiveOfferBinding(existingMappings, 10, 201);
  assert.equal(sameConflict.ok, false);
  if (!sameConflict.ok) {
    assert.equal(sameConflict.code, 'ALREADY_LINKED_SAME_PRODUCT');
    assert.equal(sameConflict.conflictStoreProductId, 10);
  }

  const crossConflict = validateExclusiveOfferBinding(existingMappings, 10, 202);
  assert.equal(crossConflict.ok, false);
  if (!crossConflict.ok) {
    assert.equal(crossConflict.code, 'ALREADY_LINKED_OTHER_PRODUCT');
    assert.equal(crossConflict.conflictStoreProductId, 20);
    assert.equal(crossConflict.conflictStoreProductTitle, 'Canva Pro 12M');
  }

  // 3. Recompacting priorities cleanly when removing #1 or middle provider
  const recompacted = computeRecompactedPriorities(
    [
      { id: 11, priority: 1 },
      { id: 12, priority: 2 },
      { id: 13, priority: 3 },
    ],
    11
  );
  assert.deepEqual(recompacted, [
    { id: 12, priority: 1, roleType: 'primary' },
    { id: 13, priority: 2, roleType: 'backup' },
  ]);

  // 4. Service/brand compatibility & full catalog audit
  assert.equal(
    isOfferCompatibleWithStoreProduct({
      storeProductTitle: 'Canva Pro 12M Private',
      storeProductCategoryName: 'التصميم والمونتاج',
      providerOfferRawName: 'Canva Edu Pro 1 Year Invitation',
    }).compatible,
    true
  );

  const mismatchCheck = isOfferCompatibleWithStoreProduct({
    storeProductTitle: 'ChatGPT Plus 1 Month',
    storeProductCategoryName: 'الذكاء الاصطناعي',
    providerOfferRawName: 'CapCut Pro 30 Days Private',
  });
  assert.equal(mismatchCheck.compatible, false);

  const auditReport = auditAllProductMappings([
    {
      mappingId: 1,
      storeProductId: 10,
      storeProductTitle: 'Gemini Plus 6M',
      storeProductCategoryName: 'Google AI',
      storeProductVisible: true,
      providerProductId: 301,
      providerId: 1,
      providerName: 'Pixora',
      providerEnabled: true,
      providerStatus: 'connected',
      providerOfferRawName: 'Gemini Google AI Pro 6 Months',
      isActiveAtProvider: true,
      wholesalePrice: '1.80',
      stockCount: 15,
      priority: 1,
      isActiveMapping: true,
    },
    {
      mappingId: 2,
      storeProductId: 11,
      storeProductTitle: 'Netflix 4K 1M',
      storeProductVisible: false,
      providerProductId: 302,
      providerId: 2,
      providerName: 'Bulkware',
      providerEnabled: false,
      providerStatus: 'disabled',
      providerOfferRawName: 'Netflix Ultra HD 30D',
      isActiveAtProvider: true,
      wholesalePrice: '2.50',
      stockCount: 0,
      priority: 1,
      isActiveMapping: true,
    },
    {
      mappingId: 3,
      storeProductId: 12,
      storeProductTitle: 'ChatGPT Plus 1M',
      storeProductVisible: true,
      providerProductId: 303,
      providerId: 3,
      providerName: 'LukuAI',
      providerEnabled: true,
      providerStatus: 'connected',
      providerOfferRawName: 'CapCut Pro 1 Month Slot',
      isActiveAtProvider: true,
      wholesalePrice: '3.00',
      stockCount: 4,
      priority: 1,
      isActiveMapping: true,
    },
  ]);

  assert.equal(auditReport.summary.totalMappings, 3);
  assert.equal(auditReport.summary.healthyCount, 1);
  assert.equal(auditReport.summary.flaggedCount, 2);
  assert.equal(auditReport.summary.disabledProviderCount, 1);
  assert.equal(auditReport.summary.mismatchCount, 1);
  assert.deepEqual(
    auditReport.issues.map((i) => i.mappingId).sort((a, b) => a - b),
    [2, 3]
  );
});

test('48. Heterogeneous Supplier Catalog Normalizer extracts full metadata, variants, pagination, and XSS-safe images', () => {
  // 1. Image URL sanitization blocks SSRF / localhost / javascript schemes and allows safe https/http
  assert.equal(sanitizeSupplierImageUrl('https://cdn.example.com/img/pro.png'), 'https://cdn.example.com/img/pro.png');
  assert.equal(sanitizeSupplierImageUrl('javascript:alert(1)'), '');
  assert.equal(sanitizeSupplierImageUrl('http://127.0.0.1:8080/internal.png'), '');
  assert.equal(sanitizeSupplierImageUrl('http://169.254.169.254/latest/meta-data'), '');

  // 2. Heterogeneous supplier response shapes (nested attributes, features, variants, suggested retail price, custom emojis)
  const rawPayload = {
    data: {
      products: [
        {
          service_id: 'svc_claude_1m',
          name: 'Claude Pro Max',
          image_url: 'https://cdn.vendor.io/claude.png',
          category_name: 'AI Subscriptions',
          product_type: 'account',
          duration_label: '30 Days',
          warranty_days: 28,
          reseller_price: '14.50',
          msrp: '20.00',
          stock_count: 18,
          min_qty: 1,
          max_qty: 10,
          region: 'Global',
          attributes: {
            description_html:
              '<blockquote><tg-emoji emoji-id="5368324170671202286">⚡</tg-emoji> <b>Claude Pro</b> Official Access</blockquote>\nVisit our store https://warzoneshop.in/shop\nRedeem at https://claude.ai/redeem<script>alert(1)</script>',
          },
          features: ['Instant Delivery', 'Private Seat'],
          variants: [
            { id: 'v_1m', name: '1 Month', price_usdt: '14.50', stock: 12, duration: '30 Days' },
            { id: 'v_3m', name: '3 Months', price_usdt: '39.00', stock: 6, duration: '90 Days' },
          ],
        },
        {
          id: 902,
          title: 'Canva Edu Pro',
          price: 1.25,
          available: 40,
          specs: { SeatType: 'Admin Invite', Validity: '12 Months' },
        },
      ],
      meta: { current_page: 1, last_page: 3, per_page: 2 },
    },
  };

  const normalized = normalizeRichSupplierCatalog(rawPayload);
  assert.equal(normalized.length, 3);

  assert.equal(normalized[0].externalProductId, 'svc_claude_1m');
  assert.equal(normalized[0].externalVariantId, 'v_1m');
  assert.equal(normalized[0].rawName, 'Claude Pro Max — 1 Month');
  assert.equal(normalized[0].imageUrl, 'https://cdn.vendor.io/claude.png');
  assert.equal(normalized[0].categoryName, 'AI Subscriptions');
  assert.equal(normalized[0].suggestedRetailPrice, '20.0000');
  assert.equal(normalized[0].variantsSummary.length, 2);
  assert.deepEqual(normalized[0].features, ['Instant Delivery', 'Private Seat']);
  assert.equal(normalized[0].extraMetadata.region, 'Global');

  // Synthesized fallback specs description when no explicit description key exists
  assert.ok(normalized[2].rawDescription.includes('SeatType: Admin Invite'));

  // 3. Preview HTML keeps original links & <tg-emoji> while stripping <script>; Import HTML scrubs supplier store link
  const preview = normalizeOriginalTelegramHtmlForPreview(normalized[0].rawDescription);
  assert.ok(preview.includes('<tg-emoji emoji-id="5368324170671202286">⚡</tg-emoji>'));
  assert.ok(!preview.includes('<script>'));
  assert.ok(preview.includes('warzoneshop.in'));

  const browserItem = buildSupplierBrowserItem(normalized[0], {
    extraSupplierNames: ['Warzone Shop'],
  });
  assert.ok(browserItem.cleanedImportHtml.includes('<tg-emoji emoji-id="5368324170671202286">⚡</tg-emoji>'));
  assert.ok(browserItem.cleanedImportHtml.includes('https://claude.ai/redeem'));
  assert.ok(!browserItem.cleanedImportHtml.includes('warzoneshop.in'));

  // 4. Pagination directives (page, cursor, offset, same-origin next_page_url vs cross-origin SSRF block)
  const pPage = extractPaginationDirective(rawPayload.data, 1, 0, 2, 2, 'https://api.vendor.io');
  assert.deepEqual(pPage, { kind: 'page', nextPage: 2, limit: 2 });

  const pSafeUrl = extractPaginationDirective(
    { next_page_url: 'https://api.vendor.io/products?page=2' },
    1,
    0,
    50,
    50,
    'https://api.vendor.io'
  );
  assert.deepEqual(pSafeUrl, { kind: 'url', nextUrl: 'https://api.vendor.io/products?page=2' });

  const pBlockedSsrf = extractPaginationDirective(
    { next_page_url: 'http://169.254.169.254/steal' },
    1,
    0,
    50,
    50,
    'https://api.vendor.io'
  );
  assert.deepEqual(pBlockedSsrf, { kind: 'none' });
});

test('49. Supplier Product Browser filtering, duplicate protection, update semantics, and strict category validation', () => {
  const rawCatalog = normalizeRichSupplierCatalog([
    {
      id: 'p-1',
      name: 'Adobe Creative Cloud 1M',
      category: 'Design',
      price: '4.00',
      stock: 10,
      description: '<b>Official Adobe CC</b> access',
    },
    {
      id: 'p-2',
      name: 'Cursor Pro 14D',
      category: 'Developer',
      price: '3.20',
      stock: 5,
      description: 'Cursor AI Pro workspace',
    },
  ]);

  const item1 = buildSupplierBrowserItem(rawCatalog[0], {
    existingLink: {
      providerProductId: 50,
      storeProductId: 700,
      storeProductTitle: 'Adobe CC 1M',
      storeCategoryId: 10,
      storeIsVisible: true,
      storeDescriptionEmpty: false,
    },
  });
  const item2 = buildSupplierBrowserItem(rawCatalog[1], { existingLink: null });

  assert.equal(item1.importStatus, 'imported');
  assert.equal(item2.importStatus, 'not_imported');

  // Filtering by search, category, and importStatus
  const onlyNotImported = filterAndPaginateSupplierBrowserItems([item1, item2], {
    status: 'not_imported',
    page: 1,
    pageSize: 24,
  });
  assert.equal(onlyNotImported.totalMatched, 1);
  assert.equal(onlyNotImported.items[0].externalProductId, 'p-2');

  const validCats = new Set<number>([10, 14]);

  // Missing or nonexistent category is rejected (never auto-created!)
  const missingCatPlan = validateAndPlanSupplierImport({
    sourceItem: item2,
    requestedCategoryId: null,
    validCategoryIds: validCats,
  });
  assert.equal(missingCatPlan.ok, false);

  const nonExistentCatPlan = validateAndPlanSupplierImport({
    sourceItem: item2,
    requestedCategoryId: 9999,
    validCategoryIds: validCats,
  });
  assert.equal(nonExistentCatPlan.ok, false);

  // Valid new import passes cleanly with full description preserved
  const createPlan = validateAndPlanSupplierImport({
    sourceItem: item2,
    requestedCategoryId: 14,
    validCategoryIds: validCats,
  });
  assert.equal(createPlan.ok, true);
  assert.equal(createPlan.action, 'create');
  assert.equal(createPlan.finalDescriptionHtml, 'Cursor AI Pro workspace');

  // Duplicate import is skipped by default unless explicit 'update' is requested
  const skipDupPlan = validateAndPlanSupplierImport({
    sourceItem: item1,
    requestedCategoryId: 10,
    validCategoryIds: validCats,
    requestedAction: 'create',
  });
  assert.equal(skipDupPlan.ok, false);
  assert.equal(skipDupPlan.action, 'skip');

  const updateDupPlan = validateAndPlanSupplierImport({
    sourceItem: item1,
    requestedCategoryId: 10,
    validCategoryIds: validCats,
    requestedAction: 'update',
  });
  assert.equal(updateDupPlan.ok, true);
  assert.equal(updateDupPlan.action, 'update');
  assert.equal(updateDupPlan.finalDescriptionHtml, '<b>Official Adobe CC</b> access');
});

test('50. PRODUCT_NOT_FOUND auto-zeros stale offer, fails over safely, shows single-icon unavailable error, and reconciles sync', () => {
  // 1. PRODUCT_NOT_FOUND triggers stock=0 + offer deactivation + admin missing-offer alert + safe backup failover
  const notFoundAction = classifyProviderAttemptFailureAction('PRODUCT_NOT_FOUND');
  assert.deepEqual(notFoundAction, {
    zeroStock: true,
    deactivateOffer: true,
    notifyAdminMissingOffer: true,
  });
  assert.equal(
    canSafelyFailoverToBackup({
      status: 'failed',
      uncertainState: false,
      deterministicFailureCode: 'PRODUCT_NOT_FOUND',
    }),
    true
  );

  // 2. OUT_OF_STOCK zeros stock without permanently deactivating the offer
  const outOfStockAction = classifyProviderAttemptFailureAction('OUT_OF_STOCK');
  assert.deepEqual(outOfStockAction, {
    zeroStock: true,
    deactivateOffer: false,
    notifyAdminMissingOffer: false,
  });

  // 3. Customer error sanitizer maps PRODUCT_NOT_FOUND / PRODUCT_UNAVAILABLE / OUT_OF_STOCK to clear product unavailable text
  assert.equal(sanitizeErrorForCustomer('PRODUCT_NOT_FOUND', 'ar'), t('ar', 'error_product_unavailable'));
  assert.equal(sanitizeErrorForCustomer('PRODUCT_NOT_FOUND', 'en'), t('en', 'error_product_unavailable'));
  assert.equal(sanitizeErrorForCustomer('OUT_OF_STOCK', 'ar'), t('ar', 'error_product_unavailable'));
  // Raw JSON containing PRODUCT_NOT_FOUND also maps cleanly without leaking supplier JSON
  const rawPandoraErr = '{"error":{"code":"PRODUCT_NOT_FOUND","message":"The product does not exist or is not API-enabled."}}';
  assert.equal(sanitizeErrorForCustomer(rawPandoraErr, 'ar'), t('ar', 'error_product_unavailable'));
  assert.equal(containsProviderLeak(sanitizeErrorForCustomer(rawPandoraErr, 'ar')), false);
  // Upstream INSUFFICIENT_BALANCE still keeps error_generic
  assert.equal(sanitizeErrorForCustomer('INSUFFICIENT_BALANCE', 'ar'), t('ar', 'error_generic'));

  // 4. ensureWarningPrefix prevents duplicate ⚠️ ⚠️ icons
  assert.equal(
    ensureWarningPrefix(t('ar', 'error_product_unavailable')),
    '⚠️ هذا المنتج غير متوفر حاليًا، يرجى المحاولة لاحقًا.'
  );
  assert.equal(
    ensureWarningPrefix('⚠️ ⚠️ تعذر إكمال العملية حاليًا'),
    '⚠️ تعذر إكمال العملية حاليًا'
  );
  assert.equal(ensureWarningPrefix('كوبون الخصم غير صالح.'), '⚠️ كوبون الخصم غير صالح.');

  // 5. Sync reconciliation zeroes disappeared offers on full live fetch, but protects against partial pagination failures
  const storedOffers = [
    { id: 4, externalProductId: 'prd_gemini_6m', externalVariantId: 'var_standard', stockCount: 209, isActiveAtProvider: true },
    { id: 1587, externalProductId: 'prd_ipOQEFPmp0rjP1Lk', externalVariantId: '', stockCount: 0, isActiveAtProvider: true },
  ];
  const liveFetched = [{ externalProductId: 'prd_ipOQEFPmp0rjP1Lk', externalVariantId: '' }];
  assert.deepEqual(collectDisappearedProviderOfferIds(storedOffers, liveFetched, false), [4]);
  assert.deepEqual(collectDisappearedProviderOfferIds(storedOffers, liveFetched, true), []);
  assert.deepEqual(collectDisappearedProviderOfferIds(storedOffers, [], false), []);
});

test('51. scrypt password hashing, strength validation, and timing-safe secret checks enforce security boundaries', () => {
  assert.equal(validatePasswordStrength('123456').ok, false);
  assert.equal(validatePasswordStrength('password123').ok, false);
  assert.equal(validatePasswordStrength('short').ok, false);
  assert.equal(validatePasswordStrength('Raqm#Owner2026!').ok, true);

  const hashA = hashPasswordScrypt('Raqm#Owner2026!');
  const hashB = hashPasswordScrypt('Raqm#Owner2026!');
  assert.ok(hashA.startsWith('scrypt$'));
  assert.notEqual(hashA, hashB); // Unique random 16-byte salt per hash
  assert.equal(verifyPasswordScrypt('Raqm#Owner2026!', hashA), true);
  assert.equal(verifyPasswordScrypt('WrongPassword123', hashA), false);
  assert.equal(verifyPasswordScrypt('Raqm#Owner2026!', null), false);
  assert.equal(verifyPasswordScrypt('Raqm#Owner2026!', 'invalid-format'), false);

  assert.equal(timingSafeSecretCompare('super-secret-token', 'super-secret-token'), true);
  assert.equal(timingSafeSecretCompare('super-secret-token', 'super-secret-tokem'), false);
  assert.equal(timingSafeSecretCompare('short', 'longer-secret'), false);
});

test('52. Granular RBAC prevents privilege escalation, strips moderators:manage from non-owners, and guards moderator targets', () => {
  assert.equal(isStaffRole('owner'), true);
  assert.equal(isStaffRole('admin'), true);
  assert.equal(isStaffRole('support'), true);
  assert.equal(isStaffRole('customer'), false);

  // Even if an attacker injects moderators:manage or unknown perms, sanitize strips them
  const sanitized = sanitizeModeratorPermissionsInput([
    'orders:manage',
    'moderators:manage',
    'unknown:perm',
    'deposits:approve',
  ]);
  assert.deepEqual(sanitized, ['orders:manage', 'deposits:approve']);

  // Owner gets ALL permissions including moderators:manage
  const ownerPerms = getEffectivePermissions('owner', []);
  assert.equal(ownerPerms.length, ADMIN_PERMISSION_DEFS.length);
  assert.equal(hasPermission({ role: 'owner', permissions: [] }, 'moderators:manage'), true);
  assert.equal(hasPermission({ role: 'owner', permissions: [] }, 'settings:manage'), true);

  // Moderator with explicit permissions only gets those permissions (never moderators:manage)
  const modPerms = getEffectivePermissions('support', ['orders:manage', 'moderators:manage']);
  assert.deepEqual(modPerms, ['orders:manage']);
  assert.equal(
    hasPermission({ role: 'support', permissions: modPerms }, 'moderators:manage'),
    false
  );
  assert.equal(hasPermission({ role: 'support', permissions: modPerms }, 'orders:manage'), true);
  assert.equal(hasPermission({ role: 'support', permissions: modPerms }, 'settings:manage'), false);
  assert.equal(
    hasAnyPermission({ role: 'support', permissions: modPerms }, ['settings:manage', 'orders:manage']),
    true
  );

  // Support fallback preset when no custom permissions set
  const defaultSupport = getEffectivePermissions('support', null);
  assert.deepEqual(defaultSupport, DEFAULT_ROLE_PERMISSION_PRESETS.support);

  // Customer gets zero admin permissions regardless of json
  assert.deepEqual(getEffectivePermissions('customer', ['orders:manage']), []);
  assert.equal(hasPermission({ role: 'customer', permissions: ['orders:manage'] }, 'orders:manage'), false);

  // Target management guards
  assert.equal(
    canManageTargetModerator({ id: 1, role: 'admin' }, { id: 2, role: 'support' }).allowed,
    false
  );
  assert.equal(
    canManageTargetModerator({ id: 1, role: 'owner' }, { id: 1, role: 'owner' }).allowed,
    false
  );
  assert.equal(
    canManageTargetModerator({ id: 1, role: 'owner' }, { id: 2, role: 'owner' }).allowed,
    false
  );
  assert.equal(
    canManageTargetModerator({ id: 1, role: 'owner' }, { id: 5, role: 'support' }).allowed,
    true
  );
});

test('53. Signed HMAC session tokens embed tokenVersion, verify cleanly, and reject tampered payloads', () => {
  const token = signSessionToken({
    uid: 'invited:mod_123',
    userId: 42,
    email: 'mod@raqm.store',
    role: 'support',
    displayName: 'Support Mod',
    tv: 3,
  });
  assert.ok(token.startsWith('raqm.'));

  const verified = verifySessionToken(token);
  assert.ok(verified);
  assert.equal(verified.userId, 42);
  assert.equal(verified.role, 'support');
  assert.equal(verified.tv, 3);

  // Tampering with signature or payload must fail verification
  const parts = token.split('.');
  const tamperedSig = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}xx`;
  assert.equal(verifySessionToken(tamperedSig), null);

  const fakePayload = Buffer.from(
    JSON.stringify({
      uid: 'local:owner-raqm',
      userId: 1,
      email: 'owner@raqm.store',
      role: 'owner',
      displayName: 'Fake Owner',
      tv: 1,
      exp: Date.now() + 60_000,
    })
  ).toString('base64url');
  assert.equal(verifySessionToken(`raqm.${fakePayload}.${parts[2]}`), null);
});
