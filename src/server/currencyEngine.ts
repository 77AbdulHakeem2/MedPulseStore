import Decimal from 'decimal.js';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { exchangeRateLogs, settings } from '../db/schema.ts';
import type { SupportedLang } from '../i18n/index.ts';

export type DisplayCurrency = 'USD' | 'YER';
export type YeRialMarket = 'sanaa' | 'aden';
export type YeRialRateType = 'buy' | 'sell' | 'mid';
export type YerRoundingMode = 'exact' | 'nearest_1' | 'nearest_10' | 'nearest_50' | 'nearest_100';

export const CURRENCY_SETTINGS_KEY = 'currency_local_deposit_settings';
export const YE_RIAL_ALLOWED_HOST = 'ye-rial.com';

export interface CurrencyLocalDepositSettings {
  localDepositsEnabled: boolean;
  market: YeRialMarket;
  rateType: YeRialRateType;
  roundingMode: YerRoundingMode;
  maxRateAgeMinutes: number; // Max staleness of provider's last_verified_at before fail-closed
  minDepositYer: number;
  maxDepositYer: number;
  reviewChannelId: string; // e.g. @channel_name or -100xxxxxxxxxx
  reviewChannelTitle: string;
  reviewChannelVerified: boolean;
  reviewChannelVerifiedAt: string | null;
}

export const DEFAULT_CURRENCY_LOCAL_DEPOSIT_SETTINGS: CurrencyLocalDepositSettings = {
  localDepositsEnabled: true,
  market: 'sanaa',
  rateType: 'buy',
  roundingMode: 'nearest_10',
  maxRateAgeMinutes: 720, // 12 hours verification window for provider sync
  minDepositYer: 1000,
  maxDepositYer: 500000,
  reviewChannelId: '',
  reviewChannelTitle: '',
  reviewChannelVerified: false,
  reviewChannelVerifiedAt: null,
};

export interface LiveExchangeRateResult {
  ok: boolean;
  rate: string | null; // 4dp decimal string e.g. "530.0000"
  buyRate: string | null;
  sellRate: string | null;
  market: YeRialMarket;
  rateType: YeRialRateType;
  source: string;
  sourceUrl: string;
  providerLastVerifiedAt: Date | null;
  providerLastPriceChange: Date | null;
  fetchedAt: Date;
  fromCache: boolean;
  providerTimestampStale?: boolean;
  usedFallback?: boolean;
  errorCode?:
    | 'API_UNREACHABLE'
    | 'INVALID_RESPONSE'
    | 'RATE_OUT_OF_RANGE'
    | 'RATE_STALE'
    | 'MARKET_MISSING';
  errorMessageAr?: string;
  errorMessageEn?: string;
}

const MIN_SANE_YER_RATE = 100;
const MAX_SANE_YER_RATE = 10000;
const DISPLAY_CACHE_TTL_MS = 60 * 1000; // 60 seconds short cache for browsing display

const BASELINE_FALLBACK_RATES: Record<YeRialMarket, { buy: string; sell: string }> = {
  sanaa: { buy: '530.0000', sell: '533.0000' },
  aden: { buy: '1620.0000', sell: '1635.0000' },
};

interface CachedRateEntry {
  cacheKey: string;
  expiresAtMs: number;
  result: LiveExchangeRateResult;
}

interface LastKnownGoodMarketRate {
  buyRate: string;
  sellRate: string;
  providerLastVerifiedAt: Date | null;
  providerLastPriceChange: Date | null;
  fetchedAt: Date;
}

let inMemoryRateCache: CachedRateEntry | null = null;
const lastKnownGoodByMarket = new Map<YeRialMarket, LastKnownGoodMarketRate>();

export function computeEffectiveYerRate(
  buyRate: string | number | Decimal,
  sellRate: string | number | Decimal,
  rateType: YeRialRateType
): string {
  const buyDec = new Decimal(buyRate);
  const sellDec = new Decimal(sellRate);
  const effective =
    rateType === 'sell'
      ? sellDec
      : rateType === 'mid'
      ? buyDec.plus(sellDec).div(2)
      : buyDec;
  return effective.toFixed(4);
}

/**
 * Pure fallback resolver used ONLY when live ye-rial.com is temporarily unreachable or invalid.
 * Guarantees 24/7 uninterrupted USD <-> YER conversion using the latest verified rate or safe baseline.
 */
export function resolveFallbackExchangeRate(params: {
  market: YeRialMarket;
  rateType: YeRialRateType;
  lastKnownGood?: LastKnownGoodMarketRate | null;
  nowMs?: number;
}): LiveExchangeRateResult {
  const nowMs = typeof params.nowMs === 'number' ? params.nowMs : Date.now();
  const sourceUrl = buildYeRialApiUrl(params.market);
  const fetchedAt = new Date(nowMs);

  const lkg = params.lastKnownGood;
  const hasValidLkg =
    Boolean(lkg) &&
    Number.isFinite(Number(lkg?.buyRate)) &&
    Number.isFinite(Number(lkg?.sellRate)) &&
    Number(lkg!.buyRate) >= MIN_SANE_YER_RATE &&
    Number(lkg!.buyRate) <= MAX_SANE_YER_RATE &&
    Number(lkg!.sellRate) >= MIN_SANE_YER_RATE &&
    Number(lkg!.sellRate) <= MAX_SANE_YER_RATE;

  const buyRate = hasValidLkg ? new Decimal(lkg!.buyRate).toFixed(4) : BASELINE_FALLBACK_RATES[params.market].buy;
  const sellRate = hasValidLkg ? new Decimal(lkg!.sellRate).toFixed(4) : BASELINE_FALLBACK_RATES[params.market].sell;
  const rate = computeEffectiveYerRate(buyRate, sellRate, params.rateType);

  return {
    ok: true,
    rate,
    buyRate,
    sellRate,
    market: params.market,
    rateType: params.rateType,
    source: hasValidLkg ? `${YE_RIAL_ALLOWED_HOST} (cached)` : `${YE_RIAL_ALLOWED_HOST} (baseline)`,
    sourceUrl,
    providerLastVerifiedAt: hasValidLkg ? lkg!.providerLastVerifiedAt : null,
    providerLastPriceChange: hasValidLkg ? lkg!.providerLastPriceChange : null,
    fetchedAt,
    fromCache: true,
    usedFallback: true,
    providerTimestampStale: true,
  };
}

export function normalizeDisplayCurrency(val: unknown): DisplayCurrency {
  return String(val || '').toUpperCase() === 'YER' ? 'YER' : 'USD';
}

export function normalizeYeRialMarket(val: unknown): YeRialMarket {
  return String(val || '').toLowerCase() === 'aden' ? 'aden' : 'sanaa';
}

export function normalizeYeRialRateType(val: unknown): YeRialRateType {
  const v = String(val || '').toLowerCase();
  if (v === 'sell' || v === 'mid') return v;
  return 'buy';
}

export function normalizeYerRoundingMode(val: unknown): YerRoundingMode {
  const v = String(val || '').toLowerCase();
  if (v === 'exact' || v === 'nearest_1' || v === 'nearest_10' || v === 'nearest_50' || v === 'nearest_100') {
    return v;
  }
  return 'nearest_10';
}

/**
 * Builds the strict allowlisted ye-rial.com URL (prevents SSRF by never accepting arbitrary URLs).
 */
export function buildYeRialApiUrl(market: YeRialMarket): string {
  const safeMarket: YeRialMarket = market === 'aden' ? 'aden' : 'sanaa';
  return `https://${YE_RIAL_ALLOWED_HOST}/api/v1/current/?market=${safeMarket}&type=currency`;
}

/**
 * Parses timestamps returned by ye-rial.com (e.g. "2026-11-21 16:31:10" in Asia/Aden UTC+3).
 */
export function parseAdenTimestamp(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Already ISO with timezone
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(trimmed)) {
    const dt = new Date(trimmed);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  // Format "YYYY-MM-DD HH:mm:ss" in Asia/Aden (+03:00)
  const normalized = trimmed.replace(' ', 'T') + '+03:00';
  const dt = new Date(normalized);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * Pure parser and validator for ye-rial.com API payload.
 * Validates schema, numeric bounds, and freshness against `last_verified_at` / `last_sync`.
 */
export function parseYeRialApiResponse(params: {
  payload: any;
  market: YeRialMarket;
  rateType: YeRialRateType;
  nowMs?: number;
  maxAgeMinutes?: number;
}): LiveExchangeRateResult {
  const nowMs = typeof params.nowMs === 'number' ? params.nowMs : Date.now();
  const maxAgeMinutes = Math.max(5, Math.min(10080, Number(params.maxAgeMinutes || 720)));
  const sourceUrl = buildYeRialApiUrl(params.market);
  const fetchedAt = new Date(nowMs);

  const raw = params.payload;
  if (!raw || typeof raw !== 'object' || raw.status !== 'success' || !raw.data || typeof raw.data !== 'object') {
    return {
      ok: false,
      rate: null,
      buyRate: null,
      sellRate: null,
      market: params.market,
      rateType: params.rateType,
      source: YE_RIAL_ALLOWED_HOST,
      sourceUrl,
      providerLastVerifiedAt: null,
      providerLastPriceChange: null,
      fetchedAt,
      fromCache: false,
      errorCode: 'INVALID_RESPONSE',
      errorMessageAr: 'تعذر قراءة سعر الصرف الحي من مزود الأسعار حاليًا. تم إيقاف التحويل لحماية رصيدك.',
      errorMessageEn: 'Unable to parse live exchange rate from provider. Conversion paused for safety.',
    };
  }

  const marketObj = raw.data[params.market];
  const usdObj = marketObj?.items?.usd;
  if (!usdObj || typeof usdObj !== 'object') {
    return {
      ok: false,
      rate: null,
      buyRate: null,
      sellRate: null,
      market: params.market,
      rateType: params.rateType,
      source: YE_RIAL_ALLOWED_HOST,
      sourceUrl,
      providerLastVerifiedAt: null,
      providerLastPriceChange: null,
      fetchedAt,
      fromCache: false,
      errorCode: 'MARKET_MISSING',
      errorMessageAr: 'بيانات سعر الدولار للسوق المحدد غير متوفرة حاليًا.',
      errorMessageEn: 'USD rate data for the selected market is currently unavailable.',
    };
  }

  const buyNum = Number(usdObj.buy);
  const sellNum = Number(usdObj.sell);
  if (
    !Number.isFinite(buyNum) ||
    !Number.isFinite(sellNum) ||
    buyNum < MIN_SANE_YER_RATE ||
    buyNum > MAX_SANE_YER_RATE ||
    sellNum < MIN_SANE_YER_RATE ||
    sellNum > MAX_SANE_YER_RATE
  ) {
    return {
      ok: false,
      rate: null,
      buyRate: null,
      sellRate: null,
      market: params.market,
      rateType: params.rateType,
      source: YE_RIAL_ALLOWED_HOST,
      sourceUrl,
      providerLastVerifiedAt: null,
      providerLastPriceChange: null,
      fetchedAt,
      fromCache: false,
      errorCode: 'RATE_OUT_OF_RANGE',
      errorMessageAr: 'سعر الصرف الوارد غير طبيعي. تم إيقاف التحويل لحماية العمليات المالية.',
      errorMessageEn: 'Received exchange rate is outside safe bounds. Conversion paused.',
    };
  }

  const buyDec = new Decimal(buyNum);
  const sellDec = new Decimal(sellNum);
  const effectiveDec =
    params.rateType === 'sell'
      ? sellDec
      : params.rateType === 'mid'
      ? buyDec.plus(sellDec).div(2)
      : buyDec;

  const verifiedAt =
    parseAdenTimestamp(raw.last_verified_at) ||
    parseAdenTimestamp(raw.last_sync) ||
    parseAdenTimestamp(usdObj.updated_at);
  const priceChangeAt =
    parseAdenTimestamp(usdObj.updated_at) || parseAdenTimestamp(raw.last_price_change);

  // Informational freshness flag: ye-rial.com often refreshes `last_verified_at` only once daily
  // (e.g., midnight Aden time) or less on weekends/stable markets, so a live successful response
  // with valid numeric bounds MUST stay usable 24/7 rather than blocking currency conversion.
  const providerTimestampStale = Boolean(
    verifiedAt && nowMs - verifiedAt.getTime() > maxAgeMinutes * 60 * 1000
  );

  return {
    ok: true,
    rate: effectiveDec.toFixed(4),
    buyRate: buyDec.toFixed(4),
    sellRate: sellDec.toFixed(4),
    market: params.market,
    rateType: params.rateType,
    source: YE_RIAL_ALLOWED_HOST,
    sourceUrl,
    providerLastVerifiedAt: verifiedAt,
    providerLastPriceChange: priceChangeAt,
    fetchedAt,
    fromCache: false,
    providerTimestampStale,
    usedFallback: false,
  };
}

/**
 * Pure Decimal USD -> YER conversion with configurable rounding.
 */
export function convertUsdToYer(
  usdAmount: string | number | Decimal,
  exchangeRate: string | number | Decimal,
  roundingMode: YerRoundingMode = 'nearest_10'
): Decimal {
  const usd = new Decimal(usdAmount || 0);
  const rate = new Decimal(exchangeRate || 0);
  if (rate.lte(0)) throw new Error('INVALID_EXCHANGE_RATE');
  const raw = usd.times(rate);
  if (raw.isZero()) return new Decimal(0);

  const isNeg = raw.isNegative();
  const abs = raw.abs();
  let rounded: Decimal;
  switch (roundingMode) {
    case 'exact':
      rounded = abs.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      break;
    case 'nearest_1':
      rounded = abs.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
      break;
    case 'nearest_10':
      rounded = abs.div(10).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(10);
      break;
    case 'nearest_50':
      rounded = abs.div(50).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(50);
      break;
    case 'nearest_100':
      rounded = abs.div(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(100);
      break;
    default:
      rounded = abs.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  }
  return isNeg ? rounded.negated() : rounded;
}

/**
 * Pure Decimal YER -> USD conversion (4dp internal wallet precision).
 */
export function convertYerToUsd(
  yerAmount: string | number | Decimal,
  exchangeRate: string | number | Decimal
): string {
  const yer = new Decimal(yerAmount || 0);
  const rate = new Decimal(exchangeRate || 0);
  if (rate.lte(0)) throw new Error('INVALID_EXCHANGE_RATE');
  return yer.div(rate).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
}

/**
 * Formats a raw YER number cleanly with thousands separators and `﷼` symbol (e.g. `5,000 ﷼`).
 */
export function formatYerNumber(yerAmount: string | number | Decimal, decimals = 0): string {
  const dec = new Decimal(yerAmount || 0);
  const fixed = decimals > 0 ? dec.toFixed(decimals) : dec.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
  const [intPart, fracPart] = fixed.split('.');
  const formattedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fracPart && Number(fracPart) !== 0 ? `${formattedInt}.${fracPart} ﷼` : `${formattedInt} ﷼`;
}

/**
 * Formats an internal USD amount in the user's chosen display currency.
 * - When `currency === 'YER'` and a valid `exchangeRate` is provided: shows YER ONLY (`﷼`), never cluttering with USD!
 * - When `currency === 'USD'` (or rate unavailable fallback for non-financial display): shows USD (`$X.XX` or `X.XX USDT`).
 */
export function formatDisplayPrice(params: {
  usdAmount: string | number | Decimal;
  currency: DisplayCurrency;
  exchangeRate?: string | number | null;
  roundingMode?: YerRoundingMode;
  usdStyle?: 'dollar' | 'usdt';
  signed?: boolean;
}): string {
  const usdDec = new Decimal(params.usdAmount || 0);
  const signPrefix = params.signed && usdDec.gt(0) ? '+' : '';

  if (params.currency === 'YER' && params.exchangeRate && new Decimal(params.exchangeRate).gt(0)) {
    const yerDec = convertUsdToYer(usdDec, params.exchangeRate, params.roundingMode || 'nearest_10');
    const decimals = params.roundingMode === 'exact' ? 2 : 0;
    return `${signPrefix}${formatYerNumber(yerDec, decimals)}`;
  }

  const absFixed = usdDec.abs().toFixed(2);
  const negPrefix = usdDec.isNegative() ? '-' : signPrefix;
  if (params.usdStyle === 'usdt') {
    return `${negPrefix}${absFixed} USDT`;
  }
  return `${negPrefix}$${absFixed}`;
}

/**
 * Dynamic label for the Main Menu currency toggle button.
 * Matches user specification:
 * - USD: "🔄 تغيير العملة | USD $"
 * - YER: "🔄 تغيير العملة | YER ﷼"
 */
export function formatCurrencyToggleButtonLabel(
  currency: DisplayCurrency,
  lang: SupportedLang = 'ar'
): string {
  if (lang === 'en') {
    return currency === 'YER'
      ? '🔄 Switch Currency | YER ﷼'
      : '🔄 Switch Currency | USD $';
  }
  return currency === 'YER'
    ? '🔄 تغيير العملة | YER ﷼'
    : '🔄 تغيير العملة | USD $';
}

export function normalizeArabicDigits(raw: string): string {
  return (raw || '')
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[,،\s]/g, '');
}

/**
 * Validates quadruple depositor name (الاسم الرباعي).
 * Requires at least 3 words (strongly encouraging full 4-part name) and disallows links/symbols/digits-only.
 */
export function validateDepositorQuadName(rawInput: string):
  | { ok: true; cleaned: string; wordCount: number }
  | { ok: false; reason: 'empty' | 'too_short' | 'invalid_chars' | 'too_long' } {
  const cleaned = (rawInput || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return { ok: false, reason: 'empty' };
  if (cleaned.length > 120) return { ok: false, reason: 'too_long' };
  if (/https?:\/\/|@|<|>|\d{4,}/i.test(cleaned)) {
    return { ok: false, reason: 'invalid_chars' };
  }
  const words = cleaned.split(' ').filter((w) => w.length >= 2);
  if (words.length < 3 || cleaned.length < 8) {
    return { ok: false, reason: 'too_short' };
  }
  return { ok: true, cleaned, wordCount: words.length };
}

/**
 * Validates local YER deposit amount against admin-configured minimum and maximum limits.
 */
export function validateLocalDepositAmountYer(
  rawInput: string | number,
  minYer: number,
  maxYer: number
):
  | { ok: true; amountYer: string; numericAmount: number }
  | { ok: false; reason: 'invalid' | 'below_min' | 'above_max'; minYer: number; maxYer: number } {
  const normalized =
    typeof rawInput === 'number' ? String(rawInput) : normalizeArabicDigits(String(rawInput || ''));
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    return { ok: false, reason: 'invalid', minYer, maxYer };
  }
  const dec = new Decimal(normalized);
  if (!dec.isFinite() || dec.lte(0)) {
    return { ok: false, reason: 'invalid', minYer, maxYer };
  }
  if (dec.lt(minYer)) {
    return { ok: false, reason: 'below_min', minYer, maxYer };
  }
  if (dec.gt(maxYer)) {
    return { ok: false, reason: 'above_max', minYer, maxYer };
  }
  return {
    ok: true,
    amountYer: dec.toFixed(2),
    numericAmount: dec.toNumber(),
  };
}

// ============================================================================
// DATABASE SETTINGS & LIVE EXCHANGE-RATE FETCHER
// ============================================================================

export async function getCurrencyLocalDepositSettings(): Promise<CurrencyLocalDepositSettings> {
  try {
    const [row] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, CURRENCY_SETTINGS_KEY))
      .limit(1);

    const raw = (row?.valueJson as Record<string, any>) || {};
    return {
      localDepositsEnabled: raw.localDepositsEnabled !== false,
      market: normalizeYeRialMarket(raw.market),
      rateType: normalizeYeRialRateType(raw.rateType),
      roundingMode: normalizeYerRoundingMode(raw.roundingMode),
      maxRateAgeMinutes: Math.max(
        5,
        Math.min(10080, Number(raw.maxRateAgeMinutes || DEFAULT_CURRENCY_LOCAL_DEPOSIT_SETTINGS.maxRateAgeMinutes))
      ),
      minDepositYer: Math.max(
        100,
        Number(raw.minDepositYer || DEFAULT_CURRENCY_LOCAL_DEPOSIT_SETTINGS.minDepositYer)
      ),
      maxDepositYer: Math.max(
        1000,
        Number(raw.maxDepositYer || DEFAULT_CURRENCY_LOCAL_DEPOSIT_SETTINGS.maxDepositYer)
      ),
      reviewChannelId: String(raw.reviewChannelId || '').trim(),
      reviewChannelTitle: String(raw.reviewChannelTitle || '').trim(),
      reviewChannelVerified: Boolean(raw.reviewChannelVerified),
      reviewChannelVerifiedAt: raw.reviewChannelVerifiedAt ? String(raw.reviewChannelVerifiedAt) : null,
    };
  } catch {
    return { ...DEFAULT_CURRENCY_LOCAL_DEPOSIT_SETTINGS };
  }
}

export async function saveCurrencyLocalDepositSettings(
  patch: Partial<CurrencyLocalDepositSettings>
): Promise<CurrencyLocalDepositSettings> {
  const current = await getCurrencyLocalDepositSettings();
  const next: CurrencyLocalDepositSettings = {
    localDepositsEnabled:
      typeof patch.localDepositsEnabled === 'boolean'
        ? patch.localDepositsEnabled
        : current.localDepositsEnabled,
    market: patch.market !== undefined ? normalizeYeRialMarket(patch.market) : current.market,
    rateType: patch.rateType !== undefined ? normalizeYeRialRateType(patch.rateType) : current.rateType,
    roundingMode:
      patch.roundingMode !== undefined ? normalizeYerRoundingMode(patch.roundingMode) : current.roundingMode,
    maxRateAgeMinutes:
      patch.maxRateAgeMinutes !== undefined
        ? Math.max(5, Math.min(10080, Math.floor(Number(patch.maxRateAgeMinutes) || 720)))
        : current.maxRateAgeMinutes,
    minDepositYer:
      patch.minDepositYer !== undefined
        ? Math.max(100, Math.floor(Number(patch.minDepositYer) || 1000))
        : current.minDepositYer,
    maxDepositYer:
      patch.maxDepositYer !== undefined
        ? Math.max(1000, Math.floor(Number(patch.maxDepositYer) || 500000))
        : current.maxDepositYer,
    reviewChannelId:
      patch.reviewChannelId !== undefined ? String(patch.reviewChannelId).trim() : current.reviewChannelId,
    reviewChannelTitle:
      patch.reviewChannelTitle !== undefined
        ? String(patch.reviewChannelTitle).trim()
        : current.reviewChannelTitle,
    reviewChannelVerified:
      typeof patch.reviewChannelVerified === 'boolean'
        ? patch.reviewChannelVerified
        : patch.reviewChannelId !== undefined && patch.reviewChannelId.trim() !== current.reviewChannelId
        ? false
        : current.reviewChannelVerified,
    reviewChannelVerifiedAt:
      patch.reviewChannelVerifiedAt !== undefined
        ? patch.reviewChannelVerifiedAt
        : patch.reviewChannelId !== undefined && patch.reviewChannelId.trim() !== current.reviewChannelId
        ? null
        : current.reviewChannelVerifiedAt,
  };

  if (next.maxDepositYer < next.minDepositYer) {
    next.maxDepositYer = next.minDepositYer;
  }

  await db
    .insert(settings)
    .values({
      key: CURRENCY_SETTINGS_KEY,
      valueJson: next,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        valueJson: next,
        updatedAt: new Date(),
      },
    });

  // Invalidate rate cache when market or rateType changes
  inMemoryRateCache = null;
  return next;
}

async function loadLastKnownGoodFromDb(market: YeRialMarket): Promise<LastKnownGoodMarketRate | null> {
  const mem = lastKnownGoodByMarket.get(market);
  if (mem) return mem;

  try {
    const rows = await db
      .select()
      .from(exchangeRateLogs)
      .where(eq(exchangeRateLogs.market, market))
      .orderBy(desc(exchangeRateLogs.fetchedAt))
      .limit(20);

    for (const row of rows) {
      const b = Number(row.buyRate);
      const s = Number(row.sellRate);
      if (
        Number.isFinite(b) &&
        Number.isFinite(s) &&
        b >= MIN_SANE_YER_RATE &&
        b <= MAX_SANE_YER_RATE &&
        s >= MIN_SANE_YER_RATE &&
        s <= MAX_SANE_YER_RATE
      ) {
        const entry: LastKnownGoodMarketRate = {
          buyRate: new Decimal(b).toFixed(4),
          sellRate: new Decimal(s).toFixed(4),
          providerLastVerifiedAt: row.providerLastVerifiedAt || null,
          providerLastPriceChange: row.providerLastPriceChange || null,
          fetchedAt: row.fetchedAt || new Date(),
        };
        lastKnownGoodByMarket.set(market, entry);
        return entry;
      }
    }
  } catch {
    // Ignore DB lookup errors and allow baseline fallback
  }
  return null;
}

/**
 * Fetches live USD/YER exchange rate directly from ye-rial.com.
 * - Always queries live ye-rial.com when `forceFresh: true` or display cache expires.
 * - Never blocks currency switching or YER conversion solely due to provider timestamp cadence;
 *   if ye-rial.com is temporarily unreachable, automatically falls back to the latest verified
 *   rate stored in memory/DB (or baseline reference rate) so conversions stay available 24/7.
 */
export async function fetchLiveYerExchangeRate(options?: {
  forceFresh?: boolean;
  settingsOverride?: CurrencyLocalDepositSettings;
}): Promise<LiveExchangeRateResult> {
  const cfg = options?.settingsOverride || (await getCurrencyLocalDepositSettings());
  const cacheKey = `${cfg.market}:${cfg.rateType}:${cfg.maxRateAgeMinutes}`;
  const nowMs = Date.now();

  if (
    !options?.forceFresh &&
    inMemoryRateCache &&
    inMemoryRateCache.cacheKey === cacheKey &&
    inMemoryRateCache.expiresAtMs > nowMs &&
    inMemoryRateCache.result.ok
  ) {
    return { ...inMemoryRateCache.result, fromCache: true };
  }

  const sourceUrl = buildYeRialApiUrl(cfg.market);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(sourceUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'RaqmStore-ExchangeSync/1.0',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const failLog: LiveExchangeRateResult = {
        ok: false,
        rate: null,
        buyRate: null,
        sellRate: null,
        market: cfg.market,
        rateType: cfg.rateType,
        source: YE_RIAL_ALLOWED_HOST,
        sourceUrl,
        providerLastVerifiedAt: null,
        providerLastPriceChange: null,
        fetchedAt: new Date(),
        fromCache: false,
        errorCode: 'API_UNREACHABLE',
        errorMessageAr: `تعذر جلب سعر الصرف المباشر حاليًا (HTTP ${res.status}).`,
        errorMessageEn: `Unable to fetch live exchange rate right now (HTTP ${res.status}).`,
      };
      await logExchangeRateAttempt(failLog);
      const lkg = await loadLastKnownGoodFromDb(cfg.market);
      const fallback = resolveFallbackExchangeRate({
        market: cfg.market,
        rateType: cfg.rateType,
        lastKnownGood: lkg,
      });
      inMemoryRateCache = {
        cacheKey,
        expiresAtMs: Date.now() + DISPLAY_CACHE_TTL_MS,
        result: fallback,
      };
      return fallback;
    }

    const json = await res.json();
    const parsed = parseYeRialApiResponse({
      payload: json,
      market: cfg.market,
      rateType: cfg.rateType,
      nowMs: Date.now(),
      maxAgeMinutes: cfg.maxRateAgeMinutes,
    });

    if (parsed.ok && parsed.buyRate && parsed.sellRate) {
      lastKnownGoodByMarket.set(cfg.market, {
        buyRate: parsed.buyRate,
        sellRate: parsed.sellRate,
        providerLastVerifiedAt: parsed.providerLastVerifiedAt,
        providerLastPriceChange: parsed.providerLastPriceChange,
        fetchedAt: parsed.fetchedAt,
      });
      inMemoryRateCache = {
        cacheKey,
        expiresAtMs: Date.now() + DISPLAY_CACHE_TTL_MS,
        result: parsed,
      };
      await logExchangeRateAttempt(parsed);
      return parsed;
    }

    await logExchangeRateAttempt(parsed);
    const lkg = await loadLastKnownGoodFromDb(cfg.market);
    const fallback = resolveFallbackExchangeRate({
      market: cfg.market,
      rateType: cfg.rateType,
      lastKnownGood: lkg,
    });
    inMemoryRateCache = {
      cacheKey,
      expiresAtMs: Date.now() + DISPLAY_CACHE_TTL_MS,
      result: fallback,
    };
    return fallback;
  } catch (err: any) {
    clearTimeout(timeout);
    const failLog: LiveExchangeRateResult = {
      ok: false,
      rate: null,
      buyRate: null,
      sellRate: null,
      market: cfg.market,
      rateType: cfg.rateType,
      source: YE_RIAL_ALLOWED_HOST,
      sourceUrl,
      providerLastVerifiedAt: null,
      providerLastPriceChange: null,
      fetchedAt: new Date(),
      fromCache: false,
      errorCode: 'API_UNREACHABLE',
      errorMessageAr: 'تعذر الاتصال بخدمة أسعار الصرف المباشرة حاليًا.',
      errorMessageEn: 'Live exchange rate service is temporarily unreachable.',
    };
    await logExchangeRateAttempt(failLog, err?.message || 'Network timeout');
    const lkg = await loadLastKnownGoodFromDb(cfg.market);
    const fallback = resolveFallbackExchangeRate({
      market: cfg.market,
      rateType: cfg.rateType,
      lastKnownGood: lkg,
    });
    inMemoryRateCache = {
      cacheKey,
      expiresAtMs: Date.now() + DISPLAY_CACHE_TTL_MS,
      result: fallback,
    };
    return fallback;
  }
}

async function logExchangeRateAttempt(result: LiveExchangeRateResult, extraError?: string): Promise<void> {
  try {
    await db.insert(exchangeRateLogs).values({
      market: result.market,
      rateType: result.rateType,
      buyRate: result.buyRate,
      sellRate: result.sellRate,
      effectiveRate: result.rate,
      sourceUrl: result.sourceUrl,
      providerLastVerifiedAt: result.providerLastVerifiedAt,
      providerLastPriceChange: result.providerLastPriceChange,
      status: result.ok ? 'ok' : 'error',
      errorMessage: result.ok ? null : extraError || result.errorCode || 'error',
      fetchedAt: result.fetchedAt,
    });
  } catch {
    // Logging failure should never break live operations
  }
}

export async function getRecentExchangeRateLogs(limit = 10) {
  return db
    .select()
    .from(exchangeRateLogs)
    .orderBy(desc(exchangeRateLogs.fetchedAt))
    .limit(limit);
}
