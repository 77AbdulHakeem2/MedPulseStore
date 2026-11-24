import Decimal from 'decimal.js';
import { Bot } from 'grammy';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  users,
  walletLedger,
  storeProducts,
  productPrices,
  productProviderMappings,
  providerProducts,
  providers,
  categories,
  deposits,
  orders,
  settings,
  paymentMethods,
  notifications,
  botMenuButtons,
  serviceGuides,
  localDeposits,
} from '../db/schema.ts';
import {
  buildCustomerMainInlineKeyboard,
  buildCustomerNavFooter,
  buildDynamicMainInlineKeyboard,
  buildProductQuantityInlineKeyboard,
  buildPurchaseConfirmationInlineKeyboard,
  buildSupportTelegramUrl,
  formatCustomerOrderCard,
  formatCustomerProductButtonLabel,
  formatCustomerProfileCard,
  formatProductPurchasePromptTelegramPayload,
  formatPurchaseConfirmationMessage,
  generatePreviewOrderCode,
  parseAndValidateCustomQuantity,
  type CustomerInlineButton,
} from './sanitizer.ts';
import {
  stripTelegramHtmlToPlainText,
  stripTgEmojiTagsKeepFallback,
} from './productDescriptionEngine.ts';
import { getLiveCustomerCatalog } from './catalogService.ts';
import { formatMoney } from './pricing.ts';
import { ensureUserWallet, creditDepositAtomically } from './walletEngine.ts';
import {
  placeCustomerOrder,
  getCustomerOrdersWithSanitizedDeliveries,
  registerOrderTelegramNotifier,
} from './orderEngine.ts';
import { decryptSecret, encryptSecret, generateUniqueRef, maskApiKey } from './crypto.ts';
import {
  OFFICIAL_USDT_CONTRACTS,
  fetchTrc20TransactionFromTronGrid,
  verifyUsdtDepositTransaction,
} from './paymentVerifier.ts';
import {
  attemptBinanceDepositAutoVerification,
  resolveBinanceCredentials,
} from './binancePayHistory.ts';
import { handleTelegramAdminPanel } from './telegramAdminHandlers.ts';
import { resolveInitialLanguage, t, type SupportedLang } from '../i18n/index.ts';
import { matchProductToStoreCategory } from '../lib/offerClassifier.ts';
import {
  formatMoney2,
  formatRatePercentDisplay,
  formatReferAndEarnMessage,
  getUserReferralHistoryPage,
  getUserReferralSummary,
  registerUserReferralAttribution,
} from './referralEngine.ts';
import {
  fetchLiveYerExchangeRate,
  formatDisplayPrice,
  getCurrencyLocalDepositSettings,
  normalizeDisplayCurrency,
  type DisplayCurrency,
  type YerRoundingMode,
} from './currencyEngine.ts';
import {
  formatLocalDepositHistoryLine,
  handleAdminChannelLocalDepositAction,
  handleCustomerLocalDepositFlow,
  type LocalDepositDraftState,
} from './telegramLocalDepositFlow.ts';
import {
  isValidTelegramNumericId,
  type TelegramSendDetailedResult,
} from './broadcastEngine.ts';

export type BotInlineButton = CustomerInlineButton;

/**
 * STRICT INLINE-ONLY PAYLOAD:
 * Notice there is NO `replyKeyboard` field — Customer Bot uses InlineKeyboardMarkup ONLY!
 * Supports native Telegram `entities` to preserve 100% of formatting & custom emojis.
 */
export interface BotReplyPayload {
  text: string;
  parseMode?: 'HTML';
  htmlNoCustomEmojiFallback?: string;
  plainFallbackText?: string;
  entities?: any[];
  inlineKeyboard: BotInlineButton[][];
  mode: 'customer' | 'admin';
  lang?: SupportedLang;
  editInPlace?: boolean;
  accessDenied?: boolean;
}

export interface StoreProfileSettings {
  storeName: string;
  storeNameEn: string;
  welcomeMessageAr: string;
  welcomeMessageEn: string;
  welcomeEntitiesAr: any[];
  welcomeEntitiesEn: any[];
  supportHandle: string;
  termsAr: string;
  termsEn: string;
  isStoreOpen: boolean;
  usdtTrc20Wallet: string;
  usdtBep20Wallet: string;
  binancePayEnabled: boolean;
  arEnabled: boolean;
  enEnabled: boolean;
  defaultLanguage: SupportedLang;
}

async function getStoreSettings(): Promise<StoreProfileSettings> {
  const rows = await db.select().from(settings).where(eq(settings.key, 'store_profile')).limit(1);
  const raw = (rows[0]?.valueJson as Record<string, any>) || {};
  return {
    storeName: raw.storeName || 'متجر رَقْم',
    storeNameEn: raw.storeNameEn || 'Raqm Digital Store',
    welcomeMessageAr:
      raw.welcomeMessageAr ||
      'أهلاً بك في متجر رَقْم!\nتصفح البرامج والخدمات الرقمية واطلب اشتراكك فورًا من رصيد محفظتك.',
    welcomeMessageEn:
      raw.welcomeMessageEn ||
      'Welcome to Raqm Digital Store!\nBrowse digital services and order your subscription instantly from your wallet.',
    welcomeEntitiesAr: Array.isArray(raw.welcomeEntitiesAr) ? raw.welcomeEntitiesAr : [],
    welcomeEntitiesEn: Array.isArray(raw.welcomeEntitiesEn) ? raw.welcomeEntitiesEn : [],
    supportHandle: raw.supportHandle || '@raqm_support',
    termsAr: raw.termsAr || 'جميع المبيعات رقمية وتُسلم تلقائيًا.',
    termsEn: raw.termsEn || 'All products are digital and delivered automatically upon confirmation.',
    isStoreOpen: raw.isStoreOpen !== false,
    usdtTrc20Wallet: raw.usdtTrc20Wallet || 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',
    usdtBep20Wallet: raw.usdtBep20Wallet || '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    binancePayEnabled: raw.binancePayEnabled !== false,
    arEnabled: raw.arEnabled !== false,
    enEnabled: raw.enEnabled !== false,
    defaultLanguage: raw.defaultLanguage === 'en' ? 'en' : 'ar',
  };
}

interface BotFsmState {
  step?:
    | 'idle'
    | 'awaiting_deposit_amount'
    | 'awaiting_binance_txid'
    | 'awaiting_usdt_txid'
    | 'awaiting_custom_ref'
    | 'awaiting_custom_quantity'
    | 'awaiting_search'
    | 'awaiting_support'
    | 'awaiting_local_depositor_name'
    | 'awaiting_local_custom_amount'
    | 'awaiting_local_temp_depositor_name'
    | 'awaiting_local_proof_photo'
    | 'awaiting_edit_saved_depositor_name'
    | 'awaiting_admin_local_reject_reason';
  methodCode?: string;
  pendingDepositId?: number;
  pendingProductId?: number;
  pendingBackSource?: string;
  pendingLocalRejectId?: number;
  localDepositDraft?: LocalDepositDraftState;
  lastScreen?: string;
  adminFsm?: {
    step?: string;
    targetId?: number;
    field?: string;
    draft?: Record<string, any>;
  };
}

async function saveUserBotState(userId: number, state: BotFsmState) {
  await db
    .update(users)
    .set({ botStateJson: state, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

async function getConfiguredOwnerTelegramIds(): Promise<string[]> {
  const fromEnv = [
    process.env.TELEGRAM_OWNER_IDS || '',
    process.env.ADMIN_TELEGRAM_IDS || '',
  ]
    .join(',')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    const [cfgRow] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, 'telegram_bot_config'))
      .limit(1);
    const cfg = (cfgRow?.valueJson as Record<string, any>) || {};
    const fromDb = String(cfg.ownerTelegramIds || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return Array.from(new Set([...fromEnv, ...fromDb]));
  } catch {
    return Array.from(new Set(fromEnv));
  }
}

export async function getOrCreateTelegramUserWithMeta(params: {
  telegramUserId: string;
  username?: string;
  displayName?: string;
  telegramLanguageCode?: string | null;
}) {
  const store = await getStoreSettings();
  const ownerIds = await getConfiguredOwnerTelegramIds();
  const shouldBeOwner = ownerIds.includes(params.telegramUserId);

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.telegramUserId, params.telegramUserId))
    .limit(1);

  if (existing.length > 0) {
    let userRecord = existing[0];
    if (shouldBeOwner && userRecord.role !== 'owner') {
      const [promoted] = await db
        .update(users)
        .set({ role: 'owner', updatedAt: new Date() })
        .where(eq(users.id, userRecord.id))
        .returning();
      if (promoted) userRecord = promoted;
    }
    await ensureUserWallet(userRecord.id);
    return { user: userRecord, isNewUser: false };
  }

  const role = shouldBeOwner ? 'owner' : 'customer';

  const initialLang = resolveInitialLanguage({
    telegramLanguageCode: params.telegramLanguageCode,
    arEnabled: store.arEnabled,
    enEnabled: store.enEnabled,
    defaultLanguage: store.defaultLanguage,
  });

  const inserted = await db
    .insert(users)
    .values({
      uid: `tg:${params.telegramUserId}`,
      telegramUserId: params.telegramUserId,
      telegramUsername: params.username || `user_${params.telegramUserId}`,
      displayName: params.displayName || `Customer #${params.telegramUserId}`,
      role,
      language: initialLang,
      languageCode: initialLang,
      languageManuallySelected: false,
      referralCode: `ref_${params.telegramUserId}`,
    })
    .onConflictDoNothing({ target: users.telegramUserId })
    .returning();

  if (inserted.length > 0) {
    await ensureUserWallet(inserted[0].id);
    return { user: inserted[0], isNewUser: true };
  }

  // Concurrent race fallback: user was just created by another update
  const [raceUser] = await db
    .select()
    .from(users)
    .where(eq(users.telegramUserId, params.telegramUserId))
    .limit(1);

  await ensureUserWallet(raceUser.id);
  return { user: raceUser, isNewUser: false };
}

export async function getOrCreateTelegramUser(params: {
  telegramUserId: string;
  username?: string;
  displayName?: string;
  telegramLanguageCode?: string | null;
}) {
  const { user } = await getOrCreateTelegramUserWithMeta(params);
  return user;
}

async function getDynamicCustomerMainKeyboard(
  lang: SupportedLang,
  supportHandle: string,
  preferredCurrency: DisplayCurrency = 'USD'
): Promise<BotInlineButton[][]> {
  const rows = await db
    .select()
    .from(botMenuButtons)
    .where(isNull(botMenuButtons.parentId))
    .orderBy(asc(botMenuButtons.rowOrder), asc(botMenuButtons.colOrder), asc(botMenuButtons.id));

  if (rows.length === 0) {
    return buildCustomerMainInlineKeyboard(lang, supportHandle, preferredCurrency);
  }

  return buildDynamicMainInlineKeyboard(
    rows.map((r) => ({
      id: r.id,
      code: r.code,
      labelAr: r.labelAr,
      labelEn: r.labelEn,
      iconEmoji: r.iconEmoji,
      iconCustomEmojiId: r.iconCustomEmojiId,
      buttonStyle: r.buttonStyle,
      actionType: r.actionType,
      actionValue: r.actionValue,
      rowOrder: r.rowOrder,
      colOrder: r.colOrder,
      buttonsPerRow: r.buttonsPerRow,
      isVisible: r.isVisible,
      isEnabled: r.isEnabled,
    })),
    lang,
    supportHandle,
    preferredCurrency
  );
}

async function getDynamicSubButtonKeyboard(
  parentButtonId: number,
  lang: SupportedLang,
  supportHandle: string
): Promise<BotInlineButton[][]> {
  const children = await db
    .select()
    .from(botMenuButtons)
    .where(eq(botMenuButtons.parentId, parentButtonId))
    .orderBy(asc(botMenuButtons.rowOrder), asc(botMenuButtons.colOrder), asc(botMenuButtons.id));

  if (children.length === 0) return [];
  return buildDynamicMainInlineKeyboard(
    children.map((r) => ({
      id: r.id,
      code: r.code,
      labelAr: r.labelAr,
      labelEn: r.labelEn,
      iconEmoji: r.iconEmoji,
      iconCustomEmojiId: r.iconCustomEmojiId,
      buttonStyle: r.buttonStyle,
      actionType: r.actionType,
      actionValue: r.actionValue,
      rowOrder: r.rowOrder,
      colOrder: r.colOrder,
      buttonsPerRow: r.buttonsPerRow,
      isVisible: r.isVisible,
      isEnabled: r.isEnabled,
    })),
    lang,
    supportHandle
  );
}

async function getPublishedCustomerProducts(lang: SupportedLang, userId?: number) {
  return getLiveCustomerCatalog(lang, userId);
}

function resolveUserLang(
  user: { languageCode?: string | null; language?: string | null },
  store: StoreProfileSettings
): SupportedLang {
  const stored = (user.languageCode || user.language || store.defaultLanguage || 'ar').toLowerCase();
  if (stored === 'en' && store.enEnabled) return 'en';
  if (stored === 'ar' && store.arEnabled) return 'ar';
  return store.defaultLanguage || (store.arEnabled ? 'ar' : 'en');
}

function getStoreDisplayName(store: StoreProfileSettings, lang: SupportedLang): string {
  return lang === 'en' ? store.storeNameEn || store.storeName : store.storeName;
}

function chunkButtons(buttons: BotInlineButton[], perRow = 2): BotInlineButton[][] {
  const rows: BotInlineButton[][] = [];
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push(buttons.slice(i, i + perRow));
  }
  return rows;
}

async function createDepositAndRenderInstructions(params: {
  userId: number;
  methodCode: string;
  amountStr: string;
  lang: SupportedLang;
  store: StoreProfileSettings;
  editInPlace: boolean;
}): Promise<BotReplyPayload> {
  const [methodRow] = await db
    .select()
    .from(paymentMethods)
    .where(eq(paymentMethods.code, params.methodCode))
    .limit(1);

  const amountDec = new Decimal(params.amountStr);
  const depRef = generateUniqueRef('DEP');
  const memoTag = `M${Date.now().toString().slice(-6)}`;

  // 1. Personal Binance ID Auto-Verification Flow
  if (params.methodCode === 'binance_id' || methodRow?.providerType === 'binance_personal_pay') {
    const binanceCreds = await resolveBinanceCredentials();
    if (!binanceCreds.receiverId) {
      return {
        mode: 'customer',
        lang: params.lang,
        editInPlace: params.editInPlace,
        text: t(params.lang, 'binance_not_configured'),
        inlineKeyboard: [buildCustomerNavFooter(params.lang, 'c:topup')],
      };
    }

    const [createdDep] = await db
      .insert(deposits)
      .values({
        depositRef: depRef,
        userId: params.userId,
        method: 'binance_id',
        expectedAmount: amountDec.toFixed(4),
        currency: 'USDT',
        network: 'BINANCE_ID',
        assignedRecipientAddress: binanceCreds.receiverId,
        uniqueMemoTag: memoTag,
        requiredConfirmations: 1,
        status: 'pending',
      })
      .returning();

    await saveUserBotState(params.userId, {
      step: 'idle',
      methodCode: 'binance_id',
      pendingDepositId: createdDep.id,
      lastScreen: 'c:topup',
    });

    return {
      mode: 'customer',
      lang: params.lang,
      editInPlace: params.editInPlace,
      text: t(params.lang, 'binance_deposit_instructions', {
        depositRef: depRef,
        amount: amountDec.toFixed(2),
        receiverId: binanceCreds.receiverId,
      }),
      inlineKeyboard: [
        [
          {
            text: t(params.lang, 'btn_confirm_transfer'),
            callbackData: `c:bn_confirm:${createdDep.id}`,
            style: 'success',
          },
        ],
        buildCustomerNavFooter(params.lang, 'c:topup'),
      ],
    };
  }

  // 2. Blockchain USDT (TRC20 / BEP20)
  if (
    params.methodCode === 'usdt_trc20' ||
    params.methodCode === 'usdt_bep20' ||
    methodRow?.providerType === 'blockchain_usdt'
  ) {
    const network = params.methodCode === 'usdt_bep20' ? 'BEP20' : 'TRC20';
    const recipient = network === 'BEP20' ? params.store.usdtBep20Wallet : params.store.usdtTrc20Wallet;
    const contract = OFFICIAL_USDT_CONTRACTS[network];

    const [createdDep] = await db
      .insert(deposits)
      .values({
        depositRef: depRef,
        userId: params.userId,
        method: params.methodCode,
        expectedAmount: amountDec.toFixed(4),
        currency: 'USDT',
        network,
        contractAddress: contract,
        assignedRecipientAddress: recipient,
        uniqueMemoTag: memoTag,
        requiredConfirmations: 12,
        status: 'pending',
      })
      .returning();

    await saveUserBotState(params.userId, {
      step: 'awaiting_usdt_txid',
      methodCode: params.methodCode,
      pendingDepositId: createdDep.id,
      lastScreen: 'c:topup',
    });

    const methodName =
      params.lang === 'en'
        ? methodRow?.nameEn || `USDT (${network})`
        : methodRow?.nameAr || `USDT (${network})`;

    return {
      mode: 'customer',
      lang: params.lang,
      editInPlace: params.editInPlace,
      text: t(params.lang, 'usdt_deposit_instructions', {
        methodName,
        depositRef: depRef,
        amount: amountDec.toFixed(2),
        recipient,
        memoTag,
      }),
      inlineKeyboard: [buildCustomerNavFooter(params.lang, 'c:topup')],
    };
  }

  // 3. Extensible Custom Payment Method
  const [createdDep] = await db
    .insert(deposits)
    .values({
      depositRef: depRef,
      userId: params.userId,
      method: params.methodCode,
      expectedAmount: amountDec.toFixed(4),
      currency: methodRow?.currency || 'USDT',
      network: params.methodCode.toUpperCase(),
      assignedRecipientAddress: String((methodRow?.configJson as any)?.accountRef || ''),
      uniqueMemoTag: memoTag,
      requiredConfirmations: 1,
      status: 'pending',
    })
    .returning();

  await saveUserBotState(params.userId, {
    step: 'awaiting_custom_ref',
    methodCode: params.methodCode,
    pendingDepositId: createdDep.id,
    lastScreen: 'c:topup',
  });

  const methodName =
    params.lang === 'en' ? methodRow?.nameEn || params.methodCode : methodRow?.nameAr || params.methodCode;
  const instructions =
    params.lang === 'en'
      ? methodRow?.instructionsEn || methodRow?.instructionsAr || ''
      : methodRow?.instructionsAr || methodRow?.instructionsEn || '';

  return {
    mode: 'customer',
    lang: params.lang,
    editInPlace: params.editInPlace,
    text: t(params.lang, 'custom_deposit_instructions', {
      methodName,
      depositRef: depRef,
      amount: amountDec.toFixed(2),
      currency: methodRow?.currency || 'USDT',
      instructions,
    }),
    inlineKeyboard: [buildCustomerNavFooter(params.lang, 'c:topup')],
  };
}

function classifyTelegramSendError(err: any): TelegramSendDetailedResult {
  const errorCode =
    typeof err?.error_code === 'number'
      ? err.error_code
      : typeof err?.status === 'number'
        ? err.status
        : undefined;
  const rawDescription = String(err?.description || err?.message || err || '').trim();
  const lower = rawDescription.toLowerCase();

  if (
    errorCode === 403 ||
    lower.includes('bot was blocked') ||
    lower.includes('user is deactivated') ||
    lower.includes("bot can't initiate conversation")
  ) {
    return {
      ok: false,
      blocked: true,
      errorCode: errorCode || 403,
      errorMessage: 'المستخدم أوقف البوت أو حظره',
    };
  }

  if (errorCode === 400 && (lower.includes('chat not found') || lower.includes('user not found'))) {
    return {
      ok: false,
      blocked: true,
      errorCode: 400,
      errorMessage: 'المستخدم لم يبدأ محادثة مع البوت',
    };
  }

  if (errorCode === 429 || lower.includes('too many requests')) {
    const retryAfterSec =
      typeof err?.parameters?.retry_after === 'number'
        ? err.parameters.retry_after
        : Number(rawDescription.match(/retry after (\d+)/i)?.[1] || 2);
    return {
      ok: false,
      errorCode: 429,
      retryAfterSec: Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 2,
      errorMessage: 'تجاوز مؤقت لحد الإرسال في تيليجرام',
    };
  }

  return {
    ok: false,
    errorCode,
    errorMessage: rawDescription || 'تعذر الإرسال عبر تيليجرام',
  };
}

/**
 * Checks whether Telegram outbound message delivery is configured (via live Grammy bot or stored bot token).
 */
export async function isTelegramDeliveryAvailable(): Promise<{
  available: boolean;
  botUsername: string | null;
  state: TelegramBotRuntimeStatus['state'];
  reasonAr?: string;
}> {
  const resolved = await resolveTelegramConfigFromDbAndEnv();
  if (!resolved.token) {
    return {
      available: false,
      botUsername: null,
      state: 'not_configured',
      reasonAr: 'توكن بوت تيليجرام غير مضبوط بعد. يرجى ربط البوت أولًا من إعدادات تيليجرام.',
    };
  }
  return {
    available: true,
    botUsername: runtimeState.botUsername,
    state: runtimeState.state,
  };
}

/**
 * Detailed direct Telegram sender used by Broadcast Engine and Admin notifications.
 * Uses the active Grammy bot instance when running, and falls back to the configured Bot API token
 * from DB/env so broadcasts still deliver reliably even if polling was paused or restarting.
 */
export async function sendDirectTelegramMessageDetailed(
  telegramUserId: string,
  text: string
): Promise<TelegramSendDetailedResult> {
  const cleanedId = String(telegramUserId || '').trim();
  if (!isValidTelegramNumericId(cleanedId)) {
    return { ok: false, errorCode: 400, errorMessage: 'معرّف تيليجرام غير صالح' };
  }

  if (grammyBotInstance) {
    try {
      await grammyBotInstance.api.sendMessage(cleanedId, text);
      return { ok: true };
    } catch (err) {
      return classifyTelegramSendError(err);
    }
  }

  const resolved = await resolveTelegramConfigFromDbAndEnv();
  if (!resolved.token) {
    return {
      ok: false,
      errorCode: 401,
      errorMessage: 'توكن بوت تيليجرام غير مضبوط',
    };
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${resolved.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cleanedId,
        text,
      }),
    });
    const payload = (await response.json().catch(() => null)) as any;
    if (response.ok && payload?.ok) {
      return { ok: true };
    }
    return classifyTelegramSendError({
      error_code: payload?.error_code ?? response.status,
      description: payload?.description || `HTTP ${response.status}`,
      parameters: payload?.parameters,
    });
  } catch (err) {
    return classifyTelegramSendError(err);
  }
}

/**
 * Helper used by Admin Dashboard & Admin Bot to notify a customer on Telegram when their balance or account status changes.
 */
export async function sendDirectTelegramNotification(telegramUserId: string, text: string): Promise<boolean> {
  const res = await sendDirectTelegramMessageDetailed(telegramUserId, text);
  if (!res.ok) {
    console.warn('Direct Telegram notification skipped:', res.errorMessage || res.errorCode);
  }
  return res.ok;
}

export function getLiveBotUsername(): string {
  return (runtimeState.botUsername || process.env.TELEGRAM_BOT_USERNAME || 'RaqmStoreBot').replace(/^@+/, '');
}

registerOrderTelegramNotifier(sendDirectTelegramNotification);

/**
 * Unified Telegram interaction handler used BOTH by real Grammy bot
 * AND by the interactive live simulator inside the dashboard!
 */
export async function handleTelegramInteraction(params: {
  telegramUserId: string;
  username?: string;
  displayName?: string;
  telegramLanguageCode?: string | null;
  text?: string;
  entities?: any[];
  callbackData?: string;
  photoFileId?: string;
  proofImageDataUrl?: string;
  photoCaption?: string;
  enforceRole?: 'customer' | 'admin';
}): Promise<BotReplyPayload> {
  const { user, isNewUser } = await getOrCreateTelegramUserWithMeta({
    telegramUserId: params.telegramUserId,
    username: params.username,
    displayName: params.displayName,
    telegramLanguageCode: params.telegramLanguageCode,
  });

  // Permanent write-once referral attribution ONLY for brand-new users arriving via /start ref_<telegramId>
  if (isNewUser && params.text && !params.callbackData) {
    try {
      await registerUserReferralAttribution({
        newUserId: user.id,
        newUserTelegramId: user.telegramUserId || params.telegramUserId,
        startPayload: params.text,
        isNewUser: true,
      });
    } catch (refErr) {
      console.warn('Referral registration skipped:', refErr instanceof Error ? refErr.message : refErr);
    }
  }

  const store = await getStoreSettings();
  const lang = resolveUserLang(user, store);
  const storeDisplayName = getStoreDisplayName(store, lang);
  const isCallback = Boolean(params.callbackData);

  const isPrivilegedAdmin =
    (user.role === 'owner' || user.role === 'admin') && params.enforceRole !== 'customer';

  const input = (params.callbackData || params.text || '/start').trim();
  const fsm: BotFsmState = (user.botStateJson as BotFsmState) || { step: 'idle' };
  const activeAdminFsmStep = fsm.adminFsm?.step && fsm.adminFsm.step !== 'idle' ? fsm.adminFsm.step : null;

  // ==========================================================================
  // 1. STRICT RBAC GUARD FOR TELEGRAM ADMIN PANEL (/admin, adm:*, active adminFsm)
  // ==========================================================================
  const isExplicitAdminCommand =
    input === '/admin' ||
    input.startsWith('adm:') ||
    input.startsWith('/setprice') ||
    input.startsWith('سعر ');

  const isAdminFsmTextInput =
    !isCallback &&
    Boolean(activeAdminFsmStep) &&
    isPrivilegedAdmin &&
    input !== '/start' &&
    !input.startsWith('/start ') &&
    input !== '/menu';

  if (isExplicitAdminCommand || isAdminFsmTextInput) {
    if (!isPrivilegedAdmin) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        accessDenied: true,
        text: t(lang, 'home_access_fallback', { storeName: storeDisplayName }),
        inlineKeyboard: await getDynamicCustomerMainKeyboard(lang, store.supportHandle),
      };
    }
    return handleTelegramAdminPanel({
      adminUser: user,
      input,
      rawText: params.text,
      entities: params.entities,
      store,
      isCallback,
      notifyTelegramUser: async (tgId, txt) => {
        await sendDirectTelegramNotification(tgId, txt);
      },
    });
  }

  // ==========================================================================
  // 1b. BLOCKED USER ENFORCEMENT (Admin Ban / Unban)
  // ==========================================================================
  if (user.isBlocked && user.role !== 'owner') {
    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      accessDenied: true,
      text:
        lang === 'en'
          ? '🚫 Your account is currently suspended by store administration.\nPlease contact support if you believe this is a mistake.'
          : '🚫 تم حظر حسابك مؤقتًا من استخدام المتجر من قِبل الإدارة.\nللاستفسار أو رفع الحظر يرجى التواصل مع الدعم الفني.',
      inlineKeyboard: [
        [{ text: t(lang, 'btn_support'), url: buildSupportTelegramUrl(store.supportHandle), style: 'primary' }],
      ],
    };
  }

  // ==========================================================================
  // 2. CUSTOMER STORE BOT FLOW (100% BILINGUAL AR/EN + USD/YER + INLINE ONLY)
  // ==========================================================================
  const wallet = await ensureUserWallet(user.id);
  const currencyCfg = await getCurrencyLocalDepositSettings();
  let preferredCurrency: DisplayCurrency = normalizeDisplayCurrency(user.preferredCurrency);
  let displayRate: string | null = null;
  const roundingMode: YerRoundingMode = currencyCfg.roundingMode;

  if (preferredCurrency === 'YER') {
    const liveRate = await fetchLiveYerExchangeRate({
      forceFresh: false,
      settingsOverride: currencyCfg,
    });
    if (liveRate.ok && liveRate.rate) {
      displayRate = liveRate.rate;
    }
  }

  const renderCustomerHome = async (
    activeLang: SupportedLang,
    bannerSuffix?: string,
    currencyOverride?: DisplayCurrency
  ): Promise<BotReplyPayload> => {
    const activeCur = currencyOverride || preferredCurrency;
    const sName = getStoreDisplayName(store, activeLang);
    const welcome = activeLang === 'en' ? store.welcomeMessageEn : store.welcomeMessageAr;
    const savedEntities = activeLang === 'en' ? store.welcomeEntitiesEn : store.welcomeEntitiesAr;
    const inlineKeyboard = await getDynamicCustomerMainKeyboard(
      activeLang,
      store.supportHandle,
      activeCur
    );

    // If admin saved custom formatted welcome text with Telegram entities, preserve it verbatim
    // and only APPEND status/banner text so entity offsets stay 100% valid!
    if (Array.isArray(savedEntities) && savedEntities.length > 0) {
      const suffixParts: string[] = [];
      if (!store.isStoreOpen) suffixParts.push(t(activeLang, 'home_status_closed'));
      if (bannerSuffix) suffixParts.push(bannerSuffix);
      const finalText = suffixParts.length > 0 ? `${welcome}\n\n${suffixParts.join('\n')}` : welcome;
      return {
        mode: 'customer',
        lang: activeLang,
        editInPlace: isCallback,
        text: finalText,
        entities: savedEntities,
        inlineKeyboard,
      };
    }

    const lines = [
      t(activeLang, 'home_title', { storeName: sName }),
      '',
      welcome,
      ...(!store.isStoreOpen ? ['', t(activeLang, 'home_status_closed')] : []),
      ...(bannerSuffix ? ['', bannerSuffix] : []),
    ];

    return {
      mode: 'customer',
      lang: activeLang,
      editInPlace: isCallback,
      text: lines.join('\n'),
      inlineKeyboard,
    };
  };

  // --- 1-CLICK INSTANT CURRENCY TOGGLE (USD $ <-> YER ﷼) ---
  if (input === 'c:currency_toggle' || input === '/currency') {
    const nextCurrency: DisplayCurrency = preferredCurrency === 'YER' ? 'USD' : 'YER';

    if (nextCurrency === 'YER') {
      const liveCheck = await fetchLiveYerExchangeRate({
        forceFresh: true,
        settingsOverride: currencyCfg,
      });
      if (!liveCheck.ok || !liveCheck.rate) {
        return renderCustomerHome(
          lang,
          lang === 'en'
            ? `⚠️ ${liveCheck.errorMessageEn || 'Live YER exchange rate is temporarily unavailable. Keeping USD.'}`
            : `⚠️ ${liveCheck.errorMessageAr || 'تعذر جلب سعر الصرف المباشر للريال اليمني حاليًا. تم الإبقاء على الدولار ($).'}`
        );
      }
      displayRate = liveCheck.rate;
    }

    preferredCurrency = nextCurrency;
    await db
      .update(users)
      .set({ preferredCurrency: nextCurrency, updatedAt: new Date() })
      .where(eq(users.id, user.id));

    const banner =
      nextCurrency === 'YER'
        ? lang === 'en'
          ? '✅ Display currency switched to Yemeni Rial (﷼). All prices and balances are now shown in YER.'
          : '✅ تم تغيير عملة العرض إلى الريال اليمني (﷼). جميع الأسعار والأرصدة ستظهر الآن بالريال اليمني.'
        : lang === 'en'
        ? '✅ Display currency switched to US Dollar ($).'
        : '✅ تم تغيير عملة العرض إلى الدولار الأمريكي ($).';

    return renderCustomerHome(lang, banner, nextCurrency);
  }

  // --- 1-CLICK INSTANT LANGUAGE TOGGLE (NO SUBMENU!) ---
  if (input === 'c:lang_toggle' || input === 'c:lang' || input === '/language' || input === '/lang') {
    let nextLang: SupportedLang = lang === 'ar' ? 'en' : 'ar';
    if (nextLang === 'en' && !store.enEnabled) nextLang = 'ar';
    if (nextLang === 'ar' && !store.arEnabled) nextLang = 'en';

    await db
      .update(users)
      .set({
        languageCode: nextLang,
        language: nextLang,
        languageManuallySelected: true,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    return renderCustomerHome(nextLang);
  }

  // Direct setlang callbacks (supported by web simulator quick-preview buttons)
  if (input === 'c:setlang:ar' || input === 'c:setlang:en') {
    const chosen: SupportedLang = input.endsWith(':en') ? 'en' : 'ar';
    if ((chosen === 'ar' && !store.arEnabled) || (chosen === 'en' && !store.enEnabled)) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text: t(lang, 'lang_disabled'),
        inlineKeyboard: [buildCustomerNavFooter(lang)],
      };
    }

    await db
      .update(users)
      .set({
        languageCode: chosen,
        language: chosen,
        languageManuallySelected: true,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    return renderCustomerHome(chosen);
  }

  // --- Start / Home (resets active customer or admin FSM cleanly) ---
  if (
    input === '/start' ||
    input.startsWith('/start ') ||
    input === '/menu' ||
    input === 'c:home' ||
    input === 'cust:home'
  ) {
    if ((fsm.step && fsm.step !== 'idle') || activeAdminFsmStep) {
      await saveUserBotState(user.id, {
        ...fsm,
        step: 'idle',
        localDepositDraft: undefined,
        adminFsm: { step: 'idle' },
      });
    }
    return renderCustomerHome(lang);
  }

  // --- LOCAL YEMENI WALLETS DEPOSIT FLOW (Callbacks, Text Steps, Photo Proof) ---
  const isLocalDepInteraction =
    input.startsWith('c:local_dep:') ||
    Boolean(params.photoFileId) ||
    Boolean(params.proofImageDataUrl) ||
    (!isCallback &&
      (fsm.step === 'awaiting_local_depositor_name' ||
        fsm.step === 'awaiting_local_custom_amount' ||
        fsm.step === 'awaiting_local_temp_depositor_name' ||
        fsm.step === 'awaiting_local_proof_photo' ||
        fsm.step === 'awaiting_edit_saved_depositor_name'));

  if (isLocalDepInteraction) {
    const localReply = await handleCustomerLocalDepositFlow({
      user,
      fsm,
      input,
      isCallback,
      lang,
      rawText: params.text,
      photoFileId: params.photoFileId,
      proofImageDataUrl: params.proofImageDataUrl,
      photoCaption: params.photoCaption,
    });
    if (localReply) {
      return localReply;
    }
  }

  // Direct slash command shortcuts
  if (input === '/wallet') {
    return handleTelegramInteraction({ ...params, callbackData: 'c:wallet', text: undefined });
  }
  if (input === '/orders') {
    return handleTelegramInteraction({ ...params, callbackData: 'c:orders', text: undefined });
  }
  if (input === '/topup') {
    return handleTelegramInteraction({ ...params, callbackData: 'c:topup', text: undefined });
  }

  // --- 🛍 STORE: 2-Column Grid of Programs & Services (Gemini, ChatGPT, Gamma, Cloud, Canva, Adobe, Duolingo, YouTube) ---
  if (
    input === 'c:store' ||
    input === 'c:cats' ||
    input === 'cust:categories' ||
    input === 'c:prods' ||
    input === 'cust:products'
  ) {
    const cats = await db
      .select()
      .from(categories)
      .where(and(eq(categories.isActive, true), eq(categories.showInStore, true)))
      .orderBy(asc(categories.sortOrder), asc(categories.id));

    const [storeParentBtn] = await db
      .select()
      .from(botMenuButtons)
      .where(and(eq(botMenuButtons.actionType, 'builtin'), eq(botMenuButtons.actionValue, 'store')))
      .limit(1);
    const extraStoreSubRows = storeParentBtn
      ? await getDynamicSubButtonKeyboard(storeParentBtn.id, lang, store.supportHandle)
      : [];

    if (cats.length === 0 && extraStoreSubRows.length === 0) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text: t(lang, 'products_empty'),
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:home')],
      };
    }

    const catButtons: BotInlineButton[] = cats.map((c) => {
      const label = lang === 'en' ? c.nameEn || c.nameAr : c.nameAr || c.nameEn;
      const prefix = c.iconEmoji ? `${c.iconEmoji} ` : '';
      return {
        text: `${prefix}${label}`,
        callbackData: `c:cat:${c.id}`,
        iconCustomEmojiId: c.iconCustomEmojiId || undefined,
        style:
          c.buttonStyle === 'success' || c.buttonStyle === 'danger' || c.buttonStyle === 'primary'
            ? c.buttonStyle
            : 'primary',
      };
    });

    const keyboard = [...chunkButtons(catButtons, 2), ...extraStoreSubRows];
    keyboard.push(buildCustomerNavFooter(lang, 'c:home'));

    const customStoreHeader = storeParentBtn
      ? lang === 'en'
        ? storeParentBtn.contentEn || storeParentBtn.contentAr
        : storeParentBtn.contentAr || storeParentBtn.contentEn
      : '';

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: customStoreHeader || t(lang, 'store_title', { storeName: storeDisplayName }),
      inlineKeyboard: keyboard,
    };
  }

  // --- Program/Category Offers View: Shows Program Guide (with preserved entities) FIRST + ONLY that Program's Offers ---
  if (input.startsWith('c:cat:') || input.startsWith('cust:cat:') || input.startsWith('c:catslug:')) {
    const isSlug = input.startsWith('c:catslug:');
    const keyVal = input.split(':')[2] || '';
    const [cat] = isSlug
      ? await db.select().from(categories).where(eq(categories.slug, keyVal)).limit(1)
      : await db.select().from(categories).where(eq(categories.id, Number(keyVal))).limit(1);

    if (!cat || !cat.isActive) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text: t(lang, 'category_empty'),
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:store')],
      };
    }

    const catTitle = lang === 'en' ? cat.nameEn || cat.nameAr : cat.nameAr || cat.nameEn;
    const allPublished = await getPublishedCustomerProducts(lang, user.id);
    const prods = allPublished.filter(
      (p) =>
        p.categoryId === cat.id ||
        (p.categoryId === null && matchProductToStoreCategory(p.title, p.description || '', [cat]) !== null)
    );

    // Fetch matching Service Guide to show formatted guide message FIRST!
    const [guide] = await db
      .select()
      .from(serviceGuides)
      .where(and(eq(serviceGuides.categoryId, cat.id), eq(serviceGuides.isVisible, true)))
      .orderBy(asc(serviceGuides.sortOrder))
      .limit(1);

    let messageText = '';
    let messageEntities: any[] | undefined;

    if (guide) {
      const guideText = lang === 'en' ? guide.contentEn || guide.contentAr : guide.contentAr || guide.contentEn;
      const guideEnts = lang === 'en' ? guide.contentEntitiesEn : guide.contentEntitiesAr;
      if (guideText && guideText.trim()) {
        messageText = guideText;
        if (Array.isArray(guideEnts) && guideEnts.length > 0) {
          messageEntities = guideEnts;
        }
      }
    }

    const offersSuffix =
      prods.length > 0
        ? t(lang, 'store_offers_header', { category: catTitle || '' })
        : t(lang, 'category_empty');

    // Always APPEND suffix after guideText so any saved Telegram entity offsets remain 100% valid!
    const finalText = messageText ? `${messageText}\n\n${offersSuffix}` : offersSuffix;

    const buttons: BotInlineButton[][] = prods.map((p) => [
      {
        text: formatCustomerProductButtonLabel({
          title: p.title,
          retailPrice: p.retailPrice,
          promoPrice: p.promoPrice,
          availableQty: p.availableQty,
          iconEmoji: p.iconEmoji,
          currency: preferredCurrency,
          exchangeRate: displayRate,
          roundingMode,
        }),
        callbackData: `c:prod:${p.id}:cat_${cat.id}`,
        iconCustomEmojiId: p.iconCustomEmojiId || undefined,
        style: 'primary',
      },
    ]);
    buttons.push(buildCustomerNavFooter(lang, 'c:store'));

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: finalText,
      entities: messageEntities,
      inlineKeyboard: buttons,
    };
  }

  // --- Featured Offers shortcut ---
  if (input === 'c:offers' || input === 'cust:offers') {
    const prods = (await getPublishedCustomerProducts(lang, user.id)).filter(
      (p) => p.isFeaturedOffer || Boolean(p.promoPrice)
    );
    if (prods.length === 0) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text: t(lang, 'offers_empty'),
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:store')],
      };
    }
    const buttons: BotInlineButton[][] = prods.map((p) => [
      {
        text: formatCustomerProductButtonLabel({
          title: p.title,
          retailPrice: p.retailPrice,
          promoPrice: p.promoPrice,
          availableQty: p.availableQty,
          iconEmoji: p.iconEmoji,
          currency: preferredCurrency,
          exchangeRate: displayRate,
          roundingMode,
        }),
        callbackData: `c:prod:${p.id}:offers`,
        style: 'primary',
      },
    ]);
    buttons.push(buildCustomerNavFooter(lang, 'c:store'));

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: t(lang, 'offers_title', { storeName: storeDisplayName }),
      inlineKeyboard: buttons,
    };
  }

  const resolveProductBackCallback = (backSource?: string): string => {
    const src = backSource || 'store';
    if (src.startsWith('cat_')) return `c:cat:${src.replace('cat_', '')}`;
    if (src === 'offers') return 'c:offers';
    return 'c:store';
  };

  // --- Single Product / Offer Detail (1-6 + Custom Quantity + Back to Products + Back to Menu) ---
  if (input.startsWith('c:prod:') || input.startsWith('cust:prod:')) {
    const parts = input.split(':');
    const prodId = Number(parts[2]);
    const backSource = parts[3] || 'store';
    const backCb = resolveProductBackCallback(backSource);

    if (fsm.step === 'awaiting_custom_quantity') {
      await saveUserBotState(user.id, { ...fsm, step: 'idle', pendingProductId: undefined, pendingBackSource: undefined });
    }

    const prods = await getPublishedCustomerProducts(lang, user.id);
    const p = prods.find((item) => item.id === prodId);
    if (!p) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text: t(lang, 'product_not_found'),
        inlineKeyboard: [
          [{ text: t(lang, 'btn_back_to_products'), callbackData: backCb, style: 'primary' }],
          [{ text: t(lang, 'btn_back_to_menu'), callbackData: 'c:home', style: 'primary' }],
        ],
      };
    }

    const finalPrice = p.promoPrice || p.retailPrice;
    const promptPayload = formatProductPurchasePromptTelegramPayload({
      categoryName: p.categoryName,
      title: p.title,
      iconEmoji: p.iconEmoji,
      unitPrice: finalPrice,
      stock: p.availableQty,
      description: p.description,
      durationLabel: p.durationLabel || t(lang, 'duration_default'),
      warrantyLabel: p.warrantyLabel,
      lang,
      currency: preferredCurrency,
      exchangeRate: displayRate,
      roundingMode,
    });

    const inlineKeyboard = buildProductQuantityInlineKeyboard({
      productId: p.id,
      backCallbackData: backCb,
      backSource,
      lang,
    });

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: promptPayload.text,
      parseMode: promptPayload.parseMode,
      htmlNoCustomEmojiFallback: promptPayload.htmlNoCustomEmojiFallback,
      plainFallbackText: promptPayload.plainFallbackText,
      inlineKeyboard,
    };
  }

  // --- Quantity Chosen (1..6) -> Show Transaction Confirmation Message BELOW Quantity Options ---
  if (input.startsWith('c:qty:')) {
    const parts = input.split(':');
    const prodId = Number(parts[2]);
    const qty = Math.max(1, Math.floor(Number(parts[3]) || 1));
    const backSource = parts[4] || 'store';
    const backCb = resolveProductBackCallback(backSource);

    if (fsm.step === 'awaiting_custom_quantity') {
      await saveUserBotState(user.id, { ...fsm, step: 'idle', pendingProductId: undefined, pendingBackSource: undefined });
    }

    const prods = await getPublishedCustomerProducts(lang, user.id);
    const p = prods.find((item) => item.id === prodId);
    if (!p) {
      return {
        mode: 'customer',
        lang,
        editInPlace: false,
        text: t(lang, 'product_not_found'),
        inlineKeyboard: [
          [{ text: t(lang, 'btn_back_to_products'), callbackData: backCb, style: 'primary' }],
          [{ text: t(lang, 'btn_back_to_menu'), callbackData: 'c:home', style: 'primary' }],
        ],
      };
    }

    if (qty > p.availableQty) {
      return {
        mode: 'customer',
        lang,
        editInPlace: false,
        text: t(lang, 'custom_qty_exceeds_stock', { requested: qty, available: p.availableQty }),
        inlineKeyboard: [
          [{ text: t(lang, 'btn_back_to_products'), callbackData: backCb, style: 'primary' }],
        ],
      };
    }

    const finalPrice = p.promoPrice || p.retailPrice;
    const confirmation = formatPurchaseConfirmationMessage({
      orderRef: generatePreviewOrderCode(),
      productTitle: p.title,
      iconEmoji: p.iconEmoji,
      quantity: qty,
      unitPrice: finalPrice,
      currentBalance: wallet.availableBalance,
      lang,
      currency: preferredCurrency,
      exchangeRate: displayRate,
      roundingMode,
    });

    return {
      mode: 'customer',
      lang,
      // Send directly BELOW the product & quantity options message!
      editInPlace: false,
      text: confirmation.text,
      inlineKeyboard: buildPurchaseConfirmationInlineKeyboard({
        productId: p.id,
        quantity: qty,
        backSource,
        lang,
      }),
    };
  }

  // --- Custom Quantity Button Pressed -> Ask Buyer to Enter Manual Quantity ---
  if (input.startsWith('c:cqty:')) {
    const parts = input.split(':');
    const prodId = Number(parts[2]);
    const backSource = parts[3] || 'store';
    const backCb = resolveProductBackCallback(backSource);

    const prods = await getPublishedCustomerProducts(lang, user.id);
    const p = prods.find((item) => item.id === prodId);
    if (!p) {
      return {
        mode: 'customer',
        lang,
        editInPlace: false,
        text: t(lang, 'product_not_found'),
        inlineKeyboard: [
          [{ text: t(lang, 'btn_back_to_products'), callbackData: backCb, style: 'primary' }],
          [{ text: t(lang, 'btn_back_to_menu'), callbackData: 'c:home', style: 'primary' }],
        ],
      };
    }

    await saveUserBotState(user.id, {
      ...fsm,
      step: 'awaiting_custom_quantity',
      pendingProductId: p.id,
      pendingBackSource: backSource,
      lastScreen: `c:prod:${p.id}:${backSource}`,
    });

    return {
      mode: 'customer',
      lang,
      editInPlace: false,
      text: t(lang, 'custom_qty_prompt', { title: p.title, maxStock: p.availableQty }),
      inlineKeyboard: [
        [{ text: t(lang, 'btn_cancel_input'), callbackData: `c:cancel_buy:${p.id}:${backSource}`, style: 'danger' }],
      ],
    };
  }

  // --- Cancel Purchase Confirmation or Custom Quantity Input ---
  if (input.startsWith('c:cancel_buy:')) {
    const parts = input.split(':');
    const backSource = parts[3] || 'store';
    const backCb = resolveProductBackCallback(backSource);

    if (fsm.step === 'awaiting_custom_quantity') {
      await saveUserBotState(user.id, { ...fsm, step: 'idle', pendingProductId: undefined, pendingBackSource: undefined });
    }

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: t(lang, 'purchase_cancelled'),
      inlineKeyboard: [
        [{ text: t(lang, 'btn_back_to_products'), callbackData: backCb, style: 'primary' }],
        [{ text: t(lang, 'btn_back_to_menu'), callbackData: 'c:home', style: 'primary' }],
      ],
    };
  }

  // --- Confirm Purchase (Executes Atomic Order & Wallet Deduction) ---
  if (input.startsWith('c:buy:') || input.startsWith('cust:buy:')) {
    const parts = input.split(':');
    const prodId = Number(parts[2]);
    const qty = Math.max(1, Math.floor(Number(parts[3]) || 1));
    const backSource = parts[4] || 'store';
    const backCb = resolveProductBackCallback(backSource);

    if (fsm.step === 'awaiting_custom_quantity') {
      await saveUserBotState(user.id, { ...fsm, step: 'idle', pendingProductId: undefined, pendingBackSource: undefined });
    }

    const result = await placeCustomerOrder({
      userId: user.id,
      storeProductId: prodId,
      quantity: qty,
      idempotencyKey: `tg-${user.id}-${prodId}-${qty}-${Date.now()}`,
      customerLabel: user.displayName,
    });

    const postButtons: BotInlineButton[][] = result.ok
      ? [
          [{ text: t(lang, 'btn_orders'), callbackData: 'c:orders', style: 'primary' }],
          [{ text: t(lang, 'btn_back_to_products'), callbackData: backCb, style: 'primary' }],
          [{ text: t(lang, 'btn_back_to_menu'), callbackData: 'c:home', style: 'primary' }],
        ]
      : [
          [{ text: t(lang, 'btn_topup'), callbackData: 'c:topup', style: 'success' }],
          [{ text: t(lang, 'btn_back_to_products'), callbackData: backCb, style: 'primary' }],
          [{ text: t(lang, 'btn_back_to_menu'), callbackData: 'c:home', style: 'primary' }],
        ];

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: result.ok
        ? result.deliveryMessageAr || t(lang, 'order_success_fallback', { orderNumber: result.orderNumber || '' })
        : `⚠️ ${result.customerErrorAr}`,
      inlineKeyboard: postButtons,
    };
  }

  // --- 💰 MY WALLET ---
  if (input === 'c:wallet' || input === 'cust:wallet') {
    const ledgerRows = await db
      .select()
      .from(walletLedger)
      .where(eq(walletLedger.userId, user.id))
      .orderBy(desc(walletLedger.createdAt))
      .limit(5);

    const isYer = preferredCurrency === 'YER' && Boolean(displayRate);
    const fmtBal = (amt: string) =>
      isYer
        ? formatDisplayPrice({
            usdAmount: amt,
            currency: 'YER',
            exchangeRate: displayRate,
            roundingMode,
          })
        : `${formatMoney(amt, 2)} USDT`;

    const ledgerText =
      ledgerRows.length > 0
        ? ledgerRows
            .map((l) => {
              const amountDisp = isYer
                ? formatDisplayPrice({
                    usdAmount: l.amount,
                    currency: 'YER',
                    exchangeRate: displayRate,
                    roundingMode,
                    signed: true,
                  })
                : `${new Decimal(l.amount).gte(0) ? '+' : ''}${formatMoney(l.amount, 2)} USDT`;
              return `• ${l.note} (${amountDisp}) — ${l.referenceCode}`;
            })
            .join('\n')
        : t(lang, 'wallet_no_ledger');

    const walletText = isYer
      ? lang === 'en'
        ? `💰 Your Wallet — ${storeDisplayName}\n\n• Available Balance: ${fmtBal(wallet.availableBalance)}\n• Reserved for Active Orders: ${fmtBal(wallet.reservedBalance)}\n\nRecent Transactions:\n${ledgerText}`
        : `💰 محفظتك — ${storeDisplayName}\n\n• الرصيد المتاح: ${fmtBal(wallet.availableBalance)}\n• الرصيد المحجوز للطلبات الجارية: ${fmtBal(wallet.reservedBalance)}\n\nآخر الحركات المالية:\n${ledgerText}`
      : t(lang, 'wallet_summary', {
          storeName: storeDisplayName,
          available: formatMoney(wallet.availableBalance, 2),
          reserved: formatMoney(wallet.reservedBalance, 2),
          ledger: ledgerText,
        });

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: walletText,
      inlineKeyboard: [
        [
          { text: t(lang, 'btn_topup'), callbackData: 'c:topup', style: 'success' },
          { text: t(lang, 'btn_deposit_history'), callbackData: 'c:dep_history', style: 'primary' },
        ],
        buildCustomerNavFooter(lang, 'c:home'),
      ],
    };
  }

  // --- 📜 DEPOSIT HISTORY (Includes Regular USDT/Binance + Local Yemeni Wallet Deposits) ---
  if (input === 'c:dep_history') {
    const [myDeposits, myLocalDeposits] = await Promise.all([
      db
        .select()
        .from(deposits)
        .where(eq(deposits.userId, user.id))
        .orderBy(desc(deposits.createdAt))
        .limit(8),
      db
        .select()
        .from(localDeposits)
        .where(eq(localDeposits.userId, user.id))
        .orderBy(desc(localDeposits.createdAt))
        .limit(8),
    ]);

    if (myDeposits.length === 0 && myLocalDeposits.length === 0) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text: `${t(lang, 'wallet_deposits_title')}\n\n${t(lang, 'wallet_deposits_empty')}`,
        inlineKeyboard: [
          [{ text: t(lang, 'btn_topup'), callbackData: 'c:topup', style: 'success' }],
          buildCustomerNavFooter(lang, 'c:wallet'),
        ],
      };
    }

    const combined: Array<{ createdAt: number; text: string }> = [
      ...myDeposits.map((d) => {
        const icon =
          d.status === 'paid' || d.status === 'confirmed'
            ? '✅'
            : d.status === 'rejected'
            ? '❌'
            : '⏳';
        const dt = new Date(d.createdAt).toISOString().slice(0, 16).replace('T', ' ');
        return {
          createdAt: new Date(d.createdAt).getTime(),
          text: `${icon} ${d.depositRef} — ${formatMoney(d.receivedAmount || d.expectedAmount, 2)} ${d.currency}\n📅 ${dt} | ${d.network}`,
        };
      }),
      ...myLocalDeposits.map((ld) => ({
        createdAt: new Date(ld.createdAt).getTime(),
        text: formatLocalDepositHistoryLine(ld, lang),
      })),
    ]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10);

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: `${t(lang, 'wallet_deposits_title')}\n\n${combined.map((c) => c.text).join('\n\n')}`,
      inlineKeyboard: [
        [{ text: t(lang, 'btn_topup'), callbackData: 'c:topup', style: 'success' }],
        buildCustomerNavFooter(lang, 'c:wallet'),
      ],
    };
  }

  // --- Top Up: Select Extensible Payment Method + Local Yemeni Wallets ---
  if (input === 'c:topup' || input === 'cust:deposit') {
    const enabledMethods = await db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.isEnabled, true))
      .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.id));

    const methodButtons: BotInlineButton[][] = [];

    if (currencyCfg.localDepositsEnabled) {
      methodButtons.push([
        {
          text: lang === 'en' ? '🇾🇪 Local Yemeni Wallets (YER ﷼)' : '🇾🇪 المحافظ المحلية',
          callbackData: 'c:local_dep:wallets',
          style: 'success',
        },
      ]);
    }

    for (const m of enabledMethods) {
      methodButtons.push([
        {
          text: lang === 'en' ? m.nameEn || m.nameAr : m.nameAr,
          callbackData: `c:pm:${m.code}`,
          style: 'primary',
        },
      ]);
    }

    if (methodButtons.length === 0) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text: t(lang, 'topup_no_methods'),
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:wallet')],
      };
    }

    methodButtons.push(buildCustomerNavFooter(lang, 'c:wallet'));

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: t(lang, 'topup_title', { storeName: storeDisplayName }),
      inlineKeyboard: methodButtons,
    };
  }

  // --- Top Up: Choose USDT Amount ---
  if (input.startsWith('c:pm:')) {
    const methodCode = input.slice('c:pm:'.length);
    const [methodRow] = await db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.code, methodCode))
      .limit(1);

    if (!methodRow || !methodRow.isEnabled) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text: t(lang, 'topup_no_methods'),
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:topup')],
      };
    }

    const methodName = lang === 'en' ? methodRow.nameEn || methodRow.nameAr : methodRow.nameAr;
    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: t(lang, 'topup_choose_amount', { methodName }),
      inlineKeyboard: [
        [
          { text: '5 USDT', callbackData: `c:dep:${methodCode}:5`, style: 'primary' },
          { text: '10 USDT', callbackData: `c:dep:${methodCode}:10`, style: 'primary' },
        ],
        [
          { text: '25 USDT', callbackData: `c:dep:${methodCode}:25`, style: 'primary' },
          { text: '50 USDT', callbackData: `c:dep:${methodCode}:50`, style: 'primary' },
        ],
        [{ text: t(lang, 'btn_custom_amount'), callbackData: `c:depcustom:${methodCode}`, style: 'success' }],
        buildCustomerNavFooter(lang, 'c:topup'),
      ],
    };
  }

  if (input.startsWith('c:depcustom:')) {
    const methodCode = input.slice('c:depcustom:'.length);
    await saveUserBotState(user.id, {
      ...fsm,
      step: 'awaiting_deposit_amount',
      methodCode,
      lastScreen: `c:pm:${methodCode}`,
    });
    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: t(lang, 'topup_enter_amount_prompt'),
      inlineKeyboard: [buildCustomerNavFooter(lang, `c:pm:${methodCode}`)],
    };
  }

  if (input.startsWith('c:dep:')) {
    const [, , methodCode, amountStr] = input.split(':');
    return createDepositAndRenderInstructions({
      userId: user.id,
      methodCode,
      amountStr: amountStr || '10',
      lang,
      store,
      editInPlace: isCallback,
    });
  }

  // --- Binance ID: Customer taps "تحققت من التحويل" ---
  if (input.startsWith('c:bn_confirm:')) {
    const depId = Number(input.split(':')[2]);
    const [dep] = await db.select().from(deposits).where(eq(deposits.id, depId)).limit(1);
    if (!dep || dep.userId !== user.id) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text: t(lang, 'error_generic'),
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:topup')],
      };
    }

    await saveUserBotState(user.id, {
      ...fsm,
      step: 'awaiting_binance_txid',
      methodCode: 'binance_id',
      pendingDepositId: dep.id,
      lastScreen: 'c:topup',
    });

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: t(lang, 'binance_enter_txid_prompt', {
        depositRef: dep.depositRef,
        amount: formatMoney(dep.expectedAmount, 2),
      }),
      inlineKeyboard: [buildCustomerNavFooter(lang, 'c:topup')],
    };
  }

  // --- Binance ID: Re-check pending deposit ---
  if (input.startsWith('c:bn_recheck:')) {
    const depId = Number(input.split(':')[2]);
    const [dep] = await db.select().from(deposits).where(eq(deposits.id, depId)).limit(1);
    if (!dep || dep.userId !== user.id || !dep.binanceTransactionId) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text: t(lang, 'error_generic'),
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:topup')],
      };
    }

    const res = await attemptBinanceDepositAutoVerification({
      depositId: dep.id,
      submittedTransactionId: dep.binanceTransactionId,
      lang,
    });

    if (res.status === 'paid') {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text: t(lang, 'binance_status_paid', {
          depositRef: dep.depositRef,
          txId: dep.binanceTransactionId,
          amount: res.creditedAmount || formatMoney(dep.expectedAmount, 2),
          newBalance: res.newBalance || formatMoney(wallet.availableBalance, 2),
        }),
        inlineKeyboard: [
          [{ text: t(lang, 'btn_wallet'), callbackData: 'c:wallet', style: 'success' }],
          buildCustomerNavFooter(lang, 'c:home'),
        ],
      };
    }

    if (res.status === 'rejected') {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text: t(lang, 'binance_status_rejected', {
          depositRef: dep.depositRef,
          reason: res.reasonText,
        }),
        inlineKeyboard: [
          [{ text: t(lang, 'btn_support'), url: buildSupportTelegramUrl(store.supportHandle), style: 'primary' }],
          buildCustomerNavFooter(lang, 'c:topup'),
        ],
      };
    }

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: t(lang, 'binance_status_pending', {
        depositRef: dep.depositRef,
        txId: dep.binanceTransactionId,
        reason: res.reasonText,
      }),
      inlineKeyboard: [
        [{ text: t(lang, 'btn_recheck_deposit'), callbackData: `c:bn_recheck:${dep.id}`, style: 'primary' }],
        buildCustomerNavFooter(lang, 'c:home'),
      ],
    };
  }

  // --- 📦 MY ORDERS (Exact Clean Format + Clickable Order Details) ---
  if (input === 'c:orders' || input === 'cust:orders') {
    const myOrders = await getCustomerOrdersWithSanitizedDeliveries(user.id);
    if (myOrders.length === 0) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text: t(lang, 'orders_empty'),
        inlineKeyboard: [
          [{ text: t(lang, 'btn_store'), callbackData: 'c:store', style: 'success' }],
          buildCustomerNavFooter(lang, 'c:home'),
        ],
      };
    }

    const slice = myOrders.slice(0, 8);
    const textBlocks = slice.map((o) => {
      const firstItem = o.items[0];
      const title = firstItem?.titleAr || (lang === 'en' ? 'Digital Subscription' : 'منتج رقمي');
      const qty = firstItem?.quantity || 1;
      return formatCustomerOrderCard({
        orderNumber: o.orderNumber,
        status: o.status,
        title,
        quantity: qty,
        totalRetail: o.totalRetail,
        createdAt: o.createdAt,
        lang,
        currency: preferredCurrency,
        exchangeRate: displayRate,
        roundingMode,
      });
    });

    const orderButtons: BotInlineButton[][] = slice.map((o) => {
      const title = o.items[0]?.titleAr || 'Order';
      const shortTitle = title.length > 24 ? `${title.slice(0, 24)}…` : title;
      return [
        {
          text: `📦 ${o.orderNumber} — ${shortTitle}`,
          callbackData: `c:ord:${o.orderNumber}`,
          style: 'primary',
        },
      ];
    });
    orderButtons.push(buildCustomerNavFooter(lang, 'c:home'));

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: `${t(lang, 'orders_title')}\n\n${textBlocks.join('\n\n')}`,
      inlineKeyboard: orderButtons,
    };
  }

  // --- Single Order Detail (Delivery Payload + Instructions) ---
  if (input.startsWith('c:ord:')) {
    const orderNum = input.slice('c:ord:'.length);
    const myOrders = await getCustomerOrdersWithSanitizedDeliveries(user.id);
    const found = myOrders.find((o) => o.orderNumber === orderNum);
    if (!found) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text: t(lang, 'order_detail_not_found'),
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:orders')],
      };
    }

    const firstItem = found.items[0];
    const headerCard = formatCustomerOrderCard({
      orderNumber: found.orderNumber,
      status: found.status,
      title: firstItem?.titleAr || (lang === 'en' ? 'Digital Subscription' : 'منتج رقمي'),
      quantity: firstItem?.quantity || 1,
      totalRetail: found.totalRetail,
      createdAt: found.createdAt,
      lang,
      currency: preferredCurrency,
      exchangeRate: displayRate,
      roundingMode,
    });

    const deliveryLines =
      found.delivery?.payloadItems && found.delivery.payloadItems.length > 0
        ? `\n\n${t(lang, 'order_delivery_label')}\n${found.delivery.payloadItems.map((it, i) => `${i + 1}. ${it}`).join('\n')}`
        : '';
    const instrLines = found.delivery?.instructionsAr
      ? `\n\n📘 ${found.delivery.instructionsAr}`
      : '';

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: `${headerCard}${deliveryLines}${instrLines}`,
      inlineKeyboard: [buildCustomerNavFooter(lang, 'c:orders')],
    };
  }

  // --- 🎁 REFER & EARN (Percentage-of-Purchases Referral & Commission System) ---
  if (input === 'c:refer') {
    const summary = await getUserReferralSummary(user.id, getLiveBotUsername());
    const text = formatReferAndEarnMessage({
      lang,
      referralLink: summary.referralLink,
      successfulReferrals: summary.successfulReferrals,
      totalPurchases: summary.totalPurchases,
      totalEarned: summary.totalEarned,
      commissionRatePercent: summary.commissionRatePercent,
      currency: summary.currency,
      isEnabled: summary.isEnabled,
      pendingRecoveryBalance: summary.pendingRecoveryBalance,
      displayCurrency: preferredCurrency,
      exchangeRate: displayRate,
      roundingMode,
    });

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text,
      inlineKeyboard: [
        [
          {
            text: lang === 'en' ? '📋 Copy Link' : '📋 نسخ رابط الإحالة',
            copyText: summary.referralLink,
            style: 'success',
          },
        ],
        [
          {
            text: lang === 'en' ? '📜 Commission History' : '📜 سجل العمولات',
            callbackData: 'c:refer_history:0',
            style: 'primary',
          },
        ],
        buildCustomerNavFooter(lang, 'c:home'),
      ],
    };
  }

  if (input.startsWith('c:refer_history:')) {
    const page = Math.max(0, Number(input.split(':')[2] || '0') || 0);
    const history = await getUserReferralHistoryPage(user.id, page, 5);
    const lines = history.items.map((item) => {
      const dt = new Date(item.createdAt).toISOString().slice(0, 16).replace('T', ' ');
      const isRev = item.entryType === 'reversal';
      const icon = isRev ? '↩️' : '💰';
      const sign = isRev ? '-' : '+';
      const amount = formatMoney2(item.grossCommissionAmount);
      const purchase = formatMoney2(item.purchaseAmount);
      const rate = formatRatePercentDisplay(item.commissionRatePercent);
      if (lang === 'en') {
        return `${icon} ${item.orderNumber} | ${sign}${amount} ${item.currency} (${rate}% of ${purchase})\n   📅 ${dt}${isRev && item.reversalReason ? ` • ${item.reversalReason}` : ''}`;
      }
      return `${icon} ${item.orderNumber} | ${sign}${amount} ${item.currency} (${rate}% من ${purchase})\n   📅 ${dt}${isRev && item.reversalReason ? ` • ${item.reversalReason}` : ''}`;
    });

    const header =
      lang === 'en'
        ? `📜 Referral Commission History (${history.total} total • Page ${history.page + 1}/${history.totalPages})`
        : `📜 سجل عمولات الإحالة (الإجمالي: ${history.total} • صفحة ${history.page + 1}/${history.totalPages})`;
    const emptyText =
      lang === 'en'
        ? 'No referral commissions recorded yet. Share your link to start earning on every referred purchase!'
        : 'لا توجد عمولات إحالة مسجلة بعد. شارك رابط الإحالة الخاص بك لبدء الربح من كل عملية شراء ناجحة!';

    const navButtons: BotInlineButton[] = [];
    if (history.page > 0) {
      navButtons.push({
        text: lang === 'en' ? '⬅️ Prev' : '⬅️ السابق',
        callbackData: `c:refer_history:${history.page - 1}`,
      });
    }
    if (history.page + 1 < history.totalPages) {
      navButtons.push({
        text: lang === 'en' ? 'Next ➡️' : 'التالي ➡️',
        callbackData: `c:refer_history:${history.page + 1}`,
      });
    }

    const kb: BotInlineButton[][] = [];
    if (navButtons.length > 0) kb.push(navButtons);
    kb.push(buildCustomerNavFooter(lang, 'c:refer'));

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: `${header}\n\n${lines.length > 0 ? lines.join('\n\n') : emptyText}`,
      inlineKeyboard: kb,
    };
  }

  // --- 🪪 PROFILE (Real User Stats from PostgreSQL) ---
  if (input === 'c:profile') {
    const [orderAgg] = await db
      .select({
        completedCount: sql<number>`count(*) filter (where ${orders.status} = 'completed')`,
        totalSpent: sql<string>`coalesce(sum(${orders.totalRetail}) filter (where ${orders.status} = 'completed'), 0)`,
      })
      .from(orders)
      .where(eq(orders.userId, user.id));

    const profileText = formatCustomerProfileCard({
      displayName: user.displayName,
      telegramUserId: user.telegramUserId || String(user.id),
      balance: wallet.availableBalance,
      ordersCount: Number(orderAgg?.completedCount || 0),
      totalSpent: orderAgg?.totalSpent || '0',
      lang,
      currency: preferredCurrency,
      exchangeRate: displayRate,
      roundingMode,
    });

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: profileText,
      inlineKeyboard: [
        [
          { text: t(lang, 'btn_wallet'), callbackData: 'c:wallet', style: 'success' },
          { text: t(lang, 'btn_orders'), callbackData: 'c:orders', style: 'primary' },
        ],
        buildCustomerNavFooter(lang, 'c:home'),
      ],
    };
  }

  // --- 📖 HOW TO USE & GUIDES (Admin-Managed, Preserving Full Telegram Formatting & Custom Emojis!) ---
  if (input === 'c:guides') {
    const visibleGuides = await db
      .select()
      .from(serviceGuides)
      .where(eq(serviceGuides.isVisible, true))
      .orderBy(asc(serviceGuides.sortOrder), asc(serviceGuides.id));

    const [guidesParentBtn] = await db
      .select()
      .from(botMenuButtons)
      .where(and(eq(botMenuButtons.actionType, 'builtin'), eq(botMenuButtons.actionValue, 'how_to_use')))
      .limit(1);
    const extraGuideSubRows = guidesParentBtn
      ? await getDynamicSubButtonKeyboard(guidesParentBtn.id, lang, store.supportHandle)
      : [];

    if (visibleGuides.length === 0 && extraGuideSubRows.length === 0) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text: `${t(lang, 'guides_header')}\n\n${t(lang, 'guides_empty')}`,
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:home')],
      };
    }

    const guideBtns: BotInlineButton[] = visibleGuides.map((g) => {
      const title = lang === 'en' ? g.titleEn || g.titleAr : g.titleAr || g.titleEn;
      const prefix = g.iconEmoji ? `${g.iconEmoji} ` : '';
      return {
        text: `${prefix}${title}`,
        callbackData: `c:guide:${g.id}`,
        iconCustomEmojiId: g.iconCustomEmojiId || undefined,
        style: 'primary',
      };
    });

    const keyboard = [...chunkButtons(guideBtns, 2), ...extraGuideSubRows];
    keyboard.push(buildCustomerNavFooter(lang, 'c:home'));

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: t(lang, 'guides_header'),
      inlineKeyboard: keyboard,
    };
  }

  if (input.startsWith('c:guide:') || input.startsWith('c:guideslug:')) {
    const isSlug = input.startsWith('c:guideslug:');
    const keyVal = input.split(':')[2] || '';
    const [guide] = isSlug
      ? await db.select().from(serviceGuides).where(eq(serviceGuides.slug, keyVal)).limit(1)
      : await db.select().from(serviceGuides).where(eq(serviceGuides.id, Number(keyVal))).limit(1);

    if (!guide || !guide.isVisible) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text: t(lang, 'guides_empty'),
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:guides')],
      };
    }

    const content = lang === 'en' ? guide.contentEn || guide.contentAr : guide.contentAr || guide.contentEn;
    const savedEntities = lang === 'en' ? guide.contentEntitiesEn : guide.contentEntitiesAr;
    const keyboard: BotInlineButton[][] = [];
    if (guide.categoryId) {
      keyboard.push([
        {
          text: t(lang, 'btn_view_service_offers'),
          callbackData: `c:cat:${guide.categoryId}`,
          style: 'success',
        },
      ]);
    }
    keyboard.push(buildCustomerNavFooter(lang, 'c:guides'));

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: content || (lang === 'en' ? guide.titleEn : guide.titleAr),
      entities: Array.isArray(savedEntities) && savedEntities.length > 0 ? savedEntities : undefined,
      inlineKeyboard: keyboard,
    };
  }

  // --- Custom Admin-Added Main Menu or Sub-Menu Button (`c:btn:<id>`) ---
  if (input.startsWith('c:btn:')) {
    const btnId = Number(input.split(':')[2]);
    const [btn] = await db.select().from(botMenuButtons).where(eq(botMenuButtons.id, btnId)).limit(1);
    if (!btn || !btn.isVisible) {
      return renderCustomerHome(lang);
    }
    if (!btn.isEnabled) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text: t(lang, 'btn_disabled_notice'),
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:home')],
      };
    }

    const childRows = await getDynamicSubButtonKeyboard(btn.id, lang, store.supportHandle);
    let backTarget = 'c:home';
    if (btn.parentId) {
      const [parentRow] = await db.select().from(botMenuButtons).where(eq(botMenuButtons.id, btn.parentId)).limit(1);
      if (parentRow?.actionType === 'builtin' && parentRow.actionValue === 'store') {
        backTarget = 'c:store';
      } else if (parentRow?.actionType === 'builtin' && parentRow.actionValue === 'how_to_use') {
        backTarget = 'c:guides';
      } else if (parentRow) {
        backTarget = `c:btn:${parentRow.id}`;
      }
    }

    const content = lang === 'en' ? btn.contentEn || btn.contentAr : btn.contentAr || btn.contentEn;
    const savedEntities = lang === 'en' ? btn.contentEntitiesEn : btn.contentEntitiesAr;
    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: content || (lang === 'en' ? btn.labelEn : btn.labelAr),
      entities: Array.isArray(savedEntities) && savedEntities.length > 0 ? savedEntities : undefined,
      inlineKeyboard: [...childRows, buildCustomerNavFooter(lang, backTarget)],
    };
  }

  if (input.startsWith('c:disabled:')) {
    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: t(lang, 'btn_disabled_notice'),
      inlineKeyboard: [buildCustomerNavFooter(lang, 'c:home')],
    };
  }

  // --- Search (FSM Input) ---
  if (input === 'c:search') {
    await saveUserBotState(user.id, { ...fsm, step: 'awaiting_search', lastScreen: 'c:home' });
    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: t(lang, 'search_prompt'),
      inlineKeyboard: [buildCustomerNavFooter(lang, 'c:home')],
    };
  }

  // --- Support fallback callback (Support main button is a direct URL, this handles legacy/internal references) ---
  if (input === 'c:support') {
    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: t(lang, 'support_info', {
        storeName: storeDisplayName,
        supportHandle: store.supportHandle,
      }),
      inlineKeyboard: [
        [{ text: t(lang, 'btn_support'), url: buildSupportTelegramUrl(store.supportHandle), style: 'primary' }],
        [{ text: t(lang, 'btn_send_support'), callbackData: 'c:support_msg' }],
        buildCustomerNavFooter(lang, 'c:home'),
      ],
    };
  }

  if (input === 'c:support_msg') {
    await saveUserBotState(user.id, { ...fsm, step: 'awaiting_support', lastScreen: 'c:support' });
    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: t(lang, 'support_enter_prompt'),
      inlineKeyboard: [buildCustomerNavFooter(lang, 'c:support')],
    };
  }

  // --- Terms & Conditions ---
  if (input === 'c:terms') {
    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text: t(lang, 'terms_title', {
        storeName: storeDisplayName,
        terms: lang === 'en' ? store.termsEn : store.termsAr,
      }),
      inlineKeyboard: [buildCustomerNavFooter(lang, 'c:home')],
    };
  }

  // ==========================================================================
  // 3. TEXT INPUT FSM HANDLERS (Custom Amount, Binance TxID, USDT TxID, Search, Support)
  // ==========================================================================
  if (!isCallback && params.text) {
    const rawText = params.text.trim();

    // 3a. Custom Deposit Amount Input
    if (fsm.step === 'awaiting_deposit_amount' && fsm.methodCode) {
      let amountDec: Decimal | null = null;
      try {
        const cleaned = rawText.replace(/[$,\s]/g, '');
        const parsed = new Decimal(cleaned);
        if (parsed.isFinite() && parsed.gte(1) && parsed.lte(50000)) {
          amountDec = parsed;
        }
      } catch {
        amountDec = null;
      }

      if (!amountDec) {
        return {
          mode: 'customer',
          lang,
          editInPlace: false,
          text: t(lang, 'topup_invalid_amount'),
          inlineKeyboard: [buildCustomerNavFooter(lang, `c:pm:${fsm.methodCode}`)],
        };
      }

      return createDepositAndRenderInstructions({
        userId: user.id,
        methodCode: fsm.methodCode,
        amountStr: amountDec.toFixed(2),
        lang,
        store,
        editInPlace: false,
      });
    }

    // 3b. Binance Pay Transaction ID Input -> Save PENDING + Auto-Verify
    if (fsm.step === 'awaiting_binance_txid' && fsm.pendingDepositId) {
      const txId = rawText.replace(/\s+/g, '');
      if (txId.length < 6 || txId.length > 128) {
        return {
          mode: 'customer',
          lang,
          editInPlace: false,
          text: t(lang, 'binance_txid_invalid_format'),
          inlineKeyboard: [buildCustomerNavFooter(lang, 'c:topup')],
        };
      }

      const [dep] = await db
        .select()
        .from(deposits)
        .where(eq(deposits.id, fsm.pendingDepositId))
        .limit(1);

      await saveUserBotState(user.id, { ...fsm, step: 'idle' });

      if (!dep || dep.userId !== user.id) {
        return {
          mode: 'customer',
          lang,
          editInPlace: false,
          text: t(lang, 'error_generic'),
          inlineKeyboard: [buildCustomerNavFooter(lang, 'c:topup')],
        };
      }

      const res = await attemptBinanceDepositAutoVerification({
        depositId: dep.id,
        submittedTransactionId: txId,
        lang,
      });

      if (res.status === 'paid') {
        return {
          mode: 'customer',
          lang,
          editInPlace: false,
          text: t(lang, 'binance_status_paid', {
            depositRef: dep.depositRef,
            txId,
            amount: res.creditedAmount || formatMoney(dep.expectedAmount, 2),
            newBalance: res.newBalance || formatMoney(wallet.availableBalance, 2),
          }),
          inlineKeyboard: [
            [{ text: t(lang, 'btn_wallet'), callbackData: 'c:wallet', style: 'success' }],
            buildCustomerNavFooter(lang, 'c:home'),
          ],
        };
      }

      if (res.status === 'rejected') {
        return {
          mode: 'customer',
          lang,
          editInPlace: false,
          text: t(lang, 'binance_status_rejected', {
            depositRef: dep.depositRef,
            reason: res.reasonText,
          }),
          inlineKeyboard: [
            [{ text: t(lang, 'btn_support'), url: buildSupportTelegramUrl(store.supportHandle), style: 'primary' }],
            buildCustomerNavFooter(lang, 'c:topup'),
          ],
        };
      }

      return {
        mode: 'customer',
        lang,
        editInPlace: false,
        text: t(lang, 'binance_status_pending', {
          depositRef: dep.depositRef,
          txId,
          reason: res.reasonText,
        }),
        inlineKeyboard: [
          [{ text: t(lang, 'btn_recheck_deposit'), callbackData: `c:bn_recheck:${dep.id}`, style: 'primary' }],
          buildCustomerNavFooter(lang, 'c:home'),
        ],
      };
    }

    // 3c. Blockchain USDT TxID Input
    if (fsm.step === 'awaiting_usdt_txid' && fsm.pendingDepositId) {
      const txHash = rawText.replace(/\s+/g, '');
      const [dep] = await db.select().from(deposits).where(eq(deposits.id, fsm.pendingDepositId)).limit(1);
      await saveUserBotState(user.id, { ...fsm, step: 'idle' });

      if (!dep || dep.userId !== user.id) {
        return {
          mode: 'customer',
          lang,
          editInPlace: false,
          text: t(lang, 'error_generic'),
          inlineKeyboard: [buildCustomerNavFooter(lang, 'c:topup')],
        };
      }

      const existingTxRows = await db.select({ txHash: deposits.txHash }).from(deposits);
      const usedSet = new Set(existingTxRows.map((r) => (r.txHash || '').toLowerCase()).filter(Boolean));
      const onChain = dep.network === 'TRC20' ? await fetchTrc20TransactionFromTronGrid(txHash) : null;

      const verdict = verifyUsdtDepositTransaction({
        depositId: dep.id,
        depositRef: dep.depositRef,
        expectedNetwork: dep.network === 'BEP20' ? 'BEP20' : 'TRC20',
        expectedContract: dep.contractAddress || OFFICIAL_USDT_CONTRACTS.TRC20,
        assignedRecipientAddress: dep.assignedRecipientAddress || store.usdtTrc20Wallet,
        expectedAmount: dep.expectedAmount,
        requiredConfirmations: dep.requiredConfirmations,
        uniqueMemoTag: dep.uniqueMemoTag,
        submittedTxHash: txHash,
        alreadyUsedTxHashes: usedSet,
        onChainRecord: onChain,
      });

      if (verdict.status === 'confirmed' && verdict.creditedAmount) {
        await db.update(deposits).set({ txHash }).where(eq(deposits.id, dep.id));
        await creditDepositAtomically({
          depositId: dep.id,
          creditedAmount: verdict.creditedAmount,
          note: `شحن رصيد مؤكد على الشبكة (${dep.depositRef})`,
        });
        return {
          mode: 'customer',
          lang,
          editInPlace: false,
          text: t(lang, 'usdt_status_confirmed', { amount: formatMoney(verdict.creditedAmount, 2) }),
          inlineKeyboard: [
            [{ text: t(lang, 'btn_wallet'), callbackData: 'c:wallet', style: 'success' }],
            buildCustomerNavFooter(lang, 'c:home'),
          ],
        };
      }

      if (verdict.status === 'pending_review') {
        await db
          .update(deposits)
          .set({ txHash, status: 'pending_review', updatedAt: new Date() })
          .where(eq(deposits.id, dep.id));
        return {
          mode: 'customer',
          lang,
          editInPlace: false,
          text: t(lang, 'usdt_status_pending_review', { reason: verdict.reasonAr }),
          inlineKeyboard: [buildCustomerNavFooter(lang, 'c:home')],
        };
      }

      await db
        .update(deposits)
        .set({ status: 'rejected', rejectionReason: verdict.reasonCode, updatedAt: new Date() })
        .where(eq(deposits.id, dep.id));

      return {
        mode: 'customer',
        lang,
        editInPlace: false,
        text: t(lang, 'usdt_status_rejected', { reason: verdict.reasonAr }),
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:topup')],
      };
    }

    // 3d. Custom Payment Reference Input
    if (fsm.step === 'awaiting_custom_ref' && fsm.pendingDepositId) {
      await db
        .update(deposits)
        .set({ txHash: rawText.slice(0, 120), status: 'pending_review', updatedAt: new Date() })
        .where(eq(deposits.id, fsm.pendingDepositId));
      await saveUserBotState(user.id, { ...fsm, step: 'idle' });
      await db.insert(notifications).values({
        audience: 'admin',
        eventType: 'new_deposit',
        severity: 'warning',
        titleAr: 'طلب شحن بوسيلة دفع مخصصة بانتظار المراجعة',
        bodyAr: `أرسل العميل ${user.displayName} المرجع: ${rawText.slice(0, 80)} لطلب الشحن #${fsm.pendingDepositId}.`,
      });
      return {
        mode: 'customer',
        lang,
        editInPlace: false,
        text: t(lang, 'usdt_status_pending_review', { reason: rawText.slice(0, 40) }),
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:home')],
      };
    }

    // 3e. Search Query Input
    if (fsm.step === 'awaiting_search' || rawText.startsWith('بحث ') || rawText.startsWith('/search ')) {
      const q = rawText.replace(/^(بحث|\/search)\s+/i, '').trim().toLowerCase();
      await saveUserBotState(user.id, { ...fsm, step: 'idle' });
      const prods = (await getPublishedCustomerProducts(lang, user.id)).filter(
        (p) =>
          p.titleAr.toLowerCase().includes(q) ||
          p.titleEn.toLowerCase().includes(q) ||
          p.descriptionAr.toLowerCase().includes(q) ||
          p.descriptionEn.toLowerCase().includes(q)
      );
      const buttons: BotInlineButton[][] = prods.map((p) => [
        {
          text: formatCustomerProductButtonLabel({
            title: p.title,
            retailPrice: p.retailPrice,
            promoPrice: p.promoPrice,
            availableQty: p.availableQty,
            iconEmoji: p.iconEmoji,
            currency: preferredCurrency,
            exchangeRate: displayRate,
            roundingMode,
          }),
          callbackData: `c:prod:${p.id}:store`,
        },
      ]);
      buttons.push(buildCustomerNavFooter(lang, 'c:home'));

      return {
        mode: 'customer',
        lang,
        editInPlace: false,
        text:
          prods.length > 0
            ? t(lang, 'search_results', { query: q })
            : t(lang, 'search_empty', { query: q }),
        inlineKeyboard: buttons,
      };
    }

    // 3f. Support Message Input
    if (fsm.step === 'awaiting_support') {
      await saveUserBotState(user.id, { ...fsm, step: 'idle' });
      await db.insert(notifications).values({
        audience: 'admin',
        eventType: 'support_ticket',
        severity: 'info',
        titleAr: `رسالة دعم فني من ${user.displayName}`,
        bodyAr: rawText.slice(0, 400),
      });
      return {
        mode: 'customer',
        lang,
        editInPlace: false,
        text: t(lang, 'support_sent_ok'),
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:home')],
      };
    }

    // 3g. Custom Quantity Manual Input -> Validate & Render Transaction Confirmation Message
    if (fsm.step === 'awaiting_custom_quantity' && fsm.pendingProductId) {
      const backSource = fsm.pendingBackSource || 'store';
      const backCb = resolveProductBackCallback(backSource);
      const prods = await getPublishedCustomerProducts(lang, user.id);
      const p = prods.find((item) => item.id === fsm.pendingProductId);

      if (!p) {
        await saveUserBotState(user.id, { ...fsm, step: 'idle', pendingProductId: undefined, pendingBackSource: undefined });
        return {
          mode: 'customer',
          lang,
          editInPlace: false,
          text: t(lang, 'product_not_found'),
          inlineKeyboard: [
            [{ text: t(lang, 'btn_back_to_products'), callbackData: backCb, style: 'primary' }],
            [{ text: t(lang, 'btn_back_to_menu'), callbackData: 'c:home', style: 'primary' }],
          ],
        };
      }

      const check = parseAndValidateCustomQuantity(rawText, p.availableQty);
      if (!check.ok) {
        const errText =
          check.reason === 'exceeds_stock'
            ? t(lang, 'custom_qty_exceeds_stock', { requested: check.requested || 0, available: p.availableQty })
            : t(lang, 'custom_qty_invalid');
        return {
          mode: 'customer',
          lang,
          editInPlace: false,
          text: errText,
          inlineKeyboard: [
            [{ text: t(lang, 'btn_cancel_input'), callbackData: `c:cancel_buy:${p.id}:${backSource}`, style: 'danger' }],
          ],
        };
      }

      await saveUserBotState(user.id, { ...fsm, step: 'idle', pendingProductId: undefined, pendingBackSource: undefined });

      const finalPrice = p.promoPrice || p.retailPrice;
      const confirmation = formatPurchaseConfirmationMessage({
        orderRef: generatePreviewOrderCode(),
        productTitle: p.title,
        iconEmoji: p.iconEmoji,
        quantity: check.quantity,
        unitPrice: finalPrice,
        currentBalance: wallet.availableBalance,
        lang,
        currency: preferredCurrency,
        exchangeRate: displayRate,
        roundingMode,
      });

      return {
        mode: 'customer',
        lang,
        editInPlace: false,
        text: confirmation.text,
        inlineKeyboard: buildPurchaseConfirmationInlineKeyboard({
          productId: p.id,
          quantity: check.quantity,
          backSource,
          lang,
        }),
      };
    }
  }

  return renderCustomerHome(lang);
}

// ============================================================================
// REAL GRAMMY TELEGRAM BOT LIVE RUNTIME (LONG POLLING + WEBHOOK + DB CONFIG)
// Strictly INLINE KEYBOARD ONLY + Native URL buttons + Entities + Styled Fallback
// ============================================================================
export interface TelegramBotRuntimeStatus {
  configured: boolean;
  tokenSource: 'database' | 'env' | 'none';
  tokenFingerprint: string | null;
  ownerTelegramIds: string;
  state: 'running' | 'starting' | 'stopped' | 'error' | 'not_configured';
  mode: 'polling' | 'webhook';
  botUsername: string | null;
  botFirstName: string | null;
  botId: number | null;
  lastError: string | null;
  startedAt: string | null;
  updatesReceived: number;
  lastUpdateAt: string | null;
}

interface StoredTelegramConfig {
  encryptedBotToken?: string;
  tokenFingerprint?: string;
  ownerTelegramIds?: string;
  enabled?: boolean;
}

let grammyBotInstance: Bot | null = null;
let activeTokenUsed: string | null = null;
let runtimeState: TelegramBotRuntimeStatus = {
  configured: false,
  tokenSource: 'none',
  tokenFingerprint: null,
  ownerTelegramIds: '',
  state: 'not_configured',
  mode: 'polling',
  botUsername: null,
  botFirstName: null,
  botId: null,
  lastError: null,
  startedAt: null,
  updatesReceived: 0,
  lastUpdateAt: null,
};

function buildTelegramInlineMarkup(
  rows: BotInlineButton[][],
  includeExtendedFields = true
): { inline_keyboard: Array<Array<Record<string, any>>> } {
  const inline_keyboard = rows
    .filter((row) => row.length > 0)
    .map((row) =>
      row.map((btn) => {
        const obj: Record<string, any> = { text: btn.text };
        if (btn.copyText) {
          obj.copy_text = { text: btn.copyText };
        } else if (btn.url) {
          obj.url = btn.url;
        } else {
          obj.callback_data = btn.callbackData || 'c:home';
        }
        if (includeExtendedFields) {
          if (btn.iconCustomEmojiId) {
            obj.icon_custom_emoji_id = btn.iconCustomEmojiId;
          }
          if (btn.style === 'primary' || btn.style === 'success' || btn.style === 'danger') {
            obj.style = btn.style;
          }
        }
        return obj;
      })
    );
  return { inline_keyboard };
}

async function resolveTelegramConfigFromDbAndEnv(): Promise<{
  token: string;
  tokenSource: 'database' | 'env' | 'none';
  tokenFingerprint: string | null;
  ownerTelegramIds: string;
  enabled: boolean;
}> {
  let stored: StoredTelegramConfig = {};
  try {
    const [row] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, 'telegram_bot_config'))
      .limit(1);
    stored = (row?.valueJson as StoredTelegramConfig) || {};
  } catch {
    stored = {};
  }

  const envOwnerIds = [process.env.TELEGRAM_OWNER_IDS || '', process.env.ADMIN_TELEGRAM_IDS || '']
    .join(',')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');

  const ownerTelegramIds = (stored.ownerTelegramIds || envOwnerIds || '').trim();

  if (stored.encryptedBotToken) {
    try {
      const decrypted = decryptSecret(stored.encryptedBotToken).trim();
      if (decrypted) {
        return {
          token: decrypted,
          tokenSource: 'database',
          tokenFingerprint: stored.tokenFingerprint || maskApiKey(decrypted),
          ownerTelegramIds,
          enabled: stored.enabled !== false,
        };
      }
    } catch {
      // Fall through to env token
    }
  }

  const envToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (envToken) {
    return {
      token: envToken,
      tokenSource: 'env',
      tokenFingerprint: maskApiKey(envToken),
      ownerTelegramIds,
      enabled: stored.enabled !== false,
    };
  }

  return {
    token: '',
    tokenSource: 'none',
    tokenFingerprint: null,
    ownerTelegramIds,
    enabled: false,
  };
}

function createConfiguredGrammyBot(token: string): Bot {
  const bot = new Bot(token);

  bot.catch((err) => {
    const message = err.error instanceof Error ? err.error.message : String(err.error);
    console.error('Telegram bot handler error:', message);
    runtimeState.lastError = message;
  });

  const sendReply = async (ctx: any, reply: BotReplyPayload, isCallbackQuery: boolean) => {
    const hasKeyboard = Boolean(reply.inlineKeyboard && reply.inlineKeyboard.length > 0);
    const hasEntities = Array.isArray(reply.entities) && reply.entities.length > 0;
    const useHtml = reply.parseMode === 'HTML' && !hasEntities;

    const buildOpts = (
      extendedButtons: boolean,
      includeEntities: boolean,
      mode: 'HTML' | 'plain'
    ): Record<string, any> => {
      const opts: Record<string, any> = {};
      if (hasKeyboard) {
        opts.reply_markup = buildTelegramInlineMarkup(reply.inlineKeyboard, extendedButtons);
      }
      if (mode === 'HTML') {
        opts.parse_mode = 'HTML';
        opts.link_preview_options = { is_disabled: true };
      } else if (includeEntities && hasEntities) {
        opts.entities = reply.entities;
      }
      return opts;
    };

    const htmlNoEmojiText = useHtml
      ? reply.htmlNoCustomEmojiFallback || stripTgEmojiTagsKeepFallback(reply.text)
      : reply.text;
    const plainFallbackText = useHtml
      ? reply.plainFallbackText || stripTelegramHtmlToPlainText(reply.text)
      : reply.text;

    const isNotModifiedError = (e: any) =>
      /message is not modified/i.test(String(e?.description || e?.message || ''));
    const isHtmlOrEmojiParseError = (e: any) =>
      /can't parse entities|unsupported start tag|unexpected end tag|custom emoji|DOCUMENT_INVALID|ENTITY_/i.test(
        String(e?.description || e?.message || '')
      );

    const deliverVia = async (method: 'edit' | 'reply'): Promise<boolean> => {
      const exec = (txt: string, opts: Record<string, any>) =>
        method === 'edit' ? ctx.editMessageText(txt, opts) : ctx.reply(txt, opts);

      if (useHtml) {
        // 1. Primary: Full Telegram HTML (including <tg-emoji>) + extended buttons
        try {
          await exec(reply.text, buildOpts(true, false, 'HTML'));
          return true;
        } catch (err1: any) {
          if (method === 'edit' && isNotModifiedError(err1)) return true;

          // 2. Retry HTML with standard buttons (if button style/icon rejected) OR without <tg-emoji> (if custom emoji rejected)
          const tryNoEmojiFirst = isHtmlOrEmojiParseError(err1) && htmlNoEmojiText !== reply.text;
          try {
            await exec(
              tryNoEmojiFirst ? htmlNoEmojiText : reply.text,
              buildOpts(tryNoEmojiFirst, false, 'HTML')
            );
            return true;
          } catch (err2: any) {
            if (method === 'edit' && isNotModifiedError(err2)) return true;

            // 3. Retry HTML without <tg-emoji> AND standard buttons (keeps <blockquote>, <b>, <i>, <a>, <code> intact!)
            if (htmlNoEmojiText !== reply.text) {
              try {
                await exec(htmlNoEmojiText, buildOpts(false, false, 'HTML'));
                return true;
              } catch (err3: any) {
                if (method === 'edit' && isNotModifiedError(err3)) return true;
              }
            }

            // 4. Guaranteed safe plain-text fallback (ZERO raw HTML tags ever shown to buyers!)
            try {
              await exec(plainFallbackText, buildOpts(false, false, 'plain'));
              return true;
            } catch (err4: any) {
              if (method === 'edit' && isNotModifiedError(err4)) return true;
              return false;
            }
          }
        }
      }

      // Standard non-HTML path (preserves native entities when present)
      try {
        await exec(reply.text, buildOpts(true, true, 'plain'));
        return true;
      } catch (err1: any) {
        if (method === 'edit' && isNotModifiedError(err1)) return true;
        try {
          await exec(reply.text, buildOpts(false, true, 'plain'));
          return true;
        } catch (err2: any) {
          if (method === 'edit' && isNotModifiedError(err2)) return true;
          if (method === 'reply') {
            await exec(reply.text, buildOpts(false, false, 'plain'));
            return true;
          }
          return false;
        }
      }
    };

    if (isCallbackQuery && reply.editInPlace) {
      const edited = await deliverVia('edit');
      if (edited) return;
    }

    await deliverVia('reply');
  };

  bot.on('message:text', async (ctx) => {
    runtimeState.updatesReceived += 1;
    runtimeState.lastUpdateAt = new Date().toISOString();
    const reply = await handleTelegramInteraction({
      telegramUserId: String(ctx.from.id),
      username: ctx.from.username,
      displayName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Customer',
      telegramLanguageCode: ctx.from.language_code,
      text: ctx.message.text,
      entities: (ctx.message.entities as any[]) || undefined,
    });
    await sendReply(ctx, reply, false);
  });

  bot.on('message:photo', async (ctx) => {
    runtimeState.updatesReceived += 1;
    runtimeState.lastUpdateAt = new Date().toISOString();
    const photos = ctx.message.photo || [];
    const largest = photos[photos.length - 1];
    const reply = await handleTelegramInteraction({
      telegramUserId: String(ctx.from.id),
      username: ctx.from.username,
      displayName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Customer',
      telegramLanguageCode: ctx.from.language_code,
      photoFileId: largest?.file_id,
      photoCaption: ctx.message.caption || '',
      text: ctx.message.caption || '',
    });
    await sendReply(ctx, reply, false);
  });

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    if (!doc?.mime_type || !doc.mime_type.startsWith('image/')) return;
    runtimeState.updatesReceived += 1;
    runtimeState.lastUpdateAt = new Date().toISOString();
    const reply = await handleTelegramInteraction({
      telegramUserId: String(ctx.from.id),
      username: ctx.from.username,
      displayName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Customer',
      telegramLanguageCode: ctx.from.language_code,
      photoFileId: doc.file_id,
      photoCaption: ctx.message.caption || '',
      text: ctx.message.caption || '',
    });
    await sendReply(ctx, reply, false);
  });

  bot.on('callback_query:data', async (ctx) => {
    runtimeState.updatesReceived += 1;
    runtimeState.lastUpdateAt = new Date().toISOString();
    const data = ctx.callbackQuery.data || '';

    // Handle Admin Review Channel Approve / Reject interactive callbacks with strict RBAC!
    if (data.startsWith('adm_ch:')) {
      const { user } = await getOrCreateTelegramUserWithMeta({
        telegramUserId: String(ctx.from.id),
        username: ctx.from.username,
        displayName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Admin',
        telegramLanguageCode: ctx.from.language_code,
      });
      const isPrivilegedAdmin = user.role === 'owner' || user.role === 'admin';
      const channelRes = await handleAdminChannelLocalDepositAction({
        adminUser: user,
        isPrivilegedAdmin,
        callbackData: data,
        fsm: (user.botStateJson as Record<string, any>) || {},
      });
      if (channelRes.handled) {
        await ctx
          .answerCallbackQuery({
            text: channelRes.alertText || 'تم تنفيذ الإجراء.',
            show_alert: true,
          })
          .catch(() => undefined);
        if (channelRes.updateChannelKeyboard) {
          await ctx
            .editMessageReplyMarkup({
              reply_markup: buildTelegramInlineMarkup(channelRes.updateChannelKeyboard, false) as any,
            })
            .catch(() => undefined);
        }
        return;
      }
    }

    await ctx.answerCallbackQuery().catch(() => undefined);
    const reply = await handleTelegramInteraction({
      telegramUserId: String(ctx.from.id),
      username: ctx.from.username,
      displayName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Customer',
      telegramLanguageCode: ctx.from.language_code,
      callbackData: data,
    });
    await sendReply(ctx, reply, true);
  });

  return bot;
}

export async function stopRealTelegramBot(): Promise<void> {
  if (grammyBotInstance) {
    const toStop = grammyBotInstance;
    grammyBotInstance = null;
    activeTokenUsed = null;
    try {
      await toStop.stop();
    } catch {
      // Ignore stop errors if already stopped
    }
  }
  if (runtimeState.configured) {
    runtimeState.state = 'stopped';
  }
}

export async function getTelegramBotRuntimeStatus(): Promise<TelegramBotRuntimeStatus> {
  const resolved = await resolveTelegramConfigFromDbAndEnv();
  return {
    ...runtimeState,
    configured: Boolean(resolved.token),
    tokenSource: resolved.tokenSource,
    tokenFingerprint: resolved.tokenFingerprint,
    ownerTelegramIds: resolved.ownerTelegramIds,
    state: resolved.token ? runtimeState.state : 'not_configured',
  };
}

export async function startOrRestartTelegramBot(): Promise<{
  ok: boolean;
  messageAr: string;
  status: TelegramBotRuntimeStatus;
}> {
  const resolved = await resolveTelegramConfigFromDbAndEnv();
  runtimeState.configured = Boolean(resolved.token);
  runtimeState.tokenSource = resolved.tokenSource;
  runtimeState.tokenFingerprint = resolved.tokenFingerprint;
  runtimeState.ownerTelegramIds = resolved.ownerTelegramIds;

  if (!resolved.token) {
    await stopRealTelegramBot();
    runtimeState.state = 'not_configured';
    runtimeState.botUsername = null;
    runtimeState.botFirstName = null;
    runtimeState.botId = null;
    runtimeState.lastError = 'لم يتم إدخال TELEGRAM_BOT_TOKEN بعد.';
    return {
      ok: false,
      messageAr: 'لم يتم إدخال توكن البوت (TELEGRAM_BOT_TOKEN) بعد. أنشئ بوتًا عبر @BotFather ثم الصق التوكن هنا.',
      status: await getTelegramBotRuntimeStatus(),
    };
  }

  await stopRealTelegramBot();
  runtimeState.state = 'starting';
  runtimeState.lastError = null;

  const bot = createConfiguredGrammyBot(resolved.token);

  try {
    const me = await bot.api.getMe();
    runtimeState.botUsername = me.username || null;
    runtimeState.botFirstName = me.first_name || null;
    runtimeState.botId = me.id;

    await bot.api.deleteWebhook({ drop_pending_updates: false });

    await bot.api
      .setMyCommands([
        { command: 'start', description: 'القائمة الرئيسية / Main Menu' },
        { command: 'wallet', description: 'محفظتي / My Wallet' },
        { command: 'orders', description: 'طلباتي / My Orders' },
        { command: 'language', description: 'تبديل اللغة / Switch Language' },
      ])
      .catch(() => undefined);

    grammyBotInstance = bot;
    activeTokenUsed = resolved.token;
    runtimeState.mode = 'polling';
    runtimeState.state = 'running';
    runtimeState.startedAt = new Date().toISOString();
    runtimeState.lastError = null;

    void bot
      .start({
        drop_pending_updates: false,
        allowed_updates: ['message', 'callback_query'],
        onStart: (botInfo) => {
          console.log(`Telegram Bot @${botInfo.username} is LIVE (Long Polling)`);
        },
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Telegram Long Polling stopped with error:', msg);
        if (grammyBotInstance === bot) {
          runtimeState.state = 'error';
          runtimeState.lastError = msg.includes('409')
            ? 'تعارض 409: هناك نسخة أخرى تعمل بنفس توكن البوت في مكان آخر.'
            : msg;
          grammyBotInstance = null;
          activeTokenUsed = null;
        }
      });

    return {
      ok: true,
      messageAr: `تم تشغيل البوت الحقيقي @${me.username} بنجاح وهو يستجيب الآن على تيليجرام (Long Polling).`,
      status: await getTelegramBotRuntimeStatus(),
    };
  } catch (err: any) {
    const rawMsg = err?.description || err?.message || String(err);
    runtimeState.state = 'error';
    runtimeState.botUsername = null;
    runtimeState.botFirstName = null;
    runtimeState.botId = null;
    runtimeState.lastError =
      rawMsg.includes('401') || /unauthorized/i.test(rawMsg)
        ? 'توكن البوت غير صالح (401 Unauthorized) — تأكد من نسخ التوكن كاملًا من @BotFather.'
        : `تعذر الاتصال بخوادم تيليجرام: ${rawMsg}`;
    grammyBotInstance = null;
    activeTokenUsed = null;
    return {
      ok: false,
      messageAr: runtimeState.lastError,
      status: await getTelegramBotRuntimeStatus(),
    };
  }
}

export async function saveTelegramBotConfig(params: {
  botToken?: string;
  ownerTelegramIds?: string;
  enabled?: boolean;
}): Promise<{ ok: boolean; messageAr: string; status: TelegramBotRuntimeStatus }> {
  const [existingRow] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, 'telegram_bot_config'))
    .limit(1);

  const prev = (existingRow?.valueJson as StoredTelegramConfig) || {};
  const next: StoredTelegramConfig = { ...prev };

  const cleanedToken = typeof params.botToken === 'string' ? params.botToken.trim() : '';
  if (cleanedToken) {
    next.encryptedBotToken = encryptSecret(cleanedToken);
    next.tokenFingerprint = maskApiKey(cleanedToken);
  }
  if (typeof params.ownerTelegramIds === 'string') {
    next.ownerTelegramIds = params.ownerTelegramIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .join(', ');
  }
  if (typeof params.enabled === 'boolean') {
    next.enabled = params.enabled;
  } else {
    next.enabled = true;
  }

  await db
    .insert(settings)
    .values({ key: 'telegram_bot_config', valueJson: next })
    .onConflictDoUpdate({
      target: settings.key,
      set: { valueJson: next, updatedAt: new Date() },
    });

  if (next.enabled === false) {
    await stopRealTelegramBot();
    return {
      ok: true,
      messageAr: 'تم إيقاف البوت وحفظ الإعدادات.',
      status: await getTelegramBotRuntimeStatus(),
    };
  }

  return startOrRestartTelegramBot();
}

export async function bootstrapTelegramBotOnStartup(): Promise<void> {
  try {
    const resolved = await resolveTelegramConfigFromDbAndEnv();
    if (resolved.token && resolved.enabled) {
      const res = await startOrRestartTelegramBot();
      if (!res.ok) {
        console.warn('Telegram bot auto-start warning:', res.messageAr);
      }
    } else {
      runtimeState.configured = Boolean(resolved.token);
      runtimeState.tokenSource = resolved.tokenSource;
      runtimeState.tokenFingerprint = resolved.tokenFingerprint;
      runtimeState.ownerTelegramIds = resolved.ownerTelegramIds;
      runtimeState.state = resolved.token ? 'stopped' : 'not_configured';
    }
  } catch (err) {
    console.error('Telegram bot bootstrap error:', err);
  }
}

export async function getTelegramBotInstanceAsync(): Promise<Bot | null> {
  const resolved = await resolveTelegramConfigFromDbAndEnv();
  if (!resolved.token) return null;
  if (grammyBotInstance && activeTokenUsed === resolved.token) {
    return grammyBotInstance;
  }
  const bot = createConfiguredGrammyBot(resolved.token);
  await bot.init();
  grammyBotInstance = bot;
  activeTokenUsed = resolved.token;
  return bot;
}

export function getTelegramBotInstance(): Bot | null {
  if (grammyBotInstance) return grammyBotInstance;
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) return null;
  grammyBotInstance = createConfiguredGrammyBot(token);
  activeTokenUsed = token;
  return grammyBotInstance;
}
