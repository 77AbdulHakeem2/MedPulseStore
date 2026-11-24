import Decimal from 'decimal.js';
import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  auditLogs,
  notifications,
  orders,
  referralCommissionAccounts,
  referralCommissions,
  referrals,
  referralSettings,
  users,
  walletLedger,
  wallets,
} from '../db/schema.ts';
import type { SupportedLang } from '../i18n/index.ts';
import {
  formatDisplayPrice,
  type DisplayCurrency,
  type YerRoundingMode,
} from './currencyEngine.ts';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

// ============================================================================
// PURE FINANCIAL & VALIDATION LOGIC (Zero DB dependencies — 100% Unit-Testable)
// ============================================================================

export function parseReferralStartPayload(rawInput: string | null | undefined): string | null {
  if (!rawInput) return null;
  const trimmed = rawInput.trim();
  const match = trimmed.match(/^(?:\/start(?:@[A-Za-z0-9_]+)?\s+)?ref_([0-9]{3,20})$/i);
  if (!match) return null;
  return match[1];
}

export function buildTelegramReferralLink(
  botUsername: string | null | undefined,
  telegramUserId: string | number
): string {
  const cleanBot = (botUsername || 'RaqmStoreBot').replace(/^@+/, '').replace(/[^A-Za-z0-9_]/g, '') || 'RaqmStoreBot';
  const cleanTgId = String(telegramUserId || '').replace(/[^0-9]/g, '');
  return `https://t.me/${cleanBot}?start=ref_${cleanTgId}`;
}

export interface ValidateReferralRegistrationInput {
  systemEnabled: boolean;
  isNewUser: boolean;
  alreadyHasReferrer: boolean;
  referrerTelegramId: string | null;
  referredTelegramId: string;
  referrerExists: boolean;
  referrerIsBlocked?: boolean;
}

export interface ValidateReferralRegistrationResult {
  allowed: boolean;
  reason?:
    | 'system_disabled'
    | 'not_new_user'
    | 'already_has_referrer'
    | 'missing_referrer'
    | 'self_referral'
    | 'referrer_not_found'
    | 'referrer_blocked';
}

export function validateReferralRegistration(
  input: ValidateReferralRegistrationInput
): ValidateReferralRegistrationResult {
  if (!input.systemEnabled) {
    return { allowed: false, reason: 'system_disabled' };
  }
  if (!input.isNewUser) {
    return { allowed: false, reason: 'not_new_user' };
  }
  if (input.alreadyHasReferrer) {
    return { allowed: false, reason: 'already_has_referrer' };
  }
  const refTg = (input.referrerTelegramId || '').trim();
  const newTg = (input.referredTelegramId || '').trim();
  if (!refTg) {
    return { allowed: false, reason: 'missing_referrer' };
  }
  if (refTg === newTg) {
    return { allowed: false, reason: 'self_referral' };
  }
  if (!input.referrerExists) {
    return { allowed: false, reason: 'referrer_not_found' };
  }
  if (input.referrerIsBlocked) {
    return { allowed: false, reason: 'referrer_blocked' };
  }
  return { allowed: true };
}

export interface CalculateReferralCommissionInput {
  purchaseAmount: string | number;
  commissionRatePercent: string | number;
  maxCommissionPerUserEnabled: boolean;
  maxCommissionPerUserAmount: string | number;
  alreadyEarnedNetByReferrer: string | number;
  pendingRecoveryBalance: string | number;
}

export interface CalculateReferralCommissionResult {
  eligible: boolean;
  reason?: 'non_positive_purchase' | 'non_positive_rate' | 'cap_reached' | 'zero_commission';
  rawGrossCommission: string;
  grossCommission: string;
  offsetApplied: string;
  netCredited: string;
  remainingRecoveryBalance: string;
  capApplied: boolean;
}

export function calculateReferralCommission(
  input: CalculateReferralCommissionInput
): CalculateReferralCommissionResult {
  const purchaseDec = new Decimal(input.purchaseAmount || 0);
  const rateDec = new Decimal(input.commissionRatePercent || 0);
  const recoveryDec = Decimal.max(0, new Decimal(input.pendingRecoveryBalance || 0));

  if (purchaseDec.lte(0)) {
    return {
      eligible: false,
      reason: 'non_positive_purchase',
      rawGrossCommission: '0.0000',
      grossCommission: '0.0000',
      offsetApplied: '0.0000',
      netCredited: '0.0000',
      remainingRecoveryBalance: recoveryDec.toFixed(4),
      capApplied: false,
    };
  }
  if (rateDec.lte(0)) {
    return {
      eligible: false,
      reason: 'non_positive_rate',
      rawGrossCommission: '0.0000',
      grossCommission: '0.0000',
      offsetApplied: '0.0000',
      netCredited: '0.0000',
      remainingRecoveryBalance: recoveryDec.toFixed(4),
      capApplied: false,
    };
  }

  // Exact financial math: purchaseAmount * (rate / 100), rounded HALF_UP to 4 decimal places
  const rawGrossDec = purchaseDec.times(rateDec).div(100).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  let effectiveGrossDec = rawGrossDec;
  let capApplied = false;

  if (input.maxCommissionPerUserEnabled) {
    const capDec = Decimal.max(0, new Decimal(input.maxCommissionPerUserAmount || 0));
    const alreadyEarnedDec = Decimal.max(0, new Decimal(input.alreadyEarnedNetByReferrer || 0));
    const remainingCap = Decimal.max(0, capDec.minus(alreadyEarnedDec));
    if (remainingCap.lte(0)) {
      return {
        eligible: false,
        reason: 'cap_reached',
        rawGrossCommission: rawGrossDec.toFixed(4),
        grossCommission: '0.0000',
        offsetApplied: '0.0000',
        netCredited: '0.0000',
        remainingRecoveryBalance: recoveryDec.toFixed(4),
        capApplied: true,
      };
    }
    if (effectiveGrossDec.gt(remainingCap)) {
      effectiveGrossDec = remainingCap.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      capApplied = true;
    }
  }

  if (effectiveGrossDec.lte(0)) {
    return {
      eligible: false,
      reason: 'zero_commission',
      rawGrossCommission: rawGrossDec.toFixed(4),
      grossCommission: '0.0000',
      offsetApplied: '0.0000',
      netCredited: '0.0000',
      remainingRecoveryBalance: recoveryDec.toFixed(4),
      capApplied,
    };
  }

  // Automatically settle any pending commission recovery balance before crediting main wallet
  const offsetDec = Decimal.min(effectiveGrossDec, recoveryDec).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  const netCreditedDec = effectiveGrossDec.minus(offsetDec).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  const remainingRecoveryDec = recoveryDec.minus(offsetDec).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

  return {
    eligible: true,
    rawGrossCommission: rawGrossDec.toFixed(4),
    grossCommission: effectiveGrossDec.toFixed(4),
    offsetApplied: offsetDec.toFixed(4),
    netCredited: netCreditedDec.toFixed(4),
    remainingRecoveryBalance: remainingRecoveryDec.toFixed(4),
    capApplied,
  };
}

export interface CalculateCommissionReversalInput {
  originalGrossCommission: string | number;
  originalOffsetApplied: string | number;
  originalNetCredited: string | number;
  referrerCurrentAvailableBalance: string | number;
  referrerCurrentPendingRecovery: string | number;
}

export interface CalculateCommissionReversalResult {
  totalReversedCommission: string;
  walletDeduction: string;
  unrecoveredDeficit: string;
  restoredOffsetAmount: string;
  newWalletBalance: string;
  newPendingRecoveryBalance: string;
  status: 'reversed' | 'deficit_recorded';
}

/**
 * Pure reversal accounting:
 * - Never pushes the referrer's main wallet below 0.0000
 * - Only deducts up to `min(availableBalance, originalNetCredited)` from wallet
 * - Any shortfall + any restored offset is safely recorded in `pendingRecoveryBalance`
 *   to be settled automatically from future commissions without touching personal deposits.
 */
export function calculateCommissionReversal(
  input: CalculateCommissionReversalInput
): CalculateCommissionReversalResult {
  const grossDec = Decimal.max(0, new Decimal(input.originalGrossCommission || 0));
  const offsetDec = Decimal.max(0, new Decimal(input.originalOffsetApplied || 0));
  const netCreditedDec = Decimal.max(0, new Decimal(input.originalNetCredited || 0));
  const availableDec = Decimal.max(0, new Decimal(input.referrerCurrentAvailableBalance || 0));
  const currentRecoveryDec = Decimal.max(0, new Decimal(input.referrerCurrentPendingRecovery || 0));

  const walletDeductionDec = Decimal.min(availableDec, netCreditedDec).toDecimalPlaces(
    4,
    Decimal.ROUND_HALF_UP
  );
  const walletShortfallDec = netCreditedDec
    .minus(walletDeductionDec)
    .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

  // Total unrecovered deficit added to recovery account = wallet shortfall + restored offset
  const addedRecoveryDec = walletShortfallDec.plus(offsetDec).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  const newWalletBalanceDec = availableDec
    .minus(walletDeductionDec)
    .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  const newPendingRecoveryDec = currentRecoveryDec
    .plus(addedRecoveryDec)
    .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

  return {
    totalReversedCommission: grossDec.toFixed(4),
    walletDeduction: walletDeductionDec.toFixed(4),
    unrecoveredDeficit: addedRecoveryDec.toFixed(4),
    restoredOffsetAmount: offsetDec.toFixed(4),
    newWalletBalance: newWalletBalanceDec.toFixed(4),
    newPendingRecoveryBalance: newPendingRecoveryDec.toFixed(4),
    status: addedRecoveryDec.gt(0) ? 'deficit_recorded' : 'reversed',
  };
}

export function formatRatePercentDisplay(rate: string | number): string {
  const dec = new Decimal(rate || 0);
  if (dec.isInteger()) return dec.toFixed(0);
  return dec.toDecimalPlaces(2).toString();
}

export function formatMoney2(value: string | number): string {
  return new Decimal(value || 0).toFixed(2);
}

export function formatReferAndEarnMessage(params: {
  lang: SupportedLang;
  referralLink: string;
  successfulReferrals: number;
  totalPurchases: string | number;
  totalEarned: string | number;
  commissionRatePercent: string | number;
  currency?: string;
  isEnabled?: boolean;
  pendingRecoveryBalance?: string | number;
  displayCurrency?: DisplayCurrency;
  exchangeRate?: string | null;
  roundingMode?: YerRoundingMode;
}): string {
  const currency = params.currency || 'USDT';
  const rateText = formatRatePercentDisplay(params.commissionRatePercent);
  const useYer = params.displayCurrency === 'YER' && Boolean(params.exchangeRate);
  const fmtAmt = (val: string | number) =>
    useYer
      ? formatDisplayPrice({
          usdAmount: val,
          currency: 'YER',
          exchangeRate: params.exchangeRate,
          roundingMode: params.roundingMode,
        })
      : `${formatMoney2(val)} ${currency}`;

  const purchasesText = fmtAmt(params.totalPurchases);
  const earnedText = fmtAmt(params.totalEarned);
  const recoveryDec = new Decimal(params.pendingRecoveryBalance || 0);
  const recoveryText = fmtAmt(recoveryDec.toFixed(4));

  if (params.lang === 'en') {
    const lines = [
      '🎁 Refer & Earn',
      '',
      'Share your referral link and earn commission on every purchase made by users who join through your link.',
      '',
      '🔗 Your Referral Link:',
      params.referralLink,
      '',
      `👥 Successful Referrals: ${params.successfulReferrals}`,
      `🛒 Total Purchases: ${purchasesText}`,
      `💰 Total Earned: ${earnedText}`,
      `📊 Commission Rate: ${rateText}%`,
    ];
    if (recoveryDec.gt(0)) {
      lines.push(`⚖️ Pending Reversal Offset: ${recoveryText}`);
    }
    if (params.isEnabled === false) {
      lines.push('', '⏸️ Note: New referrals and commissions are currently paused by store administration.');
    }
    return lines.join('\n');
  }

  const lines = [
    '🎁 الإحالة والربح',
    '',
    'شارك رابط الإحالة الخاص بك واحصل على عمولة من كل عملية شراء ناجحة ينفذها المستخدمون المسجلون عبر رابطك.',
    '',
    '🔗 رابط الإحالة الخاص بك:',
    params.referralLink,
    '',
    `👥 الإحالات الناجحة: ${params.successfulReferrals}`,
    `🛒 إجمالي المشتريات: ${purchasesText}`,
    `💰 إجمالي الأرباح: ${earnedText}`,
    `📊 نسبة العمولة: ${rateText}%`,
  ];
  if (recoveryDec.gt(0)) {
    lines.push(`⚖️ رصيد تسوية مرتجعات معلق: ${recoveryText}`);
  }
  if (params.isEnabled === false) {
    lines.push('', '⏸️ ملاحظة: تسجيل الإحالات والعمولات الجديدة متوقف مؤقتاً من الإدارة.');
  }
  return lines.join('\n');
}

export function formatCommissionCreditNotification(params: {
  lang: SupportedLang;
  orderNumber: string;
  purchaseAmount: string | number;
  commissionRatePercent: string | number;
  grossCommission: string | number;
  netCredited: string | number;
  offsetApplied: string | number;
  newBalance: string | number;
  currency?: string;
  displayCurrency?: DisplayCurrency;
  exchangeRate?: string | null;
  roundingMode?: YerRoundingMode;
}): string {
  const currency = params.currency || 'USDT';
  const rateText = formatRatePercentDisplay(params.commissionRatePercent);
  const useYer = params.displayCurrency === 'YER' && Boolean(params.exchangeRate);
  const fmtAmt = (val: string | number) =>
    useYer
      ? formatDisplayPrice({
          usdAmount: val,
          currency: 'YER',
          exchangeRate: params.exchangeRate,
          roundingMode: params.roundingMode,
        })
      : `${formatMoney2(val)} ${currency}`;

  const purchaseText = fmtAmt(params.purchaseAmount);
  const grossText = fmtAmt(params.grossCommission);
  const netText = fmtAmt(params.netCredited);
  const offsetDec = new Decimal(params.offsetApplied || 0);
  const offsetText = fmtAmt(offsetDec.toFixed(4));
  const balanceText = fmtAmt(params.newBalance);

  if (params.lang === 'en') {
    const lines = [
      '🎉 New Referral Commission Earned!',
      '',
      `🧾 Order: ${params.orderNumber}`,
      `🛒 Purchase Value: ${purchaseText}`,
      `📊 Rate Applied: ${rateText}%`,
      `💰 Commission: +${grossText}`,
    ];
    if (offsetDec.gt(0)) {
      lines.push(`⚖️ Applied to Pending Reversal: -${offsetText}`);
      lines.push(`✅ Credited to Wallet: +${netText}`);
    }
    lines.push(`👛 Current Balance: ${balanceText}`);
    return lines.join('\n');
  }

  const lines = [
    '🎉 تم إضافة عمولة إحالة جديدة إلى حسابك!',
    '',
    `🧾 رقم الطلب: ${params.orderNumber}`,
    `🛒 قيمة الشراء: ${purchaseText}`,
    `📊 نسبة العمولة: ${rateText}%`,
    `💰 قيمة العمولة: +${grossText}`,
  ];
  if (offsetDec.gt(0)) {
    lines.push(`⚖️ تسوية رصيد مرتجعات سابق: -${offsetText}`);
    lines.push(`✅ المضاف فعلياً لمحفظتك: +${netText}`);
  }
  lines.push(`👛 رصيدك الحالي: ${balanceText}`);
  return lines.join('\n');
}

export function formatCommissionReversalNotification(params: {
  lang: SupportedLang;
  orderNumber: string;
  reversedAmount: string | number;
  walletDeduction: string | number;
  pendingRecoveryAdded: string | number;
  newBalance: string | number;
  reason?: string;
  currency?: string;
}): string {
  const currency = params.currency || 'USDT';
  const revText = formatMoney2(params.reversedAmount);
  const dedText = formatMoney2(params.walletDeduction);
  const deficitDec = new Decimal(params.pendingRecoveryAdded || 0);
  const balText = formatMoney2(params.newBalance);

  if (params.lang === 'en') {
    const lines = [
      '↩️ Referral Commission Reversed',
      '',
      `🧾 Order: ${params.orderNumber}`,
      `💸 Reversed Commission: -${revText} ${currency}`,
      `👛 Deducted from Wallet: -${dedText} ${currency}`,
    ];
    if (deficitDec.gt(0)) {
      lines.push(`⚖️ Pending Offset (from future commissions): ${deficitDec.toFixed(2)} ${currency}`);
    }
    lines.push(`💼 Current Balance: ${balText} ${currency}`);
    if (params.reason) lines.push(`📝 Reason: ${params.reason}`);
    return lines.join('\n');
  }

  const lines = [
    '↩️ تم عكس عمولة إحالة',
    '',
    `🧾 رقم الطلب: ${params.orderNumber}`,
    `💸 قيمة العمولة المعكوسة: -${revText} ${currency}`,
    `👛 المخصوم من المحفظة: -${dedText} ${currency}`,
  ];
  if (deficitDec.gt(0)) {
    lines.push(`⚖️ رصيد تسوية معلق (يُخصم من العمولات القادمة): ${deficitDec.toFixed(2)} ${currency}`);
  }
  lines.push(`💼 رصيدك الحالي: ${balText} ${currency}`);
  if (params.reason) lines.push(`📝 السبب: ${params.reason}`);
  return lines.join('\n');
}

// ============================================================================
// DATABASE SETTINGS & TRANSACTIONAL ENGINE
// ============================================================================

export interface ReferralSettingsDTO {
  id: number;
  isEnabled: boolean;
  defaultCommissionPercent: string;
  maxCommissionPerUserEnabled: boolean;
  maxCommissionPerUserAmount: string;
  currency: string;
  updatedAt: Date;
}

export async function getReferralSettings(): Promise<ReferralSettingsDTO> {
  const existing = await db
    .select()
    .from(referralSettings)
    .where(eq(referralSettings.singletonKey, 'primary'))
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0];
    return {
      id: row.id,
      isEnabled: row.isEnabled,
      defaultCommissionPercent: new Decimal(row.defaultCommissionPercent).toFixed(4),
      maxCommissionPerUserEnabled: row.maxCommissionPerUserEnabled,
      maxCommissionPerUserAmount: new Decimal(row.maxCommissionPerUserAmount).toFixed(4),
      currency: row.currency || 'USDT',
      updatedAt: row.updatedAt,
    };
  }

  const [created] = await db
    .insert(referralSettings)
    .values({
      singletonKey: 'primary',
      isEnabled: true,
      defaultCommissionPercent: '5.0000',
      maxCommissionPerUserEnabled: false,
      maxCommissionPerUserAmount: '0.0000',
      currency: 'USDT',
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return {
      id: created.id,
      isEnabled: created.isEnabled,
      defaultCommissionPercent: new Decimal(created.defaultCommissionPercent).toFixed(4),
      maxCommissionPerUserEnabled: created.maxCommissionPerUserEnabled,
      maxCommissionPerUserAmount: new Decimal(created.maxCommissionPerUserAmount).toFixed(4),
      currency: created.currency || 'USDT',
      updatedAt: created.updatedAt,
    };
  }

  const [retry] = await db
    .select()
    .from(referralSettings)
    .where(eq(referralSettings.singletonKey, 'primary'))
    .limit(1);

  return {
    id: retry.id,
    isEnabled: retry.isEnabled,
    defaultCommissionPercent: new Decimal(retry.defaultCommissionPercent).toFixed(4),
    maxCommissionPerUserEnabled: retry.maxCommissionPerUserEnabled,
    maxCommissionPerUserAmount: new Decimal(retry.maxCommissionPerUserAmount).toFixed(4),
    currency: retry.currency || 'USDT',
    updatedAt: retry.updatedAt,
  };
}

export async function updateReferralSettings(params: {
  isEnabled?: boolean;
  defaultCommissionPercent?: string | number;
  maxCommissionPerUserEnabled?: boolean;
  maxCommissionPerUserAmount?: string | number;
  actorUserId?: number | null;
  actorRole?: string;
}): Promise<ReferralSettingsDTO> {
  const current = await getReferralSettings();

  let nextPercent = current.defaultCommissionPercent;
  if (params.defaultCommissionPercent !== undefined) {
    const parsed = new Decimal(params.defaultCommissionPercent);
    if (!parsed.isFinite() || parsed.lt(0) || parsed.gt(100)) {
      throw new Error('INVALID_COMMISSION_PERCENT');
    }
    nextPercent = parsed.toFixed(4);
  }

  let nextCapAmount = current.maxCommissionPerUserAmount;
  if (params.maxCommissionPerUserAmount !== undefined) {
    const parsedCap = new Decimal(params.maxCommissionPerUserAmount);
    if (!parsedCap.isFinite() || parsedCap.lt(0)) {
      throw new Error('INVALID_MAX_COMMISSION_CAP');
    }
    nextCapAmount = parsedCap.toFixed(4);
  }

  const nextEnabled = params.isEnabled !== undefined ? Boolean(params.isEnabled) : current.isEnabled;
  const nextCapEnabled =
    params.maxCommissionPerUserEnabled !== undefined
      ? Boolean(params.maxCommissionPerUserEnabled)
      : current.maxCommissionPerUserEnabled;

  const [updated] = await db
    .update(referralSettings)
    .set({
      isEnabled: nextEnabled,
      defaultCommissionPercent: nextPercent,
      maxCommissionPerUserEnabled: nextCapEnabled,
      maxCommissionPerUserAmount: nextCapAmount,
      updatedByUserId: params.actorUserId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(referralSettings.singletonKey, 'primary'))
    .returning();

  await db.insert(auditLogs).values({
    actorUserId: params.actorUserId ?? null,
    actorRole: params.actorRole || 'admin',
    action: 'REFERRAL_SETTINGS_UPDATED',
    entityType: 'referral_settings',
    entityId: String(updated.id),
    detailsJson: {
      before: {
        isEnabled: current.isEnabled,
        defaultCommissionPercent: current.defaultCommissionPercent,
        maxCommissionPerUserEnabled: current.maxCommissionPerUserEnabled,
        maxCommissionPerUserAmount: current.maxCommissionPerUserAmount,
      },
      after: {
        isEnabled: updated.isEnabled,
        defaultCommissionPercent: updated.defaultCommissionPercent,
        maxCommissionPerUserEnabled: updated.maxCommissionPerUserEnabled,
        maxCommissionPerUserAmount: updated.maxCommissionPerUserAmount,
      },
    },
  });

  return {
    id: updated.id,
    isEnabled: updated.isEnabled,
    defaultCommissionPercent: new Decimal(updated.defaultCommissionPercent).toFixed(4),
    maxCommissionPerUserEnabled: updated.maxCommissionPerUserEnabled,
    maxCommissionPerUserAmount: new Decimal(updated.maxCommissionPerUserAmount).toFixed(4),
    currency: updated.currency || 'USDT',
    updatedAt: updated.updatedAt,
  };
}

/**
 * Permanently links a brand-new Telegram user to their referrer (write-once, never overwrites).
 */
export async function registerUserReferralAttribution(params: {
  newUserId: number;
  newUserTelegramId: string;
  startPayload: string | null | undefined;
  isNewUser: boolean;
}): Promise<{ attributed: boolean; reason?: string; referrerUserId?: number }> {
  const referrerTgId = parseReferralStartPayload(params.startPayload);
  if (!referrerTgId) {
    return { attributed: false, reason: 'no_referral_payload' };
  }

  const settings = await getReferralSettings();

  return db.transaction(async (tx) => {
    const [targetUser] = await tx
      .select()
      .from(users)
      .where(eq(users.id, params.newUserId))
      .for('update')
      .limit(1);

    if (!targetUser) {
      return { attributed: false, reason: 'target_user_not_found' };
    }

    const existingRefRows = await tx
      .select()
      .from(referrals)
      .where(eq(referrals.referredUserId, targetUser.id))
      .limit(1);

    const alreadyHasReferrer = Boolean(targetUser.referredByUserId) || existingRefRows.length > 0;

    const [referrerUser] = await tx
      .select()
      .from(users)
      .where(eq(users.telegramUserId, referrerTgId))
      .limit(1);

    const validation = validateReferralRegistration({
      systemEnabled: settings.isEnabled,
      isNewUser: params.isNewUser,
      alreadyHasReferrer,
      referrerTelegramId: referrerTgId,
      referredTelegramId: params.newUserTelegramId,
      referrerExists: Boolean(referrerUser),
      referrerIsBlocked: referrerUser?.isBlocked,
    });

    if (!validation.allowed || !referrerUser) {
      return { attributed: false, reason: validation.reason };
    }

    // Extra DB-level guard against self-referral by user ID
    if (referrerUser.id === targetUser.id) {
      return { attributed: false, reason: 'self_referral' };
    }

    const inserted = await tx
      .insert(referrals)
      .values({
        referrerUserId: referrerUser.id,
        referredUserId: targetUser.id,
        referrerTelegramId: referrerUser.telegramUserId || referrerTgId,
        referredTelegramId: params.newUserTelegramId,
        referralSource: 'telegram_deep_link',
        commissionAmount: '0.0000',
        status: 'active',
      })
      .onConflictDoNothing()
      .returning();

    if (inserted.length === 0) {
      return { attributed: false, reason: 'already_has_referrer' };
    }

    await tx
      .update(users)
      .set({
        referredByUserId: referrerUser.id,
        updatedAt: new Date(),
      })
      .where(eq(users.id, targetUser.id));

    await tx.insert(auditLogs).values({
      actorUserId: targetUser.id,
      actorRole: 'system',
      action: 'REFERRAL_REGISTERED',
      entityType: 'referral',
      entityId: String(inserted[0].id),
      detailsJson: {
        referrerUserId: referrerUser.id,
        referrerTelegramId: referrerUser.telegramUserId,
        referredUserId: targetUser.id,
        referredTelegramId: params.newUserTelegramId,
      },
    });

    return { attributed: true, referrerUserId: referrerUser.id };
  });
}

export interface AwardReferralCommissionResult {
  awarded: boolean;
  reason?: string;
  commissionId?: number;
  operationRef?: string;
  grossCommission?: string;
  offsetApplied?: string;
  netCredited?: string;
  balanceBefore?: string;
  balanceAfter?: string;
  referrerUserId?: number;
}

/**
 * Atomically awards a percentage commission to the buyer's referrer upon completed purchase.
 * Strictly idempotent via DB unique index (order_id, entry_type) + row locks.
 */
export async function awardReferralCommissionForOrder(params: {
  orderId: number;
  notifyTelegramUser?: (telegramUserId: string, text: string) => Promise<boolean>;
}): Promise<AwardReferralCommissionResult> {
  const settings = await getReferralSettings();
  if (!settings.isEnabled) {
    return { awarded: false, reason: 'system_disabled' };
  }

  const postCommitNotifications: Array<{ telegramUserId: string; text: string }> = [];

  try {
    const txResult = await db.transaction(async (tx): Promise<AwardReferralCommissionResult> => {
      // 1. Lock the order row so concurrent commission runs serialize cleanly
      const [orderRow] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, params.orderId))
        .for('update')
        .limit(1);

      if (!orderRow) {
        return { awarded: false, reason: 'order_not_found' };
      }
      if (orderRow.status !== 'completed') {
        return { awarded: false, reason: 'order_not_completed' };
      }

      const purchaseAmountDec = new Decimal(orderRow.totalRetail || 0);
      if (purchaseAmountDec.lte(0)) {
        return { awarded: false, reason: 'non_positive_purchase' };
      }

      // 2. Idempotency check inside transaction
      const existingComm = await tx
        .select()
        .from(referralCommissions)
        .where(
          and(
            eq(referralCommissions.orderId, orderRow.id),
            eq(referralCommissions.entryType, 'commission')
          )
        )
        .limit(1);

      if (existingComm.length > 0) {
        return {
          awarded: false,
          reason: 'already_awarded',
          commissionId: existingComm[0].id,
          operationRef: existingComm[0].operationRef,
        };
      }

      // 3. Find permanent active referral attribution for the buyer
      const [referralRow] = await tx
        .select()
        .from(referrals)
        .where(eq(referrals.referredUserId, orderRow.userId))
        .for('update')
        .limit(1);

      if (!referralRow || referralRow.status !== 'active') {
        return { awarded: false, reason: 'no_active_referrer' };
      }
      if (referralRow.referrerUserId === orderRow.userId) {
        return { awarded: false, reason: 'self_referral' };
      }

      // 4. Verify referrer account exists and is not blocked
      const [referrerUser] = await tx
        .select()
        .from(users)
        .where(eq(users.id, referralRow.referrerUserId))
        .limit(1);

      if (!referrerUser || referrerUser.isBlocked) {
        return { awarded: false, reason: 'referrer_ineligible' };
      }

      // 5. Ensure & lock referrer's wallet row
      let [walletRow] = await tx
        .select()
        .from(wallets)
        .where(eq(wallets.userId, referrerUser.id))
        .for('update')
        .limit(1);

      if (!walletRow) {
        await tx
          .insert(wallets)
          .values({
            userId: referrerUser.id,
            currency: 'USD',
            availableBalance: '0.0000',
            reservedBalance: '0.0000',
          })
          .onConflictDoNothing();
        [walletRow] = await tx
          .select()
          .from(wallets)
          .where(eq(wallets.userId, referrerUser.id))
          .for('update')
          .limit(1);
      }

      // 6. Ensure & lock referrer's commission recovery account
      let [recoveryAcc] = await tx
        .select()
        .from(referralCommissionAccounts)
        .where(eq(referralCommissionAccounts.userId, referrerUser.id))
        .for('update')
        .limit(1);

      if (!recoveryAcc) {
        await tx
          .insert(referralCommissionAccounts)
          .values({
            userId: referrerUser.id,
            pendingRecoveryBalance: '0.0000',
          })
          .onConflictDoNothing();
        [recoveryAcc] = await tx
          .select()
          .from(referralCommissionAccounts)
          .where(eq(referralCommissionAccounts.userId, referrerUser.id))
          .for('update')
          .limit(1);
      }

      // 7. Compute already-earned net commissions by this referrer (ledger-derived for cap enforcement)
      let alreadyEarnedNet = '0.0000';
      if (settings.maxCommissionPerUserEnabled) {
        const [agg] = await tx
          .select({
            earned: sql<string>`COALESCE(SUM(CASE WHEN ${referralCommissions.entryType} = 'commission' THEN ${referralCommissions.grossCommissionAmount} ELSE -${referralCommissions.grossCommissionAmount} END), 0)`,
          })
          .from(referralCommissions)
          .where(eq(referralCommissions.referrerUserId, referrerUser.id));
        alreadyEarnedNet = Decimal.max(0, new Decimal(agg?.earned || 0)).toFixed(4);
      }

      // 8. Pure Decimal calculation
      const calc = calculateReferralCommission({
        purchaseAmount: purchaseAmountDec.toFixed(4),
        commissionRatePercent: settings.defaultCommissionPercent,
        maxCommissionPerUserEnabled: settings.maxCommissionPerUserEnabled,
        maxCommissionPerUserAmount: settings.maxCommissionPerUserAmount,
        alreadyEarnedNetByReferrer: alreadyEarnedNet,
        pendingRecoveryBalance: recoveryAcc.pendingRecoveryBalance,
      });

      if (!calc.eligible) {
        return { awarded: false, reason: calc.reason || 'not_eligible' };
      }

      const balanceBeforeDec = new Decimal(walletRow.availableBalance);
      const netCreditedDec = new Decimal(calc.netCredited);
      const balanceAfterDec = balanceBeforeDec.plus(netCreditedDec);
      const operationRef = `REF-COMM-${orderRow.id}`;
      const walletLedgerRef = netCreditedDec.gt(0) ? `REF-WL-${orderRow.id}` : null;

      // 9. Insert immutable commission ledger entry (protected by unique index (order_id, entry_type))
      const [insertedComm] = await tx
        .insert(referralCommissions)
        .values({
          operationRef,
          entryType: 'commission',
          referrerUserId: referrerUser.id,
          referredUserId: orderRow.userId,
          orderId: orderRow.id,
          originalCommissionId: null,
          purchaseAmount: purchaseAmountDec.toFixed(4),
          commissionRatePercent: settings.defaultCommissionPercent,
          grossCommissionAmount: calc.grossCommission,
          offsetAppliedAmount: calc.offsetApplied,
          netCreditedAmount: calc.netCredited,
          unrecoveredDeficitAmount: '0.0000',
          balanceBefore: balanceBeforeDec.toFixed(4),
          balanceAfter: balanceAfterDec.toFixed(4),
          currency: settings.currency,
          status: netCreditedDec.gt(0) ? 'credited' : 'offset_only',
          reversalReason: '',
          walletLedgerRef,
        })
        .returning();

      // 10. Credit main wallet & append immutable wallet_ledger row (if netCredited > 0)
      if (netCreditedDec.gt(0) && walletLedgerRef) {
        await tx
          .update(wallets)
          .set({
            availableBalance: balanceAfterDec.toFixed(4),
            updatedAt: new Date(),
          })
          .where(eq(wallets.id, walletRow.id));

        await tx.insert(walletLedger).values({
          referenceCode: walletLedgerRef,
          walletId: walletRow.id,
          userId: referrerUser.id,
          entryType: 'referral_bonus',
          amount: netCreditedDec.toFixed(4),
          balanceBefore: balanceBeforeDec.toFixed(4),
          balanceAfter: balanceAfterDec.toFixed(4),
          relatedOrderId: orderRow.id,
          note: `عمولة إحالة (${formatRatePercentDisplay(settings.defaultCommissionPercent)}%) عن الطلب ${orderRow.orderNumber}`,
        });
      }

      // 11. Update pending recovery account if an offset was applied
      if (new Decimal(calc.offsetApplied).gt(0)) {
        await tx
          .update(referralCommissionAccounts)
          .set({
            pendingRecoveryBalance: calc.remainingRecoveryBalance,
            updatedAt: new Date(),
          })
          .where(eq(referralCommissionAccounts.id, recoveryAcc.id));
      }

      // 12. Update cumulative counter on referrals link row
      const nextReferralTotal = new Decimal(referralRow.commissionAmount || 0)
        .plus(calc.grossCommission)
        .toFixed(4);
      await tx
        .update(referrals)
        .set({ commissionAmount: nextReferralTotal })
        .where(eq(referrals.id, referralRow.id));

      // 13. Notification + Audit log
      const notifLang: SupportedLang = referrerUser.languageCode === 'en' ? 'en' : 'ar';
      const notifText = formatCommissionCreditNotification({
        lang: notifLang,
        orderNumber: orderRow.orderNumber,
        purchaseAmount: purchaseAmountDec.toFixed(4),
        commissionRatePercent: settings.defaultCommissionPercent,
        grossCommission: calc.grossCommission,
        netCredited: calc.netCredited,
        offsetApplied: calc.offsetApplied,
        newBalance: balanceAfterDec.toFixed(4),
        currency: settings.currency,
      });

      await tx.insert(notifications).values({
        audience: 'customer',
        targetUserId: referrerUser.id,
        eventType: 'referral_commission_credited',
        severity: 'info',
        titleAr: `عمولة إحالة جديدة +$${formatMoney2(calc.grossCommission)}`,
        bodyAr: notifText,
      });

      await tx.insert(auditLogs).values({
        actorUserId: referrerUser.id,
        actorRole: 'system',
        action: 'REFERRAL_COMMISSION_AWARDED',
        entityType: 'referral_commission',
        entityId: String(insertedComm.id),
        detailsJson: {
          operationRef,
          orderId: orderRow.id,
          orderNumber: orderRow.orderNumber,
          referrerUserId: referrerUser.id,
          referredUserId: orderRow.userId,
          purchaseAmount: purchaseAmountDec.toFixed(4),
          commissionRatePercent: settings.defaultCommissionPercent,
          grossCommission: calc.grossCommission,
          offsetApplied: calc.offsetApplied,
          netCredited: calc.netCredited,
          balanceBefore: balanceBeforeDec.toFixed(4),
          balanceAfter: balanceAfterDec.toFixed(4),
        },
      });

      if (referrerUser.telegramUserId) {
        postCommitNotifications.push({
          telegramUserId: referrerUser.telegramUserId,
          text: notifText,
        });
      }

      return {
        awarded: true,
        commissionId: insertedComm.id,
        operationRef,
        grossCommission: calc.grossCommission,
        offsetApplied: calc.offsetApplied,
        netCredited: calc.netCredited,
        balanceBefore: balanceBeforeDec.toFixed(4),
        balanceAfter: balanceAfterDec.toFixed(4),
        referrerUserId: referrerUser.id,
      };
    });

    if (txResult.awarded && postCommitNotifications.length > 0 && params.notifyTelegramUser) {
      for (const n of postCommitNotifications) {
        try {
          await params.notifyTelegramUser(n.telegramUserId, n.text);
        } catch {
          // Never fail commission accounting if Telegram push delivery fails
        }
      }
    }

    return txResult;
  } catch (err: any) {
    // Handle unique constraint race condition gracefully (23505 on referral_comm_order_type_uniq)
    if (err?.code === '23505' || err?.cause?.code === '23505') {
      return { awarded: false, reason: 'already_awarded' };
    }
    throw err;
  }
}

export interface ReverseReferralCommissionResult {
  reversed: boolean;
  reason?: string;
  reversalId?: number;
  operationRef?: string;
  totalReversedCommission?: string;
  walletDeduction?: string;
  unrecoveredDeficit?: string;
  newWalletBalance?: string;
  newPendingRecoveryBalance?: string;
}

/**
 * Safely reverses a previously awarded referral commission upon order refund or admin cancellation.
 * - Never mutates or deletes original commission rows
 * - Creates an independent linked reversal ledger entry (unique per order_id + 'reversal')
 * - Never pushes the referrer's main wallet negative; shortfalls go to pendingRecoveryBalance
 */
export async function reverseReferralCommissionForOrder(params: {
  orderId: number;
  reason: string;
  actorUserId?: number | null;
  actorRole?: string;
  notifyTelegramUser?: (telegramUserId: string, text: string) => Promise<boolean>;
}): Promise<ReverseReferralCommissionResult> {
  const postCommitNotifications: Array<{ telegramUserId: string; text: string }> = [];

  try {
    const txResult = await db.transaction(async (tx): Promise<ReverseReferralCommissionResult> => {
      const [orderRow] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, params.orderId))
        .for('update')
        .limit(1);

      if (!orderRow) {
        return { reversed: false, reason: 'order_not_found' };
      }

      // 1. Find the original commission record
      const [originalComm] = await tx
        .select()
        .from(referralCommissions)
        .where(
          and(
            eq(referralCommissions.orderId, orderRow.id),
            eq(referralCommissions.entryType, 'commission')
          )
        )
        .for('update')
        .limit(1);

      if (!originalComm) {
        return { reversed: false, reason: 'no_commission_to_reverse' };
      }

      // 2. Idempotency: ensure not already reversed
      const [existingReversal] = await tx
        .select()
        .from(referralCommissions)
        .where(
          and(
            eq(referralCommissions.orderId, orderRow.id),
            eq(referralCommissions.entryType, 'reversal')
          )
        )
        .limit(1);

      if (existingReversal) {
        return {
          reversed: false,
          reason: 'already_reversed',
          reversalId: existingReversal.id,
          operationRef: existingReversal.operationRef,
        };
      }

      const [referrerUser] = await tx
        .select()
        .from(users)
        .where(eq(users.id, originalComm.referrerUserId))
        .limit(1);

      // 3. Lock wallet & recovery account
      let [walletRow] = await tx
        .select()
        .from(wallets)
        .where(eq(wallets.userId, originalComm.referrerUserId))
        .for('update')
        .limit(1);

      if (!walletRow) {
        await tx
          .insert(wallets)
          .values({
            userId: originalComm.referrerUserId,
            currency: 'USD',
            availableBalance: '0.0000',
            reservedBalance: '0.0000',
          })
          .onConflictDoNothing();
        [walletRow] = await tx
          .select()
          .from(wallets)
          .where(eq(wallets.userId, originalComm.referrerUserId))
          .for('update')
          .limit(1);
      }

      let [recoveryAcc] = await tx
        .select()
        .from(referralCommissionAccounts)
        .where(eq(referralCommissionAccounts.userId, originalComm.referrerUserId))
        .for('update')
        .limit(1);

      if (!recoveryAcc) {
        await tx
          .insert(referralCommissionAccounts)
          .values({
            userId: originalComm.referrerUserId,
            pendingRecoveryBalance: '0.0000',
          })
          .onConflictDoNothing();
        [recoveryAcc] = await tx
          .select()
          .from(referralCommissionAccounts)
          .where(eq(referralCommissionAccounts.userId, originalComm.referrerUserId))
          .for('update')
          .limit(1);
      }

      // 4. Pure safe reversal math
      const revCalc = calculateCommissionReversal({
        originalGrossCommission: originalComm.grossCommissionAmount,
        originalOffsetApplied: originalComm.offsetAppliedAmount,
        originalNetCredited: originalComm.netCreditedAmount,
        referrerCurrentAvailableBalance: walletRow.availableBalance,
        referrerCurrentPendingRecovery: recoveryAcc.pendingRecoveryBalance,
      });

      const balanceBeforeDec = new Decimal(walletRow.availableBalance);
      const balanceAfterDec = new Decimal(revCalc.newWalletBalance);
      const walletDedDec = new Decimal(revCalc.walletDeduction);
      const operationRef = `REF-REV-${orderRow.id}`;
      const walletLedgerRef = walletDedDec.gt(0) ? `REF-REV-WL-${orderRow.id}` : null;
      const safeReason = (params.reason || 'استرداد / إلغاء الطلب').trim().slice(0, 240);

      // 5. Insert independent reversal entry (NEVER mutates original commission row)
      const [insertedRev] = await tx
        .insert(referralCommissions)
        .values({
          operationRef,
          entryType: 'reversal',
          referrerUserId: originalComm.referrerUserId,
          referredUserId: originalComm.referredUserId,
          orderId: orderRow.id,
          originalCommissionId: originalComm.id,
          purchaseAmount: originalComm.purchaseAmount,
          commissionRatePercent: originalComm.commissionRatePercent,
          grossCommissionAmount: revCalc.totalReversedCommission,
          offsetAppliedAmount: revCalc.restoredOffsetAmount,
          netCreditedAmount: walletDedDec.negated().toFixed(4),
          unrecoveredDeficitAmount: revCalc.unrecoveredDeficit,
          balanceBefore: balanceBeforeDec.toFixed(4),
          balanceAfter: balanceAfterDec.toFixed(4),
          currency: originalComm.currency || 'USDT',
          status: revCalc.status,
          reversalReason: safeReason,
          walletLedgerRef,
        })
        .returning();

      // 6. Deduct up to available wallet balance (never negative) & log wallet_ledger
      if (walletDedDec.gt(0) && walletLedgerRef) {
        await tx
          .update(wallets)
          .set({
            availableBalance: balanceAfterDec.toFixed(4),
            updatedAt: new Date(),
          })
          .where(eq(wallets.id, walletRow.id));

        await tx.insert(walletLedger).values({
          referenceCode: walletLedgerRef,
          walletId: walletRow.id,
          userId: originalComm.referrerUserId,
          entryType: 'referral_reversal',
          amount: walletDedDec.negated().toFixed(4),
          balanceBefore: balanceBeforeDec.toFixed(4),
          balanceAfter: balanceAfterDec.toFixed(4),
          relatedOrderId: orderRow.id,
          note: `عكس عمولة إحالة للطلب ${orderRow.orderNumber} — ${safeReason}`,
        });
      }

      // 7. Persist updated pending recovery balance if shortfall occurred
      if (new Decimal(revCalc.unrecoveredDeficit).gt(0)) {
        await tx
          .update(referralCommissionAccounts)
          .set({
            pendingRecoveryBalance: revCalc.newPendingRecoveryBalance,
            updatedAt: new Date(),
          })
          .where(eq(referralCommissionAccounts.id, recoveryAcc.id));
      }

      // 8. Adjust referrals summary counter safely (floor 0)
      const [refLink] = await tx
        .select()
        .from(referrals)
        .where(eq(referrals.referredUserId, originalComm.referredUserId))
        .limit(1);

      if (refLink) {
        const adjusted = Decimal.max(
          0,
          new Decimal(refLink.commissionAmount || 0).minus(revCalc.totalReversedCommission)
        ).toFixed(4);
        await tx
          .update(referrals)
          .set({ commissionAmount: adjusted })
          .where(eq(referrals.id, refLink.id));
      }

      // 9. Customer notification & Audit log
      const notifLang: SupportedLang = referrerUser?.languageCode === 'en' ? 'en' : 'ar';
      const notifText = formatCommissionReversalNotification({
        lang: notifLang,
        orderNumber: orderRow.orderNumber,
        reversedAmount: revCalc.totalReversedCommission,
        walletDeduction: revCalc.walletDeduction,
        pendingRecoveryAdded: revCalc.unrecoveredDeficit,
        newBalance: balanceAfterDec.toFixed(4),
        reason: safeReason,
        currency: originalComm.currency || 'USDT',
      });

      await tx.insert(notifications).values({
        audience: 'customer',
        targetUserId: originalComm.referrerUserId,
        eventType: 'referral_commission_reversed',
        severity: 'warning',
        titleAr: `عكس عمولة إحالة -$${formatMoney2(revCalc.totalReversedCommission)}`,
        bodyAr: notifText,
      });

      await tx.insert(auditLogs).values({
        actorUserId: params.actorUserId ?? null,
        actorRole: params.actorRole || 'admin',
        action: 'REFERRAL_COMMISSION_REVERSED',
        entityType: 'referral_commission',
        entityId: String(insertedRev.id),
        detailsJson: {
          operationRef,
          originalCommissionId: originalComm.id,
          orderId: orderRow.id,
          orderNumber: orderRow.orderNumber,
          referrerUserId: originalComm.referrerUserId,
          totalReversedCommission: revCalc.totalReversedCommission,
          walletDeduction: revCalc.walletDeduction,
          unrecoveredDeficit: revCalc.unrecoveredDeficit,
          newWalletBalance: revCalc.newWalletBalance,
          newPendingRecoveryBalance: revCalc.newPendingRecoveryBalance,
          reason: safeReason,
        },
      });

      if (referrerUser?.telegramUserId) {
        postCommitNotifications.push({
          telegramUserId: referrerUser.telegramUserId,
          text: notifText,
        });
      }

      return {
        reversed: true,
        reversalId: insertedRev.id,
        operationRef,
        totalReversedCommission: revCalc.totalReversedCommission,
        walletDeduction: revCalc.walletDeduction,
        unrecoveredDeficit: revCalc.unrecoveredDeficit,
        newWalletBalance: revCalc.newWalletBalance,
        newPendingRecoveryBalance: revCalc.newPendingRecoveryBalance,
      };
    });

    if (txResult.reversed && postCommitNotifications.length > 0 && params.notifyTelegramUser) {
      for (const n of postCommitNotifications) {
        try {
          await params.notifyTelegramUser(n.telegramUserId, n.text);
        } catch {
          // Never fail reversal if Telegram delivery fails
        }
      }
    }

    return txResult;
  } catch (err: any) {
    if (err?.code === '23505' || err?.cause?.code === '23505') {
      return { reversed: false, reason: 'already_reversed' };
    }
    throw err;
  }
}

/**
 * Refunds a completed order back to the buyer's wallet AND automatically reverses any linked referral commission.
 */
export async function refundCompletedOrderWithCommissionReversal(params: {
  orderId: number;
  reason: string;
  actorUserId?: number | null;
  actorRole?: string;
  notifyTelegramUser?: (telegramUserId: string, text: string) => Promise<boolean>;
}): Promise<{
  ok: boolean;
  alreadyRefunded?: boolean;
  orderNumber?: string;
  refundedAmount?: string;
  commissionReversal?: ReverseReferralCommissionResult;
  error?: string;
}> {
  const safeReason = (params.reason || 'استرداد طلب مكتمل من الإدارة').trim().slice(0, 240);

  const refundOutcome = await db.transaction(async (tx) => {
    const [orderRow] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .for('update')
      .limit(1);

    if (!orderRow) {
      return { ok: false as const, error: 'الطلب غير موجود.' };
    }
    if (orderRow.status === 'refunded') {
      return {
        ok: true as const,
        alreadyRefunded: true,
        orderNumber: orderRow.orderNumber,
        refundedAmount: new Decimal(orderRow.totalRetail).toFixed(2),
      };
    }
    if (orderRow.status !== 'completed') {
      return {
        ok: false as const,
        error: `لا يمكن استرداد طلب بحالة (${orderRow.status}). يُسمح بالاسترداد للطلبات المكتملة فقط.`,
      };
    }

    let [buyerWallet] = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.userId, orderRow.userId))
      .for('update')
      .limit(1);

    if (!buyerWallet) {
      await tx
        .insert(wallets)
        .values({
          userId: orderRow.userId,
          currency: 'USD',
          availableBalance: '0.0000',
          reservedBalance: '0.0000',
        })
        .onConflictDoNothing();
      [buyerWallet] = await tx
        .select()
        .from(wallets)
        .where(eq(wallets.userId, orderRow.userId))
        .for('update')
        .limit(1);
    }

    const refundDec = new Decimal(orderRow.totalRetail);
    const beforeDec = new Decimal(buyerWallet.availableBalance);
    const afterDec = beforeDec.plus(refundDec);

    await tx
      .update(wallets)
      .set({
        availableBalance: afterDec.toFixed(4),
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, buyerWallet.id));

    await tx.insert(walletLedger).values({
      referenceCode: `ADMIN-RFD-${orderRow.id}`,
      walletId: buyerWallet.id,
      userId: orderRow.userId,
      entryType: 'refund',
      amount: refundDec.toFixed(4),
      balanceBefore: beforeDec.toFixed(4),
      balanceAfter: afterDec.toFixed(4),
      relatedOrderId: orderRow.id,
      note: `استرداد قيمة الطلب ${orderRow.orderNumber} — ${safeReason}`,
    });

    await tx
      .update(orders)
      .set({
        status: 'refunded',
        updatedAt: new Date(),
      })
      .where(eq(orders.id, orderRow.id));

    await tx.insert(auditLogs).values({
      actorUserId: params.actorUserId ?? null,
      actorRole: params.actorRole || 'admin',
      action: 'ORDER_REFUNDED_ADMIN',
      entityType: 'order',
      entityId: String(orderRow.id),
      detailsJson: {
        orderNumber: orderRow.orderNumber,
        refundedAmount: refundDec.toFixed(4),
        reason: safeReason,
      },
    });

    return {
      ok: true as const,
      alreadyRefunded: false,
      orderNumber: orderRow.orderNumber,
      refundedAmount: refundDec.toFixed(2),
    };
  });

  if (!refundOutcome.ok) {
    return refundOutcome;
  }

  // Automatically trigger idempotent referral commission reversal if a commission existed for this order
  const commissionReversal = await reverseReferralCommissionForOrder({
    orderId: params.orderId,
    reason: `استرداد الطلب ${refundOutcome.orderNumber}: ${safeReason}`,
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    notifyTelegramUser: params.notifyTelegramUser,
  });

  return {
    ...refundOutcome,
    commissionReversal,
  };
}

// ============================================================================
// LEDGER-DERIVED ANALYTICS & CUSTOMER/ADMIN QUERIES (Zero Drift!)
// ============================================================================

export interface UserReferralSummaryDTO {
  userId: number;
  telegramUserId: string;
  referralLink: string;
  totalReferredUsers: number;
  successfulReferrals: number;
  totalPurchases: string;
  grossEarned: string;
  totalReversed: string;
  totalEarned: string;
  pendingRecoveryBalance: string;
  commissionRatePercent: string;
  currency: string;
  isEnabled: boolean;
}

export async function getUserReferralSummary(
  userId: number,
  botUsername: string | null | undefined
): Promise<UserReferralSummaryDTO> {
  const settings = await getReferralSettings();
  const [userRow] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const tgId = userRow?.telegramUserId || String(userId);
  const referralLink = buildTelegramReferralLink(botUsername, tgId);

  const refRows = await db
    .select({ referredUserId: referrals.referredUserId })
    .from(referrals)
    .where(eq(referrals.referrerUserId, userId));

  const referredIds = refRows.map((r) => r.referredUserId);
  let successfulReferrals = 0;
  let totalPurchases = '0.0000';

  if (referredIds.length > 0) {
    const [orderAgg] = await db
      .select({
        distinctBuyers: sql<number>`COUNT(DISTINCT ${orders.userId})::int`,
        totalSpent: sql<string>`COALESCE(SUM(${orders.totalRetail}), 0)`,
      })
      .from(orders)
      .where(and(inArray(orders.userId, referredIds), eq(orders.status, 'completed')));

    successfulReferrals = Number(orderAgg?.distinctBuyers || 0);
    totalPurchases = new Decimal(orderAgg?.totalSpent || 0).toFixed(4);
  }

  const [commAgg] = await db
    .select({
      grossEarned: sql<string>`COALESCE(SUM(CASE WHEN ${referralCommissions.entryType} = 'commission' THEN ${referralCommissions.grossCommissionAmount} ELSE 0 END), 0)`,
      totalReversed: sql<string>`COALESCE(SUM(CASE WHEN ${referralCommissions.entryType} = 'reversal' THEN ${referralCommissions.grossCommissionAmount} ELSE 0 END), 0)`,
    })
    .from(referralCommissions)
    .where(eq(referralCommissions.referrerUserId, userId));

  const grossDec = new Decimal(commAgg?.grossEarned || 0);
  const revDec = new Decimal(commAgg?.totalReversed || 0);
  const netEarnedDec = Decimal.max(0, grossDec.minus(revDec));

  const [recAcc] = await db
    .select()
    .from(referralCommissionAccounts)
    .where(eq(referralCommissionAccounts.userId, userId))
    .limit(1);

  return {
    userId,
    telegramUserId: tgId,
    referralLink,
    totalReferredUsers: referredIds.length,
    successfulReferrals,
    totalPurchases,
    grossEarned: grossDec.toFixed(4),
    totalReversed: revDec.toFixed(4),
    totalEarned: netEarnedDec.toFixed(4),
    pendingRecoveryBalance: new Decimal(recAcc?.pendingRecoveryBalance || 0).toFixed(4),
    commissionRatePercent: settings.defaultCommissionPercent,
    currency: settings.currency,
    isEnabled: settings.isEnabled,
  };
}

export async function getUserReferralHistoryPage(userId: number, page = 0, pageSize = 6) {
  const safePage = Math.max(0, Math.floor(page));
  const safeLimit = Math.max(1, Math.min(20, Math.floor(pageSize)));

  const [countRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(referralCommissions)
    .where(eq(referralCommissions.referrerUserId, userId));

  const total = Number(countRow?.count || 0);

  const rows = await db
    .select({
      id: referralCommissions.id,
      operationRef: referralCommissions.operationRef,
      entryType: referralCommissions.entryType,
      orderId: referralCommissions.orderId,
      orderNumber: orders.orderNumber,
      purchaseAmount: referralCommissions.purchaseAmount,
      commissionRatePercent: referralCommissions.commissionRatePercent,
      grossCommissionAmount: referralCommissions.grossCommissionAmount,
      offsetAppliedAmount: referralCommissions.offsetAppliedAmount,
      netCreditedAmount: referralCommissions.netCreditedAmount,
      unrecoveredDeficitAmount: referralCommissions.unrecoveredDeficitAmount,
      status: referralCommissions.status,
      reversalReason: referralCommissions.reversalReason,
      currency: referralCommissions.currency,
      createdAt: referralCommissions.createdAt,
    })
    .from(referralCommissions)
    .innerJoin(orders, eq(referralCommissions.orderId, orders.id))
    .where(eq(referralCommissions.referrerUserId, userId))
    .orderBy(desc(referralCommissions.createdAt), desc(referralCommissions.id))
    .limit(safeLimit)
    .offset(safePage * safeLimit);

  return {
    items: rows,
    page: safePage,
    pageSize: safeLimit,
    total,
    totalPages: Math.max(1, Math.ceil(total / safeLimit)),
  };
}

export async function getAdminReferralOverview() {
  const settings = await getReferralSettings();

  const [refStats] = await db
    .select({
      totalReferredUsers: sql<number>`COUNT(*)::int`,
      activeReferrers: sql<number>`COUNT(DISTINCT ${referrals.referrerUserId})::int`,
    })
    .from(referrals);

  const [buyerStats] = await db
    .select({
      successfulReferrals: sql<number>`COUNT(DISTINCT ${orders.userId})::int`,
      totalReferredPurchases: sql<string>`COALESCE(SUM(${orders.totalRetail}), 0)`,
      completedReferredOrders: sql<number>`COUNT(${orders.id})::int`,
    })
    .from(orders)
    .innerJoin(referrals, eq(orders.userId, referrals.referredUserId))
    .where(eq(orders.status, 'completed'));

  const [commStats] = await db
    .select({
      commissionOrdersCount: sql<number>`COUNT(*) FILTER (WHERE ${referralCommissions.entryType} = 'commission')::int`,
      reversalsCount: sql<number>`COUNT(*) FILTER (WHERE ${referralCommissions.entryType} = 'reversal')::int`,
      totalGrossCommissions: sql<string>`COALESCE(SUM(CASE WHEN ${referralCommissions.entryType} = 'commission' THEN ${referralCommissions.grossCommissionAmount} ELSE 0 END), 0)`,
      totalReversedCommissions: sql<string>`COALESCE(SUM(CASE WHEN ${referralCommissions.entryType} = 'reversal' THEN ${referralCommissions.grossCommissionAmount} ELSE 0 END), 0)`,
      totalOffsetApplied: sql<string>`COALESCE(SUM(CASE WHEN ${referralCommissions.entryType} = 'commission' THEN ${referralCommissions.offsetAppliedAmount} ELSE 0 END), 0)`,
      totalWalletCredited: sql<string>`COALESCE(SUM(CASE WHEN ${referralCommissions.entryType} = 'commission' THEN ${referralCommissions.netCreditedAmount} ELSE 0 END), 0)`,
      totalWalletDeducted: sql<string>`COALESCE(SUM(CASE WHEN ${referralCommissions.entryType} = 'reversal' THEN ABS(${referralCommissions.netCreditedAmount}) ELSE 0 END), 0)`,
    })
    .from(referralCommissions);

  const [recoveryStats] = await db
    .select({
      totalPendingRecovery: sql<string>`COALESCE(SUM(${referralCommissionAccounts.pendingRecoveryBalance}), 0)`,
      accountsWithRecovery: sql<number>`COUNT(*) FILTER (WHERE ${referralCommissionAccounts.pendingRecoveryBalance} > 0)::int`,
    })
    .from(referralCommissionAccounts);

  const grossDec = new Decimal(commStats?.totalGrossCommissions || 0);
  const revDec = new Decimal(commStats?.totalReversedCommissions || 0);
  const netPaidDec = Decimal.max(0, grossDec.minus(revDec));

  // Detect suspicious patterns (e.g. referrers with pending recovery deficits or high reversal counts)
  const recoveryAlerts = await db
    .select({
      userId: referralCommissionAccounts.userId,
      telegramUserId: users.telegramUserId,
      displayName: users.displayName,
      pendingRecoveryBalance: referralCommissionAccounts.pendingRecoveryBalance,
    })
    .from(referralCommissionAccounts)
    .innerJoin(users, eq(referralCommissionAccounts.userId, users.id))
    .where(sql`${referralCommissionAccounts.pendingRecoveryBalance} > 0`)
    .orderBy(desc(referralCommissionAccounts.pendingRecoveryBalance))
    .limit(10);

  // Top referrers leaderboard (derived from ledger + referrals)
  const topReferrers = await db
    .select({
      referrerUserId: referrals.referrerUserId,
      displayName: users.displayName,
      telegramUserId: users.telegramUserId,
      telegramUsername: users.telegramUsername,
      referredCount: sql<number>`COUNT(DISTINCT ${referrals.referredUserId})::int`,
      netEarned: sql<string>`COALESCE((
        SELECT SUM(CASE WHEN rc.entry_type = 'commission' THEN rc.gross_commission_amount ELSE -rc.gross_commission_amount END)
        FROM referral_commissions rc
        WHERE rc.referrer_user_id = ${referrals.referrerUserId}
      ), 0)`,
    })
    .from(referrals)
    .innerJoin(users, eq(referrals.referrerUserId, users.id))
    .groupBy(referrals.referrerUserId, users.displayName, users.telegramUserId, users.telegramUsername)
    .orderBy(desc(sql`COUNT(DISTINCT ${referrals.referredUserId})`))
    .limit(10);

  return {
    settings,
    stats: {
      totalReferredUsers: Number(refStats?.totalReferredUsers || 0),
      successfulReferrals: Number(buyerStats?.successfulReferrals || 0),
      activeReferrers: Number(refStats?.activeReferrers || 0),
      completedReferredOrders: Number(buyerStats?.completedReferredOrders || 0),
      commissionOrdersCount: Number(commStats?.commissionOrdersCount || 0),
      reversalsCount: Number(commStats?.reversalsCount || 0),
      totalReferredPurchases: new Decimal(buyerStats?.totalReferredPurchases || 0).toFixed(2),
      totalGrossCommissions: grossDec.toFixed(2),
      totalReversedCommissions: revDec.toFixed(2),
      netCommissionsPaid: netPaidDec.toFixed(2),
      totalPendingRecovery: new Decimal(recoveryStats?.totalPendingRecovery || 0).toFixed(2),
      accountsWithRecovery: Number(recoveryStats?.accountsWithRecovery || 0),
    },
    recoveryAlerts: recoveryAlerts.map((a) => ({
      ...a,
      pendingRecoveryBalance: new Decimal(a.pendingRecoveryBalance).toFixed(2),
    })),
    topReferrers: topReferrers.map((r) => ({
      ...r,
      netEarned: Decimal.max(0, new Decimal(r.netEarned || 0)).toFixed(2),
    })),
  };
}

export async function lookupAdminReferralUser(
  rawQuery: string,
  botUsername: string | null | undefined
) {
  const q = (rawQuery || '').trim().replace(/^@+/, '');
  if (!q) return null;

  const isNumeric = /^\d+$/.test(q);
  const parsedInt = isNumeric ? Number(q) : NaN;
  const fitsPgInt32 = Number.isInteger(parsedInt) && parsedInt > 0 && parsedInt <= 2147483647;
  const matchingUsers = await db
    .select()
    .from(users)
    .where(
      isNumeric
        ? fitsPgInt32
          ? or(eq(users.telegramUserId, q), eq(users.id, parsedInt))
          : eq(users.telegramUserId, q)
        : or(
            eq(users.telegramUserId, q),
            ilike(users.telegramUsername, q),
            ilike(users.displayName, `%${q}%`)
          )
    )
    .limit(1);

  if (matchingUsers.length === 0) return null;
  const target = matchingUsers[0];

  const summary = await getUserReferralSummary(target.id, botUsername);

  // Who referred this user (if anyone)?
  let referredBy: { id: number; displayName: string; telegramUserId: string | null } | null = null;
  if (target.referredByUserId) {
    const [parent] = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        telegramUserId: users.telegramUserId,
      })
      .from(users)
      .where(eq(users.id, target.referredByUserId))
      .limit(1);
    referredBy = parent || null;
  }

  // List of users referred by this user + each user's completed purchase stats
  const referredUsersRaw = await db
    .select({
      referralId: referrals.id,
      referredUserId: referrals.referredUserId,
      displayName: users.displayName,
      telegramUserId: users.telegramUserId,
      telegramUsername: users.telegramUsername,
      isBlocked: users.isBlocked,
      status: referrals.status,
      joinedAt: referrals.createdAt,
      completedOrdersCount: sql<number>`COALESCE((
        SELECT COUNT(*)::int FROM orders o
        WHERE o.user_id = ${referrals.referredUserId} AND o.status = 'completed'
      ), 0)`,
      totalPurchased: sql<string>`COALESCE((
        SELECT SUM(o.total_retail) FROM orders o
        WHERE o.user_id = ${referrals.referredUserId} AND o.status = 'completed'
      ), 0)`,
      netCommissionGenerated: sql<string>`COALESCE((
        SELECT SUM(CASE WHEN rc.entry_type = 'commission' THEN rc.gross_commission_amount ELSE -rc.gross_commission_amount END)
        FROM referral_commissions rc
        WHERE rc.referrer_user_id = ${target.id} AND rc.referred_user_id = ${referrals.referredUserId}
      ), 0)`,
    })
    .from(referrals)
    .innerJoin(users, eq(referrals.referredUserId, users.id))
    .where(eq(referrals.referrerUserId, target.id))
    .orderBy(desc(referrals.createdAt))
    .limit(100);

  // Wallet balance
  const [walletRow] = await db.select().from(wallets).where(eq(wallets.userId, target.id)).limit(1);

  // Recent commissions for this user
  const history = await getUserReferralHistoryPage(target.id, 0, 20);

  return {
    user: {
      id: target.id,
      displayName: target.displayName,
      telegramUserId: target.telegramUserId,
      telegramUsername: target.telegramUsername,
      isBlocked: target.isBlocked,
      createdAt: target.createdAt,
      walletBalance: new Decimal(walletRow?.availableBalance || 0).toFixed(2),
    },
    referredBy,
    summary: {
      ...summary,
      totalPurchases: formatMoney2(summary.totalPurchases),
      grossEarned: formatMoney2(summary.grossEarned),
      totalReversed: formatMoney2(summary.totalReversed),
      totalEarned: formatMoney2(summary.totalEarned),
      pendingRecoveryBalance: formatMoney2(summary.pendingRecoveryBalance),
      commissionRatePercent: formatRatePercentDisplay(summary.commissionRatePercent),
    },
    referredUsers: referredUsersRaw.map((r) => ({
      ...r,
      totalPurchased: formatMoney2(r.totalPurchased),
      netCommissionGenerated: Decimal.max(0, new Decimal(r.netCommissionGenerated || 0)).toFixed(2),
    })),
    recentCommissions: history.items.map((c) => ({
      ...c,
      purchaseAmount: formatMoney2(c.purchaseAmount),
      commissionRatePercent: formatRatePercentDisplay(c.commissionRatePercent),
      grossCommissionAmount: formatMoney2(c.grossCommissionAmount),
      offsetAppliedAmount: formatMoney2(c.offsetAppliedAmount),
      netCreditedAmount: formatMoney2(c.netCreditedAmount),
      unrecoveredDeficitAmount: formatMoney2(c.unrecoveredDeficitAmount),
    })),
  };
}

export async function listAdminReferralCommissions(params: {
  search?: string;
  entryType?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}) {
  const safePage = Math.max(0, Math.floor(params.page || 0));
  const safeLimit = Math.max(1, Math.min(50, Math.floor(params.pageSize || 15)));

  const conditions: any[] = [];
  if (params.entryType && (params.entryType === 'commission' || params.entryType === 'reversal')) {
    conditions.push(eq(referralCommissions.entryType, params.entryType));
  }
  if (params.status && params.status !== 'all') {
    conditions.push(eq(referralCommissions.status, params.status));
  }
  if (params.dateFrom) {
    const dtFrom = new Date(params.dateFrom);
    if (!Number.isNaN(dtFrom.getTime())) {
      conditions.push(gte(referralCommissions.createdAt, dtFrom));
    }
  }
  if (params.dateTo) {
    const dtTo = new Date(params.dateTo);
    if (!Number.isNaN(dtTo.getTime())) {
      if (params.dateTo.length <= 10) {
        dtTo.setUTCHours(23, 59, 59, 999);
      }
      conditions.push(lte(referralCommissions.createdAt, dtTo));
    }
  }

  const trimmedSearch = (params.search || '').trim();
  if (trimmedSearch) {
    const matchingUserIds = await db
      .select({ id: users.id })
      .from(users)
      .where(
        or(
          eq(users.telegramUserId, trimmedSearch),
          ilike(users.displayName, `%${trimmedSearch}%`),
          ilike(users.telegramUsername, `%${trimmedSearch.replace(/^@+/, '')}%`)
        )
      )
      .limit(50);

    const matchingOrderIds = await db
      .select({ id: orders.id })
      .from(orders)
      .where(ilike(orders.orderNumber, `%${trimmedSearch}%`))
      .limit(50);

    const searchOrs: any[] = [ilike(referralCommissions.operationRef, `%${trimmedSearch}%`)];
    const uids = matchingUserIds.map((u) => u.id);
    if (uids.length > 0) {
      searchOrs.push(inArray(referralCommissions.referrerUserId, uids));
      searchOrs.push(inArray(referralCommissions.referredUserId, uids));
    }
    const oids = matchingOrderIds.map((o) => o.id);
    if (oids.length > 0) {
      searchOrs.push(inArray(referralCommissions.orderId, oids));
    }
    conditions.push(or(...searchOrs));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [countRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(referralCommissions)
    .where(whereClause);

  const total = Number(countRow?.count || 0);

  const rows = await db
    .select({
      id: referralCommissions.id,
      operationRef: referralCommissions.operationRef,
      entryType: referralCommissions.entryType,
      referrerUserId: referralCommissions.referrerUserId,
      referredUserId: referralCommissions.referredUserId,
      orderId: referralCommissions.orderId,
      originalCommissionId: referralCommissions.originalCommissionId,
      purchaseAmount: referralCommissions.purchaseAmount,
      commissionRatePercent: referralCommissions.commissionRatePercent,
      grossCommissionAmount: referralCommissions.grossCommissionAmount,
      offsetAppliedAmount: referralCommissions.offsetAppliedAmount,
      netCreditedAmount: referralCommissions.netCreditedAmount,
      unrecoveredDeficitAmount: referralCommissions.unrecoveredDeficitAmount,
      balanceBefore: referralCommissions.balanceBefore,
      balanceAfter: referralCommissions.balanceAfter,
      currency: referralCommissions.currency,
      status: referralCommissions.status,
      reversalReason: referralCommissions.reversalReason,
      walletLedgerRef: referralCommissions.walletLedgerRef,
      createdAt: referralCommissions.createdAt,
      orderNumber: orders.orderNumber,
      orderStatus: orders.status,
    })
    .from(referralCommissions)
    .innerJoin(orders, eq(referralCommissions.orderId, orders.id))
    .where(whereClause)
    .orderBy(desc(referralCommissions.createdAt), desc(referralCommissions.id))
    .limit(safeLimit)
    .offset(safePage * safeLimit);

  // Hydrate referrer & referred user details + whether each commission has a reversal row
  const userIds = Array.from(
    new Set(rows.flatMap((r) => [r.referrerUserId, r.referredUserId]))
  );
  const userMap = new Map<
    number,
    { id: number; displayName: string; telegramUserId: string | null; telegramUsername: string | null }
  >();
  if (userIds.length > 0) {
    const userRows = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        telegramUserId: users.telegramUserId,
        telegramUsername: users.telegramUsername,
      })
      .from(users)
      .where(inArray(users.id, userIds));
    for (const u of userRows) userMap.set(u.id, u);
  }

  const orderIds = Array.from(new Set(rows.map((r) => r.orderId)));
  const reversedOrderIds = new Set<number>();
  if (orderIds.length > 0) {
    const revRows = await db
      .select({ orderId: referralCommissions.orderId })
      .from(referralCommissions)
      .where(
        and(
          inArray(referralCommissions.orderId, orderIds),
          eq(referralCommissions.entryType, 'reversal')
        )
      );
    for (const rr of revRows) reversedOrderIds.add(rr.orderId);
  }

  return {
    items: rows.map((r) => {
      const referrer = userMap.get(r.referrerUserId);
      const referred = userMap.get(r.referredUserId);
      return {
        ...r,
        purchaseAmount: formatMoney2(r.purchaseAmount),
        commissionRatePercent: formatRatePercentDisplay(r.commissionRatePercent),
        grossCommissionAmount: formatMoney2(r.grossCommissionAmount),
        offsetAppliedAmount: formatMoney2(r.offsetAppliedAmount),
        netCreditedAmount: formatMoney2(r.netCreditedAmount),
        unrecoveredDeficitAmount: formatMoney2(r.unrecoveredDeficitAmount),
        balanceBefore: formatMoney2(r.balanceBefore),
        balanceAfter: formatMoney2(r.balanceAfter),
        hasReversal: reversedOrderIds.has(r.orderId),
        referrerName: referrer?.displayName || `User #${r.referrerUserId}`,
        referrerTelegramId: referrer?.telegramUserId || '',
        referredName: referred?.displayName || `User #${r.referredUserId}`,
        referredTelegramId: referred?.telegramUserId || '',
      };
    }),
    page: safePage,
    pageSize: safeLimit,
    total,
    totalPages: Math.max(1, Math.ceil(total / safeLimit)),
  };
}
