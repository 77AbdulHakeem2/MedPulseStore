import { count, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  roles,
  permissions,
  users,
  providers,
  providerCredentials,
  providerProducts,
  categories,
  storeProducts,
  settings,
  paymentMethods,
  binancePaySettings,
  botMenuButtons,
  serviceGuides,
} from '../db/schema.ts';
import { encryptSecret, maskApiKey } from './crypto.ts';
import { matchProductToStoreCategory, parseAuthHeaderInput } from '../lib/offerClassifier.ts';
import { containsInternalAdminNotice, sanitizeCustomerProductDescription } from './sanitizer.ts';
import { registerDynamicSupplierIdentities } from './productDescriptionEngine.ts';

let seededOnce = false;

export const DEFAULT_PROGRAM_CATEGORIES = [
  { slug: 'gemini', nameAr: 'Gemini', nameEn: 'Gemini', iconEmoji: '✨', sortOrder: 1 },
  { slug: 'chatgpt', nameAr: 'ChatGPT', nameEn: 'ChatGPT', iconEmoji: '🤖', sortOrder: 2 },
  { slug: 'gamma', nameAr: 'Gamma', nameEn: 'Gamma', iconEmoji: '📊', sortOrder: 3 },
  { slug: 'cloud', nameAr: 'Cloud', nameEn: 'Cloud', iconEmoji: '☁️', sortOrder: 4 },
  { slug: 'canva', nameAr: 'Canva', nameEn: 'Canva', iconEmoji: '🎨', sortOrder: 5 },
  { slug: 'adobe', nameAr: 'Adobe', nameEn: 'Adobe', iconEmoji: '🅰️', sortOrder: 6 },
  { slug: 'duolingo', nameAr: 'Duolingo', nameEn: 'Duolingo', iconEmoji: '🦉', sortOrder: 7 },
  { slug: 'youtube', nameAr: 'YouTube', nameEn: 'YouTube', iconEmoji: '▶️', sortOrder: 8 },
] as const;

export const DEFAULT_MAIN_MENU_BUTTONS = [
  {
    code: 'store',
    labelAr: '🛍 المتجر',
    labelEn: '🛍 Store',
    iconEmoji: '🛍',
    buttonStyle: 'success',
    actionType: 'builtin',
    actionValue: 'store',
    rowOrder: 1,
    colOrder: 1,
    buttonsPerRow: 2,
  },
  {
    code: 'wallet',
    labelAr: '💰 محفظتي',
    labelEn: '💰 My Wallet',
    iconEmoji: '💰',
    buttonStyle: 'success',
    actionType: 'builtin',
    actionValue: 'wallet',
    rowOrder: 1,
    colOrder: 2,
    buttonsPerRow: 2,
  },
  {
    code: 'orders',
    labelAr: '📦 طلباتي',
    labelEn: '📦 My Orders',
    iconEmoji: '📦',
    buttonStyle: 'primary',
    actionType: 'builtin',
    actionValue: 'orders',
    rowOrder: 2,
    colOrder: 1,
    buttonsPerRow: 2,
  },
  {
    code: 'refer',
    labelAr: '👥 الإحالة والربح',
    labelEn: '👥 Refer & Earn',
    iconEmoji: '👥',
    buttonStyle: 'primary',
    actionType: 'builtin',
    actionValue: 'refer',
    rowOrder: 2,
    colOrder: 2,
    buttonsPerRow: 2,
  },
  {
    code: 'profile',
    labelAr: '🪪 حسابي',
    labelEn: '🪪 Profile',
    iconEmoji: '🪪',
    buttonStyle: 'primary',
    actionType: 'builtin',
    actionValue: 'profile',
    rowOrder: 3,
    colOrder: 1,
    buttonsPerRow: 2,
  },
  {
    code: 'how_to_use',
    labelAr: '📖 طريقة الاستخدام',
    labelEn: '📖 How to Use',
    iconEmoji: '📖',
    buttonStyle: 'primary',
    actionType: 'builtin',
    actionValue: 'how_to_use',
    rowOrder: 3,
    colOrder: 2,
    buttonsPerRow: 2,
  },
  {
    code: 'support',
    labelAr: '📞 الدعم الفني',
    labelEn: '📞 Support',
    iconEmoji: '📞',
    buttonStyle: 'primary',
    actionType: 'url',
    actionValue: 'support_link',
    rowOrder: 4,
    colOrder: 1,
    buttonsPerRow: 2,
  },
  {
    code: 'lang_toggle',
    labelAr: '🌐 اللغة / Lang',
    labelEn: '🌐 اللغة / Lang',
    iconEmoji: '🌐',
    buttonStyle: 'primary',
    actionType: 'builtin',
    actionValue: 'lang_toggle',
    rowOrder: 4,
    colOrder: 2,
    buttonsPerRow: 2,
  },
  {
    code: 'currency_toggle',
    labelAr: '🔄 تغيير العملة | USD $',
    labelEn: '🔄 Switch Currency | USD $',
    iconEmoji: '🔄',
    buttonStyle: 'primary',
    actionType: 'builtin',
    actionValue: 'currency_toggle',
    rowOrder: 5,
    colOrder: 1,
    buttonsPerRow: 1,
  },
] as const;

function inferProgramCategorySlug(title: string): string {
  const t = title.toLowerCase();
  if (t.includes('gemini')) return 'gemini';
  if (t.includes('chatgpt') || t.includes('gpt')) return 'chatgpt';
  if (t.includes('gamma')) return 'gamma';
  if (t.includes('canva')) return 'canva';
  if (t.includes('adobe')) return 'adobe';
  if (t.includes('duolingo')) return 'duolingo';
  if (t.includes('youtube')) return 'youtube';
  return 'cloud';
}

async function ensureProgramCategoriesMenusAndGuides(): Promise<void> {
  // 1. Ensure default payment methods exist (Binance ID + USDT TRC20/BEP20)
  await db
    .insert(paymentMethods)
    .values([
      {
        code: 'binance_id',
        nameAr: 'Binance ID (USDT — تحقق تلقائي)',
        nameEn: 'Binance ID (USDT — Auto Verify)',
        providerType: 'binance_personal_pay',
        currency: 'USDT',
        isEnabled: true,
        autoVerifySupported: true,
        sortOrder: 1,
        instructionsAr:
          'حوّل مبلغ USDT عبر Binance Pay إلى معرّف Binance ID الموضح ثم أرسل الرقم المرجعي (Transaction ID).',
        instructionsEn:
          'Transfer the exact USDT amount via Binance Pay to the shown Binance ID, then submit your Transaction ID.',
      },
      {
        code: 'usdt_trc20',
        nameAr: 'USDT (شبكة TRC20)',
        nameEn: 'USDT (TRC20 Network)',
        providerType: 'blockchain_usdt',
        currency: 'USDT',
        isEnabled: true,
        autoVerifySupported: true,
        sortOrder: 2,
        instructionsAr: 'أرسل USDT على شبكة TRC20 ثم أدخل رقم المعاملة (TxID).',
        instructionsEn: 'Send USDT over the TRC20 network and submit your TxID.',
      },
      {
        code: 'usdt_bep20',
        nameAr: 'USDT (شبكة BEP20)',
        nameEn: 'USDT (BEP20 Network)',
        providerType: 'blockchain_usdt',
        currency: 'USDT',
        isEnabled: true,
        autoVerifySupported: false,
        sortOrder: 3,
        instructionsAr: 'أرسل USDT على شبكة BEP20 (BNB Smart Chain) ثم أدخل رقم المعاملة.',
        instructionsEn: 'Send USDT over BEP20 (BNB Smart Chain) and submit your TxID.',
      },
    ])
    .onConflictDoNothing();

  // 2. Ensure singleton binance_pay_settings row exists
  await db
    .insert(binancePaySettings)
    .values({
      singletonKey: 'primary',
      binanceReceiverId: (process.env.BINANCE_RECEIVER_ID || '').trim(),
      autoVerifyEnabled: false,
      eligibilityStatus: 'untested',
      eligibilityMessageAr:
        'لم يتم تشغيل اختبار الاتصال والأهلية بعد. أدخل Binance ID ومفتاح القراءة فقط ثم اختبر الاتصال.',
    })
    .onConflictDoNothing();

  // 3. Ensure Program/Service Categories exist (only seed if not already created)
  const existingCats = await db.select().from(categories);
  const existingSlugs = new Set(existingCats.map((c) => c.slug));
  const legacyGenericSlugs = ['ai-tools', 'design-creative', 'learning', 'streaming'];
  const hasProgramCats = DEFAULT_PROGRAM_CATEGORIES.some((c) => existingSlugs.has(c.slug));

  if (!hasProgramCats) {
    await db
      .insert(categories)
      .values(
        DEFAULT_PROGRAM_CATEGORIES.map((c) => ({
          slug: c.slug,
          nameAr: c.nameAr,
          nameEn: c.nameEn,
          iconEmoji: c.iconEmoji,
          buttonStyle: 'primary',
          showInStore: true,
          showInGuides: true,
          sortOrder: c.sortOrder,
          isActive: true,
        }))
      )
      .onConflictDoNothing();
  }

  // Migrate any products still linked to old generic categories to their matching program category
  const refreshedCats = await db.select().from(categories);
  const catBySlug = new Map(refreshedCats.map((c) => [c.slug, c]));
  const legacyCats = refreshedCats.filter((c) => legacyGenericSlugs.includes(c.slug));

  if (legacyCats.length > 0 && catBySlug.has('gemini')) {
    const legacyIds = legacyCats.map((c) => c.id);
    const affectedProds = await db
      .select()
      .from(storeProducts)
      .where(inArray(storeProducts.categoryId, legacyIds));

    for (const prod of affectedProds) {
      const targetSlug = inferProgramCategorySlug(`${prod.titleAr} ${prod.titleEn}`);
      const targetCat = catBySlug.get(targetSlug) || catBySlug.get('cloud') || catBySlug.get('gemini');
      if (targetCat) {
        await db
          .update(storeProducts)
          .set({ categoryId: targetCat.id, updatedAt: new Date() })
          .where(eq(storeProducts.id, prod.id));
      }
    }

    // Remove the old generic categories cleanly once all products have been migrated
    await db.delete(categories).where(inArray(categories.id, legacyIds));
  }

  // 4. Ensure default Main Menu Inline Buttons exist (only when table is empty so admin edits/deletes are preserved!)
  const [{ value: btnCount }] = await db.select({ value: count() }).from(botMenuButtons);
  if (Number(btnCount) === 0) {
    await db
      .insert(botMenuButtons)
      .values(
        DEFAULT_MAIN_MENU_BUTTONS.map((b) => ({
          code: b.code,
          labelAr: b.labelAr,
          labelEn: b.labelEn,
          iconEmoji: b.iconEmoji,
          buttonStyle: b.buttonStyle,
          actionType: b.actionType,
          actionValue: b.actionValue,
          rowOrder: b.rowOrder,
          colOrder: b.colOrder,
          buttonsPerRow: b.buttonsPerRow,
          isVisible: true,
          isEnabled: true,
        }))
      )
      .onConflictDoNothing();
  } else {
    // Ensure existing stores seamlessly get the built-in Currency Toggle main menu button if not already present
    const existingCurrencyBtn = await db
      .select({ id: botMenuButtons.id })
      .from(botMenuButtons)
      .where(eq(botMenuButtons.code, 'currency_toggle'))
      .limit(1);
    if (existingCurrencyBtn.length === 0) {
      await db
        .insert(botMenuButtons)
        .values({
          code: 'currency_toggle',
          labelAr: '🔄 تغيير العملة | USD $',
          labelEn: '🔄 Switch Currency | USD $',
          iconEmoji: '🔄',
          buttonStyle: 'primary',
          actionType: 'builtin',
          actionValue: 'currency_toggle',
          rowOrder: 5,
          colOrder: 1,
          buttonsPerRow: 1,
          isVisible: true,
          isEnabled: true,
        })
        .onConflictDoNothing();
    }
  }

  // 5. Ensure starter Service Guides exist (only when table is empty so admin edits/deletes are preserved!)
  const [{ value: guideCount }] = await db.select({ value: count() }).from(serviceGuides);
  if (Number(guideCount) === 0) {
    const finalCats = await db.select().from(categories).orderBy(categories.sortOrder);
    const finalCatBySlug = new Map(finalCats.map((c) => [c.slug, c]));

    const starterGuides = DEFAULT_PROGRAM_CATEGORIES.map((c) => {
      const cat = finalCatBySlug.get(c.slug);
      const headerAr = `📘 دليل استخدام وتفعيل ${c.nameAr}`;
      const bodyAr =
        `${headerAr}\n\n` +
        `• خطوات التفعيل: بعد اختيار الباقة وإتمام الشراء، ستصلك بيانات أو رابط التفعيل مباشرة داخل البوت.\n` +
        `• الضمان: يشمل كامل مدة الباقة المحددة عند الالتزام بتعليمات الاستخدام.\n` +
        `• للمساعدة: يمكنك مراسلة الدعم الفني مباشرة من القائمة الرئيسية.`;
      const headerEn = `📘 ${c.nameEn} — Activation & Usage Guide`;
      const bodyEn =
        `${headerEn}\n\n` +
        `• Activation: After purchasing a plan below, your activation code or invite link is delivered instantly inside the bot.\n` +
        `• Warranty: Valid throughout the stated subscription period when following usage guidelines.\n` +
        `• Need help? Tap Support from the main menu anytime.`;

      return {
        slug: c.slug,
        categoryId: cat?.id || null,
        titleAr: c.nameAr,
        titleEn: c.nameEn,
        iconEmoji: c.iconEmoji,
        contentAr: bodyAr,
        contentEntitiesAr: [{ type: 'bold', offset: 0, length: headerAr.length }],
        contentEn: bodyEn,
        contentEntitiesEn: [{ type: 'bold', offset: 0, length: headerEn.length }],
        sortOrder: c.sortOrder,
        isVisible: true,
      };
    });

    await db.insert(serviceGuides).values(starterGuides).onConflictDoNothing();
  }

  // 6. Ensure store_profile defaults exist without overwriting admin edits
  const [profRow] = await db.select().from(settings).where(eq(settings.key, 'store_profile')).limit(1);
  if (!profRow) {
    await db
      .insert(settings)
      .values({
        key: 'store_profile',
        valueJson: {
          storeName: 'متجر رَقْم',
          storeNameEn: 'Raqm Digital Store',
          tagline: 'اشتراكات ومنتجات رقمية أصلية بتسليم فوري',
          welcomeMessageAr: 'أهلاً بك في متجر رَقْم! تصفح الاشتراكات الرقمية المعتمدة واشترِ فورًا من محفظتك بأمان تام.',
          welcomeMessageEn:
            'Welcome to Raqm Digital Store! Browse verified digital subscriptions and purchase instantly from your wallet.',
          currency: 'USD',
          usdtToUsdRate: '1.0000',
          supportHandle: '@raqm_support',
          termsAr: 'جميع المنتجات رقمية وتُسلم تلقائيًا بعد تأكيد الدفع. الضمان يطابق المدة المذكورة في كل عرض.',
          termsEn:
            'All products are digital and delivered automatically upon confirmation. Warranty covers the exact period stated on each plan.',
          isStoreOpen: true,
          usdtTrc20Wallet: '',
          usdtBep20Wallet: '',
          binancePayEnabled: true,
          arEnabled: true,
          enEnabled: true,
          defaultLanguage: 'ar',
        },
      })
      .onConflictDoNothing();
  } else {
    const val = (profRow.valueJson as Record<string, any>) || {};
    if (val.welcomeMessageEn === undefined || val.arEnabled === undefined) {
      await db
        .update(settings)
        .set({
          valueJson: {
            ...val,
            storeNameEn: val.storeNameEn || 'Raqm Digital Store',
            welcomeMessageEn:
              val.welcomeMessageEn ||
              'Welcome to Raqm Digital Store! Browse verified digital subscriptions and purchase instantly from your wallet.',
            termsEn:
              val.termsEn ||
              'All products are digital and delivered automatically upon confirmation.',
            arEnabled: val.arEnabled !== false,
            enEnabled: val.enEnabled !== false,
            defaultLanguage: val.defaultLanguage || 'ar',
          },
          updatedAt: new Date(),
        })
        .where(eq(settings.key, 'store_profile'));
    }
  }
}

/**
 * Structural-only bootstrap:
 * NEVER seeds fake demo customers, fake orders, fake deposits, fake balances, or fake profits!
 */
export async function ensureSeededDatabase(): Promise<void> {
  if (seededOnce) return;

  // 1. Roles & Permissions
  await db
    .insert(roles)
    .values([
      { code: 'owner', nameAr: 'مالك المتجر', description: 'صلاحيات كاملة لإدارة الخوادم والمفاتيح والمالية والمديرين' },
      { code: 'admin', nameAr: 'مدير متجر', description: 'إدارة المنتجات والأسعار والطلبات والإيداعات' },
      { code: 'support', nameAr: 'دعم فني', description: 'متابعة طلبات العملاء والرد على التذاكر دون كشف المفاتيح' },
      { code: 'customer', nameAr: 'عميل', description: 'شراء المنتجات وشحن المحفظة فقط — معزول تمامًا عن الإدارة' },
    ])
    .onConflictDoNothing();

  await db
    .insert(permissions)
    .values([
      { code: 'providers:manage', roleCode: 'owner', description: 'إضافة وتعديل مفاتيح API للخوادم' },
      { code: 'pricing:manage', roleCode: 'admin', description: 'تعديل أسعار البيع وهوامش الربح' },
      { code: 'catalog:publish', roleCode: 'admin', description: 'إظهار وإخفاء المنتجات' },
      { code: 'deposits:approve', roleCode: 'admin', description: 'اعتماد ورفض الإيداعات المعلقة' },
      { code: 'orders:support', roleCode: 'support', description: 'متابعة حالة الطلبات للعملاء' },
    ])
    .onConflictDoNothing();

  // 2. Ensure Local Owner Admin Account Exists (Zero fake orders/deposits!)
  await db
    .insert(users)
    .values({
      uid: 'local:owner-raqm',
      email: 'owner@raqm.store',
      telegramUserId: '700100001',
      telegramUsername: 'raqm_owner',
      displayName: 'مالك المتجر',
      role: 'owner',
      referralCode: 'RAQM-OWNER',
    })
    .onConflictDoNothing();

  // 3. Ensure the 5 Provider Definitions exist (Disconnected & $0.00 until configured with real keys!)
  const [{ value: providerCount }] = await db.select({ value: count() }).from(providers);
  if (Number(providerCount) === 0) {
    await db
      .insert(providers)
      .values([
        {
          code: 'aivaulthub',
          name: 'AIVault Hub',
          baseUrl: 'https://reseller.aivaulthub.store/api/v1',
          docsUrl: 'https://reseller.aivaulthub.store/api/v1/docs',
          authType: 'x_api_key',
          authHeader: 'X-API-Key',
          rateLimitPerMin: 60,
          supportsIdempotency: true,
          supportsWebhooks: true,
          supportsQuote: true,
          status: 'disconnected',
          isEnabled: true,
          cachedBalance: '0.0000',
          lowBalanceThreshold: '15.0000',
          priority: 1,
        },
        {
          code: 'pandora',
          name: 'Pandora Digital',
          baseUrl: 'https://api.pandoradigital.shop/api/v1',
          docsUrl: 'https://api.pandoradigital.shop/docs',
          authType: 'bearer',
          authHeader: 'Authorization',
          rateLimitPerMin: 60,
          supportsIdempotency: true,
          supportsWebhooks: true,
          supportsQuote: true,
          status: 'disconnected',
          isEnabled: true,
          cachedBalance: '0.0000',
          lowBalanceThreshold: '15.0000',
          priority: 2,
        },
        {
          code: 'qorix',
          name: 'QORIX',
          baseUrl: 'https://qorixlab.com/api/public/reseller/v1',
          docsUrl: 'https://qorixlab.com/reseller/docs',
          authType: 'bearer',
          authHeader: 'Authorization',
          rateLimitPerMin: 30,
          supportsIdempotency: true,
          supportsWebhooks: false,
          supportsQuote: false,
          status: 'disconnected',
          isEnabled: true,
          cachedBalance: '0.0000',
          lowBalanceThreshold: '10.0000',
          priority: 3,
        },
        {
          code: 'digitalcore',
          name: 'DigitalCore',
          baseUrl: 'https://digitalcore.top',
          docsUrl: 'https://digitalcore.top/docs',
          authType: 'api_key',
          authHeader: 'Api-Key',
          rateLimitPerMin: 60,
          supportsIdempotency: false,
          supportsWebhooks: false,
          supportsQuote: false,
          status: 'disconnected',
          isEnabled: true,
          cachedBalance: '0.0000',
          lowBalanceThreshold: '15.0000',
          priority: 4,
        },
        {
          code: 'pixora',
          name: 'Pixora API',
          baseUrl: 'https://daddyclub.bar/pixora-api/v1',
          docsUrl: 'https://daddyclub.bar/pixora-api/v1/docs',
          authType: 'bearer',
          authHeader: 'Authorization',
          rateLimitPerMin: 60,
          supportsIdempotency: false,
          supportsWebhooks: false,
          supportsQuote: false,
          status: 'disconnected',
          isEnabled: true,
          cachedBalance: '0.0000',
          lowBalanceThreshold: '10.0000',
          priority: 5,
        },
      ])
      .onConflictDoNothing();
  }

  // 4. Default Notification Preferences
  await db
    .insert(settings)
    .values({
      key: 'notification_preferences',
      valueJson: {
        new_deposit: true,
        order_success: true,
        order_failed: true,
        low_provider_balance: true,
        out_of_stock: true,
        wholesale_price_increase: true,
        api_offline: true,
        webhook_failed: true,
        stale_pending_order: true,
        duplicate_txid: true,
      },
    })
    .onConflictDoNothing();

  await ensureProgramCategoriesMenusAndGuides();
  await ensureV2ResellerProvidersAndRepairHeaders();
  await ensureV3ResellerProviders();
  await ensureCategoriesRepairedV1();
  await cleanupLegacyInternalProductNotices();
  seededOnce = true;
}

/**
 * Idempotent DB hygiene pass:
 * 1. Registers all configured providers (current & future) into the dynamic supplier scrubber.
 * 2. Scrubs any legacy internal admin notices, supplier branding/ads, disallowed links, or
 *    malformed/unclosed HTML from existing `store_products` and `provider_products` while
 *    preserving 100% of product details, valid Telegram HTML, custom emojis, and official links.
 */
async function cleanupLegacyInternalProductNotices(): Promise<void> {
  const allProviders = await db
    .select({
      name: providers.name,
      code: providers.code,
      baseUrl: providers.baseUrl,
      docsUrl: providers.docsUrl,
    })
    .from(providers);
  registerDynamicSupplierIdentities(allProviders);

  const existingStoreProds = await db
    .select({
      id: storeProducts.id,
      descriptionAr: storeProducts.descriptionAr,
      descriptionEn: storeProducts.descriptionEn,
    })
    .from(storeProducts);

  for (const sp of existingStoreProds) {
    const rawAr = (sp.descriptionAr || '').trim();
    const rawEn = (sp.descriptionEn || '').trim();
    const cleanedAr = rawAr ? sanitizeCustomerProductDescription(rawAr) : '';
    const cleanedEn = rawEn ? sanitizeCustomerProductDescription(rawEn) : '';
    const arChanged = Boolean(rawAr) && (containsInternalAdminNotice(rawAr) || cleanedAr !== rawAr);
    const enChanged = Boolean(rawEn) && (containsInternalAdminNotice(rawEn) || cleanedEn !== rawEn);
    if (arChanged || enChanged) {
      await db
        .update(storeProducts)
        .set({
          descriptionAr: arChanged ? cleanedAr : sp.descriptionAr,
          descriptionEn: enChanged ? cleanedEn : sp.descriptionEn,
          updatedAt: new Date(),
        })
        .where(eq(storeProducts.id, sp.id));
    }
  }

  const existingProvProds = await db
    .select({
      id: providerProducts.id,
      rawDescription: providerProducts.rawDescription,
    })
    .from(providerProducts);

  for (const pp of existingProvProds) {
    const raw = (pp.rawDescription || '').trim();
    if (!raw) continue;
    const cleaned = sanitizeCustomerProductDescription(raw);
    if (containsInternalAdminNotice(raw) || cleaned !== raw) {
      await db
        .update(providerProducts)
        .set({
          rawDescription: cleaned,
        })
        .where(eq(providerProducts.id, pp.id));
    }
  }
}

const REQUESTED_V2_PROVIDERS = [
  {
    code: 'lukuai',
    name: 'LukuAI Partner',
    baseUrl: 'https://bot.lukuai.com',
    docsUrl: 'https://bot.lukuai.com/partner-api-docs?lang=en',
    authType: 'partner_pair',
    authHeader: 'X-Api-Key',
    rateLimitPerMin: 60,
    supportsIdempotency: false,
    supportsWebhooks: false,
    supportsQuote: true,
    priority: 11,
  },
  {
    code: 'sajidofficial',
    name: 'Sajid Official',
    baseUrl: 'https://sajidofficial.com/api/v1',
    docsUrl: 'https://sajidofficial.com/docs',
    authType: 'x_api_key',
    authHeader: 'X-API-Key',
    rateLimitPerMin: 60,
    supportsIdempotency: true,
    supportsWebhooks: true,
    supportsQuote: true,
    priority: 12,
  },
  {
    code: 'toolverio',
    name: 'Toolverio',
    baseUrl: 'https://api.toolverio.com',
    docsUrl: 'https://toolverio.com/docs',
    authType: 'bearer',
    authHeader: 'Authorization',
    rateLimitPerMin: 60,
    supportsIdempotency: true,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 13,
  },
  {
    code: 'aiversehub',
    name: 'AIVerse Hub',
    baseUrl: 'https://aiversehub.store',
    docsUrl: 'https://aiversehub.store/docs',
    authType: 'x_api_key',
    authHeader: 'X-API-Key',
    rateLimitPerMin: 60,
    supportsIdempotency: false,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 14,
  },
  {
    code: 'hmai',
    name: 'HMAI Store',
    baseUrl: 'https://api.hmai.shop',
    docsUrl: 'https://api.hmai.shop/api/docs',
    authType: 'bearer',
    authHeader: 'Authorization',
    rateLimitPerMin: 60,
    supportsIdempotency: true,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 15,
  },
  {
    code: 'canboso',
    name: 'Canboso',
    baseUrl: 'https://canboso.com',
    docsUrl: 'https://canboso.com/api/swagger',
    authType: 'x_api_key',
    authHeader: 'x-buyer-key',
    rateLimitPerMin: 25,
    supportsIdempotency: false,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 16,
  },
  {
    code: 'kangnequantri',
    name: 'Kanghne Store',
    baseUrl: 'https://bot.kangnequantri.cc/api/v1',
    docsUrl: 'https://bot.kangnequantri.cc/api-docs',
    authType: 'x_api_key',
    authHeader: 'X-API-Key',
    rateLimitPerMin: 60,
    supportsIdempotency: false,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 17,
  },
  {
    code: 'renqis',
    name: 'Renqis API',
    baseUrl: 'https://api.renqis.online/api/reseller/v1',
    docsUrl: 'https://api.renqis.online/api/reseller/docs',
    authType: 'x_api_key',
    authHeader: 'X-API-Key',
    rateLimitPerMin: 60,
    supportsIdempotency: true,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 18,
  },
] as const;

async function ensureV2ResellerProvidersAndRepairHeaders(): Promise<void> {
  // 1. One-time seed of the 8 requested reseller servers (tracked via settings flag so deleted servers stay deleted!)
  const [flagRow] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, 'seeded_v2_reseller_providers'))
    .limit(1);

  if (!flagRow) {
    await db
      .insert(providers)
      .values(
        REQUESTED_V2_PROVIDERS.map((p) => ({
          ...p,
          status: 'disconnected',
          isEnabled: true,
          cachedBalance: '0.0000',
          lowBalanceThreshold: '10.0000',
        }))
      )
      .onConflictDoNothing();

    await db
      .insert(settings)
      .values({
        key: 'seeded_v2_reseller_providers',
        valueJson: { seeded: true, seededAt: new Date().toISOString() },
      })
      .onConflictDoNothing();
  }

  // 2. Repair any existing providers where a raw API key was pasted into auth_header or /api/v1 suffix was omitted
  const existingProvs = await db.select().from(providers);
  const existingCreds = await db.select().from(providerCredentials);
  const credProviderIds = new Set(existingCreds.map((c) => c.providerId));

  for (const prov of existingProvs) {
    const parsed = parseAuthHeaderInput(prov.authHeader || '', prov.authType || 'bearer');
    let nextBaseUrl = prov.baseUrl.replace(/\/+$/, '');
    const lowBase = nextBaseUrl.toLowerCase();
    if (
      (lowBase === 'https://api.warzoneshop.in' ||
        lowBase === 'https://api.aivaulthub.store' ||
        lowBase === 'https://reseller.aivaulthub.store') &&
      !lowBase.endsWith('/api/v1')
    ) {
      nextBaseUrl = `${nextBaseUrl}/api/v1`;
    }

    const needsHeaderFix =
      parsed.authHeader !== prov.authHeader ||
      (parsed.extractedApiKey !== null && parsed.authType !== prov.authType) ||
      nextBaseUrl !== prov.baseUrl;

    if (parsed.extractedApiKey && !credProviderIds.has(prov.id)) {
      await db
        .insert(providerCredentials)
        .values({
          providerId: prov.id,
          encryptedApiKey: encryptSecret(parsed.extractedApiKey),
          keyFingerprint: maskApiKey(parsed.extractedApiKey),
        })
        .onConflictDoNothing();
      credProviderIds.add(prov.id);
    }

    if (needsHeaderFix) {
      await db
        .update(providers)
        .set({
          authHeader: parsed.authHeader,
          authType: parsed.extractedApiKey ? parsed.authType : prov.authType,
          baseUrl: nextBaseUrl,
          updatedAt: new Date(),
        })
        .where(eq(providers.id, prov.id));
    }
  }
}

const REQUESTED_V3_PROVIDERS = [
  {
    code: 'qcst',
    name: 'QCST API',
    baseUrl: 'https://api.qcst.tech',
    docsUrl: 'https://api.qcst.tech/docs',
    authType: 'x_api_key',
    authHeader: 'X-API-Key',
    rateLimitPerMin: 60,
    supportsIdempotency: true,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 19,
  },
  {
    code: 'digitalaistore',
    name: 'DigitalAI Store',
    baseUrl: 'https://api.digitalaistore.com/v1',
    docsUrl: 'https://api.digitalaistore.com/v1',
    authType: 'x_api_key',
    authHeader: 'X-API-Key',
    rateLimitPerMin: 60,
    supportsIdempotency: true,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 20,
  },
  {
    code: 'resellwithme',
    name: 'ResellWithMe',
    baseUrl: 'https://resellwithme.com/api/v1',
    docsUrl: 'https://resellwithme.com/api/v1',
    authType: 'x_api_key',
    authHeader: 'X-API-Key',
    rateLimitPerMin: 60,
    supportsIdempotency: true,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 21,
  },
  {
    code: 'bulkware',
    name: 'Bulkware',
    baseUrl: 'https://bulkware.co',
    docsUrl: 'https://bulkware.co',
    authType: 'x_api_key',
    authHeader: 'X-API-Key',
    rateLimitPerMin: 60,
    supportsIdempotency: false,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 22,
  },
  {
    code: 'cmpdr',
    name: 'CMPDR API',
    baseUrl: 'https://api.cmpdr.dev',
    docsUrl: 'https://api.cmpdr.dev/docs',
    authType: 'x_api_key',
    authHeader: 'X-API-Key',
    rateLimitPerMin: 60,
    supportsIdempotency: true,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 23,
  },
  {
    code: 'qamify',
    name: 'Qamify',
    baseUrl: 'https://api.qamify.site',
    docsUrl: 'https://api.qamify.site/docs',
    authType: 'x_api_key',
    authHeader: 'X-API-Key',
    rateLimitPerMin: 60,
    supportsIdempotency: true,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 24,
  },
  {
    code: 'technysoft',
    name: 'TechnySoft',
    baseUrl: 'https://api.technysoft.com',
    docsUrl: 'https://api.technysoft.com/docs',
    authType: 'x_api_key',
    authHeader: 'X-API-Key',
    rateLimitPerMin: 60,
    supportsIdempotency: true,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 25,
  },
  {
    code: 'nastele',
    name: 'Nastele Partner',
    baseUrl: 'https://nastele.online/api/partner',
    docsUrl: 'https://nastele.online/api/partner/docs',
    authType: 'x_api_key',
    authHeader: 'X-API-Key',
    rateLimitPerMin: 60,
    supportsIdempotency: true,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 26,
  },
  {
    code: 'hmkstore',
    name: 'HMK Store',
    baseUrl: 'https://hmkstore.com/api/v1',
    docsUrl: 'https://hmkstore.com/en/developers?src=bot',
    authType: 'x_api_key',
    authHeader: 'X-API-Key',
    rateLimitPerMin: 60,
    supportsIdempotency: false,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 27,
  },
  {
    code: 'aihubfashion',
    name: 'AIHub Fashion',
    baseUrl: 'https://api.aihub.fashion',
    docsUrl: 'https://api.aihub.fashion/docs',
    authType: 'x_api_key',
    authHeader: 'X-API-Key',
    rateLimitPerMin: 60,
    supportsIdempotency: true,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 28,
  },
  {
    code: 'namqzz',
    name: 'Nam API',
    baseUrl: 'https://api.nam.qzz.io',
    docsUrl: 'https://api.nam.qzz.io',
    authType: 'x_api_key',
    authHeader: 'X-API-Key',
    rateLimitPerMin: 60,
    supportsIdempotency: false,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 29,
  },
  {
    code: 'qwanhailuna',
    name: 'Qwanhailuna Shop',
    baseUrl: 'https://shop.qwanhailuna.io.vn',
    docsUrl: 'https://shop.qwanhailuna.io.vn/api-docs.html',
    authType: 'x_api_key',
    authHeader: 'X-API-Key',
    rateLimitPerMin: 60,
    supportsIdempotency: false,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 30,
  },
  {
    code: 'bunnytools',
    name: 'BunnyTools Bot',
    baseUrl: 'https://bunnytoolsbot.tech/api/v1',
    docsUrl: 'https://bunnytoolsbot.tech/developer',
    authType: 'x_api_key',
    authHeader: 'X-API-Key',
    rateLimitPerMin: 60,
    supportsIdempotency: false,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 31,
  },
  {
    code: 'dakipartner',
    name: 'Daki Partner',
    baseUrl: 'http://paid2.daki.cc:4153/api/partner/v1',
    docsUrl: 'http://paid2.daki.cc:4153/api/partner/v1',
    authType: 'x_api_key',
    authHeader: 'X-API-Key',
    rateLimitPerMin: 60,
    supportsIdempotency: false,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 32,
  },
  {
    code: 'aitoolifystudio',
    name: 'AIToolify Studio',
    baseUrl: 'https://bot.aitoolifystudio.io/api/reseller/v1',
    docsUrl: 'https://bot.aitoolifystudio.io/api/reseller/v1',
    authType: 'x_api_key',
    authHeader: 'X-API-Key',
    rateLimitPerMin: 60,
    supportsIdempotency: true,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 33,
  },
  {
    code: 'silvexai',
    name: 'Silvex AI',
    baseUrl: 'https://silvex-ai.com/api/public/reseller',
    docsUrl: 'https://silvex-ai.com/api/public/reseller',
    authType: 'bearer',
    authHeader: 'Authorization',
    rateLimitPerMin: 60,
    supportsIdempotency: true,
    supportsWebhooks: false,
    supportsQuote: false,
    priority: 34,
  },
] as const;

async function ensureV3ResellerProviders(): Promise<void> {
  const [flagRow] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, 'seeded_v3_reseller_providers'))
    .limit(1);

  if (flagRow) return;

  await db
    .insert(providers)
    .values(
      REQUESTED_V3_PROVIDERS.map((p) => ({
        ...p,
        status: 'disconnected',
        isEnabled: true,
        cachedBalance: '0.0000',
        lowBalanceThreshold: '10.0000',
      }))
    )
    .onConflictDoNothing();

  await db
    .insert(settings)
    .values({
      key: 'seeded_v3_reseller_providers',
      valueJson: { seeded: true, count: REQUESTED_V3_PROVIDERS.length, seededAt: new Date().toISOString() },
    })
    .onConflictDoNothing();
}

async function ensureCategoriesRepairedV1(): Promise<void> {
  const [flag] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, 'repaired_product_categories_v1'))
    .limit(1);
  if (flag) return;

  const allCats = await db.select().from(categories);
  const catBySlug = new Map(allCats.map((c) => [c.slug.toLowerCase(), c]));

  // 1. Re-link any service_guides whose category_id became NULL when a category was recreated (e.g. Gemini)
  const guides = await db.select().from(serviceGuides);
  for (const g of guides) {
    if (g.categoryId === null) {
      const matchedCat = catBySlug.get(g.slug.toLowerCase());
      if (matchedCat) {
        await db
          .update(serviceGuides)
          .set({ categoryId: matchedCat.id, updatedAt: new Date() })
          .where(eq(serviceGuides.id, g.id));
      }
    }
  }

  // 2. Repair uncategorized (NULL) products & products wrongly dumped into Cloud by older sync logic
  const cloudCatId = catBySlug.get('cloud')?.id ?? null;
  const allProds = await db.select().from(storeProducts);

  for (const prod of allProds) {
    const isNullCat = prod.categoryId === null;
    const isInCloud = cloudCatId !== null && prod.categoryId === cloudCatId;
    if (!isNullCat && !isInCloud) continue;

    const matched = matchProductToStoreCategory(
      `${prod.titleAr} ${prod.titleEn || ''}`,
      `${prod.descriptionAr} ${prod.descriptionEn || ''}`,
      allCats
    );

    if (matched && matched.categoryId !== prod.categoryId) {
      await db
        .update(storeProducts)
        .set({ categoryId: matched.categoryId, updatedAt: new Date() })
        .where(eq(storeProducts.id, prod.id));
    } else if (isInCloud && !matched) {
      // Product in Cloud doesn't actually match Cloud (it was dumped by legacy default fallback) -> mark NULL so admin can auto-categorize cleanly
      await db
        .update(storeProducts)
        .set({ categoryId: null, updatedAt: new Date() })
        .where(eq(storeProducts.id, prod.id));
    }
  }

  await db
    .insert(settings)
    .values({
      key: 'repaired_product_categories_v1',
      valueJson: { repaired: true, repairedAt: new Date().toISOString() },
    })
    .onConflictDoNothing();
}
