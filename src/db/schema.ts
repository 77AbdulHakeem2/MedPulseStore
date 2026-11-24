import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  numeric,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// 1. Roles & Permissions (RBAC)
export const roles = pgTable('roles', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(), // owner | admin | support | customer
  nameAr: text('name_ar').notNull(),
  description: text('description').default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const permissions = pgTable('permissions', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(), // e.g., providers:manage, catalog:edit, deposits:approve
  roleCode: text('role_code').notNull(),
  description: text('description').default(''),
});

// 2. Users (Firebase UID + Telegram User ID)
export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    uid: text('uid').notNull().unique(), // Firebase UID or tg:<telegram_user_id>
    email: text('email'),
    telegramUserId: text('telegram_user_id').unique(),
    telegramUsername: text('telegram_username'),
    displayName: text('display_name').notNull(),
    role: text('role').notNull().default('customer'), // owner | admin | support | customer
    pricingTier: text('pricing_tier').notNull().default('customer'), // customer | agent
    language: text('language').notNull().default('ar'),
    languageCode: text('language_code').notNull().default('ar'), // ar | en (persisted customer choice)
    languageManuallySelected: boolean('language_manually_selected').notNull().default(false),
    preferredCurrency: text('preferred_currency').notNull().default('USD'), // USD | YER (display currency only — internal wallet stays USD)
    savedDepositorName: text('saved_depositor_name'), // permanent quadruple name for local Yemeni wallet deposits
    botStateJson: jsonb('bot_state_json').$type<Record<string, any>>(), // persistent FSM & nav context
    referralCode: text('referral_code').unique(),
    referredByUserId: integer('referred_by_user_id'),
    isBlocked: boolean('is_blocked').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('users_role_idx').on(table.role),
    index('users_pricing_tier_idx').on(table.pricingTier),
  ]
);

// 3. API Providers & Encrypted Credentials (ADMIN-ONLY)
export const providers = pgTable('providers', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(), // pixora | pandora | qorix | digitalcore | aivaulthub
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  docsUrl: text('docs_url').notNull(),
  authType: text('auth_type').notNull(), // bearer | api_key | x_api_key
  authHeader: text('auth_header').notNull(),
  rateLimitPerMin: integer('rate_limit_per_min').notNull().default(60),
  supportsIdempotency: boolean('supports_idempotency').notNull().default(false),
  supportsWebhooks: boolean('supports_webhooks').notNull().default(false),
  supportsQuote: boolean('supports_quote').notNull().default(false),
  status: text('status').notNull().default('disconnected'), // connected | disconnected | error | disabled
  isEnabled: boolean('is_enabled').notNull().default(true),
  cachedBalance: numeric('cached_balance', { precision: 14, scale: 4 }).notNull().default('0.0000'),
  balanceCurrency: text('balance_currency').notNull().default('USD'),
  lowBalanceThreshold: numeric('low_balance_threshold', { precision: 14, scale: 4 }).notNull().default('10.0000'),
  priority: integer('priority').notNull().default(10),
  lastSyncAt: timestamp('last_sync_at'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const providerCredentials = pgTable('provider_credentials', {
  id: serial('id').primaryKey(),
  providerId: integer('provider_id')
    .references(() => providers.id, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  encryptedApiKey: text('encrypted_api_key').notNull(),
  keyFingerprint: text('key_fingerprint').notNull(), // masked preview e.g. sk_live_****9a1f
  encryptedWebhookSecret: text('encrypted_webhook_secret'),
  updatedByUserId: integer('updated_by_user_id'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 4. Raw Provider Products (Synced from Upstream APIs — ADMIN-ONLY)
export const providerProducts = pgTable(
  'provider_products',
  {
    id: serial('id').primaryKey(),
    providerId: integer('provider_id')
      .references(() => providers.id, { onDelete: 'cascade' })
      .notNull(),
    externalProductId: text('external_product_id').notNull(),
    externalVariantId: text('external_variant_id').notNull().default(''),
    rawName: text('raw_name').notNull(),
    rawDescription: text('raw_description').default(''),
    wholesalePrice: numeric('wholesale_price', { precision: 14, scale: 4 }).notNull(),
    previousWholesalePrice: numeric('previous_wholesale_price', { precision: 14, scale: 4 }),
    currency: text('currency').notNull().default('USD'),
    stockCount: integer('stock_count').notNull().default(0),
    minQty: integer('min_qty').notNull().default(1),
    maxQty: integer('max_qty').notNull().default(100),
    deliveryType: text('delivery_type').notNull().default('code'), // code | link | account | manual
    durationLabel: text('duration_label').default(''),
    warrantyDays: integer('warranty_days').notNull().default(0),
    pricingTiersJson: jsonb('pricing_tiers_json').$type<Array<{ minQty: number; maxQty: number | null; price: string }>>(),
    isActiveAtProvider: boolean('is_active_at_provider').notNull().default(true),
    lastSyncedAt: timestamp('last_synced_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('provider_prod_unique_idx').on(
      table.providerId,
      table.externalProductId,
      table.externalVariantId
    ),
  ]
);

// 5. Store Categories & Published Storefront Catalog (CUSTOMER-SAFE)
export const categories = pgTable('categories', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').default(''),
  iconEmoji: text('icon_emoji').notNull().default(''),
  iconCustomEmojiId: text('icon_custom_emoji_id'),
  buttonStyle: text('button_style'), // primary | success | danger | null
  showInStore: boolean('show_in_store').notNull().default(true),
  showInGuides: boolean('show_in_guides').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const storeProducts = pgTable(
  'store_products',
  {
    id: serial('id').primaryKey(),
    sku: text('sku').notNull().unique(),
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),
    titleAr: text('title_ar').notNull(),
    titleEn: text('title_en').notNull().default(''),
    descriptionAr: text('description_ar').notNull().default(''),
    descriptionEn: text('description_en').notNull().default(''),
    descriptionEntitiesAr: jsonb('description_entities_ar').$type<any[]>(),
    descriptionEntitiesEn: jsonb('description_entities_en').$type<any[]>(),
    iconEmoji: text('icon_emoji').notNull().default(''),
    iconCustomEmojiId: text('icon_custom_emoji_id'),
    imageUrl: text('image_url').default(''),
    deliveryInstructionsAr: text('delivery_instructions_ar').default(''),
    deliveryInstructionsEn: text('delivery_instructions_en').default(''),
    warrantyLabelAr: text('warranty_label_ar').notNull().default('ضمان التشغيل الفوري'),
    warrantyLabelEn: text('warranty_label_en').notNull().default('Instant Activation Warranty'),
    warrantyDays: integer('warranty_days').notNull().default(0),
    durationLabel: text('duration_label').notNull().default(''),
    deliveryType: text('delivery_type').notNull().default('code'), // code | link | account | text
    // CRITICAL REQUIREMENT: All newly imported products MUST be hidden by default
    isVisible: boolean('is_visible').notNull().default(false),
    isPaused: boolean('is_paused').notNull().default(false),
    autoHideOutOfStock: boolean('auto_hide_out_of_stock').notNull().default(true),
    isFeaturedOffer: boolean('is_featured_offer').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(100),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('store_products_visible_idx').on(table.isVisible, table.isPaused)]
);

// 6. Multi-Provider Mapping (Primary + Backup Routing per Store Product — ADMIN-ONLY)
export const productProviderMappings = pgTable(
  'product_provider_mappings',
  {
    id: serial('id').primaryKey(),
    storeProductId: integer('store_product_id')
      .references(() => storeProducts.id, { onDelete: 'cascade' })
      .notNull(),
    providerProductId: integer('provider_product_id')
      .references(() => providerProducts.id, { onDelete: 'cascade' })
      .notNull(),
    roleType: text('role_type').notNull().default('primary'), // primary | backup
    priority: integer('priority').notNull().default(1),
    selectionStrategy: text('selection_strategy').notNull().default('priority'), // priority | lowest_price | highest_stock
    isVerifiedCompatible: boolean('is_verified_compatible').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('store_provider_mapping_unique').on(table.storeProductId, table.providerProductId),
    uniqueIndex('provider_product_single_store_unique').on(table.providerProductId),
  ]
);

// 7. Pricing Rules (Decimal Precision, Manual Price Lock)
export const productPrices = pgTable('product_prices', {
  id: serial('id').primaryKey(),
  storeProductId: integer('store_product_id')
    .references(() => storeProducts.id, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  pricingMode: text('pricing_mode').notNull().default('manual'), // manual | fixed_margin | percent_margin
  retailPrice: numeric('retail_price', { precision: 14, scale: 4 }).notNull().default('0.0000'),
  agentPrice: numeric('agent_price', { precision: 14, scale: 4 }), // Independent Agent (Reseller) tier price in USD
  fixedMargin: numeric('fixed_margin', { precision: 14, scale: 4 }).notNull().default('1.0000'),
  percentMargin: numeric('percent_margin', { precision: 8, scale: 4 }).notNull().default('30.0000'),
  paymentFeePercent: numeric('payment_fee_percent', { precision: 8, scale: 4 }).notNull().default('1.5000'),
  extraFixedCost: numeric('extra_fixed_cost', { precision: 14, scale: 4 }).notNull().default('0.0000'),
  promoPrice: numeric('promo_price', { precision: 14, scale: 4 }),
  promoEndsAt: timestamp('promo_ends_at'),
  bulkTiersJson: jsonb('bulk_tiers_json').$type<Array<{ minQty: number; unitPrice: string }>>(),
  lockManualPrice: boolean('lock_manual_price').notNull().default(true),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 8. Customer Wallets & Immutable Financial Ledger
export const wallets = pgTable('wallets', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  currency: text('currency').notNull().default('USD'),
  availableBalance: numeric('available_balance', { precision: 14, scale: 4 }).notNull().default('0.0000'),
  reservedBalance: numeric('reserved_balance', { precision: 14, scale: 4 }).notNull().default('0.0000'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const walletLedger = pgTable(
  'wallet_ledger',
  {
    id: serial('id').primaryKey(),
    referenceCode: text('reference_code').notNull().unique(),
    walletId: integer('wallet_id')
      .references(() => wallets.id, { onDelete: 'cascade' })
      .notNull(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    entryType: text('entry_type').notNull(), // deposit | reserve | capture | refund | referral_bonus | admin_adjustment
    amount: numeric('amount', { precision: 14, scale: 4 }).notNull(),
    balanceBefore: numeric('balance_before', { precision: 14, scale: 4 }).notNull(),
    balanceAfter: numeric('balance_after', { precision: 14, scale: 4 }).notNull(),
    relatedOrderId: integer('related_order_id'),
    relatedDepositId: integer('related_deposit_id'),
    note: text('note').notNull().default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('wallet_ledger_user_idx').on(table.userId, table.createdAt)]
);

// 9. Deposits & Payment Transactions (Binance Pay + Verified USDT TxID)
export const deposits = pgTable(
  'deposits',
  {
    id: serial('id').primaryKey(),
    depositRef: text('deposit_ref').notNull().unique(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    method: text('method').notNull(), // binance_pay | usdt_trc20 | usdt_bep20
    expectedAmount: numeric('expected_amount', { precision: 14, scale: 4 }).notNull(),
    receivedAmount: numeric('received_amount', { precision: 14, scale: 4 }),
    currency: text('currency').notNull().default('USDT'),
    network: text('network').default('TRC20'),
    contractAddress: text('contract_address'),
    assignedRecipientAddress: text('assigned_recipient_address'),
    uniqueMemoTag: text('unique_memo_tag').unique(), // ties payment uniquely to this customer deposit request
    txHash: text('tx_hash').unique(),
    confirmations: integer('confirmations').notNull().default(0),
    requiredConfirmations: integer('required_confirmations').notNull().default(12),
    binancePrepayId: text('binance_prepay_id').unique(),
    binanceTransactionId: text('binance_transaction_id'), // Binance Pay Trade History transactionId (uniqueness enforced in binance_used_transactions)
    verificationAttempts: integer('verification_attempts').notNull().default(0),
    lastCheckedAt: timestamp('last_checked_at'),
    verificationNote: text('verification_note'),
    status: text('status').notNull().default('pending'), // pending | pending_review | paid | confirmed | rejected | expired
    rejectionReason: text('rejection_reason'),
    reviewedByUserId: integer('reviewed_by_user_id'),
    creditedAt: timestamp('credited_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('deposits_status_idx').on(table.status, table.userId),
    index('deposits_binance_tx_idx').on(table.binanceTransactionId),
  ]
);

// 9b. Extensible Payment Methods (Binance ID + USDT + Future Methods)
export const paymentMethods = pgTable('payment_methods', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(), // binance_id | usdt_trc20 | usdt_bep20 | custom_*
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').notNull(),
  providerType: text('provider_type').notNull().default('manual_custom'), // binance_personal_pay | blockchain_usdt | manual_custom
  currency: text('currency').notNull().default('USDT'),
  isEnabled: boolean('is_enabled').notNull().default(true),
  autoVerifySupported: boolean('auto_verify_supported').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(10),
  instructionsAr: text('instructions_ar').notNull().default(''),
  instructionsEn: text('instructions_en').notNull().default(''),
  configJson: jsonb('config_json').$type<Record<string, any>>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 9c. Personal Binance Pay Trade History API Config (Encrypted in Backend ONLY)
export const binancePaySettings = pgTable('binance_pay_settings', {
  id: serial('id').primaryKey(),
  singletonKey: text('singleton_key').notNull().unique().default('primary'),
  binanceReceiverId: text('binance_receiver_id').notNull().default(''),
  encryptedApiKey: text('encrypted_api_key'),
  apiKeyFingerprint: text('api_key_fingerprint'),
  encryptedApiSecret: text('encrypted_api_secret'),
  apiSecretFingerprint: text('api_secret_fingerprint'),
  recvWindowMs: integer('recv_window_ms').notNull().default(5000),
  autoVerifyEnabled: boolean('auto_verify_enabled').notNull().default(false),
  eligibilityStatus: text('eligibility_status').notNull().default('untested'), // untested | eligible | failed_permissions | failed_region | failed_no_incoming | error
  eligibilityMessageAr: text('eligibility_message_ar').default('لم يتم تشغيل اختبار الاتصال والأهلية بعد.'),
  eligibilityCheckedAt: timestamp('eligibility_checked_at'),
  lastSyncAt: timestamp('last_sync_at'),
  lastSyncCount: integer('last_sync_count').notNull().default(0),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 9d. Unique Ledger of Used Binance Transaction IDs (Prevents Double-Credit Across Concurrent Calls)
export const binanceUsedTransactions = pgTable('binance_used_transactions', {
  id: serial('id').primaryKey(),
  transactionId: text('transaction_id').notNull().unique(),
  depositId: integer('deposit_id')
    .references(() => deposits.id, { onDelete: 'restrict' })
    .notNull(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'restrict' })
    .notNull(),
  amount: numeric('amount', { precision: 14, scale: 4 }).notNull(),
  currency: text('currency').notNull().default('USDT'),
  orderType: text('order_type').notNull().default('C2C'),
  receiverId: text('receiver_id').default(''),
  transactionTime: timestamp('transaction_time').notNull(),
  verifiedAt: timestamp('verified_at').defaultNow().notNull(),
});

export const paymentTransactions = pgTable('payment_transactions', {
  id: serial('id').primaryKey(),
  depositId: integer('deposit_id')
    .references(() => deposits.id, { onDelete: 'cascade' })
    .notNull(),
  gateway: text('gateway').notNull(), // binance_pay | trongrid | bscscan | manual_review
  externalTxnId: text('external_txn_id').notNull().unique(),
  rawStatus: text('raw_status').notNull(),
  signatureVerified: boolean('signature_verified').notNull().default(false),
  payloadSanitizedJson: jsonb('payload_sanitized_json'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 10. Orders, Order Items, Provider Orders & Deliveries
export const orders = pgTable(
  'orders',
  {
    id: serial('id').primaryKey(),
    orderNumber: text('order_number').notNull().unique(), // Customer-facing: RQM-2026-...
    idempotencyKey: text('idempotency_key').notNull().unique(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'restrict' })
      .notNull(),
    status: text('status').notNull().default('reserved'), // reserved | processing | completed | pending_delivery | failed | refunded | manual_reconciliation
    subtotalRetail: numeric('subtotal_retail', { precision: 14, scale: 4 }).notNull(),
    discountAmount: numeric('discount_amount', { precision: 14, scale: 4 }).notNull().default('0.0000'),
    totalRetail: numeric('total_retail', { precision: 14, scale: 4 }).notNull(),
    totalWholesaleSnapshot: numeric('total_wholesale_snapshot', { precision: 14, scale: 4 }).notNull().default('0.0000'),
    paymentFeeSnapshot: numeric('payment_fee_snapshot', { precision: 14, scale: 4 }).notNull().default('0.0000'),
    netProfitSnapshot: numeric('net_profit_snapshot', { precision: 14, scale: 4 }).notNull().default('0.0000'),
    couponCode: text('coupon_code'),
    displayCurrency: text('display_currency').notNull().default('USD'),
    displayExchangeRate: numeric('display_exchange_rate', { precision: 14, scale: 4 }),
    customerMessageAr: text('customer_message_ar').default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('orders_user_idx').on(table.userId, table.createdAt)]
);

export const orderItems = pgTable('order_items', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id')
    .references(() => orders.id, { onDelete: 'cascade' })
    .notNull(),
  storeProductId: integer('store_product_id')
    .references(() => storeProducts.id, { onDelete: 'restrict' })
    .notNull(),
  productTitleSnapshot: text('product_title_snapshot').notNull(),
  quantity: integer('quantity').notNull().default(1),
  unitRetailSnapshot: numeric('unit_retail_snapshot', { precision: 14, scale: 4 }).notNull(),
  unitWholesaleSnapshot: numeric('unit_wholesale_snapshot', { precision: 14, scale: 4 }).notNull().default('0.0000'),
  warrantyLabelSnapshot: text('warranty_label_snapshot').notNull().default(''),
});

// ADMIN-ONLY Provider Execution Tracking
export const providerOrders = pgTable('provider_orders', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id')
    .references(() => orders.id, { onDelete: 'cascade' })
    .notNull(),
  providerId: integer('provider_id')
    .references(() => providers.id, { onDelete: 'restrict' })
    .notNull(),
  externalRef: text('external_ref').notNull().unique(), // Idempotency ref sent to provider
  providerOrderId: text('provider_order_id'),
  status: text('status').notNull().default('initiated'), // initiated | pending | completed | failed | uncertain
  uncertainState: boolean('uncertain_state').notNull().default(false), // Blocks blind failover!
  chargedWholesale: numeric('charged_wholesale', { precision: 14, scale: 4 }).default('0.0000'),
  lastPollAt: timestamp('last_poll_at'),
  rawErrorSanitized: text('raw_error_sanitized'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const deliveries = pgTable('deliveries', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id')
    .references(() => orders.id, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  ownerUserId: integer('owner_user_id')
    .references(() => users.id, { onDelete: 'restrict' })
    .notNull(),
  deliveryType: text('delivery_type').notNull().default('code'), // code | link | account | text | pending
  encryptedPayload: text('encrypted_payload').notNull(), // AES-256-GCM encrypted codes/credentials
  customerInstructionsAr: text('customer_instructions_ar').notNull().default(''),
  warrantyNoticeAr: text('warranty_notice_ar').notNull().default(''),
  deliveredAt: timestamp('delivered_at').defaultNow().notNull(),
});

// 11. Coupons, Referrals, Notifications, Audit Logs, Settings
export const coupons = pgTable('coupons', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  discountType: text('discount_type').notNull().default('percent'), // percent | fixed
  discountValue: numeric('discount_value', { precision: 14, scale: 4 }).notNull(),
  maxUses: integer('max_uses').notNull().default(100),
  usedCount: integer('used_count').notNull().default(0),
  minOrderAmount: numeric('min_order_amount', { precision: 14, scale: 4 }).notNull().default('0.0000'),
  isActive: boolean('is_active').notNull().default(true),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const referralSettings = pgTable('referral_settings', {
  id: serial('id').primaryKey(),
  singletonKey: text('singleton_key').notNull().unique().default('primary'),
  isEnabled: boolean('is_enabled').notNull().default(true),
  defaultCommissionPercent: numeric('default_commission_percent', { precision: 8, scale: 4 })
    .notNull()
    .default('5.0000'),
  maxCommissionPerUserEnabled: boolean('max_commission_per_user_enabled').notNull().default(false),
  maxCommissionPerUserAmount: numeric('max_commission_per_user_amount', { precision: 14, scale: 4 })
    .notNull()
    .default('0.0000'),
  currency: text('currency').notNull().default('USDT'),
  updatedByUserId: integer('updated_by_user_id'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const referrals = pgTable(
  'referrals',
  {
    id: serial('id').primaryKey(),
    referrerUserId: integer('referrer_user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    referredUserId: integer('referred_user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull()
      .unique(),
    referrerTelegramId: text('referrer_telegram_id'),
    referredTelegramId: text('referred_telegram_id'),
    referralSource: text('referral_source').notNull().default('telegram_deep_link'),
    commissionAmount: numeric('commission_amount', { precision: 14, scale: 4 }).notNull().default('0.0000'),
    status: text('status').notNull().default('active'), // active | suspended
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('referrals_referrer_idx').on(table.referrerUserId, table.createdAt)]
);

// Immutable financial ledger for referral commissions & commission reversals (strictly idempotent per order + type)
export const referralCommissions = pgTable(
  'referral_commissions',
  {
    id: serial('id').primaryKey(),
    operationRef: text('operation_ref').notNull().unique(),
    entryType: text('entry_type').notNull().default('commission'), // commission | reversal
    referrerUserId: integer('referrer_user_id')
      .references(() => users.id, { onDelete: 'restrict' })
      .notNull(),
    referredUserId: integer('referred_user_id')
      .references(() => users.id, { onDelete: 'restrict' })
      .notNull(),
    orderId: integer('order_id')
      .references(() => orders.id, { onDelete: 'restrict' })
      .notNull(),
    originalCommissionId: integer('original_commission_id'),
    purchaseAmount: numeric('purchase_amount', { precision: 14, scale: 4 }).notNull(),
    commissionRatePercent: numeric('commission_rate_percent', { precision: 8, scale: 4 }).notNull(),
    grossCommissionAmount: numeric('gross_commission_amount', { precision: 14, scale: 4 }).notNull(),
    offsetAppliedAmount: numeric('offset_applied_amount', { precision: 14, scale: 4 }).notNull().default('0.0000'),
    netCreditedAmount: numeric('net_credited_amount', { precision: 14, scale: 4 }).notNull(),
    unrecoveredDeficitAmount: numeric('unrecovered_deficit_amount', { precision: 14, scale: 4 })
      .notNull()
      .default('0.0000'),
    balanceBefore: numeric('balance_before', { precision: 14, scale: 4 }).notNull(),
    balanceAfter: numeric('balance_after', { precision: 14, scale: 4 }).notNull(),
    currency: text('currency').notNull().default('USDT'),
    status: text('status').notNull().default('credited'), // credited | reversed | offset_only | deficit_recorded
    reversalReason: text('reversal_reason').notNull().default(''),
    walletLedgerRef: text('wallet_ledger_ref'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('referral_comm_order_type_uniq').on(table.orderId, table.entryType),
    index('referral_comm_referrer_idx').on(table.referrerUserId, table.createdAt),
    index('referral_comm_referred_idx').on(table.referredUserId, table.createdAt),
    index('referral_comm_status_idx').on(table.status, table.createdAt),
  ]
);

// Per-referrer commission recovery balance (safely records reversal shortfalls without driving main wallet negative)
export const referralCommissionAccounts = pgTable('referral_commission_accounts', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  pendingRecoveryBalance: numeric('pending_recovery_balance', { precision: 14, scale: 4 })
    .notNull()
    .default('0.0000'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const notifications = pgTable(
  'notifications',
  {
    id: serial('id').primaryKey(),
    audience: text('audience').notNull().default('admin'), // admin | customer
    targetUserId: integer('target_user_id'),
    eventType: text('event_type').notNull(), // new_deposit | order_success | order_failed | low_provider_balance | out_of_stock | wholesale_price_increase | api_offline | webhook_failed | stale_pending_order | duplicate_txid
    severity: text('severity').notNull().default('info'), // info | warning | critical
    titleAr: text('title_ar').notNull(),
    bodyAr: text('body_ar').notNull(),
    isRead: boolean('is_read').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('notifications_audience_idx').on(table.audience, table.isRead)]
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: serial('id').primaryKey(),
    actorUserId: integer('actor_user_id'),
    actorRole: text('actor_role').notNull().default('system'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').default(''),
    detailsJson: jsonb('details_json'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('audit_logs_created_idx').on(table.createdAt)]
);

export const settings = pgTable('settings', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  valueJson: jsonb('value_json').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 12. Dynamic Customer Bot Inline Menu Buttons (Main & Nested Sub-Buttons — 100% Controllable from Admin)
export const botMenuButtons = pgTable(
  'bot_menu_buttons',
  {
    id: serial('id').primaryKey(),
    parentId: integer('parent_id'), // NULL = Main Menu button; non-NULL = Sub-button nested under parent button ID
    code: text('code').notNull().unique(),
    labelAr: text('label_ar').notNull(),
    labelEn: text('label_en').notNull(),
    iconEmoji: text('icon_emoji').notNull().default(''),
    iconCustomEmojiId: text('icon_custom_emoji_id'),
    buttonStyle: text('button_style'), // primary | success | danger | null
    actionType: text('action_type').notNull().default('builtin'), // builtin | submenu | category | guide | custom_text | url
    actionValue: text('action_value').notNull().default(''),
    contentAr: text('content_ar').notNull().default(''),
    contentEntitiesAr: jsonb('content_entities_ar').$type<any[]>(),
    contentEn: text('content_en').notNull().default(''),
    contentEntitiesEn: jsonb('content_entities_en').$type<any[]>(),
    rowOrder: integer('row_order').notNull().default(1),
    colOrder: integer('col_order').notNull().default(1),
    buttonsPerRow: integer('buttons_per_row').notNull().default(2),
    isVisible: boolean('is_visible').notNull().default(true),
    isEnabled: boolean('is_enabled').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('bot_menu_buttons_order_idx').on(table.rowOrder, table.colOrder),
    index('bot_menu_buttons_parent_idx').on(table.parentId, table.rowOrder),
  ]
);

// 13. Service Guides ("How to Use" & Pre-Purchase App Guides — Full Telegram Entities Preserved!)
export const serviceGuides = pgTable(
  'service_guides',
  {
    id: serial('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),
    titleAr: text('title_ar').notNull(),
    titleEn: text('title_en').notNull(),
    iconEmoji: text('icon_emoji').notNull().default(''),
    iconCustomEmojiId: text('icon_custom_emoji_id'),
    contentAr: text('content_ar').notNull().default(''),
    contentEntitiesAr: jsonb('content_entities_ar').$type<any[]>(),
    contentEn: text('content_en').notNull().default(''),
    contentEntitiesEn: jsonb('content_entities_en').$type<any[]>(),
    sortOrder: integer('sort_order').notNull().default(10),
    isVisible: boolean('is_visible').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('service_guides_order_idx').on(table.sortOrder)]
);

// 14. Database Backup Snapshots (Created Before Cleanup Operations)
export const dataBackups = pgTable('data_backups', {
  id: serial('id').primaryKey(),
  label: text('label').notNull(),
  summaryJson: jsonb('summary_json').notNull(),
  payloadJson: jsonb('payload_json').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 15. Local Yemeni Wallets (Admin-Managed Manual Deposit Wallets in YER)
export const localWallets = pgTable(
  'local_wallets',
  {
    id: serial('id').primaryKey(),
    code: text('code').notNull().unique(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en').notNull().default(''),
    accountNumber: text('account_number').notNull(),
    accountHolderName: text('account_holder_name').notNull(),
    instructionsAr: text('instructions_ar').notNull().default(''),
    instructionsEn: text('instructions_en').notNull().default(''),
    logoUrl: text('logo_url').notNull().default(''),
    minAmountYer: numeric('min_amount_yer', { precision: 14, scale: 2 }),
    maxAmountYer: numeric('max_amount_yer', { precision: 14, scale: 2 }),
    isEnabled: boolean('is_enabled').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(10),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('local_wallets_sort_idx').on(table.isEnabled, table.sortOrder)]
);

// 16. Local Wallet Deposit Requests (Manual Review via Dedicated Admin Telegram Channel & Web Panel)
export const localDeposits = pgTable(
  'local_deposits',
  {
    id: serial('id').primaryKey(),
    depositRef: text('deposit_ref').notNull().unique(), // e.g., LDEP-2026-XXXXX
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    localWalletId: integer('local_wallet_id').references(() => localWallets.id, {
      onDelete: 'set null',
    }),
    walletNameSnapshot: text('wallet_name_snapshot').notNull(),
    recipientAccountSnapshot: text('recipient_account_snapshot').notNull(),
    recipientHolderSnapshot: text('recipient_holder_snapshot').notNull(),
    depositorNameUsed: text('depositor_name_used').notNull(),
    depositorNameIsTemporary: boolean('depositor_name_is_temporary').notNull().default(false),
    senderWalletNumber: text('sender_wallet_number').notNull().default(''),
    amountYer: numeric('amount_yer', { precision: 14, scale: 2 }).notNull(),
    equivalentUsd: numeric('equivalent_usd', { precision: 14, scale: 4 }).notNull(),
    exchangeRateUsed: numeric('exchange_rate_used', { precision: 14, scale: 4 }).notNull(),
    exchangeRateSource: text('exchange_rate_source').notNull().default('ye-rial.com'),
    exchangeRateMarket: text('exchange_rate_market').notNull().default('sanaa'),
    exchangeRateVerifiedAt: timestamp('exchange_rate_verified_at'),
    proofTelegramFileId: text('proof_telegram_file_id'),
    proofImageDataUrl: text('proof_image_data_url'),
    proofCaption: text('proof_caption').notNull().default(''),
    channelChatId: text('channel_chat_id'),
    channelMessageId: text('channel_message_id'),
    status: text('status').notNull().default('pending_review'), // pending_review | approved | rejected | cancelled
    rejectionReason: text('rejection_reason'),
    reviewedByUserId: integer('reviewed_by_user_id'),
    reviewedByName: text('reviewed_by_name'),
    reviewedAt: timestamp('reviewed_at'),
    creditedAt: timestamp('credited_at'),
    walletLedgerRef: text('wallet_ledger_ref').unique(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('local_deposits_status_idx').on(table.status, table.createdAt),
    index('local_deposits_user_idx').on(table.userId, table.createdAt),
  ]
);

// 17. Live Exchange Rate Snapshots & Audit Log (ye-rial.com)
export const exchangeRateLogs = pgTable(
  'exchange_rate_logs',
  {
    id: serial('id').primaryKey(),
    market: text('market').notNull().default('sanaa'), // sanaa | aden
    rateType: text('rate_type').notNull().default('buy'), // buy | sell | mid
    buyRate: numeric('buy_rate', { precision: 14, scale: 4 }),
    sellRate: numeric('sell_rate', { precision: 14, scale: 4 }),
    effectiveRate: numeric('effective_rate', { precision: 14, scale: 4 }),
    sourceUrl: text('source_url').notNull(),
    providerLastVerifiedAt: timestamp('provider_last_verified_at'),
    providerLastPriceChange: timestamp('provider_last_price_change'),
    status: text('status').notNull().default('ok'), // ok | error
    errorMessage: text('error_message'),
    fetchedAt: timestamp('fetched_at').defaultNow().notNull(),
  },
  (table) => [index('exchange_rate_logs_fetched_idx').on(table.market, table.fetchedAt)]
);

// 18. Per-Customer Custom Product Pricing & Visibility Overrides (Isolated per User)
export const customerProductOverrides = pgTable(
  'customer_product_overrides',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    storeProductId: integer('store_product_id')
      .references(() => storeProducts.id, { onDelete: 'cascade' })
      .notNull(),
    customPriceUsd: numeric('custom_price_usd', { precision: 14, scale: 4 }),
    isHidden: boolean('is_hidden').notNull().default(false),
    updatedByUserId: integer('updated_by_user_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('customer_product_overrides_unique_idx').on(table.userId, table.storeProductId),
    index('customer_product_overrides_user_idx').on(table.userId),
  ]
);

// Relations
export const usersRelations = relations(users, ({ one, many }) => ({
  wallet: one(wallets, { fields: [users.id], references: [wallets.userId] }),
  orders: many(orders),
  deposits: many(deposits),
  localDeposits: many(localDeposits),
  productOverrides: many(customerProductOverrides),
}));

export const storeProductsRelations = relations(storeProducts, ({ one, many }) => ({
  category: one(categories, { fields: [storeProducts.categoryId], references: [categories.id] }),
  price: one(productPrices, { fields: [storeProducts.id], references: [productPrices.storeProductId] }),
  mappings: many(productProviderMappings),
}));
