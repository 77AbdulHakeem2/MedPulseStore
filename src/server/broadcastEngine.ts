export type BroadcastAudience = 'customers' | 'all_telegram' | 'admins_only';

export interface BroadcastCandidateUser {
  id: number;
  uid: string;
  role: string;
  isBlocked: boolean;
  telegramUserId: string | null;
  telegramUsername?: string | null;
  displayName: string;
}

export interface BroadcastRecipient {
  userId: number;
  telegramUserId: string;
  displayName: string;
  role: string;
}

export interface BroadcastRecipientSelection {
  audience: BroadcastAudience;
  recipients: BroadcastRecipient[];
  totalInAudience: number;
  skippedBlocked: number;
  skippedNoTelegram: number;
  skippedPlaceholder: number;
}

export interface TelegramSendDetailedResult {
  ok: boolean;
  blocked?: boolean;
  retryAfterSec?: number;
  errorCode?: number;
  errorMessage?: string;
}

export interface BroadcastDeliveryErrorSample {
  userId: number;
  displayName: string;
  telegramUserId: string;
  reason: string;
}

export interface BroadcastDeliveryResult {
  totalEligible: number;
  sentCount: number;
  failedCount: number;
  blockedCount: number;
  errorsSample: BroadcastDeliveryErrorSample[];
}

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const SEEDED_LOCAL_TELEGRAM_IDS = new Set(['700100001']);

export function normalizeBroadcastAudience(raw: unknown): BroadcastAudience {
  if (raw === 'all_telegram' || raw === 'admins_only' || raw === 'customers') {
    return raw;
  }
  return 'customers';
}

export function isValidTelegramNumericId(telegramUserId: string | null | undefined): boolean {
  if (!telegramUserId) return false;
  return /^\d{5,20}$/.test(telegramUserId.trim());
}

export function isSeededPlaceholderUser(user: {
  uid?: string | null;
  telegramUserId?: string | null;
}): boolean {
  const uid = (user.uid || '').trim();
  const tgId = (user.telegramUserId || '').trim();
  if (uid.startsWith('local:')) return true;
  if (tgId && SEEDED_LOCAL_TELEGRAM_IDS.has(tgId)) return true;
  return false;
}

export function formatBroadcastTelegramMessage(params: {
  title: string;
  message: string;
  storeName?: string;
}): { ok: true; text: string } | { ok: false; errorAr: string } {
  const title = (params.title || '').trim();
  const message = (params.message || '').trim();
  const storeName = (params.storeName || '').trim();

  if (!title || !message) {
    return { ok: false, errorAr: 'يرجى كتابة عنوان ونص الإعلان.' };
  }

  const lines = [`📢 ${title}`, '━━━━━━━━━━━━━━━━━━', message];
  if (storeName) {
    lines.push('', `— ${storeName}`);
  }
  const text = lines.join('\n');

  if (text.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
    return {
      ok: false,
      errorAr: `نص الإعلان طويل جدًا (${text.length} حرف). الحد الأقصى المسموح به في تيليجرام هو ${TELEGRAM_MAX_MESSAGE_LENGTH} حرفًا.`,
    };
  }

  return { ok: true, text };
}

function matchesAudienceRole(role: string, audience: BroadcastAudience): boolean {
  const normalizedRole = (role || '').trim().toLowerCase();
  if (audience === 'customers') {
    return normalizedRole === 'customer';
  }
  if (audience === 'admins_only') {
    return normalizedRole === 'owner' || normalizedRole === 'admin';
  }
  return normalizedRole === 'customer' || normalizedRole === 'owner' || normalizedRole === 'admin';
}

export function selectBroadcastRecipients(
  allUsers: BroadcastCandidateUser[],
  audienceInput: BroadcastAudience = 'customers'
): BroadcastRecipientSelection {
  const audience = normalizeBroadcastAudience(audienceInput);
  const seenTelegramIds = new Set<string>();
  const recipients: BroadcastRecipient[] = [];

  let totalInAudience = 0;
  let skippedBlocked = 0;
  let skippedNoTelegram = 0;
  let skippedPlaceholder = 0;

  for (const user of allUsers) {
    if (!matchesAudienceRole(user.role, audience)) continue;
    totalInAudience += 1;

    if (isSeededPlaceholderUser(user)) {
      skippedPlaceholder += 1;
      continue;
    }

    if (user.isBlocked) {
      skippedBlocked += 1;
      continue;
    }

    const tgId = (user.telegramUserId || '').trim();
    if (!isValidTelegramNumericId(tgId)) {
      skippedNoTelegram += 1;
      continue;
    }

    if (seenTelegramIds.has(tgId)) continue;
    seenTelegramIds.add(tgId);

    recipients.push({
      userId: user.id,
      telegramUserId: tgId,
      displayName: user.displayName || `عميل #${user.id}`,
      role: user.role,
    });
  }

  return {
    audience,
    recipients,
    totalInAudience,
    skippedBlocked,
    skippedNoTelegram,
    skippedPlaceholder,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeBroadcastDelivery(params: {
  recipients: BroadcastRecipient[];
  text: string;
  sendMessage: (telegramUserId: string, text: string) => Promise<TelegramSendDetailedResult>;
  delayMs?: number;
  maxRetriesOn429?: number;
  sleepFn?: (ms: number) => Promise<void>;
}): Promise<BroadcastDeliveryResult> {
  const {
    recipients,
    text,
    sendMessage,
    delayMs = 45,
    maxRetriesOn429 = 1,
    sleepFn = defaultSleep,
  } = params;

  let sentCount = 0;
  let failedCount = 0;
  let blockedCount = 0;
  const errorsSample: BroadcastDeliveryErrorSample[] = [];

  for (let i = 0; i < recipients.length; i += 1) {
    const recipient = recipients[i];
    let result: TelegramSendDetailedResult;

    try {
      result = await sendMessage(recipient.telegramUserId, text);
    } catch (err) {
      result = {
        ok: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    // Automatic single retry when Telegram responds with 429 Too Many Requests
    let retriesLeft = maxRetriesOn429;
    while (!result.ok && result.errorCode === 429 && retriesLeft > 0) {
      retriesLeft -= 1;
      const waitMs = Math.min(Math.max(Number(result.retryAfterSec || 1), 1), 10) * 1000;
      await sleepFn(waitMs);
      try {
        result = await sendMessage(recipient.telegramUserId, text);
      } catch (err) {
        result = {
          ok: false,
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (result.ok) {
      sentCount += 1;
    } else {
      failedCount += 1;
      if (result.blocked) {
        blockedCount += 1;
      }
      if (errorsSample.length < 5) {
        errorsSample.push({
          userId: recipient.userId,
          displayName: recipient.displayName,
          telegramUserId: recipient.telegramUserId,
          reason: result.errorMessage || 'تعذر الإرسال عبر تيليجرام',
        });
      }
    }

    if (delayMs > 0 && i < recipients.length - 1) {
      await sleepFn(delayMs);
    }
  }

  return {
    totalEligible: recipients.length,
    sentCount,
    failedCount,
    blockedCount,
    errorsSample,
  };
}

export function buildBroadcastResultSummaryAr(params: {
  audience: BroadcastAudience;
  delivery: BroadcastDeliveryResult;
}): string {
  const { audience, delivery } = params;
  const targetLabel =
    audience === 'admins_only'
      ? 'الإدارة (نسخة تجريبية)'
      : audience === 'all_telegram'
        ? 'العملاء والإدارة'
        : 'العملاء';

  if (delivery.totalEligible === 0) {
    return 'لا يوجد مستلمون مؤهلون مرتبطون بتيليجرام ضمن الفئة المختارة.';
  }

  if (delivery.sentCount === 0) {
    return `تعذر توصيل الإعلان عبر تيليجرام إلى أي مستلم (فشل ${delivery.failedCount} من أصل ${delivery.totalEligible}).`;
  }

  if (delivery.failedCount === 0) {
    return `تم إرسال الإعلان فعليًا عبر تيليجرام إلى ${delivery.sentCount} من ${targetLabel} بنجاح.`;
  }

  const blockedNote =
    delivery.blockedCount > 0 ? ` (منهم ${delivery.blockedCount} حظروا البوت أو لم يبدؤوه)` : '';
  return `تم إرسال الإعلان فعليًا عبر تيليجرام إلى ${delivery.sentCount} من أصل ${delivery.totalEligible} مستلم، وتعذر التوصيل لـ ${delivery.failedCount}${blockedNote}.`;
}
