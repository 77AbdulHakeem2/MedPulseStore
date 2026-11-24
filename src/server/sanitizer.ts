import Decimal from 'decimal.js';
import { formatMoney } from './pricing.ts';
import { getLocalizedProductFields, t, type SupportedLang } from '../i18n/index.ts';
import {
  formatCurrencyToggleButtonLabel,
  formatDisplayPrice,
  type DisplayCurrency,
  type YerRoundingMode,
} from './currencyEngine.ts';
import { resolveEffectiveOrderChargeUsd } from './walletEngine.ts';
import {
  escapeTelegramHtml,
  processSupplierProductDescription,
  stripTelegramHtmlToPlainText,
} from './productDescriptionEngine.ts';

/**
 * Forbidden terms that MUST NEVER appear in any customer-facing message,
 * inline keyboard button, error response, or product DTO — in ANY language (AR or EN).
 */
export const FORBIDDEN_CUSTOMER_LEAK_PATTERNS: RegExp[] = [
  /pixora/i,
  /pandora\s*digital/i,
  /pandoradigital/i,
  /qorix/i,
  /digitalcore/i,
  /aivaulthub/i,
  /aivault/i,
  /daddyclub/i,
  /reseller\s*api/i,
  /wholesale/i,
  /سعر\s*الجملة/,
  /رصيد\s*المزود/,
  /مزود\s*api/i,
  /api\s*key/i,
  /px_live_/i,
  /sk_live_/i,
  /x-api-key/i,
  /x-mbx-apikey/i,
  /provider_order_id/i,
  /supplier\s*balance/i,
  /sapi\/v1/i,
];

/**
 * Internal system/admin remarks that MUST NEVER be exposed to buyers in the storefront or Telegram bot.
 */
export const INTERNAL_ADMIN_NOTICE_PATTERNS: RegExp[] = [
  /منتج\s*مستورد\s*تلقائي(?:ًا|ا)?\s*من\s*(?:الخادم|المزود|السيرفر)/i,
  /مخفي\s*افتراضي(?:ًا|ا)?\s*حتى\s*التفعيل(?:\s*والتسعير)?/i,
  /مستورد\s*تلقائي(?:ًا|ا)?\s*من\s*(?:الخادم|المزود|السيرفر)/i,
  /مخفي\s*افتراضي(?:ًا|ا)?/i,
  /حتى\s*التفعيل\s*والتسعير/i,
  /ملاحظة\s*إدارية\s*داخلية/i,
  /خاص\s*بالإدارة\s*فقط|للمسؤول\s*فقط/i,
  /auto[-\s]*imported\s*from\s*(?:the\s*)?(?:server|provider|supplier)/i,
  /hidden\s*by\s*default\s*(?:until|pending)\s*(?:activation|pricing|review)/i,
  /pending\s*(?:admin\s*)?activation\s*(?:and|&)\s*pricing/i,
  /internal\s*(?:admin|system)\s*note/i,
  /for\s*admin\s*only/i,
];

export function containsInternalAdminNotice(text: string | null | undefined): boolean {
  const val = (text || '').trim();
  if (!val) return false;
  return INTERNAL_ADMIN_NOTICE_PATTERNS.some((pattern) => pattern.test(val));
}

/**
 * Centralized customer product description sanitizer:
 * - Preserves valid Telegram HTML formatting (<blockquote>, <b>, <i>, <u>, <s>, <code>, <pre>,
 *   <tg-spoiler>, <a href="...">, <tg-emoji emoji-id="...">) and repairs unclosed/misnested tags.
 * - Selectively removes supplier identities, store/channel/referral links, promotional lines,
 *   and internal admin import notices while preserving official service/activation links and
 *   100% of operational product details.
 */
export function sanitizeCustomerProductDescription(text: string | null | undefined): string {
  const processed = processSupplierProductDescription(text);
  if (!processed.plainText) return '';
  return processed.hasHtmlFormatting ? processed.telegramHtml : processed.plainText;
}

export type InlineButtonStyle = 'primary' | 'success' | 'danger' | null;

export interface CustomerInlineButton {
  text: string;
  callbackData?: string;
  url?: string;
  copyText?: string;
  iconCustomEmojiId?: string | null;
  style?: InlineButtonStyle;
}

export interface DynamicMenuButtonInput {
  id: number;
  code: string;
  labelAr: string;
  labelEn: string;
  iconEmoji?: string | null;
  iconCustomEmojiId?: string | null;
  buttonStyle?: string | null;
  actionType: string; // builtin | category | guide | custom_text | url
  actionValue: string;
  rowOrder: number;
  colOrder: number;
  buttonsPerRow?: number;
  isVisible: boolean;
  isEnabled: boolean;
}

export function buildSupportTelegramUrl(supportHandle?: string | null): string {
  const cleaned = (supportHandle || '@raqm_support').trim();
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  const username = cleaned.replace(/^@+/, '').replace(/[^a-zA-Z0-9_]/g, '') || 'raqm_support';
  return `https://t.me/${username}`;
}

function normalizeButtonStyle(style?: string | null): InlineButtonStyle {
  if (style === 'primary' || style === 'success' || style === 'danger') return style;
  return null;
}

/**
 * Pure, deterministic builder for dynamic Customer Main Menu InlineKeyboard rows.
 * Groups visible buttons by `rowOrder`, sorts by `colOrder`, respects `buttonsPerRow`,
 * wires direct `url` buttons (e.g., Support chat), and strips any forbidden provider labels!
 */
export function buildDynamicMainInlineKeyboard(
  rowsInput: DynamicMenuButtonInput[],
  lang: SupportedLang,
  supportHandle?: string | null,
  preferredCurrency: DisplayCurrency = 'USD'
): CustomerInlineButton[][] {
  const visible = rowsInput
    .filter((b) => b.isVisible)
    .sort((a, b) => a.rowOrder - b.rowOrder || a.colOrder - b.colOrder || a.id - b.id);

  if (visible.length === 0) {
    return buildCustomerMainInlineKeyboard(lang, supportHandle, preferredCurrency);
  }

  // Group by rowOrder
  const grouped = new Map<number, DynamicMenuButtonInput[]>();
  for (const item of visible) {
    const arr = grouped.get(item.rowOrder) || [];
    arr.push(item);
    grouped.set(item.rowOrder, arr);
  }

  const keyboard: CustomerInlineButton[][] = [];
  for (const [, rowItems] of Array.from(grouped.entries()).sort((a, b) => a[0] - b[0])) {
    const maxPerRow = Math.max(1, Math.min(4, rowItems[0]?.buttonsPerRow || 2));
    for (let i = 0; i < rowItems.length; i += maxPerRow) {
      const slice = rowItems.slice(i, i + maxPerRow);
      const renderedRow: CustomerInlineButton[] = slice.map((btn) => {
        const rawLabel = lang === 'en' ? btn.labelEn || btn.labelAr : btn.labelAr || btn.labelEn;
        const safeLabel = containsProviderLeak(rawLabel) ? 'Menu' : rawLabel;
        const style = normalizeButtonStyle(btn.buttonStyle);
        const iconCustomEmojiId = btn.iconCustomEmojiId || undefined;

        if (!btn.isEnabled) {
          return {
            text: safeLabel,
            callbackData: `c:disabled:${btn.id}`,
            iconCustomEmojiId,
            style,
          };
        }

        if (btn.actionType === 'url') {
          const url =
            btn.actionValue === 'support_link' || !/^https?:\/\//i.test(btn.actionValue)
              ? buildSupportTelegramUrl(
                  btn.actionValue === 'support_link' ? supportHandle : btn.actionValue
                )
              : btn.actionValue;
          return {
            text: safeLabel,
            url,
            iconCustomEmojiId,
            style,
          };
        }

        let callbackData = `c:btn:${btn.id}`;
        if (btn.actionType === 'builtin') {
          switch (btn.actionValue) {
            case 'store':
              callbackData = 'c:store';
              break;
            case 'wallet':
              callbackData = 'c:wallet';
              break;
            case 'orders':
              callbackData = 'c:orders';
              break;
            case 'refer':
              callbackData = 'c:refer';
              break;
            case 'profile':
              callbackData = 'c:profile';
              break;
            case 'how_to_use':
              callbackData = 'c:guides';
              break;
            case 'lang_toggle':
              callbackData = 'c:lang_toggle';
              break;
            case 'currency_toggle':
              return {
                text: formatCurrencyToggleButtonLabel(preferredCurrency, lang),
                callbackData: 'c:currency_toggle',
                iconCustomEmojiId,
                style: style || 'primary',
              };
            case 'support':
              return {
                text: safeLabel,
                url: buildSupportTelegramUrl(supportHandle),
                iconCustomEmojiId,
                style,
              };
            default:
              callbackData = `c:btn:${btn.id}`;
          }
        } else if (btn.actionType === 'category' && btn.actionValue) {
          callbackData = `c:catslug:${btn.actionValue}`;
        } else if (btn.actionType === 'guide' && btn.actionValue) {
          callbackData = `c:guideslug:${btn.actionValue}`;
        }

        return {
          text: safeLabel,
          callbackData,
          iconCustomEmojiId,
          style,
        };
      });
      if (renderedRow.length > 0) keyboard.push(renderedRow);
    }
  }

  return keyboard;
}

/**
 * Default 8-button Inline Keyboard matching the exact requested 2-column layout:
 * Row 1: 🛍 Store | 💰 My Wallet (green primary)
 * Row 2: 📦 My Orders | 👥 Refer & Earn
 * Row 3: 🪪 Profile | 📖 How to Use
 * Row 4: 📞 Support (direct URL) | 🌐 اللغة / Lang (1-click instant toggle)
 */
export function buildCustomerMainInlineKeyboard(
  lang: SupportedLang,
  supportHandle?: string | null,
  preferredCurrency: DisplayCurrency = 'USD'
): CustomerInlineButton[][] {
  return [
    [
      { text: t(lang, 'btn_store'), callbackData: 'c:store', style: 'success' },
      { text: t(lang, 'btn_wallet'), callbackData: 'c:wallet', style: 'success' },
    ],
    [
      { text: t(lang, 'btn_orders'), callbackData: 'c:orders', style: 'primary' },
      { text: t(lang, 'btn_refer'), callbackData: 'c:refer', style: 'primary' },
    ],
    [
      { text: t(lang, 'btn_profile'), callbackData: 'c:profile', style: 'primary' },
      { text: t(lang, 'btn_how_to_use'), callbackData: 'c:guides', style: 'primary' },
    ],
    [
      { text: t(lang, 'btn_support'), url: buildSupportTelegramUrl(supportHandle), style: 'primary' },
      { text: t(lang, 'btn_lang_toggle'), callbackData: 'c:lang_toggle', style: 'primary' },
    ],
    [
      {
        text: formatCurrencyToggleButtonLabel(preferredCurrency, lang),
        callbackData: 'c:currency_toggle',
        style: 'primary',
      },
    ],
  ];
}

export function buildCustomerNavFooter(lang: SupportedLang, backTarget?: string): CustomerInlineButton[] {
  const row: CustomerInlineButton[] = [];
  if (backTarget) {
    row.push({ text: t(lang, 'btn_back'), callbackData: backTarget });
  }
  row.push({ text: t(lang, 'btn_home'), callbackData: 'c:home' });
  return row;
}

/**
 * Formats an order row in the exact clean layout requested:
 * ✅ VCP0XQQ1JE
 * 🛒 Gemini Plus 6 Months x1 — 0.50 USDT
 * 📅 2026-11-12 Time 20:06
 */
export function formatCustomerOrderCard(params: {
  orderNumber: string;
  status: string;
  title: string;
  quantity: number;
  totalRetail: string;
  createdAt: Date | string;
  lang: SupportedLang;
  currency?: DisplayCurrency;
  exchangeRate?: string | null;
  roundingMode?: YerRoundingMode;
}): string {
  const icon =
    params.status === 'completed'
      ? '✅'
      : params.status === 'refunded'
      ? '↩️'
      : params.status === 'failed'
      ? '❌'
      : '⏳';
  const dt = params.createdAt instanceof Date ? params.createdAt : new Date(params.createdAt);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  const hh = String(dt.getUTCHours()).padStart(2, '0');
  const min = String(dt.getUTCMinutes()).padStart(2, '0');
  const timeWord = params.lang === 'en' ? 'Time' : 'الساعة';
  const amountDisplay =
    params.currency === 'YER' && params.exchangeRate
      ? formatDisplayPrice({
          usdAmount: params.totalRetail,
          currency: 'YER',
          exchangeRate: params.exchangeRate,
          roundingMode: params.roundingMode,
        })
      : `${formatMoney(params.totalRetail, 2)} USDT`;

  return (
    `${icon} ${params.orderNumber}\n` +
    `🛒 ${params.title} x${params.quantity} — ${amountDisplay}\n` +
    `📅 ${yyyy}-${mm}-${dd} ${timeWord} ${hh}:${min}`
  );
}

/**
 * Formats the Profile card in the user's preferred display currency (USD or YER).
 */
export function formatCustomerProfileCard(params: {
  displayName: string;
  telegramUserId: string;
  balance: string;
  ordersCount: number;
  totalSpent: string;
  lang: SupportedLang;
  currency?: DisplayCurrency;
  exchangeRate?: string | null;
  roundingMode?: YerRoundingMode;
}): string {
  if (params.currency === 'YER' && params.exchangeRate) {
    const balYer = formatDisplayPrice({
      usdAmount: params.balance,
      currency: 'YER',
      exchangeRate: params.exchangeRate,
      roundingMode: params.roundingMode,
    });
    const spentYer = formatDisplayPrice({
      usdAmount: params.totalSpent,
      currency: 'YER',
      exchangeRate: params.exchangeRate,
      roundingMode: params.roundingMode,
    });
    if (params.lang === 'en') {
      return [
        '👤 Your Profile',
        '',
        `Name: ${params.displayName}`,
        `User ID: ${params.telegramUserId}`,
        `💱 Display Currency: YER ﷼`,
        '',
        `👛 Balance: ${balYer}`,
        `📦 Orders: ${params.ordersCount}`,
        `💰 Total spent: ${spentYer}`,
      ].join('\n');
    }
    return [
      '👤 ملفك الشخصي',
      '',
      `الاسم: ${params.displayName}`,
      `معرّف المستخدم: ${params.telegramUserId}`,
      `💱 العملة الحالية: الريال اليمني (﷼)`,
      '',
      `👛 الرصيد: ${balYer}`,
      `📦 الطلبات: ${params.ordersCount}`,
      `💰 إجمالي الإنفاق: ${spentYer}`,
    ].join('\n');
  }

  return t(params.lang, 'profile_card', {
    name: params.displayName,
    userId: params.telegramUserId,
    balance: formatMoney(params.balance, 2),
    ordersCount: String(params.ordersCount),
    totalSpent: formatMoney(params.totalSpent, 2),
  });
}

export const FORBIDDEN_CUSTOMER_BUTTONS = [
  'Reseller API',
  'API',
  'API Keys',
  'Servers',
  'Providers',
  'Wholesale Prices',
  'Supplier Balance',
  'Supplier Dashboard',
  'Developer Tools',
  'API Documentation',
  'إدارة الخوادم',
];

export function containsProviderLeak(text: string): boolean {
  return FORBIDDEN_CUSTOMER_LEAK_PATTERNS.some((pattern) => pattern.test(text));
}

export function sanitizeErrorForCustomer(rawError: unknown, lang: SupportedLang = 'ar'): string {
  const msg = typeof rawError === 'string' ? rawError : rawError instanceof Error ? rawError.message : '';

  if (/INSUFFICIENT_CUSTOMER_BALANCE/i.test(msg)) {
    return t(lang, 'error_insufficient_balance');
  }
  if (/STORE_MAINTENANCE/i.test(msg)) {
    return t(lang, 'error_maintenance');
  }
  if (/PRODUCT_UNAVAILABLE_CUSTOMER|OUT_OF_STOCK_CUSTOMER/i.test(msg)) {
    return t(lang, 'error_product_unavailable');
  }
  if (/UNAUTHORIZED_ORDER_ACCESS/i.test(msg)) {
    return lang === 'en' ? 'You are not authorized to view this order.' : 'لا يمكنك عرض تفاصيل هذا الطلب.';
  }

  return t(lang, 'error_generic');
}

export interface CustomerProductDTO {
  id: number;
  sku: string;
  categoryId: number | null;
  categoryNameAr: string;
  categoryNameEn: string;
  categoryName: string;
  titleAr: string;
  titleEn: string;
  title: string;
  descriptionAr: string;
  descriptionEn: string;
  description: string;
  iconEmoji?: string;
  iconCustomEmojiId?: string | null;
  imageUrl: string;
  retailPrice: string;
  promoPrice: string | null;
  currency: string;
  warrantyLabelAr: string;
  warrantyLabelEn: string;
  warrantyLabel: string;
  durationLabel: string;
  deliveryType: string;
  inStock: boolean;
  availableQty: number;
  isFeaturedOffer: boolean;
}

function scrubLeaks(text: string, fallback: string): string {
  if (!containsProviderLeak(text)) return text;
  const cleaned = text.replace(/pixora|pandora\s*digital|pandora|qorix|digitalcore|aivaulthub|aivault/gi, '').trim();
  return cleaned && !containsProviderLeak(cleaned) ? cleaned : fallback;
}

export function toCustomerProductDTO(input: {
  id: number;
  sku: string;
  categoryId: number | null;
  categoryNameAr: string;
  categoryNameEn?: string | null;
  titleAr: string;
  titleEn?: string | null;
  descriptionAr: string;
  descriptionEn?: string | null;
  iconEmoji?: string | null;
  iconCustomEmojiId?: string | null;
  imageUrl: string | null;
  warrantyLabelAr: string;
  warrantyLabelEn?: string | null;
  durationLabel: string;
  deliveryType: string;
  isVisible: boolean;
  isPaused: boolean;
  autoHideOutOfStock: boolean;
  isFeaturedOffer: boolean;
  retailPrice: string;
  promoPrice: string | null;
  availableStock: number;
  currency?: string;
  lang?: SupportedLang;
}): CustomerProductDTO | null {
  const trueStock = Math.max(0, Math.floor(input.availableStock || 0));
  if (!input.isVisible || input.isPaused) return null;
  // Auto-hide whenever combined stock across all linked providers is 0; auto-restores when stock returns
  if (trueStock <= 0) return null;

  const lang = input.lang || 'ar';
  const cleanTitleAr = scrubLeaks(
    containsInternalAdminNotice(input.titleAr) ? '' : input.titleAr,
    'منتج رقمي'
  );
  const cleanTitleEn =
    input.titleEn && !containsInternalAdminNotice(input.titleEn)
      ? scrubLeaks(input.titleEn, cleanTitleAr)
      : '';
  const cleanDescAr = sanitizeCustomerProductDescription(input.descriptionAr);
  const cleanDescEn = sanitizeCustomerProductDescription(input.descriptionEn);
  const cleanWarrantyAr = containsInternalAdminNotice(input.warrantyLabelAr)
    ? ''
    : scrubLeaks(input.warrantyLabelAr || '', '');
  const cleanWarrantyEn =
    input.warrantyLabelEn && !containsInternalAdminNotice(input.warrantyLabelEn)
      ? scrubLeaks(input.warrantyLabelEn, '')
      : '';

  const localized = getLocalizedProductFields(
    {
      titleAr: cleanTitleAr,
      titleEn: cleanTitleEn,
      descriptionAr: cleanDescAr,
      descriptionEn: cleanDescEn,
      warrantyLabelAr: cleanWarrantyAr,
      warrantyLabelEn: cleanWarrantyEn,
      categoryNameAr: input.categoryNameAr,
      categoryNameEn: input.categoryNameEn,
    },
    lang
  );

  return {
    id: input.id,
    sku: input.sku,
    categoryId: input.categoryId,
    categoryNameAr: input.categoryNameAr,
    categoryNameEn: input.categoryNameEn || input.categoryNameAr,
    categoryName: localized.categoryName,
    titleAr: cleanTitleAr,
    titleEn: cleanTitleEn || cleanTitleAr,
    title: localized.title,
    descriptionAr: cleanDescAr,
    descriptionEn: cleanDescEn || cleanDescAr,
    description: localized.description,
    iconEmoji: input.iconEmoji || '',
    iconCustomEmojiId: input.iconCustomEmojiId || null,
    imageUrl: input.imageUrl || '',
    retailPrice: formatMoney(input.retailPrice, 2),
    promoPrice: input.promoPrice ? formatMoney(input.promoPrice, 2) : null,
    currency: input.currency || 'USDT',
    warrantyLabelAr: cleanWarrantyAr,
    warrantyLabelEn: cleanWarrantyEn || 'Instant Activation Warranty',
    warrantyLabel: localized.warrantyLabel,
    durationLabel: input.durationLabel,
    deliveryType: input.deliveryType,
    inStock: trueStock > 0,
    availableQty: trueStock,
    isFeaturedOffer: input.isFeaturedOffer,
  };
}

/**
 * Formats the customer-facing Telegram Inline Button label for a product in the exact requested format:
 * "Product Name - $Price - [TotalStock]"
 * Example: "Gemini Plus 6 Months - $1.13 - [2000]"
 */
export function formatCustomerProductButtonLabel(params: {
  title: string;
  retailPrice: string;
  promoPrice?: string | null;
  availableQty: number;
  iconEmoji?: string | null;
  currency?: DisplayCurrency;
  exchangeRate?: string | null;
  roundingMode?: YerRoundingMode;
}): string {
  const effectivePrice = params.promoPrice || params.retailPrice;
  const priceStr =
    params.currency === 'YER' && params.exchangeRate
      ? formatDisplayPrice({
          usdAmount: effectivePrice,
          currency: 'YER',
          exchangeRate: params.exchangeRate,
          roundingMode: params.roundingMode,
        })
      : `$${formatMoney(effectivePrice, 2)}`;
  const stockStr = `[${Math.max(0, Math.floor(params.availableQty))}]`;
  const emojiPrefix = params.iconEmoji ? `${params.iconEmoji} ` : '';
  const promoSuffix = params.promoPrice ? ' 🔥' : '';
  return `${emojiPrefix}${params.title} - ${priceStr} - ${stockStr}${promoSuffix}`;
}

export function buildCustomerDeliveryMessage(params: {
  storeName: string;
  orderNumber: string;
  productTitleAr: string;
  quantity: number;
  totalRetail: string;
  deliveredItems: string[];
  instructionsAr?: string;
  warrantyLabelAr: string;
  supportHandle?: string;
  lang?: SupportedLang;
  currency?: DisplayCurrency;
  exchangeRate?: string | null;
  roundingMode?: YerRoundingMode;
}): string {
  const lang = params.lang || 'ar';
  const safeItems = params.deliveredItems.map((item, idx) => `${idx + 1}. ${item}`).join('\n');
  const paidDisplay =
    params.currency === 'YER' && params.exchangeRate
      ? formatDisplayPrice({
          usdAmount: params.totalRetail,
          currency: 'YER',
          exchangeRate: params.exchangeRate,
          roundingMode: params.roundingMode,
        })
      : `${formatMoney(params.totalRetail, 2)} USDT`;

  if (lang === 'en') {
    const lines = [
      `✅ Order Completed Successfully — ${params.storeName}`,
      `Order Number: ${params.orderNumber}`,
      `Product: ${params.productTitleAr} (Qty: ${params.quantity})`,
      `Amount Paid: ${paidDisplay}`,
      '',
      '📦 Delivery Details:',
      safeItems || 'Preparing your delivery — you will be notified immediately.',
    ];
    if (params.instructionsAr) lines.push('', `📘 How to Use:\n${params.instructionsAr}`);
    if (params.warrantyLabelAr) lines.push('', `🛡️ Warranty: ${params.warrantyLabelAr}`);
    if (params.supportHandle) lines.push(`📞 Support: ${params.supportHandle}`);
    return lines.join('\n');
  }

  const lines = [
    `✅ تم تنفيذ طلبك بنجاح — ${params.storeName}`,
    `رقم الطلب: ${params.orderNumber}`,
    `المنتج: ${params.productTitleAr} (الكمية: ${params.quantity})`,
    `المبلغ المدفوع: ${paidDisplay}`,
    '',
    '📦 بيانات التسليم:',
    safeItems || 'جاري تجهيز التسليم وسيصلك إشعار فور اكتماله.',
  ];

  if (params.instructionsAr) {
    lines.push('', `📘 طريقة الاستخدام:\n${params.instructionsAr}`);
  }
  if (params.warrantyLabelAr) {
    lines.push('', `🛡️ الضمان: ${params.warrantyLabelAr}`);
  }
  if (params.supportHandle) {
    lines.push(`📞 للدعم الفني: ${params.supportHandle}`);
  }

  return lines.join('\n');
}

export function canUserAccessDelivery(deliveryOwnerUserId: number, requestingUserId: number, role: string): boolean {
  if (role === 'owner' || role === 'admin') return true;
  return deliveryOwnerUserId === requestingUserId;
}

export const CUSTOMER_PRESET_QUANTITIES = [1, 2, 3, 4, 5, 6] as const;

export type CustomQuantityValidationResult =
  | { ok: true; quantity: number }
  | { ok: false; reason: 'invalid_number' | 'too_low' | 'exceeds_stock'; requested?: number };

/**
 * Parses and validates manual customer quantity input (supports ASCII and Arabic-Indic digits).
 */
export function parseAndValidateCustomQuantity(
  rawInput: string,
  maxStock: number
): CustomQuantityValidationResult {
  const normalized = (rawInput || '')
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

  if (!/^-?\d+$/.test(normalized)) {
    return { ok: false, reason: 'invalid_number' };
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return { ok: false, reason: 'too_low', requested: parsed };
  }
  const effectiveCap = Math.max(0, Math.min(1000, Math.floor(maxStock || 0)));
  if (parsed > effectiveCap) {
    return { ok: false, reason: 'exceeds_stock', requested: parsed };
  }
  return { ok: true, quantity: parsed };
}

/**
 * Generates a clean preview transaction reference matching ORD-XXXXX-XXXX format.
 */
export function generatePreviewOrderCode(): string {
  const numPart = String(Math.floor(10000 + Math.random() * 90000));
  const hexPart = Math.floor(0x1000 + Math.random() * 0xefff)
    .toString(16)
    .toLowerCase();
  return `ORD-${numPart}-${hexPart}`;
}

/**
 * Builds the exact inline keyboard layout for ANY product detail screen:
 * Row 1: [ 1 ] [ 2 ] [ 3 ] (primary/blue)
 * Row 2: [ 4 ] [ 5 ] [ 6 ] (primary/blue)
 * Row 3: [ 📋 Custom Quantity ] (success/green, full width)
 * Row 4: [ ⬅️ Back to Products ] (primary/blue, full width)
 * Row 5: [ ⬅️ Back to Menu ] (primary/blue, full width)
 */
export function buildProductQuantityInlineKeyboard(params: {
  productId: number;
  backCallbackData: string;
  backSource: string;
  lang: SupportedLang;
}): CustomerInlineButton[][] {
  const { productId, backCallbackData, backSource, lang } = params;
  return [
    [1, 2, 3].map((q) => ({
      text: String(q),
      callbackData: `c:qty:${productId}:${q}:${backSource}`,
      style: 'primary' as const,
    })),
    [4, 5, 6].map((q) => ({
      text: String(q),
      callbackData: `c:qty:${productId}:${q}:${backSource}`,
      style: 'primary' as const,
    })),
    [
      {
        text: t(lang, 'btn_custom_quantity'),
        callbackData: `c:cqty:${productId}:${backSource}`,
        style: 'success' as const,
      },
    ],
    [
      {
        text: t(lang, 'btn_back_to_products'),
        callbackData: backCallbackData,
        style: 'primary' as const,
      },
    ],
    [
      {
        text: t(lang, 'btn_back_to_menu'),
        callbackData: 'c:home',
        style: 'primary' as const,
      },
    ],
  ];
}

/**
 * Formats the product detail card in clean plain text (guaranteed fallback & backward-compatible helper).
 */
export function formatProductPurchasePromptMessage(params: {
  categoryName: string;
  title: string;
  iconEmoji?: string | null;
  unitPrice: string;
  stock: number;
  description: string;
  durationLabel?: string;
  warrantyLabel?: string;
  lang: SupportedLang;
  currency?: DisplayCurrency;
  exchangeRate?: string | null;
  roundingMode?: YerRoundingMode;
}): string {
  const priceStr =
    params.currency === 'YER' && params.exchangeRate
      ? formatDisplayPrice({
          usdAmount: params.unitPrice,
          currency: 'YER',
          exchangeRate: params.exchangeRate,
          roundingMode: params.roundingMode,
        })
      : `$${formatMoney(params.unitPrice, 2)}`;
  const stockCount = Math.max(0, Math.floor(params.stock || 0));
  const badge = params.iconEmoji ? `${params.iconEmoji} ` : '✦ ';
  const headline = (params.categoryName || params.title).toUpperCase();
  const processedDesc = processSupplierProductDescription(params.description);
  const safeDescPlain = processedDesc.plainText;
  const rawDuration = (params.durationLabel || '').trim();
  const normalizedDuration =
    params.lang === 'en' && rawDuration === 'حسب الباقة' ? 'Per Plan' : rawDuration;
  const metaParts: string[] = [];
  if (normalizedDuration && !/duration:|المدة:/i.test(safeDescPlain)) {
    metaParts.push(params.lang === 'en' ? `[+] Duration: ${normalizedDuration}` : `[+] المدة: ${normalizedDuration}`);
  }
  if (params.warrantyLabel && !/warranty|الضمان/i.test(safeDescPlain)) {
    metaParts.push(params.lang === 'en' ? `[+] Warranty: ${params.warrantyLabel}` : `[+] الضمان: ${params.warrantyLabel}`);
  }

  const lines: string[] = [
    `${badge}${headline}`,
    '━━━━━━━━━━━━━━',
    params.title,
    '',
    params.lang === 'en' ? `💲 Price: ${priceStr}` : `💲 السعر: ${priceStr}`,
    params.lang === 'en' ? `📊 Stock: ${stockCount}` : `📊 المخزون: ${stockCount}`,
  ];

  if (safeDescPlain) {
    lines.push('', safeDescPlain);
  }
  if (metaParts.length > 0) {
    lines.push('', ...metaParts);
  }
  lines.push('', t(params.lang, 'choose_buy_quantity'));
  return lines.join('\n');
}

export interface TelegramFormattedProductPrompt {
  text: string;
  parseMode: 'HTML';
  htmlNoCustomEmojiFallback: string;
  plainFallbackText: string;
  hasHtmlFormatting: boolean;
  hasCustomEmoji: boolean;
}

/**
 * Formats the product detail card for Telegram Bot API with `parse_mode: "HTML"`:
 * - Renders supplier Telegram HTML (`<blockquote>`, `<b>`, `<i>`, `<u>`, `<s>`, `<code>`,
 *   `<pre>`, `<tg-spoiler>`, `<a href>`, `<tg-emoji emoji-id="...">`) faithfully.
 * - Escapes header, title, price, stock, and plain-text segments safely to prevent
 *   `Bad Request: can't parse entities` errors.
 * - Provides both `htmlNoCustomEmojiFallback` and `plainFallbackText` for guaranteed delivery.
 */
export function formatProductPurchasePromptTelegramPayload(params: {
  categoryName: string;
  title: string;
  iconEmoji?: string | null;
  unitPrice: string;
  stock: number;
  description: string;
  durationLabel?: string;
  warrantyLabel?: string;
  lang: SupportedLang;
  currency?: DisplayCurrency;
  exchangeRate?: string | null;
  roundingMode?: YerRoundingMode;
}): TelegramFormattedProductPrompt {
  const priceStr =
    params.currency === 'YER' && params.exchangeRate
      ? formatDisplayPrice({
          usdAmount: params.unitPrice,
          currency: 'YER',
          exchangeRate: params.exchangeRate,
          roundingMode: params.roundingMode,
        })
      : `$${formatMoney(params.unitPrice, 2)}`;
  const stockCount = Math.max(0, Math.floor(params.stock || 0));
  const badge = params.iconEmoji ? `${params.iconEmoji} ` : '✦ ';
  const headline = (params.categoryName || params.title).toUpperCase();
  const processed = processSupplierProductDescription(params.description, { maxVisibleChars: 3400 });
  const safeDescPlain = processed.plainText;

  const rawDuration = (params.durationLabel || '').trim();
  const normalizedDuration =
    params.lang === 'en' && rawDuration === 'حسب الباقة' ? 'Per Plan' : rawDuration;
  const metaParts: string[] = [];
  if (normalizedDuration && !/duration:|المدة:/i.test(safeDescPlain)) {
    metaParts.push(params.lang === 'en' ? `[+] Duration: ${normalizedDuration}` : `[+] المدة: ${normalizedDuration}`);
  }
  if (params.warrantyLabel && !/warranty|الضمان/i.test(safeDescPlain)) {
    metaParts.push(params.lang === 'en' ? `[+] Warranty: ${params.warrantyLabel}` : `[+] الضمان: ${params.warrantyLabel}`);
  }

  const buildHtml = (descHtml: string): string => {
    const lines: string[] = [
      `<b>${escapeTelegramHtml(`${badge}${headline}`)}</b>`,
      '━━━━━━━━━━━━━━',
      `<b>${escapeTelegramHtml(stripTelegramHtmlToPlainText(params.title))}</b>`,
      '',
      params.lang === 'en'
        ? `💲 Price: <b>${escapeTelegramHtml(priceStr)}</b>`
        : `💲 السعر: <b>${escapeTelegramHtml(priceStr)}</b>`,
      params.lang === 'en'
        ? `📊 Stock: <b>${stockCount}</b>`
        : `📊 المخزون: <b>${stockCount}</b>`,
    ];

    if (descHtml) {
      lines.push('', descHtml);
    }
    if (metaParts.length > 0) {
      lines.push('', ...metaParts.map((m) => escapeTelegramHtml(m)));
    }
    lines.push('', escapeTelegramHtml(t(params.lang, 'choose_buy_quantity')));
    return lines.join('\n');
  };

  const plainFallbackText = formatProductPurchasePromptMessage(params);

  return {
    text: buildHtml(processed.telegramHtml),
    parseMode: 'HTML',
    htmlNoCustomEmojiFallback: buildHtml(processed.telegramHtmlNoCustomEmoji),
    plainFallbackText,
    hasHtmlFormatting: processed.hasHtmlFormatting,
    hasCustomEmoji: processed.hasCustomEmoji,
  };
}

export function formatPurchaseConfirmationMessage(params: {
  orderRef: string;
  productTitle: string;
  iconEmoji?: string | null;
  quantity: number;
  unitPrice: string;
  currentBalance: string;
  lang: SupportedLang;
  currency?: DisplayCurrency;
  exchangeRate?: string | null;
  roundingMode?: YerRoundingMode;
}): {
  text: string;
  unitPriceFormatted: string;
  totalFormatted: string;
  balanceFormatted: string;
  afterPurchaseFormatted: string;
  hasSufficientBalance: boolean;
} {
  const unitDec = new Decimal(params.unitPrice || '0').toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const qty = Math.max(1, Math.floor(params.quantity || 1));
  const totalDec = unitDec.times(qty);
  const balanceDec = new Decimal(params.currentBalance || '0');
  const chargeEval = resolveEffectiveOrderChargeUsd({
    availableBalanceUsd: balanceDec,
    quotedTotalUsd: totalDec,
    preferredCurrency: params.currency,
    exchangeRate: params.exchangeRate,
    roundingMode: params.roundingMode,
  });
  const hasSufficientBalance = chargeEval.sufficient;
  const rawAfterDec = balanceDec.minus(
    hasSufficientBalance ? new Decimal(chargeEval.effectiveChargeUsd) : totalDec
  );
  const afterDec = rawAfterDec.isNegative() && rawAfterDec.abs().lt('0.005') ? new Decimal(0) : rawAfterDec;

  const unitPriceFormatted = unitDec.toFixed(2);
  const totalFormatted = totalDec.toFixed(2);
  const balanceFormatted = balanceDec.toFixed(2);
  const afterPurchaseFormatted = afterDec.toFixed(2);
  const prodPrefix = params.iconEmoji ? `${params.iconEmoji} ` : '✦ ';

  const isYer = params.currency === 'YER' && Boolean(params.exchangeRate);
  const fmtVal = (d: Decimal) =>
    isYer
      ? formatDisplayPrice({
          usdAmount: d,
          currency: 'YER',
          exchangeRate: params.exchangeRate,
          roundingMode: params.roundingMode,
        })
      : `$${d.toFixed(2)}`;

  const unitDisp = fmtVal(unitDec);
  const totalDisp = fmtVal(totalDec);
  const balDisp = fmtVal(balanceDec);
  const afterDisp = fmtVal(afterDec);

  const text =
    params.lang === 'en'
      ? [
          '🛒 CONFIRM PURCHASE',
          '',
          `🧾 Order ID: ${params.orderRef}`,
          `🏪 Product: ${prodPrefix}${params.productTitle}`,
          `🧮 Quantity: ${qty}`,
          `💲 Unit Price: ${unitDisp}`,
          `💰 Total: ${totalDisp}`,
          '',
          `💎 Your Balance: ${balDisp}`,
          `💎 After Purchase: ${afterDisp}`,
          '',
          'Confirm your purchase?',
        ].join('\n')
      : [
          '🛒 تأكيد الشراء',
          '',
          `🧾 رقم الطلب: ${params.orderRef}`,
          `🏪 المنتج: ${prodPrefix}${params.productTitle}`,
          `🧮 الكمية: ${qty}`,
          `💲 سعر الوحدة: ${unitDisp}`,
          `💰 الإجمالي: ${totalDisp}`,
          '',
          `💎 رصيدك الحالي: ${balDisp}`,
          `💎 الرصيد بعد الشراء: ${afterDisp}`,
          '',
          'هل تؤكد إتمام عملية الشراء؟',
        ].join('\n');

  return {
    text,
    unitPriceFormatted,
    totalFormatted,
    balanceFormatted,
    afterPurchaseFormatted,
    hasSufficientBalance,
  };
}

/**
 * Builds the 2 side-by-side confirmation buttons below the Transaction Message:
 * [ ✅ Confirm (green/success) ] [ ❌ Cancel (red/danger) ]
 */
export function buildPurchaseConfirmationInlineKeyboard(params: {
  productId: number;
  quantity: number;
  backSource: string;
  lang: SupportedLang;
}): CustomerInlineButton[][] {
  return [
    [
      {
        text: t(params.lang, 'btn_confirm'),
        callbackData: `c:buy:${params.productId}:${params.quantity}:${params.backSource}`,
        style: 'success',
      },
      {
        text: t(params.lang, 'btn_cancel_input'),
        callbackData: `c:cancel_buy:${params.productId}:${params.backSource}`,
        style: 'danger',
      },
    ],
  ];
}
