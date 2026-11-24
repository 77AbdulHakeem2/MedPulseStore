import crypto from 'node:crypto';
import Decimal from 'decimal.js';
import { asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  auditLogs,
  localDeposits,
  localWallets,
  notifications,
  settings,
  users,
  walletLedger,
  wallets,
} from '../db/schema.ts';
import { decryptSecret } from './crypto.ts';
import { buildSupportTelegramUrl } from './sanitizer.ts';
import {
  convertYerToUsd,
  fetchLiveYerExchangeRate,
  formatDisplayPrice,
  formatYerNumber,
  getCurrencyLocalDepositSettings,
  normalizeDisplayCurrency,
  saveCurrencyLocalDepositSettings,
  validateDepositorQuadName,
  validateLocalDepositAmountYer,
  type DisplayCurrency,
  type YerRoundingMode,
} from './currencyEngine.ts';
import type { SupportedLang } from '../i18n/index.ts';

export type LocalDepositStatus = 'pending_review' | 'approved' | 'rejected' | 'cancelled';

export const LOCAL_DEPOSIT_PRESET_AMOUNTS_YER = [1000, 2000, 3000, 4000, 5000] as const;

export const LOCAL_DEPOSIT_REJECTION_REASONS = [
  { code: 'unclear_proof', labelAr: 'صورة إثبات التحويل غير واضحة أو ناقصة', labelEn: 'Transfer proof screenshot is unclear or incomplete' },
  { code: 'amount_mismatch', labelAr: 'المبلغ المحول غير مطابق للمبلغ المطلوب', labelEn: 'Transferred amount does not match requested amount' },
  { code: 'not_received', labelAr: 'لم يصل التحويل إلى حساب المحفظة المحدد', labelEn: 'Transfer has not been received in the target wallet' },
  { code: 'sender_mismatch', labelAr: 'بيانات اسم المرسل غير مطابقة للحوالة', labelEn: 'Sender name does not match the transfer record' },
  { code: 'duplicate_proof', labelAr: 'إيصال التحويل مستخدم مسبقًا', labelEn: 'Transfer receipt was already used' },
] as const;

export const DEFAULT_LOCAL_REJECTION_REASON_AR =
  'لم نتمكن من مطابقة تفاصيل التحويل المرفقة. يرجى مراجعة البيانات أو التواصل مع الدعم الفني.';

const MAX_PROOF_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Pure state machine validator: prevents duplicate approvals, double credits,
 * approving rejected deposits, or rejecting already-approved deposits.
 */
export function canTransitionLocalDeposit(
  currentStatus: string,
  action: 'approve' | 'reject' | 'cancel'
): { allowed: boolean; reason?: string } {
  if (currentStatus === 'pending_review') {
    return { allowed: true };
  }
  if (currentStatus === 'approved') {
    return { allowed: false, reason: 'ALREADY_APPROVED' };
  }
  if (currentStatus === 'rejected') {
    return { allowed: false, reason: 'ALREADY_REJECTED' };
  }
  return { allowed: false, reason: 'INVALID_STATUS' };
}

/**
 * Validates proof image data URL (web/simulator uploads).
 * Strictly allows only image/jpeg, image/png, image/webp (blocks SVG/HTML/JS XSS).
 */
export function validateProofImageDataUrl(raw?: string | null): {
  ok: boolean;
  mime?: string;
  sizeBytes?: number;
  errorAr?: string;
} {
  const val = String(raw || '').trim();
  if (!val) return { ok: false, errorAr: 'يرجى إرفاق صورة واضحة لإثبات التحويل.' };

  const match = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(val);
  if (!match) {
    return {
      ok: false,
      errorAr: 'صيغة الصورة غير مدعومة. يرجى رفع صورة بصيغة JPG أو PNG أو WEBP فقط.',
    };
  }
  const mime = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const base64Clean = match[2].replace(/\s+/g, '');
  const sizeBytes = Math.floor((base64Clean.length * 3) / 4);
  if (sizeBytes < 200) {
    return { ok: false, errorAr: 'ملف الصورة فارغ أو تالف. يرجى رفع لقطة شاشة واضحة للتحويل.' };
  }
  if (sizeBytes > MAX_PROOF_IMAGE_BYTES) {
    return { ok: false, errorAr: 'حجم الصورة يتجاوز الحد الأقصى المسموح به (5 ميجابايت).' };
  }
  return { ok: true, mime, sizeBytes };
}

export function generateLocalDepositRef(): string {
  const year = new Date().getUTCFullYear();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `LDEP-${year}-${rand}`;
}

export function formatUtcTimestamp(dt: Date | string): string {
  const d = dt instanceof Date ? dt : new Date(dt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

/**
 * Pure formatter for the Admin Review Telegram Channel post (pending review).
 * Includes every required detail clearly structured for fast manual verification.
 */
export function formatAdminChannelDepositCaption(params: {
  depositRef: string;
  username?: string | null;
  telegramUserId?: string | null;
  userDisplayName: string;
  depositorNameUsed: string;
  depositorNameIsTemporary: boolean;
  walletName: string;
  recipientAccount: string;
  senderWalletNumber?: string | null;
  amountYer: string | number;
  equivalentUsd: string | number;
  exchangeRateUsed: string | number;
  exchangeRateMarket: string;
  createdAt: Date | string;
}): string {
  const userHandle = params.username
    ? `@${params.username.replace(/^@+/, '')}`
    : params.userDisplayName || 'غير متوفر';
  const tgId = params.telegramUserId || 'WEB';
  const directLink = params.username
    ? `https://t.me/${params.username.replace(/^@+/, '')}`
    : params.telegramUserId && /^\d+$/.test(params.telegramUserId)
    ? `tg://user?id=${params.telegramUserId}`
    : 'غير متوفر';
  const tempBadge = params.depositorNameIsTemporary
    ? ' (اسم مؤقت لهذه العملية فقط)'
    : ' (الاسم الدائم المحفوظ)';
  const marketLabel = params.exchangeRateMarket === 'aden' ? 'عدن' : 'صنعاء';

  const lines = [
    '📥 طلب إيداع محلي جديد — بانتظار المراجعة',
    '━━━━━━━━━━━━━━━━━━━━',
    `🧾 رقم العملية: ${params.depositRef}`,
    `👤 اسم المستخدم: ${userHandle}`,
    `🆔 Telegram ID: ${tgId}`,
    `🔗 رابط المستخدم: ${directLink}`,
    `🪪 اسم المودع الرباعي: ${params.depositorNameUsed}${tempBadge}`,
    `🏦 المحفظة المختارة: ${params.walletName} (${params.recipientAccount})`,
  ];

  if (params.senderWalletNumber && params.senderWalletNumber.trim()) {
    lines.push(`📱 رقم محفظة المرسل: ${params.senderWalletNumber.trim()}`);
  }

  lines.push(
    `💰 المبلغ بالريال اليمني: ${formatYerNumber(params.amountYer)}`,
    `💵 المعادل بالدولار: $${new Decimal(params.equivalentUsd).toFixed(2)} (${new Decimal(params.equivalentUsd).toFixed(4)} USD)`,
    `💱 سعر الصرف المعتمد: 1$ = ${new Decimal(params.exchangeRateUsed).toFixed(2)} ﷼ (${marketLabel})`,
    `🕒 وقت الإرسال: ${formatUtcTimestamp(params.createdAt)}`,
    `📌 الحالة: ⏳ قيد المراجعة`
  );

  return lines.join('\n');
}

/**
 * Pure formatter for the updated Admin Review Channel post after Approval or Rejection.
 */
export function formatAdminChannelReviewedCaption(params: {
  depositRef: string;
  username?: string | null;
  telegramUserId?: string | null;
  userDisplayName: string;
  depositorNameUsed: string;
  depositorNameIsTemporary: boolean;
  walletName: string;
  recipientAccount: string;
  senderWalletNumber?: string | null;
  amountYer: string | number;
  equivalentUsd: string | number;
  exchangeRateUsed: string | number;
  exchangeRateMarket: string;
  createdAt: Date | string;
  decision: 'approved' | 'rejected';
  reviewerName: string;
  reviewedAt: Date | string;
  rejectionReason?: string | null;
}): string {
  const base = formatAdminChannelDepositCaption(params).replace(
    '📥 طلب إيداع محلي جديد — بانتظار المراجعة',
    params.decision === 'approved'
      ? '✅ طلب إيداع محلي — تمت الموافقة'
      : '❌ طلب إيداع محلي — مرفوض'
  );

  const withoutPending = base.replace('📌 الحالة: ⏳ قيد المراجعة', '').trimEnd();

  const footer =
    params.decision === 'approved'
      ? [
          `📌 الحالة: ✅ تمت الموافقة وإضافة الرصيد`,
          `👮 بواسطة المسؤول: ${params.reviewerName}`,
          `🕒 وقت الاعتماد: ${formatUtcTimestamp(params.reviewedAt)}`,
        ]
      : [
          `📌 الحالة: ❌ مرفوض`,
          `👮 بواسطة المسؤول: ${params.reviewerName}`,
          `📝 سبب الرفض: ${params.rejectionReason || DEFAULT_LOCAL_REJECTION_REASON_AR}`,
          `🕒 وقت الرفض: ${formatUtcTimestamp(params.reviewedAt)}`,
        ];

  return `${withoutPending}\n${footer.join('\n')}`;
}

/**
 * Pure formatter for User Approval Notification (respects user's preferred currency!).
 */
export function formatUserLocalDepositApprovedMessage(params: {
  lang: SupportedLang;
  preferredCurrency: DisplayCurrency;
  amountYer: string | number;
  equivalentUsd: string | number;
  newBalanceUsd: string | number;
  exchangeRateUsed: string | number;
  roundingMode?: YerRoundingMode;
  depositRef: string;
}): string {
  const addedDisplay =
    params.preferredCurrency === 'YER'
      ? formatYerNumber(params.amountYer)
      : `$${new Decimal(params.equivalentUsd).toFixed(2)}`;
  const balanceDisplay = formatDisplayPrice({
    usdAmount: params.newBalanceUsd,
    currency: params.preferredCurrency,
    exchangeRate: params.exchangeRateUsed,
    roundingMode: params.roundingMode || 'nearest_10',
    usdStyle: 'dollar',
  });

  if (params.lang === 'en') {
    return [
      '✅ Your Deposit Has Been Credited Successfully',
      '',
      `💰 Amount Added: ${addedDisplay}`,
      `💳 Current Balance: ${balanceDisplay}`,
      `🧾 Reference: ${params.depositRef}`,
    ].join('\n');
  }

  return [
    '✅ تم إيداع رصيدك بنجاح',
    '',
    `💰 المبلغ المضاف: ${addedDisplay}`,
    `💳 رصيدك الحالي: ${balanceDisplay}`,
    `🧾 رقم العملية: ${params.depositRef}`,
  ].join('\n');
}

/**
 * Pure formatter for User Rejection Notification (with reason + support button).
 */
export function formatUserLocalDepositRejectedMessage(params: {
  lang: SupportedLang;
  reason: string;
  depositRef: string;
}): string {
  const safeReason = (params.reason || '').trim() || DEFAULT_LOCAL_REJECTION_REASON_AR;
  if (params.lang === 'en') {
    return [
      '❌ Deposit Request Rejected',
      `Your deposit request (${params.depositRef}) could not be approved.`,
      '',
      `Reason: ${safeReason}`,
    ].join('\n');
  }

  return [
    '❌ تعذر قبول عملية الإيداع',
    `لم يتم اعتماد طلب الإيداع الخاص بك (${params.depositRef})، وذلك بسبب: ${safeReason}`,
  ].join('\n');
}

// ============================================================================
// TELEGRAM BOT API LOW-LEVEL HELPERS (NO CIRCULAR DEPENDENCY)
// ============================================================================

async function resolveBotTokenOnly(): Promise<string> {
  try {
    const [row] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, 'telegram_bot_config'))
      .limit(1);
    const stored = (row?.valueJson as Record<string, any>) || {};
    if (stored.encryptedBotToken) {
      const dec = decryptSecret(stored.encryptedBotToken);
      if (dec) return dec.trim();
    }
  } catch {
    // fall through
  }
  return (process.env.TELEGRAM_BOT_TOKEN || '').trim();
}

async function getStoreSupportHandle(): Promise<string> {
  try {
    const [row] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, 'store_profile'))
      .limit(1);
    const prof = (row?.valueJson as Record<string, any>) || {};
    return String(prof.supportHandle || '@raqm_support').trim();
  } catch {
    return '@raqm_support';
  }
}

async function callTelegramApi(
  token: string,
  method: string,
  body: Record<string, any> | FormData
): Promise<{ ok: boolean; result?: any; description?: string }> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: isForm ? undefined : { 'Content-Type': 'application/json' },
      body: isForm ? body : JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    return data;
  } catch (err: any) {
    clearTimeout(timer);
    return { ok: false, description: err?.message || 'Network error' };
  }
}

/**
 * Strips invisible Unicode BiDi / zero-width characters often injected when copying IDs from RTL Telegram clients
 * and converts Arabic/Persian numerals to ASCII digits.
 */
function cleanChannelInputString(raw: string): string {
  return String(raw || '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .trim();
}

/**
 * Pure helper: normalizes any Telegram Channel/Group ID, @username, or t.me link
 * into an ordered list of canonical Telegram `chat_id` candidates.
 */
export function buildTelegramChannelCandidates(rawInput: string): {
  ok: boolean;
  cleaned: string;
  candidates: string[];
  errorAr?: string;
} {
  const cleaned = cleanChannelInputString(rawInput);
  if (!cleaned) {
    return {
      ok: false,
      cleaned: '',
      candidates: [],
      errorAr: 'يرجى إدخال معرّف القناة (مثل -100xxxxxxxxxx أو @username أو رابط رسالة من القناة t.me/c/...).',
    };
  }

  // Reject private invite links explicitly with helpful guidance
  if (/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)/i.test(cleaned)) {
    return {
      ok: false,
      cleaned,
      candidates: [],
      errorAr:
        'لا يدعم تيليجرام روابط الدعوة الخاصة (t.me/+...). يرجى إدخال معرّف القناة الرقمي (-100xxxxxxxxxx) أو نسخ رابط أي رسالة داخل القناة (مثل t.me/c/1234567890/1) أو اسم المستخدم العام (@username).',
    };
  }

  // Private channel message link: https://t.me/c/<digits>/<msg_id> -> -100<digits>
  const privateLinkMatch = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/c\/(\d+)(?:\/\d+)*\/?$/i.exec(cleaned);
  if (privateLinkMatch) {
    const id = `-100${privateLinkMatch[1]}`;
    return { ok: true, cleaned: id, candidates: [id] };
  }

  // Public channel link: https://t.me/<username>(/<msg_id>)? -> @<username>
  const publicLinkMatch = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,})(?:\/\d+)?\/?$/i.exec(
    cleaned
  );
  if (publicLinkMatch) {
    const handle = `@${publicLinkMatch[1]}`;
    return { ok: true, cleaned: handle, candidates: [handle] };
  }

  // Explicit @username
  if (/^@[A-Za-z][A-Za-z0-9_]{3,}$/.test(cleaned)) {
    return { ok: true, cleaned, candidates: [cleaned] };
  }

  // Bare username without @
  if (/^[A-Za-z][A-Za-z0-9_]{3,}$/.test(cleaned)) {
    const handle = `@${cleaned}`;
    return { ok: true, cleaned: handle, candidates: [handle] };
  }

  // Numeric channel/group IDs (remove internal spaces)
  const numericCompact = cleaned.replace(/\s+/g, '');
  if (/^-100\d{5,}$/.test(numericCompact)) {
    return { ok: true, cleaned: numericCompact, candidates: [numericCompact] };
  }
  if (/^-\d{5,}$/.test(numericCompact)) {
    const digits = numericCompact.slice(1);
    return {
      ok: true,
      cleaned: numericCompact,
      candidates: [numericCompact, `-100${digits}`],
    };
  }
  if (/^\d{5,}$/.test(numericCompact)) {
    const candidates: string[] = [];
    // If user copied 100xxxxxxxxxx without the leading minus sign
    if (numericCompact.startsWith('100') && numericCompact.length >= 11) {
      candidates.push(`-${numericCompact}`);
    }
    const withMinus100 = `-100${numericCompact}`;
    if (!candidates.includes(withMinus100)) candidates.push(withMinus100);
    const withMinus = `-${numericCompact}`;
    if (!candidates.includes(withMinus)) candidates.push(withMinus);
    candidates.push(numericCompact);
    return { ok: true, cleaned: numericCompact, candidates };
  }

  return {
    ok: false,
    cleaned,
    candidates: [],
    errorAr:
      'صيغة معرّف القناة غير صحيحة. أدخل المعرّف الرقمي مثل -1001234567890 أو اسم القناة @channel_name أو رابط رسالة من القناة.',
  };
}

/**
 * Pure helper: evaluates Telegram chat type and bot ChatMember permissions for deposit review dispatch.
 */
export function evaluateTelegramChannelPermissions(params: {
  chatType: string;
  chatTitle: string;
  botUsername?: string;
  memberStatus: string;
  canPostMessages?: boolean;
  canSendMessages?: boolean;
  canEditMessages?: boolean;
}): {
  ok: boolean;
  messageAr: string;
  warningAr?: string;
} {
  const botRef = params.botUsername ? `@${params.botUsername}` : 'البوت';
  const title = params.chatTitle || 'القناة';

  if (params.chatType === 'private') {
    return {
      ok: false,
      messageAr:
        'المعرّف المُدخل يعود إلى حساب مستخدم شخصي وليس قناة أو مجموعة. يرجى إدخال معرّف قناة المراجعة (-100xxxxxxxxxx) أو رابط رسالة داخل القناة (t.me/c/...).',
    };
  }

  const isAdmin = params.memberStatus === 'administrator' || params.memberStatus === 'creator';
  if (params.chatType === 'channel') {
    const canPost = params.memberStatus === 'creator' || params.canPostMessages === true;
    if (!isAdmin || !canPost) {
      return {
        ok: false,
        messageAr: `البوت (${botRef}) موجود في القناة «${title}» لكنه لا يملك صلاحية المسؤول أو نشر الرسائل (Post Messages). قم بترقيته كمسؤول وتفعيل صلاحية «نشر الرسائل».`,
      };
    }
    const warningAr =
      params.memberStatus !== 'creator' && params.canEditMessages === false
        ? 'ملاحظة: يفضّل أيضًا تفعيل صلاحية «تعديل الرسائل» للبوت ليتمكن من تحديث حالة الإيداع بعد الموافقة أو الرفض.'
        : undefined;
    return {
      ok: true,
      messageAr: `✅ تم التحقق بنجاح! البوت (${botRef}) مسؤول في قناة «${title}» ويملك صلاحية إرسال الصور والرسائل والأزرار التفاعلية.`,
      warningAr,
    };
  }

  // Group / Supergroup support
  if (params.chatType === 'supergroup' || params.chatType === 'group') {
    if (!isAdmin) {
      return {
        ok: false,
        messageAr: `البوت (${botRef}) عضو عادي في المجموعة «${title}». يرجى ترقيته كمسؤول (Admin) لضمان إرسال صور الإيداعات وتحديث حالتها دون قيود.`,
      };
    }
    if (params.canSendMessages === false) {
      return {
        ok: false,
        messageAr: `البوت (${botRef}) مقيد من إرسال الرسائل في المجموعة «${title}». يرجى منحه صلاحية إرسال الرسائل والوسائط.`,
      };
    }
    return {
      ok: true,
      messageAr: `✅ تم التحقق بنجاح! البوت (${botRef}) مسؤول في مجموعة المراجعة «${title}» وجاهز لاستقبال صور الإيداعات وأزرار القرار.`,
    };
  }

  return {
    ok: false,
    messageAr: `نوع المحادثة (${params.chatType || 'غير معروف'}) غير مدعوم كقناة مراجعة إدارية.`,
  };
}

/**
 * Verifies that the configured Telegram Review Channel exists and the bot is an admin
 * with permissions to post messages/photos. Automatically resolves raw IDs, t.me/c links, and @usernames.
 */
export async function verifyTelegramReviewChannel(channelIdRaw: string): Promise<{
  ok: boolean;
  channelId: string;
  channelTitle?: string;
  channelType?: string;
  botUsername?: string;
  warningAr?: string;
  messageAr: string;
}> {
  const parsed = buildTelegramChannelCandidates(channelIdRaw);
  if (!parsed.ok || parsed.candidates.length === 0) {
    return {
      ok: false,
      channelId: parsed.cleaned,
      messageAr: parsed.errorAr || 'يرجى إدخال معرّف القناة (مثل @channel أو -100xxxxxxxxxx).',
    };
  }

  const token = await resolveBotTokenOnly();
  if (!token) {
    return {
      ok: false,
      channelId: parsed.cleaned,
      messageAr: 'لم يتم ربط توكن بوت تيليجرام بعد. قم بضبط البوت من قسم «بوت الإدارة والعملاء» أولًا.',
    };
  }

  const meRes = await callTelegramApi(token, 'getMe', {});
  if (!meRes.ok || !meRes.result?.id) {
    return {
      ok: false,
      channelId: parsed.cleaned,
      messageAr: `تعذر التحقق من البوت: ${meRes.description || 'توكن غير صالح'}`,
    };
  }
  const botId = meRes.result.id;
  const botUsername = String(meRes.result.username || '').trim();

  // Try each normalized candidate until Telegram resolves a valid channel/group
  let chatRes: { ok: boolean; result?: any; description?: string } = { ok: false };
  let matchedCandidate = parsed.candidates[0];
  let lastErrorDesc = '';
  for (const candidate of parsed.candidates) {
    const attempt = await callTelegramApi(token, 'getChat', { chat_id: candidate });
    if (attempt.ok && attempt.result) {
      // If a raw positive ID accidentally matched a private user chat, prefer a channel/group candidate if one exists
      if (attempt.result.type === 'private' && parsed.candidates.length > 1 && candidate !== parsed.candidates[0]) {
        chatRes = attempt;
        matchedCandidate = candidate;
        continue;
      }
      chatRes = attempt;
      matchedCandidate = candidate;
      break;
    }
    if (attempt.description && !lastErrorDesc) {
      lastErrorDesc = attempt.description;
    }
  }

  if (!chatRes.ok || !chatRes.result) {
    const botHint = botUsername ? `@${botUsername}` : 'البوت';
    await saveCurrencyLocalDepositSettings({
      reviewChannelId: parsed.cleaned,
      reviewChannelVerified: false,
      reviewChannelVerifiedAt: null,
    });
    const extraHint = /^\d{5,}$/.test(parsed.cleaned)
      ? ` (جرّبنا تلقائيًا -100${parsed.cleaned} و -${parsed.cleaned} أيضًا، وتأكد من إضافة ${botHint} كمسؤول داخل القناة ثم نسخ رابط رسالة منها مثل t.me/c/... أو المعرّف الصحيح).`
      : ` — تأكد من إضافة البوت (${botHint}) كمسؤول داخل القناة وصحة المعرّف.`;
    return {
      ok: false,
      channelId: parsed.cleaned,
      botUsername,
      messageAr: `تعذر الوصول إلى القناة (${lastErrorDesc || 'chat not found'})${extraHint}`,
    };
  }

  const canonicalChatId = String(chatRes.result.id || matchedCandidate);
  const chatType = String(chatRes.result.type || '');
  const title = String(chatRes.result.title || chatRes.result.username || canonicalChatId);

  if (chatType === 'private') {
    await saveCurrencyLocalDepositSettings({
      reviewChannelId: parsed.cleaned,
      reviewChannelVerified: false,
      reviewChannelVerifiedAt: null,
    });
    const evalRes = evaluateTelegramChannelPermissions({
      chatType,
      chatTitle: title,
      botUsername,
      memberStatus: 'member',
    });
    return {
      ok: false,
      channelId: parsed.cleaned,
      channelTitle: title,
      channelType: chatType,
      botUsername,
      messageAr: evalRes.messageAr,
    };
  }

  const memberRes = await callTelegramApi(token, 'getChatMember', {
    chat_id: canonicalChatId,
    user_id: botId,
  });

  if (!memberRes.ok || !memberRes.result) {
    await saveCurrencyLocalDepositSettings({
      reviewChannelId: canonicalChatId,
      reviewChannelTitle: title,
      reviewChannelVerified: false,
      reviewChannelVerifiedAt: null,
    });
    return {
      ok: false,
      channelId: canonicalChatId,
      channelTitle: title,
      channelType: chatType,
      botUsername,
      messageAr: `تم العثور على «${title}» لكن تعذر فحص صلاحيات البوت (${memberRes.description || 'تأكد أن البوت مضاف كمسؤول في القناة'}).`,
    };
  }

  const member = memberRes.result;
  const evalRes = evaluateTelegramChannelPermissions({
    chatType,
    chatTitle: title,
    botUsername,
    memberStatus: String(member.status || ''),
    canPostMessages: member.can_post_messages,
    canSendMessages: member.can_send_messages,
    canEditMessages: member.can_edit_messages,
  });

  if (!evalRes.ok) {
    await saveCurrencyLocalDepositSettings({
      reviewChannelId: canonicalChatId,
      reviewChannelTitle: title,
      reviewChannelVerified: false,
      reviewChannelVerifiedAt: null,
    });
    return {
      ok: false,
      channelId: canonicalChatId,
      channelTitle: title,
      channelType: chatType,
      botUsername,
      messageAr: evalRes.messageAr,
    };
  }

  await saveCurrencyLocalDepositSettings({
    reviewChannelId: canonicalChatId,
    reviewChannelTitle: title,
    reviewChannelVerified: true,
    reviewChannelVerifiedAt: new Date().toISOString(),
  });

  return {
    ok: true,
    channelId: canonicalChatId,
    channelTitle: title,
    channelType: chatType,
    botUsername,
    warningAr: evalRes.warningAr,
    messageAr: evalRes.messageAr,
  };
}

/**
 * Fetches raw image bytes for a Telegram file_id via authenticated backend proxy
 * (NEVER exposes bot token to client browsers).
 */
export async function fetchTelegramProofFileBytes(fileId: string): Promise<{
  ok: boolean;
  buffer?: Buffer;
  contentType?: string;
}> {
  const token = await resolveBotTokenOnly();
  if (!token || !fileId) return { ok: false };

  const fileInfo = await callTelegramApi(token, 'getFile', { file_id: fileId });
  const filePath = fileInfo?.result?.file_path;
  if (!fileInfo.ok || !filePath || typeof filePath !== 'string') {
    return { ok: false };
  }

  const downloadUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const res = await fetch(downloadUrl);
  if (!res.ok) return { ok: false };
  const arr = await res.arrayBuffer();
  const ext = filePath.toLowerCase();
  const contentType = ext.endsWith('.png')
    ? 'image/png'
    : ext.endsWith('.webp')
    ? 'image/webp'
    : 'image/jpeg';
  return { ok: true, buffer: Buffer.from(arr), contentType };
}

async function dispatchDepositToAdminChannel(params: {
  depositId: number;
  caption: string;
  proofTelegramFileId?: string | null;
  proofImageDataUrl?: string | null;
}): Promise<{ dispatched: boolean; chatId?: string; messageId?: string; error?: string }> {
  const cfg = await getCurrencyLocalDepositSettings();
  if (!cfg.reviewChannelId) {
    return { dispatched: false, error: 'REVIEW_CHANNEL_NOT_CONFIGURED' };
  }
  const parsedChannel = buildTelegramChannelCandidates(cfg.reviewChannelId);
  const targetChatId = parsedChannel.candidates[0] || cfg.reviewChannelId.trim();
  const token = await resolveBotTokenOnly();
  if (!token) {
    return { dispatched: false, error: 'BOT_TOKEN_NOT_CONFIGURED' };
  }

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: '✅ موافقة على الإيداع', callback_data: `adm_ch:approve_local:${params.depositId}` },
        { text: '❌ رفض الإيداع', callback_data: `adm_ch:reject_local:${params.depositId}` },
      ],
    ],
  };

  // Truncate caption safely to Telegram's 1024-char photo caption limit
  const safeCaption = params.caption.slice(0, 1020);

  if (params.proofTelegramFileId) {
    const res = await callTelegramApi(token, 'sendPhoto', {
      chat_id: targetChatId,
      photo: params.proofTelegramFileId,
      caption: safeCaption,
      reply_markup: replyMarkup,
    });
    if (res.ok && res.result?.message_id) {
      return {
        dispatched: true,
        chatId: String(res.result.chat?.id || targetChatId),
        messageId: String(res.result.message_id),
      };
    }
    return { dispatched: false, error: res.description || 'sendPhoto failed' };
  }

  if (params.proofImageDataUrl) {
    const match = /^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/i.exec(params.proofImageDataUrl);
    if (match) {
      const mime = match[1];
      const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
      const buf = Buffer.from(match[2], 'base64');
      const form = new FormData();
      form.append('chat_id', targetChatId);
      form.append('caption', safeCaption);
      form.append('reply_markup', JSON.stringify(replyMarkup));
      form.append('photo', new Blob([buf], { type: mime }), `proof-${params.depositId}.${ext}`);
      const res = await callTelegramApi(token, 'sendPhoto', form);
      if (res.ok && res.result?.message_id) {
        return {
          dispatched: true,
          chatId: String(res.result.chat?.id || targetChatId),
          messageId: String(res.result.message_id),
        };
      }
      return { dispatched: false, error: res.description || 'sendPhoto upload failed' };
    }
  }

  // Fallback message if no photo binary
  const res = await callTelegramApi(token, 'sendMessage', {
    chat_id: targetChatId,
    text: safeCaption,
    reply_markup: replyMarkup,
  });
  if (res.ok && res.result?.message_id) {
    return {
      dispatched: true,
      chatId: String(res.result.chat?.id || targetChatId),
      messageId: String(res.result.message_id),
    };
  }
  return { dispatched: false, error: res.description || 'sendMessage failed' };
}

async function updateAdminChannelMessageAfterReview(params: {
  chatId?: string | null;
  messageId?: string | null;
  hasPhoto: boolean;
  caption: string;
}): Promise<void> {
  if (!params.chatId || !params.messageId) return;
  const token = await resolveBotTokenOnly();
  if (!token) return;

  const safeCaption = params.caption.slice(0, 1020);
  if (params.hasPhoto) {
    await callTelegramApi(token, 'editMessageCaption', {
      chat_id: params.chatId,
      message_id: Number(params.messageId),
      caption: safeCaption,
      reply_markup: { inline_keyboard: [] },
    });
  } else {
    await callTelegramApi(token, 'editMessageText', {
      chat_id: params.chatId,
      message_id: Number(params.messageId),
      text: safeCaption,
      reply_markup: { inline_keyboard: [] },
    });
  }
}

async function notifyTelegramCustomerDirect(params: {
  telegramUserId?: string | null;
  text: string;
  inlineKeyboard?: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
}): Promise<void> {
  if (!params.telegramUserId || !/^\d+$/.test(params.telegramUserId)) return;
  const token = await resolveBotTokenOnly();
  if (!token) return;
  await callTelegramApi(token, 'sendMessage', {
    chat_id: params.telegramUserId,
    text: params.text,
    ...(params.inlineKeyboard ? { reply_markup: { inline_keyboard: params.inlineKeyboard } } : {}),
  });
}

// ============================================================================
// LOCAL WALLETS CRUD
// ============================================================================

export async function listLocalWallets(options?: { onlyEnabled?: boolean }) {
  const query = options?.onlyEnabled
    ? db
        .select()
        .from(localWallets)
        .where(eq(localWallets.isEnabled, true))
        .orderBy(asc(localWallets.sortOrder), asc(localWallets.id))
    : db
        .select()
        .from(localWallets)
        .orderBy(asc(localWallets.sortOrder), asc(localWallets.id));
  return query;
}

export async function createLocalWallet(input: {
  nameAr: string;
  nameEn?: string;
  accountNumber: string;
  accountHolderName: string;
  instructionsAr?: string;
  instructionsEn?: string;
  logoUrl?: string;
  minAmountYer?: number | null;
  maxAmountYer?: number | null;
  isEnabled?: boolean;
  sortOrder?: number;
}) {
  const nameAr = String(input.nameAr || '').trim();
  const accountNumber = String(input.accountNumber || '').trim();
  const accountHolderName = String(input.accountHolderName || '').trim();
  if (!nameAr || !accountNumber || !accountHolderName) {
    throw new Error('اسم المحفظة ورقم الحساب واسم المستلم مطلوبة.');
  }

  const slugBase = nameAr
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  const code = `lw_${slugBase || 'wallet'}_${crypto.randomBytes(2).toString('hex')}`;

  const [created] = await db
    .insert(localWallets)
    .values({
      code,
      nameAr,
      nameEn: String(input.nameEn || '').trim() || nameAr,
      accountNumber,
      accountHolderName,
      instructionsAr: String(input.instructionsAr || '').trim(),
      instructionsEn: String(input.instructionsEn || '').trim(),
      logoUrl: sanitizeOptionalLogoUrl(input.logoUrl),
      minAmountYer:
        input.minAmountYer !== undefined && input.minAmountYer !== null && Number(input.minAmountYer) > 0
          ? new Decimal(input.minAmountYer).toFixed(2)
          : null,
      maxAmountYer:
        input.maxAmountYer !== undefined && input.maxAmountYer !== null && Number(input.maxAmountYer) > 0
          ? new Decimal(input.maxAmountYer).toFixed(2)
          : null,
      isEnabled: input.isEnabled !== false,
      sortOrder: Number.isFinite(Number(input.sortOrder)) ? Number(input.sortOrder) : 10,
      updatedAt: new Date(),
    })
    .returning();

  return created;
}

export async function updateLocalWallet(
  walletId: number,
  patch: Partial<{
    nameAr: string;
    nameEn: string;
    accountNumber: string;
    accountHolderName: string;
    instructionsAr: string;
    instructionsEn: string;
    logoUrl: string;
    minAmountYer: number | null;
    maxAmountYer: number | null;
    isEnabled: boolean;
    sortOrder: number;
  }>
) {
  const updateSet: Record<string, any> = { updatedAt: new Date() };
  if (patch.nameAr !== undefined) updateSet.nameAr = String(patch.nameAr).trim();
  if (patch.nameEn !== undefined) updateSet.nameEn = String(patch.nameEn).trim();
  if (patch.accountNumber !== undefined) updateSet.accountNumber = String(patch.accountNumber).trim();
  if (patch.accountHolderName !== undefined)
    updateSet.accountHolderName = String(patch.accountHolderName).trim();
  if (patch.instructionsAr !== undefined) updateSet.instructionsAr = String(patch.instructionsAr).trim();
  if (patch.instructionsEn !== undefined) updateSet.instructionsEn = String(patch.instructionsEn).trim();
  if (patch.logoUrl !== undefined) updateSet.logoUrl = sanitizeOptionalLogoUrl(patch.logoUrl);
  if (patch.minAmountYer !== undefined) {
    updateSet.minAmountYer =
      patch.minAmountYer !== null && Number(patch.minAmountYer) > 0
        ? new Decimal(patch.minAmountYer).toFixed(2)
        : null;
  }
  if (patch.maxAmountYer !== undefined) {
    updateSet.maxAmountYer =
      patch.maxAmountYer !== null && Number(patch.maxAmountYer) > 0
        ? new Decimal(patch.maxAmountYer).toFixed(2)
        : null;
  }
  if (typeof patch.isEnabled === 'boolean') updateSet.isEnabled = patch.isEnabled;
  if (patch.sortOrder !== undefined && Number.isFinite(Number(patch.sortOrder))) {
    updateSet.sortOrder = Math.floor(Number(patch.sortOrder));
  }

  const [updated] = await db
    .update(localWallets)
    .set(updateSet)
    .where(eq(localWallets.id, walletId))
    .returning();
  return updated || null;
}

export async function deleteLocalWallet(walletId: number): Promise<boolean> {
  const deleted = await db
    .delete(localWallets)
    .where(eq(localWallets.id, walletId))
    .returning({ id: localWallets.id });
  return deleted.length > 0;
}

export async function reorderLocalWallets(orderedIds: number[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(localWallets)
        .set({ sortOrder: (i + 1) * 10, updatedAt: new Date() })
        .where(eq(localWallets.id, orderedIds[i]));
    }
  });
}

function sanitizeOptionalLogoUrl(raw?: string | null): string {
  const val = String(raw || '').trim();
  if (!val) return '';
  if (/^https?:\/\//i.test(val)) return val.slice(0, 500);
  return '';
}

// ============================================================================
// CORE TRANSACTIONAL LOCAL DEPOSIT LIFECYCLE
// ============================================================================

export async function createLocalDepositRequest(params: {
  userId: number;
  localWalletId: number;
  amountYer: string | number;
  depositorNameUsed: string;
  depositorNameIsTemporary: boolean;
  saveDepositorNameAsPermanent?: boolean;
  senderWalletNumber?: string;
  proofTelegramFileId?: string | null;
  proofImageDataUrl?: string | null;
  proofCaption?: string;
}): Promise<{
  ok: boolean;
  deposit?: typeof localDeposits.$inferSelect;
  channelDispatched?: boolean;
  errorAr?: string;
  errorEn?: string;
}> {
  const cfg = await getCurrencyLocalDepositSettings();
  if (!cfg.localDepositsEnabled) {
    return {
      ok: false,
      errorAr: 'الإيداع عبر المحافظ المحلية متوقف مؤقتًا من إدارة المتجر.',
      errorEn: 'Local wallet deposits are temporarily disabled.',
    };
  }

  const [walletRow] = await db
    .select()
    .from(localWallets)
    .where(eq(localWallets.id, params.localWalletId))
    .limit(1);

  if (!walletRow || !walletRow.isEnabled) {
    return {
      ok: false,
      errorAr: 'المحفظة المختارة غير متاحة حاليًا. يرجى اختيار محفظة أخرى.',
      errorEn: 'Selected local wallet is currently unavailable.',
    };
  }

  const minYer = walletRow.minAmountYer ? Number(walletRow.minAmountYer) : cfg.minDepositYer;
  const maxYer = walletRow.maxAmountYer ? Number(walletRow.maxAmountYer) : cfg.maxDepositYer;

  const amtCheck = validateLocalDepositAmountYer(params.amountYer, minYer, maxYer);
  if (!amtCheck.ok) {
    if (amtCheck.reason === 'below_min') {
      return {
        ok: false,
        errorAr: `الحد الأدنى للإيداع في هذه المحفظة هو ${formatYerNumber(minYer)}.`,
        errorEn: `Minimum deposit for this wallet is ${formatYerNumber(minYer)}.`,
      };
    }
    if (amtCheck.reason === 'above_max') {
      return {
        ok: false,
        errorAr: `الحد الأقصى للإيداع في هذه المحفظة هو ${formatYerNumber(maxYer)}.`,
        errorEn: `Maximum deposit for this wallet is ${formatYerNumber(maxYer)}.`,
      };
    }
    return {
      ok: false,
      errorAr: 'المبلغ المدخل بالريال اليمني غير صالح.',
      errorEn: 'Invalid YER deposit amount.',
    };
  }

  const nameCheck = validateDepositorQuadName(params.depositorNameUsed);
  if (!nameCheck.ok) {
    return {
      ok: false,
      errorAr: 'يرجى إدخال الاسم الرباعي الصحيح لصاحب المحفظة المرسلة (ثلاث كلمات على الأقل بدون روابط).',
      errorEn: 'Please provide a valid full depositor name (at least 3 words).',
    };
  }

  // Enforce proof screenshot presence (either Telegram file_id OR validated image data URL)
  if (!params.proofTelegramFileId && !params.proofImageDataUrl) {
    return {
      ok: false,
      errorAr: '📸 لا يمكن إرسال الطلب بدون صورة إثبات التحويل. يرجى إرفاق لقطة شاشة واضحة للتحويل.',
      errorEn: '📸 Transfer proof image is required before submitting the deposit request.',
    };
  }

  if (params.proofImageDataUrl) {
    const imgCheck = validateProofImageDataUrl(params.proofImageDataUrl);
    if (!imgCheck.ok) {
      return { ok: false, errorAr: imgCheck.errorAr, errorEn: 'Invalid proof image file.' };
    }
  }

  // MANDATORY: Fetch fresh live exchange rate from ye-rial.com — FAIL CLOSED if unavailable/stale!
  const liveRate = await fetchLiveYerExchangeRate({ forceFresh: true, settingsOverride: cfg });
  if (!liveRate.ok || !liveRate.rate) {
    return {
      ok: false,
      errorAr:
        liveRate.errorMessageAr ||
        'تعذر التحقق من سعر الصرف الحي الآن. تم إيقاف إرسال الإيداع مؤقتًا لضمان دقة رصيدك.',
      errorEn:
        liveRate.errorMessageEn ||
        'Live exchange rate unavailable. Local deposit paused to protect accuracy.',
    };
  }

  const [userRow] = await db
    .select()
    .from(users)
    .where(eq(users.id, params.userId))
    .limit(1);

  if (!userRow) {
    return { ok: false, errorAr: 'تعذر العثور على حساب المستخدم.', errorEn: 'User account not found.' };
  }

  // Save permanent depositor name ONLY if requested and NOT marked temporary
  if (params.saveDepositorNameAsPermanent && !params.depositorNameIsTemporary) {
    await db
      .update(users)
      .set({ savedDepositorName: nameCheck.cleaned, updatedAt: new Date() })
      .where(eq(users.id, userRow.id));
  }

  const equivalentUsd = convertYerToUsd(amtCheck.amountYer, liveRate.rate);
  const depositRef = generateLocalDepositRef();

  const [created] = await db
    .insert(localDeposits)
    .values({
      depositRef,
      userId: userRow.id,
      localWalletId: walletRow.id,
      walletNameSnapshot: walletRow.nameAr,
      recipientAccountSnapshot: walletRow.accountNumber,
      recipientHolderSnapshot: walletRow.accountHolderName,
      depositorNameUsed: nameCheck.cleaned,
      depositorNameIsTemporary: Boolean(params.depositorNameIsTemporary),
      senderWalletNumber: String(params.senderWalletNumber || '').trim().slice(0, 64),
      amountYer: amtCheck.amountYer,
      equivalentUsd,
      exchangeRateUsed: liveRate.rate,
      exchangeRateSource: liveRate.source,
      exchangeRateMarket: liveRate.market,
      exchangeRateVerifiedAt: liveRate.providerLastVerifiedAt || liveRate.fetchedAt,
      proofTelegramFileId: params.proofTelegramFileId || null,
      proofImageDataUrl: params.proofImageDataUrl || null,
      proofCaption: String(params.proofCaption || '').trim().slice(0, 500),
      status: 'pending_review',
    })
    .returning();

  // Admin notification in Web Panel
  await db.insert(notifications).values({
    audience: 'admin',
    eventType: 'new_deposit',
    severity: 'info',
    titleAr: `طلب إيداع محلي جديد (${depositRef})`,
    bodyAr: `المستخدم ${userRow.displayName} أرسل طلب إيداع بمبلغ ${formatYerNumber(amtCheck.amountYer)} ($${new Decimal(equivalentUsd).toFixed(2)}) عبر ${walletRow.nameAr} — بانتظار المراجعة.`,
  });

  // Dispatch immediately to configured Admin Review Telegram Channel
  const channelCaption = formatAdminChannelDepositCaption({
    depositRef: created.depositRef,
    username: userRow.telegramUsername,
    telegramUserId: userRow.telegramUserId,
    userDisplayName: userRow.displayName,
    depositorNameUsed: created.depositorNameUsed,
    depositorNameIsTemporary: created.depositorNameIsTemporary,
    walletName: created.walletNameSnapshot,
    recipientAccount: created.recipientAccountSnapshot,
    senderWalletNumber: created.senderWalletNumber,
    amountYer: created.amountYer,
    equivalentUsd: created.equivalentUsd,
    exchangeRateUsed: created.exchangeRateUsed,
    exchangeRateMarket: created.exchangeRateMarket,
    createdAt: created.createdAt,
  });

  const dispatchRes = await dispatchDepositToAdminChannel({
    depositId: created.id,
    caption: channelCaption,
    proofTelegramFileId: created.proofTelegramFileId,
    proofImageDataUrl: created.proofImageDataUrl,
  });

  let finalRow = created;
  if (dispatchRes.dispatched && dispatchRes.chatId && dispatchRes.messageId) {
    const [updated] = await db
      .update(localDeposits)
      .set({
        channelChatId: dispatchRes.chatId,
        channelMessageId: dispatchRes.messageId,
        updatedAt: new Date(),
      })
      .where(eq(localDeposits.id, created.id))
      .returning();
    if (updated) finalRow = updated;
  }

  return {
    ok: true,
    deposit: finalRow,
    channelDispatched: dispatchRes.dispatched,
  };
}

/**
 * Atomically approves a pending local deposit request inside a PostgreSQL row-locked transaction.
 * Guarantees ZERO double-credits across concurrent Telegram Channel clicks and Web Admin clicks.
 */
export async function approveLocalDepositAtomically(params: {
  depositId: number;
  reviewerUserId: number | null;
  reviewerName: string;
}): Promise<{
  ok: boolean;
  alreadyProcessed?: boolean;
  status?: string;
  deposit?: typeof localDeposits.$inferSelect;
  nextBalanceUsd?: string;
  messageAr: string;
}> {
  const reviewedAt = new Date();
  const ledgerRef = `LDEP-CREDIT-${params.depositId}`;

  const txResult = await db.transaction(async (tx) => {
    const lockedRes = await tx.execute(
      sql`SELECT * FROM local_deposits WHERE id = ${params.depositId} FOR UPDATE`
    );
    const raw = lockedRes.rows[0] as any;
    if (!raw) {
      return { ok: false as const, messageAr: 'طلب الإيداع المحلي غير موجود.' };
    }

    const check = canTransitionLocalDeposit(String(raw.status), 'approve');
    if (!check.allowed || raw.credited_at) {
      return {
        ok: false as const,
        alreadyProcessed: true,
        status: String(raw.status),
        messageAr:
          raw.status === 'approved'
            ? 'تمت الموافقة على هذا الإيداع وإضافة رصيده مسبقًا.'
            : 'تمت معالجة هذا الطلب مسبقًا ولا يمكن اعتماده مرة أخرى.',
      };
    }

    const userId = Number(raw.user_id);
    const creditUsd = new Decimal(String(raw.equivalent_usd));
    if (creditUsd.lte(0)) {
      return { ok: false as const, messageAr: 'قيمة المعادل بالدولار غير صالحة.' };
    }

    // Ensure wallet row exists and lock it with FOR UPDATE
    await tx.insert(wallets).values({ userId, currency: 'USD' }).onConflictDoNothing();
    const walletLockedRes = await tx.execute(
      sql`SELECT id, available_balance, reserved_balance FROM wallets WHERE user_id = ${userId} FOR UPDATE`
    );
    const walletRow = walletLockedRes.rows[0] as any;
    const prevAvail = new Decimal(String(walletRow.available_balance));
    const nextAvail = prevAvail.plus(creditUsd).toFixed(4);

    // Double-check ledger idempotency key
    const existingLedger = await tx
      .select({ id: walletLedger.id })
      .from(walletLedger)
      .where(eq(walletLedger.referenceCode, ledgerRef))
      .limit(1);

    if (existingLedger.length > 0) {
      return {
        ok: false as const,
        alreadyProcessed: true,
        status: 'approved',
        messageAr: 'تمت إضافة هذا الإيداع إلى سجل المحفظة مسبقًا.',
      };
    }

    await tx
      .update(wallets)
      .set({ availableBalance: nextAvail, updatedAt: reviewedAt })
      .where(eq(wallets.id, Number(walletRow.id)));

    await tx.insert(walletLedger).values({
      walletId: Number(walletRow.id),
      userId,
      entryType: 'deposit_credit',
      amount: creditUsd.toFixed(4),
      balanceBefore: prevAvail.toFixed(4),
      balanceAfter: nextAvail,
      referenceCode: ledgerRef,
      note: `إيداع محلي ${raw.deposit_ref} (${formatYerNumber(raw.amount_yer)} عبر ${raw.wallet_name_snapshot})`,
    });

    const [updatedDeposit] = await tx
      .update(localDeposits)
      .set({
        status: 'approved',
        reviewedByUserId: params.reviewerUserId,
        reviewedByName: params.reviewerName,
        reviewedAt,
        creditedAt: reviewedAt,
        walletLedgerRef: ledgerRef,
        updatedAt: reviewedAt,
      })
      .where(eq(localDeposits.id, params.depositId))
      .returning();

    const [userRow] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);

    await tx.insert(auditLogs).values({
      actorUserId: params.reviewerUserId,
      actorRole: 'admin',
      action: 'local_deposit_approved',
      entityType: 'local_deposit',
      entityId: String(params.depositId),
      detailsJson: {
        depositRef: updatedDeposit.depositRef,
        amountYer: updatedDeposit.amountYer,
        equivalentUsd: updatedDeposit.equivalentUsd,
        exchangeRateUsed: updatedDeposit.exchangeRateUsed,
        reviewerName: params.reviewerName,
        walletLedgerRef: ledgerRef,
      },
    });

    await tx.insert(notifications).values({
      audience: 'customer',
      targetUserId: userId,
      eventType: 'new_deposit',
      severity: 'info',
      titleAr: 'تم إيداع رصيدك بنجاح',
      bodyAr: `تمت الموافقة على إيداعك ${updatedDeposit.depositRef} بمبلغ ${formatYerNumber(updatedDeposit.amountYer)} وإضافة الرصيد إلى محفظتك.`,
    });

    return {
      ok: true as const,
      deposit: updatedDeposit,
      userRow,
      nextBalanceUsd: nextAvail,
    };
  });

  if (!txResult.ok) {
    return txResult;
  }

  const { deposit, userRow, nextBalanceUsd } = txResult;
  const cfg = await getCurrencyLocalDepositSettings();

  // 1. Update Admin Review Channel post
  const updatedChannelCaption = formatAdminChannelReviewedCaption({
    depositRef: deposit.depositRef,
    username: userRow?.telegramUsername,
    telegramUserId: userRow?.telegramUserId,
    userDisplayName: userRow?.displayName || 'Customer',
    depositorNameUsed: deposit.depositorNameUsed,
    depositorNameIsTemporary: deposit.depositorNameIsTemporary,
    walletName: deposit.walletNameSnapshot,
    recipientAccount: deposit.recipientAccountSnapshot,
    senderWalletNumber: deposit.senderWalletNumber,
    amountYer: deposit.amountYer,
    equivalentUsd: deposit.equivalentUsd,
    exchangeRateUsed: deposit.exchangeRateUsed,
    exchangeRateMarket: deposit.exchangeRateMarket,
    createdAt: deposit.createdAt,
    decision: 'approved',
    reviewerName: params.reviewerName,
    reviewedAt,
  });

  await updateAdminChannelMessageAfterReview({
    chatId: deposit.channelChatId,
    messageId: deposit.channelMessageId,
    hasPhoto: Boolean(deposit.proofTelegramFileId || deposit.proofImageDataUrl),
    caption: updatedChannelCaption,
  });

  // 2. Notify customer instantly via Telegram in their chosen currency & language
  if (userRow?.telegramUserId) {
    const userLang: SupportedLang = userRow.languageCode === 'en' ? 'en' : 'ar';
    const userCurrency: DisplayCurrency = normalizeDisplayCurrency(userRow.preferredCurrency);
    const userText = formatUserLocalDepositApprovedMessage({
      lang: userLang,
      preferredCurrency: userCurrency,
      amountYer: deposit.amountYer,
      equivalentUsd: deposit.equivalentUsd,
      newBalanceUsd: nextBalanceUsd,
      exchangeRateUsed: deposit.exchangeRateUsed,
      roundingMode: cfg.roundingMode,
      depositRef: deposit.depositRef,
    });
    await notifyTelegramCustomerDirect({
      telegramUserId: userRow.telegramUserId,
      text: userText,
      inlineKeyboard: [[{ text: userLang === 'en' ? '🏠 Home' : '🏠 الرئيسية', callback_data: 'c:home' }]],
    });
  }

  return {
    ok: true,
    deposit,
    nextBalanceUsd,
    messageAr: `✅ تمت الموافقة على الإيداع ${deposit.depositRef} وإضافة الرصيد بنجاح.`,
  };
}

/**
 * Atomically rejects a pending local deposit request (never credits balance).
 */
export async function rejectLocalDepositAtomically(params: {
  depositId: number;
  reviewerUserId: number | null;
  reviewerName: string;
  reason?: string;
}): Promise<{
  ok: boolean;
  alreadyProcessed?: boolean;
  status?: string;
  deposit?: typeof localDeposits.$inferSelect;
  messageAr: string;
}> {
  const reviewedAt = new Date();
  const cleanReason = String(params.reason || '').trim() || DEFAULT_LOCAL_REJECTION_REASON_AR;

  const txResult = await db.transaction(async (tx) => {
    const lockedRes = await tx.execute(
      sql`SELECT * FROM local_deposits WHERE id = ${params.depositId} FOR UPDATE`
    );
    const raw = lockedRes.rows[0] as any;
    if (!raw) {
      return { ok: false as const, messageAr: 'طلب الإيداع المحلي غير موجود.' };
    }

    const check = canTransitionLocalDeposit(String(raw.status), 'reject');
    if (!check.allowed) {
      return {
        ok: false as const,
        alreadyProcessed: true,
        status: String(raw.status),
        messageAr:
          raw.status === 'approved'
            ? 'لا يمكن رفض إيداع تمت الموافقة عليه وإضافة رصيده مسبقًا.'
            : 'تمت معالجة هذا الطلب مسبقًا.',
      };
    }

    const [updatedDeposit] = await tx
      .update(localDeposits)
      .set({
        status: 'rejected',
        rejectionReason: cleanReason,
        reviewedByUserId: params.reviewerUserId,
        reviewedByName: params.reviewerName,
        reviewedAt,
        updatedAt: reviewedAt,
      })
      .where(eq(localDeposits.id, params.depositId))
      .returning();

    const [userRow] = await tx
      .select()
      .from(users)
      .where(eq(users.id, Number(raw.user_id)))
      .limit(1);

    await tx.insert(auditLogs).values({
      actorUserId: params.reviewerUserId,
      actorRole: 'admin',
      action: 'local_deposit_rejected',
      entityType: 'local_deposit',
      entityId: String(params.depositId),
      detailsJson: {
        depositRef: updatedDeposit.depositRef,
        amountYer: updatedDeposit.amountYer,
        rejectionReason: cleanReason,
        reviewerName: params.reviewerName,
      },
    });

    await tx.insert(notifications).values({
      audience: 'customer',
      targetUserId: Number(raw.user_id),
      eventType: 'new_deposit',
      severity: 'warning',
      titleAr: 'تعذر قبول عملية الإيداع',
      bodyAr: `تم رفض طلب الإيداع ${updatedDeposit.depositRef} بسبب: ${cleanReason}`,
    });

    return { ok: true as const, deposit: updatedDeposit, userRow };
  });

  if (!txResult.ok) {
    return txResult;
  }

  const { deposit, userRow } = txResult;

  // 1. Update Admin Review Channel post
  const updatedChannelCaption = formatAdminChannelReviewedCaption({
    depositRef: deposit.depositRef,
    username: userRow?.telegramUsername,
    telegramUserId: userRow?.telegramUserId,
    userDisplayName: userRow?.displayName || 'Customer',
    depositorNameUsed: deposit.depositorNameUsed,
    depositorNameIsTemporary: deposit.depositorNameIsTemporary,
    walletName: deposit.walletNameSnapshot,
    recipientAccount: deposit.recipientAccountSnapshot,
    senderWalletNumber: deposit.senderWalletNumber,
    amountYer: deposit.amountYer,
    equivalentUsd: deposit.equivalentUsd,
    exchangeRateUsed: deposit.exchangeRateUsed,
    exchangeRateMarket: deposit.exchangeRateMarket,
    createdAt: deposit.createdAt,
    decision: 'rejected',
    reviewerName: params.reviewerName,
    reviewedAt,
    rejectionReason: cleanReason,
  });

  await updateAdminChannelMessageAfterReview({
    chatId: deposit.channelChatId,
    messageId: deposit.channelMessageId,
    hasPhoto: Boolean(deposit.proofTelegramFileId || deposit.proofImageDataUrl),
    caption: updatedChannelCaption,
  });

  // 2. Notify customer via Telegram with Support & Home buttons
  if (userRow?.telegramUserId) {
    const userLang: SupportedLang = userRow.languageCode === 'en' ? 'en' : 'ar';
    const supportHandle = await getStoreSupportHandle();
    const supportUrl = buildSupportTelegramUrl(supportHandle);
    const userText = formatUserLocalDepositRejectedMessage({
      lang: userLang,
      reason: cleanReason,
      depositRef: deposit.depositRef,
    });
    await notifyTelegramCustomerDirect({
      telegramUserId: userRow.telegramUserId,
      text: userText,
      inlineKeyboard: [
        [
          { text: userLang === 'en' ? '💬 Contact Support' : '💬 التواصل مع الدعم', url: supportUrl },
          { text: userLang === 'en' ? '🏠 Home' : '🏠 الرئيسية', callback_data: 'c:home' },
        ],
      ],
    });
  }

  return {
    ok: true,
    deposit,
    messageAr: `❌ تم رفض الإيداع ${deposit.depositRef} وإبلاغ المستخدم بالسبب.`,
  };
}

// ============================================================================
// ADMIN QUERIES (LOCAL DEPOSITS & SAVED DEPOSITOR NAMES)
// ============================================================================

export async function listLocalDepositsForAdmin(params?: {
  status?: string;
  search?: string;
  limit?: number;
}) {
  const limit = Math.min(200, Math.max(10, Number(params?.limit || 100)));
  const rows = await db
    .select({
      deposit: localDeposits,
      userDisplayName: users.displayName,
      userTelegramId: users.telegramUserId,
      userTelegramUsername: users.telegramUsername,
      userPreferredCurrency: users.preferredCurrency,
      userSavedDepositorName: users.savedDepositorName,
    })
    .from(localDeposits)
    .leftJoin(users, eq(localDeposits.userId, users.id))
    .orderBy(desc(localDeposits.createdAt))
    .limit(limit);

  const statusFilter = (params?.status || 'all').trim().toLowerCase();
  const searchFilter = (params?.search || '').trim().toLowerCase();

  return rows
    .filter((r) => {
      if (statusFilter && statusFilter !== 'all' && r.deposit.status !== statusFilter) {
        return false;
      }
      if (searchFilter) {
        const hay = [
          r.deposit.depositRef,
          String(r.deposit.userId),
          r.userTelegramId || '',
          r.userTelegramUsername || '',
          r.userDisplayName || '',
          r.deposit.depositorNameUsed,
          r.deposit.walletNameSnapshot,
        ]
          .join(' ')
          .toLowerCase();
        return hay.includes(searchFilter);
      }
      return true;
    })
    .map((r) => ({
      ...r.deposit,
      // Never dump huge base64 data URLs into list payload; expose boolean & fetch via authenticated proof endpoint
      hasProofImage: Boolean(r.deposit.proofTelegramFileId || r.deposit.proofImageDataUrl),
      proofImageDataUrl: undefined,
      userDisplayName: r.userDisplayName || 'Customer',
      userTelegramId: r.userTelegramId || '',
      userTelegramUsername: r.userTelegramUsername || '',
      userPreferredCurrency: normalizeDisplayCurrency(r.userPreferredCurrency),
      userSavedDepositorName: r.userSavedDepositorName || '',
    }));
}

export async function listSavedDepositorNamesForAdmin(search?: string) {
  const rows = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      telegramUserId: users.telegramUserId,
      telegramUsername: users.telegramUsername,
      preferredCurrency: users.preferredCurrency,
      savedDepositorName: users.savedDepositorName,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(
      search && search.trim()
        ? or(
            ilike(users.savedDepositorName, `%${search.trim()}%`),
            ilike(users.displayName, `%${search.trim()}%`),
            ilike(users.telegramUserId, `%${search.trim()}%`),
            ilike(users.telegramUsername, `%${search.trim()}%`)
          )
        : undefined
    )
    .orderBy(desc(users.updatedAt))
    .limit(200);

  return rows.filter((u) => Boolean(u.savedDepositorName && u.savedDepositorName.trim()));
}
