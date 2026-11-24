import crypto from 'node:crypto';
import Decimal from 'decimal.js';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  binancePaySettings,
  binanceUsedTransactions,
  deposits,
  notifications,
  paymentTransactions,
  users,
  walletLedger,
  wallets,
  auditLogs,
} from '../db/schema.ts';
import { decryptSecret, encryptSecret, maskApiKey } from './crypto.ts';
import { computeCreditTransition } from './walletEngine.ts';
import { t, type SupportedLang } from '../i18n/index.ts';

const BINANCE_SAPI_BASE = 'https://api.binance.com';
const PAY_TRANSACTIONS_PATH = '/sapi/v1/pay/transactions';
const API_RESTRICTIONS_PATH = '/sapi/v1/account/apiRestrictions';

export interface BinancePayTradeRecord {
  orderType?: string; // PAY | PAY_REFUND | C2C | CRYPTO_BOX | PAYOUT | REMITTANCE
  transactionId: string;
  transactionTime: number; // ms epoch
  amount: string; // positive = incoming, negative = outgoing
  currency: string; // e.g. USDT
  walletType?: number;
  walletTypes?: number[];
  status?: string; // optional status field if returned
  fundsDetail?: Array<{ currency: string; amount: string }>;
  payerInfo?: {
    name?: string;
    type?: string;
    binanceId?: string;
    accountId?: string;
    email?: string;
  };
  receiverInfo?: {
    name?: string;
    type?: string;
    binanceId?: string;
    accountId?: string;
    email?: string;
  };
}

export interface BinanceVerifyInput {
  submittedTransactionId: string;
  expectedAmount: string;
  expectedCurrency?: string; // default USDT
  expectedReceiverId: string;
  depositCreatedAtMs: number;
  nowMs?: number;
  alreadyUsedTransactionIds: Set<string>;
  historyRecords: BinancePayTradeRecord[];
}

export interface BinanceVerifyResult {
  outcome: 'paid' | 'pending' | 'rejected';
  reasonCode:
    | 'VERIFIED'
    | 'NOT_FOUND_YET'
    | 'DUPLICATE_TRANSACTION_ID'
    | 'NOT_INCOMING_TRANSFER'
    | 'WRONG_CURRENCY'
    | 'AMOUNT_MISMATCH'
    | 'WRONG_RECEIVER_ID'
    | 'TIMESTAMP_OUT_OF_WINDOW'
    | 'INCOMPLETE_STATUS'
    | 'INVALID_INPUT';
  i18nReasonKey:
    | 'verify_reason_not_found'
    | 'verify_reason_duplicate'
    | 'verify_reason_outgoing'
    | 'verify_reason_wrong_currency'
    | 'verify_reason_amount_mismatch'
    | 'verify_reason_wrong_receiver'
    | 'verify_reason_invalid_time'
    | 'verify_reason_incomplete';
  matchedRecord?: BinancePayTradeRecord;
  verifiedAmount?: string;
}

/**
 * Official Binance SAPI HMAC-SHA256 Query Signer.
 * Uses personal account Read-Only API key + secret (NEVER Merchant BINANCE_PAY_SECRET_KEY).
 */
export function buildBinanceSignedQuery(params: {
  queryParams: Record<string, string | number | undefined>;
  apiSecret: string;
  timestampMs?: number;
  recvWindowMs?: number;
}): { queryString: string; signature: string; fullQuery: string } {
  const entries: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(params.queryParams)) {
    if (v !== undefined && v !== null && v !== '') {
      entries.push([k, String(v)]);
    }
  }
  entries.push(['recvWindow', String(params.recvWindowMs ?? 5000)]);
  entries.push(['timestamp', String(params.timestampMs ?? Date.now())]);

  const queryString = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const signature = crypto
    .createHmac('sha256', params.apiSecret)
    .update(queryString)
    .digest('hex');

  return {
    queryString,
    signature,
    fullQuery: `${queryString}&signature=${signature}`,
  };
}

/**
 * Pure, unit-testable 9-Condition Verification Engine for Binance Pay Trade History.
 * Enforces EVERY single condition strictly using Decimal math:
 * 1. Transaction exists in Binance Pay Trade History of the owner's account
 * 2. transactionId matches submitted reference exactly
 * 3. Transfer is incoming (positive Decimal amount & non-refund/outgoing orderType)
 * 4. Currency is strictly USDT
 * 5. Exact Decimal amount match with the deposit request
 * 6. Receiver matches owner's configured BINANCE_RECEIVER_ID
 * 7. Transaction timestamp is within valid deposit window (not an old historical tx)
 * 8. Transaction ID has NEVER been used previously
 * 9. Record is complete & settled (proves receipt of funds)
 */
export function verifyBinancePayTransaction(input: BinanceVerifyInput): BinanceVerifyResult {
  const cleanTxId = (input.submittedTransactionId || '').trim();
  const expectedReceiver = (input.expectedReceiverId || '').trim();
  const expectedCurrency = (input.expectedCurrency || 'USDT').trim().toUpperCase();
  const nowMs = input.nowMs ?? Date.now();

  if (!cleanTxId || cleanTxId.length < 6) {
    return {
      outcome: 'rejected',
      reasonCode: 'INVALID_INPUT',
      i18nReasonKey: 'verify_reason_not_found',
    };
  }

  // Condition 8: Transaction ID must never have been used before
  if (input.alreadyUsedTransactionIds.has(cleanTxId)) {
    return {
      outcome: 'rejected',
      reasonCode: 'DUPLICATE_TRANSACTION_ID',
      i18nReasonKey: 'verify_reason_duplicate',
    };
  }

  // Condition 1 & 2: Transaction exists in owner's Binance Pay history & exact transactionId match
  const matched = input.historyRecords.find((r) => String(r.transactionId || '').trim() === cleanTxId);
  if (!matched) {
    return {
      outcome: 'pending',
      reasonCode: 'NOT_FOUND_YET',
      i18nReasonKey: 'verify_reason_not_found',
    };
  }

  // Condition 9: Completed / settled check (reject failed/pending/cancelled statuses if status field present)
  if (matched.status) {
    const normalizedStatus = matched.status.trim().toUpperCase();
    const validStatuses = new Set(['SUCCESS', 'COMPLETED', 'PAID', 'SETTLED']);
    if (!validStatuses.has(normalizedStatus)) {
      return {
        outcome: 'pending',
        reasonCode: 'INCOMPLETE_STATUS',
        i18nReasonKey: 'verify_reason_incomplete',
        matchedRecord: matched,
      };
    }
  }

  // Condition 3: Incoming transfer ONLY (positive amount & not outgoing/refund type)
  let amountDec: Decimal;
  try {
    amountDec = new Decimal(String(matched.amount || '0'));
  } catch {
    return {
      outcome: 'rejected',
      reasonCode: 'INCOMPLETE_STATUS',
      i18nReasonKey: 'verify_reason_incomplete',
      matchedRecord: matched,
    };
  }

  const orderTypeUpper = String(matched.orderType || '').toUpperCase();
  const outgoingOrderTypes = new Set(['PAY_REFUND', 'CRYPTO_BOX_RF', 'C2C_HOLDING_RF', 'PAYOUT']);
  if (amountDec.lte(0) || outgoingOrderTypes.has(orderTypeUpper)) {
    return {
      outcome: 'rejected',
      reasonCode: 'NOT_INCOMING_TRANSFER',
      i18nReasonKey: 'verify_reason_outgoing',
      matchedRecord: matched,
    };
  }

  // Condition 4: Currency must be strictly USDT
  const txCurrency = String(matched.currency || '').trim().toUpperCase();
  if (txCurrency !== expectedCurrency) {
    return {
      outcome: 'rejected',
      reasonCode: 'WRONG_CURRENCY',
      i18nReasonKey: 'verify_reason_wrong_currency',
      matchedRecord: matched,
    };
  }

  // Condition 5: Exact Decimal amount match against deposit request
  const expectedDec = new Decimal(input.expectedAmount);
  if (!amountDec.eq(expectedDec)) {
    return {
      outcome: 'rejected',
      reasonCode: 'AMOUNT_MISMATCH',
      i18nReasonKey: 'verify_reason_amount_mismatch',
      matchedRecord: matched,
    };
  }

  // Condition 6: Receiver must match configured BINANCE_RECEIVER_ID
  // Note: On personal Binance Pay Trade History, receiverInfo may contain binanceId or accountId.
  // If receiverInfo specifies a binanceId/accountId it MUST match expectedReceiver exactly.
  // We also require expectedReceiver to be configured (never accept unconfigured receiver!).
  if (!expectedReceiver) {
    return {
      outcome: 'rejected',
      reasonCode: 'WRONG_RECEIVER_ID',
      i18nReasonKey: 'verify_reason_wrong_receiver',
      matchedRecord: matched,
    };
  }
  const recBinanceId = String(matched.receiverInfo?.binanceId || '').trim();
  const recAccountId = String(matched.receiverInfo?.accountId || '').trim();
  if (recBinanceId || recAccountId) {
    const matchesReceiver = recBinanceId === expectedReceiver || recAccountId === expectedReceiver;
    if (!matchesReceiver) {
      return {
        outcome: 'rejected',
        reasonCode: 'WRONG_RECEIVER_ID',
        i18nReasonKey: 'verify_reason_wrong_receiver',
        matchedRecord: matched,
      };
    }
  } else {
    // If Binance omitted receiverInfo completely on an incoming record, ensure payerInfo exists
    // (confirming someone else paid the authenticated owner's account) and payer is NOT the owner.
    const payerId = String(matched.payerInfo?.binanceId || matched.payerInfo?.accountId || '').trim();
    if (!matched.payerInfo || (payerId && payerId === expectedReceiver)) {
      return {
        outcome: 'rejected',
        reasonCode: 'WRONG_RECEIVER_ID',
        i18nReasonKey: 'verify_reason_wrong_receiver',
        matchedRecord: matched,
      };
    }
  }

  // Condition 7: Transaction timestamp must be suitable for this deposit request
  // Allow 10 minutes before deposit creation (in case customer transferred slightly before tapping button)
  // and up to 5 minutes ahead of server clock skew, and reject anything older than 24h before deposit creation.
  const txTime = Number(matched.transactionTime || 0);
  const minAllowedMs = input.depositCreatedAtMs - 10 * 60 * 1000;
  const maxAllowedMs = nowMs + 5 * 60 * 1000;
  if (!Number.isFinite(txTime) || txTime < minAllowedMs || txTime > maxAllowedMs) {
    return {
      outcome: 'rejected',
      reasonCode: 'TIMESTAMP_OUT_OF_WINDOW',
      i18nReasonKey: 'verify_reason_invalid_time',
      matchedRecord: matched,
    };
  }

  return {
    outcome: 'paid',
    reasonCode: 'VERIFIED',
    i18nReasonKey: 'verify_reason_not_found',
    matchedRecord: matched,
    verifiedAmount: amountDec.toFixed(4),
  };
}

// ============================================================================
// Short-TTL History Cache & Rate Limit Protection (prevents spamming Binance)
// ============================================================================
interface HistoryCacheEntry {
  fetchedAtMs: number;
  records: BinancePayTradeRecord[];
}
let historyCache: HistoryCacheEntry | null = null;
let rateLimitedUntilMs = 0;
const HISTORY_CACHE_TTL_MS = 15_000; // 15s cooldown between full Binance API fetches

export function clearBinanceHistoryCache() {
  historyCache = null;
}

export async function getBinanceSettingsRow() {
  const rows = await db
    .select()
    .from(binancePaySettings)
    .where(eq(binancePaySettings.singletonKey, 'primary'))
    .limit(1);

  if (rows.length > 0) return rows[0];

  const [created] = await db
    .insert(binancePaySettings)
    .values({
      singletonKey: 'primary',
      binanceReceiverId: (process.env.BINANCE_RECEIVER_ID || '').trim(),
      autoVerifyEnabled: false,
      eligibilityStatus: 'untested',
      eligibilityMessageAr: 'لم يتم تشغيل اختبار الاتصال والأهلية بعد.',
    })
    .onConflictDoNothing()
    .returning();

  if (created) return created;
  const [refetched] = await db
    .select()
    .from(binancePaySettings)
    .where(eq(binancePaySettings.singletonKey, 'primary'))
    .limit(1);
  return refetched;
}

export async function resolveBinanceCredentials(): Promise<{
  apiKey: string;
  apiSecret: string;
  receiverId: string;
  recvWindowMs: number;
  autoVerifyEnabled: boolean;
  eligibilityStatus: string;
  source: 'database' | 'env' | 'none';
}> {
  const row = await getBinanceSettingsRow();
  const dbKey = row.encryptedApiKey ? decryptSecret(row.encryptedApiKey) : '';
  const dbSecret = row.encryptedApiSecret ? decryptSecret(row.encryptedApiSecret) : '';
  const envKey = (process.env.BINANCE_API_KEY || '').trim();
  const envSecret = (process.env.BINANCE_API_SECRET || '').trim();
  const envReceiver = (process.env.BINANCE_RECEIVER_ID || '').trim();

  const apiKey = dbKey || envKey;
  const apiSecret = dbSecret || envSecret;
  const receiverId = (row.binanceReceiverId || envReceiver || '').trim();

  return {
    apiKey,
    apiSecret,
    receiverId,
    recvWindowMs: row.recvWindowMs || 5000,
    autoVerifyEnabled: Boolean(row.autoVerifyEnabled && row.eligibilityStatus === 'eligible'),
    eligibilityStatus: row.eligibilityStatus,
    source: dbKey && dbSecret ? 'database' : envKey && envSecret ? 'env' : 'none',
  };
}

export async function saveBinanceSettings(params: {
  binanceReceiverId?: string;
  apiKey?: string;
  apiSecret?: string;
  recvWindowMs?: number;
  autoVerifyEnabled?: boolean;
  actorUserId?: number;
  actorRole?: string;
}) {
  const current = await getBinanceSettingsRow();
  const patch: Record<string, any> = { updatedAt: new Date() };

  if (typeof params.binanceReceiverId === 'string') {
    patch.binanceReceiverId = params.binanceReceiverId.trim();
  }
  if (typeof params.recvWindowMs === 'number' && params.recvWindowMs >= 1000 && params.recvWindowMs <= 60000) {
    patch.recvWindowMs = params.recvWindowMs;
  }
  if (typeof params.apiKey === 'string' && params.apiKey.trim().length > 0) {
    patch.encryptedApiKey = encryptSecret(params.apiKey.trim());
    patch.apiKeyFingerprint = maskApiKey(params.apiKey.trim());
    // Changing credentials resets eligibility until re-tested!
    patch.eligibilityStatus = 'untested';
    patch.autoVerifyEnabled = false;
    patch.eligibilityMessageAr = 'تم تحديث مفتاح API — يرجى تشغيل اختبار الأهلية قبل تفعيل التحقق التلقائي.';
    clearBinanceHistoryCache();
  }
  if (typeof params.apiSecret === 'string' && params.apiSecret.trim().length > 0) {
    patch.encryptedApiSecret = encryptSecret(params.apiSecret.trim());
    patch.apiSecretFingerprint = maskApiKey(params.apiSecret.trim());
    patch.eligibilityStatus = 'untested';
    patch.autoVerifyEnabled = false;
    patch.eligibilityMessageAr = 'تم تحديث المفتاح السري — يرجى تشغيل اختبار الأهلية قبل تفعيل التحقق التلقائي.';
    clearBinanceHistoryCache();
  }
  if (typeof params.autoVerifyEnabled === 'boolean') {
    if (params.autoVerifyEnabled && current.eligibilityStatus !== 'eligible' && patch.eligibilityStatus !== 'eligible') {
      throw new Error('ELIGIBILITY_REQUIRED_BEFORE_ENABLE');
    }
    patch.autoVerifyEnabled = params.autoVerifyEnabled;
  }

  const [updated] = await db
    .update(binancePaySettings)
    .set(patch)
    .where(eq(binancePaySettings.id, current.id))
    .returning();

  await db.insert(auditLogs).values({
    actorUserId: params.actorUserId ?? null,
    actorRole: params.actorRole || 'admin',
    action: 'BINANCE_PAY_SETTINGS_UPDATED',
    entityType: 'binance_pay_settings',
    entityId: String(updated.id),
    detailsJson: {
      receiverIdSet: Boolean(updated.binanceReceiverId),
      apiKeyFingerprint: updated.apiKeyFingerprint,
      autoVerifyEnabled: updated.autoVerifyEnabled,
    },
  });

  return updated;
}

/**
 * Signed HTTPS request to official Binance Pay Trade History API:
 * GET https://api.binance.com/sapi/v1/pay/transactions
 * Respects cache TTL, rate limits (429/418), and time-window pagination.
 */
export async function fetchBinancePayTradeHistory(options?: {
  forceRefresh?: boolean;
  startTimeMs?: number;
  endTimeMs?: number;
  limit?: number;
  maxPages?: number;
}): Promise<{
  ok: boolean;
  records: BinancePayTradeRecord[];
  fromCache?: boolean;
  rateLimited?: boolean;
  httpStatus?: number;
  binanceCode?: number;
  errorType?: 'missing_credentials' | 'rate_limited' | 'region_restricted' | 'auth_permission' | 'api_error';
  errorMessageAr?: string;
}> {
  const creds = await resolveBinanceCredentials();
  if (!creds.apiKey || !creds.apiSecret) {
    return {
      ok: false,
      records: [],
      errorType: 'missing_credentials',
      errorMessageAr: 'لم يتم إدخال BINANCE_API_KEY و BINANCE_API_SECRET بعد.',
    };
  }

  const now = Date.now();
  if (now < rateLimitedUntilMs) {
    return {
      ok: false,
      records: historyCache?.records || [],
      rateLimited: true,
      errorType: 'rate_limited',
      errorMessageAr: 'تم الوصول لحد طلبات Binance مؤقتًا، سيتم إعادة المحاولة بعد انتهاء فترة التهدئة.',
    };
  }

  if (!options?.forceRefresh && historyCache && now - historyCache.fetchedAtMs < HISTORY_CACHE_TTL_MS) {
    return {
      ok: true,
      records: historyCache.records,
      fromCache: true,
    };
  }

  const limit = Math.min(100, Math.max(10, options?.limit ?? 100));
  const maxPages = Math.min(3, Math.max(1, options?.maxPages ?? 2));
  const allRecords: BinancePayTradeRecord[] = [];
  const seenIds = new Set<string>();

  let currentEndTime = options?.endTimeMs ?? now;
  const floorStartTime = options?.startTimeMs ?? now - 7 * 24 * 60 * 60 * 1000; // last 7 days window

  for (let page = 0; page < maxPages; page++) {
    const signed = buildBinanceSignedQuery({
      queryParams: {
        startTime: floorStartTime,
        endTime: currentEndTime,
        limit,
      },
      apiSecret: creds.apiSecret,
      recvWindowMs: creds.recvWindowMs,
    });

    try {
      const res = await fetch(`${BINANCE_SAPI_BASE}${PAY_TRANSACTIONS_PATH}?${signed.fullQuery}`, {
        method: 'GET',
        headers: {
          'X-MBX-APIKEY': creds.apiKey,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(12_000),
      });

      if (res.status === 429 || res.status === 418) {
        const retrySec = Number(res.headers.get('retry-after') || '60');
        rateLimitedUntilMs = Date.now() + Math.max(30, retrySec) * 1000;
        return {
          ok: false,
          records: allRecords,
          rateLimited: true,
          httpStatus: res.status,
          errorType: 'rate_limited',
          errorMessageAr: `تجاوز حد الاستخدام لدى Binance (HTTP ${res.status}). يرجى الانتظار ${retrySec} ثانية.`,
        };
      }

      if (res.status === 451) {
        return {
          ok: false,
          records: [],
          httpStatus: 451,
          errorType: 'region_restricted',
          errorMessageAr:
            'واجهة Binance محظورة جغرافيًا (HTTP 451) من منطقة الخادم الحالي. يجب استضافة الخادم في منطقة مدعومة من Binance.',
        };
      }

      const rawText = await res.text();
      let payload: any = {};
      try {
        payload = rawText ? JSON.parse(rawText) : {};
      } catch {
        payload = { msg: rawText };
      }

      if (!res.ok || (payload?.code && String(payload.code) !== '000000' && Number(payload.code) < 0)) {
        const bCode = Number(payload?.code || res.status);
        const rawMsg = String(payload?.msg || payload?.message || `HTTP ${res.status}`);
        const isAuthErr = [-2014, -2015, -1022, -1021, 401, 403].includes(bCode) || res.status === 401 || res.status === 403;
        return {
          ok: false,
          records: [],
          httpStatus: res.status,
          binanceCode: bCode,
          errorType: isAuthErr ? 'auth_permission' : 'api_error',
          errorMessageAr: isAuthErr
            ? `رفضت Binance المصادقة أو صلاحية القراءة (${bCode}): ${rawMsg}. تأكد من صلاحية Enable Reading وتقييد IP.`
            : `خطأ من واجهة Binance Pay Trade History (${bCode}): ${rawMsg}`,
        };
      }

      const pageData: BinancePayTradeRecord[] = Array.isArray(payload?.data) ? payload.data : [];
      for (const item of pageData) {
        const id = String(item.transactionId || '');
        if (id && !seenIds.has(id)) {
          seenIds.add(id);
          allRecords.push(item);
        }
      }

      if (pageData.length < limit) break;
      const oldestTime = Math.min(...pageData.map((r) => Number(r.transactionTime || currentEndTime)));
      if (!Number.isFinite(oldestTime) || oldestTime <= floorStartTime) break;
      currentEndTime = oldestTime - 1;
    } catch (err: any) {
      return {
        ok: false,
        records: allRecords,
        errorType: 'api_error',
        errorMessageAr: `تعذر الاتصال بـ https://api.binance.com: ${err?.message || 'خطأ شبكة مؤقت'}`,
      };
    }
  }

  historyCache = { fetchedAtMs: Date.now(), records: allRecords };
  await db
    .update(binancePaySettings)
    .set({ lastSyncAt: new Date(), lastSyncCount: allRecords.length, updatedAt: new Date() })
    .where(eq(binancePaySettings.singletonKey, 'primary'));

  return {
    ok: true,
    records: allRecords,
    fromCache: false,
  };
}

/**
 * Step 7 — Official Eligibility & Read-Only Key Security Check.
 * NEVER fakes success! Actually tests:
 * 1. Read-only key restrictions via GET /sapi/v1/account/apiRestrictions (warns/blocks if trading or withdrawals enabled!)
 * 2. Signed call to GET /sapi/v1/pay/transactions
 * 3. Confirms whether incoming Pay transfers are returned for the account
 * 4. Optional live test against a real small transactionId owned by the admin
 */
export async function runBinanceEligibilityCheck(options?: {
  testTransactionId?: string;
  testAmount?: string;
}): Promise<{
  eligible: boolean;
  status: 'eligible' | 'failed_permissions' | 'failed_region' | 'failed_no_incoming' | 'error';
  messageAr: string;
  steps: Array<{ name: string; ok: boolean; detail: string }>;
  incomingCount: number;
  totalFetched: number;
}> {
  const creds = await resolveBinanceCredentials();
  const steps: Array<{ name: string; ok: boolean; detail: string }> = [];

  if (!creds.apiKey || !creds.apiSecret || !creds.receiverId) {
    const msg =
      'البيانات غير مكتملة: أدخل Binance Receiver ID و BINANCE_API_KEY و BINANCE_API_SECRET (بصلاحية القراءة فقط) ثم أعد الاختبار.';
    await db
      .update(binancePaySettings)
      .set({
        eligibilityStatus: 'error',
        eligibilityMessageAr: msg,
        eligibilityCheckedAt: new Date(),
        autoVerifyEnabled: false,
      })
      .where(eq(binancePaySettings.singletonKey, 'primary'));

    return {
      eligible: false,
      status: 'error',
      messageAr: msg,
      steps: [{ name: 'التحقق من توفر المفاتيح و Binance ID', ok: false, detail: msg }],
      incomingCount: 0,
      totalFetched: 0,
    };
  }

  // Step 1: Check API Key Restrictions (ensure Read-Only, NO trading or withdrawals!)
  let restrictionsOk = true;
  try {
    const signedRestr = buildBinanceSignedQuery({
      queryParams: {},
      apiSecret: creds.apiSecret,
      recvWindowMs: creds.recvWindowMs,
    });
    const rRes = await fetch(`${BINANCE_SAPI_BASE}${API_RESTRICTIONS_PATH}?${signedRestr.fullQuery}`, {
      method: 'GET',
      headers: { 'X-MBX-APIKEY': creds.apiKey },
      signal: AbortSignal.timeout(10_000),
    });

    if (rRes.status === 451) {
      const msg =
        'واجهة Binance محظورة من المنطقة الجغرافية للخادم الحالي (HTTP 451). تم إيقاف التفعيل التلقائي لحماية الحساب.';
      await db
        .update(binancePaySettings)
        .set({
          eligibilityStatus: 'failed_region',
          eligibilityMessageAr: msg,
          eligibilityCheckedAt: new Date(),
          autoVerifyEnabled: false,
        })
        .where(eq(binancePaySettings.singletonKey, 'primary'));
      return {
        eligible: false,
        status: 'failed_region',
        messageAr: msg,
        steps: [{ name: 'فحص الاتصال بـ api.binance.com', ok: false, detail: msg }],
        incomingCount: 0,
        totalFetched: 0,
      };
    }

    const rJson = (await rRes.json().catch(() => ({}))) as Record<string, any>;
    if (!rRes.ok) {
      restrictionsOk = false;
      steps.push({
        name: 'فحص صلاحيات مفتاح API (قراءة فقط)',
        ok: false,
        detail: `فشل فحص الصلاحيات (${rJson?.code || rRes.status}): ${rJson?.msg || 'تحقق من المفتاح وIP'}`,
      });
    } else if (rJson.enableWithdrawals || rJson.enableSpotAndMarginTrading || rJson.enableInternalTransfer) {
      restrictionsOk = false;
      const msg =
        'تحذير أمني: مفتاح API يملك صلاحيات سحب أو تداول أو تحويل داخلي! يجب تعطيلها والإبقاء على Enable Reading فقط.';
      steps.push({ name: 'فحص صلاحيات مفتاح API (قراءة فقط)', ok: false, detail: msg });
      await db
        .update(binancePaySettings)
        .set({
          eligibilityStatus: 'failed_permissions',
          eligibilityMessageAr: msg,
          eligibilityCheckedAt: new Date(),
          autoVerifyEnabled: false,
        })
        .where(eq(binancePaySettings.singletonKey, 'primary'));
      return {
        eligible: false,
        status: 'failed_permissions',
        messageAr: msg,
        steps,
        incomingCount: 0,
        totalFetched: 0,
      };
    } else if (rJson.enableReading === false) {
      restrictionsOk = false;
      steps.push({
        name: 'فحص صلاحيات مفتاح API (قراءة فقط)',
        ok: false,
        detail: 'صلاحية القراءة (Enable Reading) غير مفعلة على هذا المفتاح.',
      });
    } else {
      steps.push({
        name: 'فحص صلاحيات مفتاح API (قراءة فقط)',
        ok: true,
        detail: 'المفتاح بصلاحية القراءة فقط بدون تداول أو سحب.',
      });
    }
  } catch (err: any) {
    restrictionsOk = false;
    steps.push({
      name: 'فحص صلاحيات مفتاح API (قراءة فقط)',
      ok: false,
      detail: `تعذر الوصول إلى apiRestrictions: ${err?.message || 'خطأ شبكة'}`,
    });
  }

  // Step 2: Signed request to GET /sapi/v1/pay/transactions
  const hist = await fetchBinancePayTradeHistory({ forceRefresh: true, limit: 50, maxPages: 1 });
  if (!hist.ok) {
    const status =
      hist.errorType === 'region_restricted'
        ? 'failed_region'
        : hist.errorType === 'auth_permission'
        ? 'failed_permissions'
        : 'error';
    const msg = hist.errorMessageAr || 'فشل الاستعلام من سجل Binance Pay Trade History.';
    steps.push({ name: 'استعلام GET /sapi/v1/pay/transactions', ok: false, detail: msg });
    await db
      .update(binancePaySettings)
      .set({
        eligibilityStatus: status,
        eligibilityMessageAr: msg,
        eligibilityCheckedAt: new Date(),
        autoVerifyEnabled: false,
      })
      .where(eq(binancePaySettings.singletonKey, 'primary'));
    return {
      eligible: false,
      status,
      messageAr: msg,
      steps,
      incomingCount: 0,
      totalFetched: 0,
    };
  }

  steps.push({
    name: 'استعلام GET /sapi/v1/pay/transactions',
    ok: true,
    detail: `نجح الاستعلام وتم جلب ${hist.records.length} معاملة من سجل Binance Pay.`,
  });

  // Step 3: Verify response includes incoming transfers (NEVER assume API 200 means incoming transfers are visible!)
  const incoming = hist.records.filter((r) => {
    try {
      return new Decimal(r.amount || '0').gt(0);
    } catch {
      return false;
    }
  });

  if (incoming.length === 0) {
    const msg =
      'نجح الاتصال بـ Binance API لكن لم يتم العثور على أي تحويلات واردة في سجل Binance Pay لحسابك بعد. أرسل تحويلًا تجريبيًا صغيرًا بـ USDT إلى حسابك ثم أعد الاختبار.';
    steps.push({ name: 'التحقق من وجود تحويلات واردة في السجل', ok: false, detail: msg });
    await db
      .update(binancePaySettings)
      .set({
        eligibilityStatus: 'failed_no_incoming',
        eligibilityMessageAr: msg,
        eligibilityCheckedAt: new Date(),
        autoVerifyEnabled: false,
      })
      .where(eq(binancePaySettings.singletonKey, 'primary'));
    return {
      eligible: false,
      status: 'failed_no_incoming',
      messageAr: msg,
      steps,
      incomingCount: 0,
      totalFetched: hist.records.length,
    };
  }

  steps.push({
    name: 'التحقق من وجود تحويلات واردة في السجل',
    ok: true,
    detail: `تم العثور على ${incoming.length} تحويل وارد حقيقي في سجل Binance Pay.`,
  });

  // Step 4: Optional real test reference verification + duplicate check
  if (options?.testTransactionId && options.testTransactionId.trim()) {
    const usedRows = await db.select({ transactionId: binanceUsedTransactions.transactionId }).from(binanceUsedTransactions);
    const usedSet = new Set(usedRows.map((u) => u.transactionId));
    const check = verifyBinancePayTransaction({
      submittedTransactionId: options.testTransactionId.trim(),
      expectedAmount: options.testAmount || '1',
      expectedCurrency: 'USDT',
      expectedReceiverId: creds.receiverId,
      depositCreatedAtMs: Date.now() - 30 * 24 * 60 * 60 * 1000, // allow testing a recent real transfer up to 30d old
      alreadyUsedTransactionIds: usedSet,
      historyRecords: hist.records,
    });
    steps.push({
      name: 'اختبار الرقم المرجعي الحقيقي وتطابق المبلغ والعملة والمستلم',
      ok: check.outcome === 'paid',
      detail:
        check.outcome === 'paid'
          ? `تمت مطابقة الرقم المرجعي ${options.testTransactionId.trim()} بنجاح (${check.verifiedAmount} USDT).`
          : `فشل اختبار الرقم المرجعي: ${check.reasonCode}`,
    });
    if (check.outcome !== 'paid') {
      const msg = `تعذر التحقق من الرقم المرجعي الاختباري (${check.reasonCode}). لم يتم تفعيل التحقق التلقائي.`;
      await db
        .update(binancePaySettings)
        .set({
          eligibilityStatus: 'error',
          eligibilityMessageAr: msg,
          eligibilityCheckedAt: new Date(),
          autoVerifyEnabled: false,
        })
        .where(eq(binancePaySettings.singletonKey, 'primary'));
      return {
        eligible: false,
        status: 'error',
        messageAr: msg,
        steps,
        incomingCount: incoming.length,
        totalFetched: hist.records.length,
      };
    }
  }

  if (!restrictionsOk) {
    const msg = 'تعذر التحقق من قيود مفتاح API (قراءة فقط). أوقفنا التفعيل التلقائي كإجراء أمان.';
    await db
      .update(binancePaySettings)
      .set({
        eligibilityStatus: 'failed_permissions',
        eligibilityMessageAr: msg,
        eligibilityCheckedAt: new Date(),
        autoVerifyEnabled: false,
      })
      .where(eq(binancePaySettings.singletonKey, 'primary'));
    return {
      eligible: false,
      status: 'failed_permissions',
      messageAr: msg,
      steps,
      incomingCount: incoming.length,
      totalFetched: hist.records.length,
    };
  }

  const okMsg = `اجتاز الحساب جميع اختبارات الأهلية بنجاح (${incoming.length} تحويل وارد مؤكد). التحقق التلقائي جاهز ومفعّل.`;
  await db
    .update(binancePaySettings)
    .set({
      eligibilityStatus: 'eligible',
      eligibilityMessageAr: okMsg,
      eligibilityCheckedAt: new Date(),
      autoVerifyEnabled: true,
    })
    .where(eq(binancePaySettings.singletonKey, 'primary'));

  return {
    eligible: true,
    status: 'eligible',
    messageAr: okMsg,
    steps,
    incomingCount: incoming.length,
    totalFetched: hist.records.length,
  };
}

/**
 * Atomic Database Transaction for Binance ID Deposit Credit (Section 4):
 * 1. Locks deposit row FOR UPDATE
 * 2. Inserts transactionId into `binance_used_transactions` (UNIQUE constraint blocks concurrent double credit!)
 * 3. Adds Decimal USDT amount to customer wallet
 * 4. Saves unique immutable `wallet_ledger` record
 * 5. Updates deposit status to `paid`
 * 6. Creates localized customer notification & admin notification
 */
export async function creditBinanceDepositAtomically(params: {
  depositId: number;
  transactionId: string;
  creditedAmount: string;
  orderType: string;
  receiverId: string;
  transactionTimeMs: number;
}): Promise<{
  ok: boolean;
  alreadyProcessed?: boolean;
  duplicateTransactionId?: boolean;
  newBalance?: string;
  userLang?: SupportedLang;
}> {
  return db.transaction(async (tx) => {
    const [dep] = await tx
      .select()
      .from(deposits)
      .where(eq(deposits.id, params.depositId))
      .for('update');

    if (!dep) throw new Error('DEPOSIT_NOT_FOUND');
    if (dep.status === 'paid' || dep.status === 'confirmed' || dep.creditedAt) {
      return { ok: true, alreadyProcessed: true };
    }

    // Check if transactionId already used inside the same DB transaction
    const existingUsed = await tx
      .select()
      .from(binanceUsedTransactions)
      .where(eq(binanceUsedTransactions.transactionId, params.transactionId))
      .limit(1);

    if (existingUsed.length > 0) {
      return { ok: false, duplicateTransactionId: true };
    }

    // Insert unique transaction record FIRST (PostgreSQL UNIQUE index prevents race conditions!)
    try {
      await tx.insert(binanceUsedTransactions).values({
        transactionId: params.transactionId,
        depositId: dep.id,
        userId: dep.userId,
        amount: new Decimal(params.creditedAmount).toFixed(4),
        currency: 'USDT',
        orderType: params.orderType || 'C2C',
        receiverId: params.receiverId || '',
        transactionTime: new Date(params.transactionTimeMs || Date.now()),
      });
    } catch (err: any) {
      if (err?.code === '23505') {
        return { ok: false, duplicateTransactionId: true };
      }
      throw err;
    }

    await tx
      .insert(wallets)
      .values({ userId: dep.userId, currency: 'USD', availableBalance: '0.0000', reservedBalance: '0.0000' })
      .onConflictDoNothing();

    const [wallet] = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.userId, dep.userId))
      .for('update');

    const transition = computeCreditTransition(
      { availableBalance: wallet.availableBalance, reservedBalance: wallet.reservedBalance },
      params.creditedAmount
    );
    if (!transition.ok || !transition.next) {
      throw new Error(transition.errorCode || 'INVALID_CREDIT_AMOUNT');
    }

    const ledgerRef = `BN-DEP-${dep.id}-${params.transactionId.slice(-8)}`;
    await tx
      .update(wallets)
      .set({
        availableBalance: transition.next.availableBalance,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, wallet.id));

    await tx.insert(walletLedger).values({
      referenceCode: ledgerRef,
      walletId: wallet.id,
      userId: dep.userId,
      entryType: 'deposit',
      amount: new Decimal(params.creditedAmount).toFixed(4),
      balanceBefore: wallet.availableBalance,
      balanceAfter: transition.next.availableBalance,
      relatedDepositId: dep.id,
      note: `شحن تلقائي عبر Binance ID (${dep.depositRef})`,
    });

    await tx
      .update(deposits)
      .set({
        status: 'paid',
        binanceTransactionId: params.transactionId,
        txHash: params.transactionId,
        receivedAmount: new Decimal(params.creditedAmount).toFixed(4),
        creditedAt: new Date(),
        lastCheckedAt: new Date(),
        verificationNote: 'AUTO_VERIFIED_BINANCE_PAY_HISTORY',
        updatedAt: new Date(),
      })
      .where(eq(deposits.id, dep.id));

    await tx
      .insert(paymentTransactions)
      .values({
        depositId: dep.id,
        gateway: 'binance_personal_pay',
        externalTxnId: params.transactionId,
        rawStatus: 'PAID',
        signatureVerified: true,
        payloadSanitizedJson: {
          amount: params.creditedAmount,
          currency: 'USDT',
          orderType: params.orderType,
          transactionTime: params.transactionTimeMs,
        },
      })
      .onConflictDoNothing();

    const [userRow] = await tx.select().from(users).where(eq(users.id, dep.userId)).limit(1);
    const userLang: SupportedLang = userRow?.languageCode === 'en' ? 'en' : 'ar';

    // Customer notification in their persisted language
    await tx.insert(notifications).values({
      audience: 'customer',
      targetUserId: dep.userId,
      eventType: 'new_deposit',
      severity: 'info',
      titleAr: t(userLang, 'notif_deposit_credited_title'),
      bodyAr: t(userLang, 'notif_deposit_credited_body', {
        txId: params.transactionId,
        amount: new Decimal(params.creditedAmount).toFixed(2),
      }),
    });

    // Admin notification
    await tx.insert(notifications).values({
      audience: 'admin',
      eventType: 'new_deposit',
      severity: 'info',
      titleAr: `إيداع Binance ID مؤكد تلقائيًا (${dep.depositRef})`,
      bodyAr: `تم التحقق التلقائي وإضافة $${new Decimal(params.creditedAmount).toFixed(2)} USDT للعميل ${userRow?.displayName || `#${dep.userId}`} — المرجع: ${params.transactionId}.`,
    });

    return {
      ok: true,
      alreadyProcessed: false,
      newBalance: transition.next.availableBalance,
      userLang,
    };
  });
}

/**
 * Full end-to-end verification attempt for a customer's submitted Binance Transaction ID.
 */
export async function attemptBinanceDepositAutoVerification(params: {
  depositId: number;
  submittedTransactionId: string;
  lang: SupportedLang;
}): Promise<{
  status: 'paid' | 'pending' | 'rejected';
  reasonKey: string;
  reasonText: string;
  creditedAmount?: string;
  newBalance?: string;
}> {
  const cleanTxId = params.submittedTransactionId.trim();
  const [dep] = await db.select().from(deposits).where(eq(deposits.id, params.depositId)).limit(1);
  if (!dep) {
    return { status: 'rejected', reasonKey: 'verify_reason_not_found', reasonText: t(params.lang, 'verify_reason_not_found') };
  }

  if (dep.status === 'paid' || dep.status === 'confirmed') {
    const [w] = await db.select().from(wallets).where(eq(wallets.userId, dep.userId)).limit(1);
    return {
      status: 'paid',
      reasonKey: 'VERIFIED',
      reasonText: '',
      creditedAmount: new Decimal(dep.receivedAmount || dep.expectedAmount).toFixed(2),
      newBalance: new Decimal(w?.availableBalance || '0').toFixed(2),
    };
  }

  // Always check duplicate transaction ID first (even before hitting Binance API!)
  const existingUsed = await db
    .select()
    .from(binanceUsedTransactions)
    .where(eq(binanceUsedTransactions.transactionId, cleanTxId))
    .limit(1);

  if (existingUsed.length > 0) {
    await db
      .update(deposits)
      .set({
        binanceTransactionId: cleanTxId,
        status: 'rejected',
        rejectionReason: 'DUPLICATE_TRANSACTION_ID',
        lastCheckedAt: new Date(),
        verificationAttempts: sql`${deposits.verificationAttempts} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(deposits.id, dep.id));

    await db.insert(notifications).values({
      audience: 'admin',
      eventType: 'duplicate_txid',
      severity: 'critical',
      titleAr: 'محاولة إعادة استخدام رقم مرجعي لـ Binance ID',
      bodyAr: `طلب الإيداع ${dep.depositRef} حاول إعادة استخدام Transaction ID مستخدم سابقًا: ${cleanTxId}.`,
    });

    return {
      status: 'rejected',
      reasonKey: 'verify_reason_duplicate',
      reasonText: t(params.lang, 'verify_reason_duplicate'),
    };
  }

  // Save transaction ID & keep deposit in PENDING state while querying Binance Pay Trade History
  await db
    .update(deposits)
    .set({
      binanceTransactionId: cleanTxId,
      status: 'pending',
      lastCheckedAt: new Date(),
      verificationAttempts: sql`${deposits.verificationAttempts} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(deposits.id, dep.id));

  const creds = await resolveBinanceCredentials();
  if (!creds.autoVerifyEnabled) {
    return {
      status: 'pending',
      reasonKey: 'verify_reason_api_unavailable',
      reasonText: t(params.lang, 'verify_reason_api_unavailable'),
    };
  }

  const hist = await fetchBinancePayTradeHistory({
    startTimeMs: Math.max(Date.now() - 48 * 60 * 60 * 1000, dep.createdAt.getTime() - 15 * 60 * 1000),
    limit: 100,
    maxPages: 2,
  });

  if (!hist.ok) {
    const key = hist.rateLimited ? 'verify_reason_rate_limited' : 'verify_reason_api_unavailable';
    await db
      .update(deposits)
      .set({ verificationNote: hist.errorType || 'API_UNAVAILABLE', updatedAt: new Date() })
      .where(eq(deposits.id, dep.id));
    return {
      status: 'pending',
      reasonKey: key,
      reasonText: t(params.lang, key),
    };
  }

  const allUsedRows = await db.select({ id: binanceUsedTransactions.transactionId }).from(binanceUsedTransactions);
  const usedSet = new Set(allUsedRows.map((r) => r.id));

  const verdict = verifyBinancePayTransaction({
    submittedTransactionId: cleanTxId,
    expectedAmount: dep.expectedAmount,
    expectedCurrency: 'USDT',
    expectedReceiverId: creds.receiverId,
    depositCreatedAtMs: dep.createdAt.getTime(),
    alreadyUsedTransactionIds: usedSet,
    historyRecords: hist.records,
  });

  if (verdict.outcome === 'paid' && verdict.matchedRecord && verdict.verifiedAmount) {
    const creditRes = await creditBinanceDepositAtomically({
      depositId: dep.id,
      transactionId: cleanTxId,
      creditedAmount: verdict.verifiedAmount,
      orderType: verdict.matchedRecord.orderType || 'C2C',
      receiverId: creds.receiverId,
      transactionTimeMs: verdict.matchedRecord.transactionTime || Date.now(),
    });

    if (creditRes.duplicateTransactionId) {
      return {
        status: 'rejected',
        reasonKey: 'verify_reason_duplicate',
        reasonText: t(params.lang, 'verify_reason_duplicate'),
      };
    }

    return {
      status: 'paid',
      reasonKey: 'VERIFIED',
      reasonText: '',
      creditedAmount: new Decimal(verdict.verifiedAmount).toFixed(2),
      newBalance: creditRes.newBalance ? new Decimal(creditRes.newBalance).toFixed(2) : undefined,
    };
  }

  if (verdict.outcome === 'rejected') {
    await db
      .update(deposits)
      .set({
        status: 'rejected',
        rejectionReason: verdict.reasonCode,
        verificationNote: verdict.reasonCode,
        updatedAt: new Date(),
      })
      .where(eq(deposits.id, dep.id));
    return {
      status: 'rejected',
      reasonKey: verdict.i18nReasonKey,
      reasonText: t(params.lang, verdict.i18nReasonKey),
    };
  }

  // Still pending — safe retry later by background worker
  await db
    .update(deposits)
    .set({
      status: 'pending',
      verificationNote: verdict.reasonCode,
      updatedAt: new Date(),
    })
    .where(eq(deposits.id, dep.id));

  return {
    status: 'pending',
    reasonKey: verdict.i18nReasonKey,
    reasonText: t(params.lang, verdict.i18nReasonKey),
  };
}

/**
 * Background Worker: safely polls pending Binance ID deposits that already have a submitted Transaction ID
 * using a single shared cached Binance Pay Trade History call (never hammers Binance API!).
 */
let workerStarted = false;
export function startBinancePendingDepositWorker(onDepositPaid?: (userId: number, depositRef: string, amount: string, txId: string, lang: SupportedLang) => Promise<void>) {
  if (workerStarted) return;
  workerStarted = true;

  setInterval(async () => {
    try {
      const creds = await resolveBinanceCredentials();
      if (!creds.autoVerifyEnabled) return;

      const pendingRows = await db
        .select({ dep: deposits, user: users })
        .from(deposits)
        .innerJoin(users, eq(deposits.userId, users.id))
        .where(and(eq(deposits.method, 'binance_id'), eq(deposits.status, 'pending')))
        .orderBy(desc(deposits.createdAt))
        .limit(20);

      const actionable = pendingRows.filter(
        (r) =>
          Boolean(r.dep.binanceTransactionId) &&
          r.dep.verificationAttempts < 24 &&
          Date.now() - r.dep.createdAt.getTime() < 24 * 60 * 60 * 1000
      );

      if (actionable.length === 0) return;

      for (const row of actionable) {
        const lang: SupportedLang = row.user.languageCode === 'en' ? 'en' : 'ar';
        const res = await attemptBinanceDepositAutoVerification({
          depositId: row.dep.id,
          submittedTransactionId: row.dep.binanceTransactionId!,
          lang,
        });
        if (res.status === 'paid' && onDepositPaid && res.creditedAmount) {
          await onDepositPaid(row.dep.userId, row.dep.depositRef, res.creditedAmount, row.dep.binanceTransactionId!, lang);
        }
      }
    } catch (err) {
      console.error('Binance pending deposit worker tick error:', err);
    }
  }, 30_000);
}

/**
 * Admin overview stats for Binance ID Auto-Verification panel
 */
export async function getBinanceAdminSummary() {
  const settingsRow = await getBinanceSettingsRow();
  const binanceDeps = await db
    .select()
    .from(deposits)
    .where(inArray(deposits.method, ['binance_id', 'binance_pay']));

  const paidCount = binanceDeps.filter((d) => d.status === 'paid' || d.status === 'confirmed').length;
  const pendingCount = binanceDeps.filter((d) => d.status === 'pending' || d.status === 'pending_review').length;
  const rejectedCount = binanceDeps.filter((d) => d.status === 'rejected').length;

  const usedRows = await db
    .select({
      tx: binanceUsedTransactions,
      user: users,
      dep: deposits,
    })
    .from(binanceUsedTransactions)
    .innerJoin(users, eq(binanceUsedTransactions.userId, users.id))
    .innerJoin(deposits, eq(binanceUsedTransactions.depositId, deposits.id))
    .orderBy(desc(binanceUsedTransactions.verifiedAt))
    .limit(40);

  return {
    config: {
      binanceReceiverId: settingsRow.binanceReceiverId || process.env.BINANCE_RECEIVER_ID || '',
      hasApiKey: Boolean(settingsRow.encryptedApiKey || process.env.BINANCE_API_KEY),
      apiKeyFingerprint:
        settingsRow.apiKeyFingerprint ||
        (process.env.BINANCE_API_KEY ? maskApiKey(process.env.BINANCE_API_KEY) : null),
      hasApiSecret: Boolean(settingsRow.encryptedApiSecret || process.env.BINANCE_API_SECRET),
      apiSecretFingerprint:
        settingsRow.apiSecretFingerprint ||
        (process.env.BINANCE_API_SECRET ? maskApiKey(process.env.BINANCE_API_SECRET) : null),
      recvWindowMs: settingsRow.recvWindowMs,
      autoVerifyEnabled: settingsRow.autoVerifyEnabled,
      eligibilityStatus: settingsRow.eligibilityStatus,
      eligibilityMessageAr: settingsRow.eligibilityMessageAr,
      eligibilityCheckedAt: settingsRow.eligibilityCheckedAt,
      lastSyncAt: settingsRow.lastSyncAt,
      lastSyncCount: settingsRow.lastSyncCount,
    },
    stats: {
      paidCount,
      pendingCount,
      rejectedCount,
      totalUsedReferences: usedRows.length,
    },
    usedTransactions: usedRows.map((r) => ({
      id: r.tx.id,
      transactionId: r.tx.transactionId,
      depositRef: r.dep.depositRef,
      customerName: r.user.displayName,
      amount: new Decimal(r.tx.amount).toFixed(2),
      currency: r.tx.currency,
      orderType: r.tx.orderType,
      receiverId: r.tx.receiverId,
      transactionTime: r.tx.transactionTime,
      verifiedAt: r.tx.verifiedAt,
    })),
  };
}
