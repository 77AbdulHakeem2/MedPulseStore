import Decimal from 'decimal.js';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { wallets, walletLedger, deposits } from '../db/schema.ts';
import { generateUniqueRef } from './crypto.ts';
import {
  convertUsdToYer,
  type DisplayCurrency,
  type YerRoundingMode,
} from './currencyEngine.ts';

/**
 * Pure Decimal wallet state-machine transition functions (unit-testable without DB!)
 */
export interface WalletSnapshot {
  availableBalance: string;
  reservedBalance: string;
}

/**
 * Resolves the exact USD charge to reserve/capture against a buyer's wallet while preventing
 * false "insufficient balance" rejections caused strictly by sub-cent rounding dust
 * (e.g. legacy wallet holding $1.1260 displayed as $1.13, or a YER deposit converted at live rate
 * whose rounded YER display fully covers the rounded YER product price).
 *
 * Security & accounting invariants:
 * - Never allows a negative balance (`effectiveChargeUsd <= availableBalanceUsd`).
 * - Strictly rejects any real USD shortfall (>= $0.0051 or displayed 2dp USD < displayed 2dp price).
 * - In YER mode, strictly requires displayed YER balance >= displayed YER price AND caps tolerance
 *   to half of one rounding step (max $0.10).
 */
export function resolveEffectiveOrderChargeUsd(params: {
  availableBalanceUsd: string | number | Decimal;
  quotedTotalUsd: string | number | Decimal;
  preferredCurrency?: DisplayCurrency;
  exchangeRate?: string | number | null;
  roundingMode?: YerRoundingMode;
}): {
  sufficient: boolean;
  effectiveChargeUsd: string;
  roundingAdjustmentUsd: string;
} {
  const avail = new Decimal(params.availableBalanceUsd || '0');
  const quoted = new Decimal(params.quotedTotalUsd || '0');

  if (!avail.isFinite() || !quoted.isFinite() || quoted.lte(0)) {
    return {
      sufficient: false,
      effectiveChargeUsd: quoted.isFinite() ? quoted.toFixed(4) : '0.0000',
      roundingAdjustmentUsd: '0.0000',
    };
  }

  // Case 1: Wallet directly covers the exact quoted total
  if (avail.gte(quoted)) {
    return {
      sufficient: true,
      effectiveChargeUsd: quoted.toFixed(4),
      roundingAdjustmentUsd: '0.0000',
    };
  }

  if (avail.lte(0)) {
    return {
      sufficient: false,
      effectiveChargeUsd: quoted.toFixed(4),
      roundingAdjustmentUsd: '0.0000',
    };
  }

  const gap = quoted.minus(avail);

  // Case 2: Sub-cent USD display parity (e.g., $1.1260 displays as $1.13 for a $1.13 product)
  if (
    gap.lte(new Decimal('0.0050')) &&
    avail.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).gte(quoted.toDecimalPlaces(2, Decimal.ROUND_HALF_UP))
  ) {
    return {
      sufficient: true,
      effectiveChargeUsd: avail.toFixed(4),
      roundingAdjustmentUsd: gap.toFixed(4),
    };
  }

  // Case 3: YER display parity (e.g., customer deposited 600 ﷼ at live rate to buy a 600 ﷼ product)
  if (params.preferredCurrency === 'YER' && params.exchangeRate) {
    const rate = new Decimal(params.exchangeRate);
    if (rate.gt(0)) {
      const mode: YerRoundingMode = params.roundingMode || 'nearest_10';
      const availYer = convertUsdToYer(avail, rate, mode);
      const quotedYer = convertUsdToYer(quoted, rate, mode);
      const halfStepYer =
        mode === 'nearest_100'
          ? 50
          : mode === 'nearest_50'
          ? 25
          : mode === 'nearest_10'
          ? 5
          : mode === 'nearest_1'
          ? 1
          : 0.5;
      const maxToleranceUsd = Decimal.min(new Decimal(halfStepYer).div(rate), new Decimal('0.10'));
      if (availYer.gte(quotedYer) && gap.lte(maxToleranceUsd)) {
        return {
          sufficient: true,
          effectiveChargeUsd: avail.toFixed(4),
          roundingAdjustmentUsd: gap.toFixed(4),
        };
      }
    }
  }

  return {
    sufficient: false,
    effectiveChargeUsd: quoted.toFixed(4),
    roundingAdjustmentUsd: '0.0000',
  };
}

export function computeReserveTransition(wallet: WalletSnapshot, amountStr: string): {
  ok: boolean;
  errorCode?: string;
  next?: WalletSnapshot;
} {
  const avail = new Decimal(wallet.availableBalance);
  const resv = new Decimal(wallet.reservedBalance);
  const amount = new Decimal(amountStr);

  if (amount.lte(0)) {
    return { ok: false, errorCode: 'INVALID_AMOUNT' };
  }
  if (avail.lt(amount)) {
    return { ok: false, errorCode: 'INSUFFICIENT_CUSTOMER_BALANCE' };
  }
  const nextAvail = avail.minus(amount);
  if (nextAvail.lt(0)) {
    return { ok: false, errorCode: 'NEGATIVE_BALANCE_FORBIDDEN' };
  }
  return {
    ok: true,
    next: {
      availableBalance: nextAvail.toFixed(4),
      reservedBalance: resv.plus(amount).toFixed(4),
    },
  };
}

export function computeCaptureTransition(wallet: WalletSnapshot, amountStr: string): {
  ok: boolean;
  errorCode?: string;
  next?: WalletSnapshot;
} {
  const resv = new Decimal(wallet.reservedBalance);
  const amount = new Decimal(amountStr);
  if (amount.lte(0) || resv.lt(amount)) {
    return { ok: false, errorCode: 'INVALID_CAPTURE_AMOUNT' };
  }
  return {
    ok: true,
    next: {
      availableBalance: new Decimal(wallet.availableBalance).toFixed(4),
      reservedBalance: resv.minus(amount).toFixed(4),
    },
  };
}

export function computeRefundTransition(wallet: WalletSnapshot, amountStr: string): {
  ok: boolean;
  errorCode?: string;
  next?: WalletSnapshot;
} {
  const avail = new Decimal(wallet.availableBalance);
  const resv = new Decimal(wallet.reservedBalance);
  const amount = new Decimal(amountStr);
  if (amount.lte(0) || resv.lt(amount)) {
    return { ok: false, errorCode: 'INVALID_REFUND_AMOUNT' };
  }
  return {
    ok: true,
    next: {
      availableBalance: avail.plus(amount).toFixed(4),
      reservedBalance: resv.minus(amount).toFixed(4),
    },
  };
}

export function computeCreditTransition(wallet: WalletSnapshot, amountStr: string): {
  ok: boolean;
  errorCode?: string;
  next?: WalletSnapshot;
} {
  const avail = new Decimal(wallet.availableBalance);
  const amount = new Decimal(amountStr);
  if (amount.lte(0)) {
    return { ok: false, errorCode: 'INVALID_CREDIT_AMOUNT' };
  }
  return {
    ok: true,
    next: {
      availableBalance: avail.plus(amount).toFixed(4),
      reservedBalance: new Decimal(wallet.reservedBalance).toFixed(4),
    },
  };
}

// ============================================================================
// Transactional PostgreSQL Wallet Operations (Immutable Ledger)
// ============================================================================

export async function ensureUserWallet(userId: number) {
  try {
    const existing = await db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
    if (existing.length > 0) return existing[0];
    const created = await db
      .insert(wallets)
      .values({ userId, currency: 'USD', availableBalance: '0.0000', reservedBalance: '0.0000' })
      .onConflictDoNothing()
      .returning();
    if (created.length > 0) return created[0];
    const refetched = await db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
    return refetched[0];
  } catch (error) {
    console.error('ensureUserWallet failed:', error);
    throw new Error('Failed to load customer wallet', { cause: error });
  }
}

export async function reserveWalletBalance(params: {
  userId: number;
  amount: string;
  orderId: number;
  referenceCode?: string;
  note: string;
}) {
  const ref = params.referenceCode || generateUniqueRef('RSV');
  return db.transaction(async (tx) => {
    await tx
      .insert(wallets)
      .values({ userId: params.userId, currency: 'USD', availableBalance: '0.0000', reservedBalance: '0.0000' })
      .onConflictDoNothing();

    // Check idempotency via unique reference_code
    const existingLedger = await tx
      .select()
      .from(walletLedger)
      .where(eq(walletLedger.referenceCode, ref))
      .limit(1);
    if (existingLedger.length > 0) {
      return { alreadyProcessed: true, referenceCode: ref };
    }

    // Lock row for update via Drizzle query
    const [wallet] = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.userId, params.userId))
      .for('update');

    const transition = computeReserveTransition(
      { availableBalance: wallet.availableBalance, reservedBalance: wallet.reservedBalance },
      params.amount
    );
    if (!transition.ok || !transition.next) {
      throw new Error(transition.errorCode || 'INSUFFICIENT_CUSTOMER_BALANCE');
    }

    await tx
      .update(wallets)
      .set({
        availableBalance: transition.next.availableBalance,
        reservedBalance: transition.next.reservedBalance,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, wallet.id));

    await tx.insert(walletLedger).values({
      referenceCode: ref,
      walletId: wallet.id,
      userId: params.userId,
      entryType: 'reserve',
      amount: new Decimal(params.amount).neg().toFixed(4),
      balanceBefore: wallet.availableBalance,
      balanceAfter: transition.next.availableBalance,
      relatedOrderId: params.orderId,
      note: params.note,
    });

    return { alreadyProcessed: false, referenceCode: ref, next: transition.next };
  });
}

export async function captureReservedWalletBalance(params: {
  userId: number;
  amount: string;
  orderId: number;
  referenceCode?: string;
  note: string;
}) {
  const ref = params.referenceCode || generateUniqueRef('CAP');
  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(walletLedger)
      .where(eq(walletLedger.referenceCode, ref))
      .limit(1);
    if (existing.length > 0) return { alreadyProcessed: true, referenceCode: ref };

    const [wallet] = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.userId, params.userId))
      .for('update');

    const transition = computeCaptureTransition(
      { availableBalance: wallet.availableBalance, reservedBalance: wallet.reservedBalance },
      params.amount
    );
    if (!transition.ok || !transition.next) {
      throw new Error(transition.errorCode || 'INVALID_CAPTURE_AMOUNT');
    }

    await tx
      .update(wallets)
      .set({
        reservedBalance: transition.next.reservedBalance,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, wallet.id));

    await tx.insert(walletLedger).values({
      referenceCode: ref,
      walletId: wallet.id,
      userId: params.userId,
      entryType: 'capture',
      amount: new Decimal(params.amount).neg().toFixed(4),
      balanceBefore: wallet.availableBalance,
      balanceAfter: transition.next.availableBalance,
      relatedOrderId: params.orderId,
      note: params.note,
    });

    return { alreadyProcessed: false, referenceCode: ref };
  });
}

export async function refundReservedWalletBalance(params: {
  userId: number;
  amount: string;
  orderId: number;
  referenceCode?: string;
  note: string;
}) {
  const ref = params.referenceCode || generateUniqueRef('RFD');
  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(walletLedger)
      .where(eq(walletLedger.referenceCode, ref))
      .limit(1);
    if (existing.length > 0) return { alreadyProcessed: true, referenceCode: ref };

    const [wallet] = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.userId, params.userId))
      .for('update');

    const transition = computeRefundTransition(
      { availableBalance: wallet.availableBalance, reservedBalance: wallet.reservedBalance },
      params.amount
    );
    if (!transition.ok || !transition.next) {
      throw new Error(transition.errorCode || 'INVALID_REFUND_AMOUNT');
    }

    await tx
      .update(wallets)
      .set({
        availableBalance: transition.next.availableBalance,
        reservedBalance: transition.next.reservedBalance,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, wallet.id));

    await tx.insert(walletLedger).values({
      referenceCode: ref,
      walletId: wallet.id,
      userId: params.userId,
      entryType: 'refund',
      amount: new Decimal(params.amount).toFixed(4),
      balanceBefore: wallet.availableBalance,
      balanceAfter: transition.next.availableBalance,
      relatedOrderId: params.orderId,
      note: params.note,
    });

    return { alreadyProcessed: false, referenceCode: ref };
  });
}

/**
 * Credits a confirmed deposit EXACTLY ONCE inside a serializable row-locked transaction.
 * Guarantees no duplicate credit even under concurrent webhook deliveries or double clicks.
 */
export async function creditDepositAtomically(params: {
  depositId: number;
  creditedAmount: string;
  reviewedByUserId?: number | null;
  note: string;
}) {
  return db.transaction(async (tx) => {
    const [dep] = await tx
      .select()
      .from(deposits)
      .where(eq(deposits.id, params.depositId))
      .for('update');

    if (!dep) throw new Error('DEPOSIT_NOT_FOUND');
    if (dep.status === 'confirmed' || dep.creditedAt) {
      return { alreadyCredited: true, deposit: dep };
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

    const ledgerRef = `DEP-CREDIT-${dep.id}`;
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
      note: params.note,
    });

    const [updatedDeposit] = await tx
      .update(deposits)
      .set({
        status: 'confirmed',
        receivedAmount: new Decimal(params.creditedAmount).toFixed(4),
        reviewedByUserId: params.reviewedByUserId ?? null,
        creditedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(deposits.id, dep.id))
      .returning();

    return { alreadyCredited: false, deposit: updatedDeposit, nextBalance: transition.next.availableBalance };
  });
}

export type WalletAdjustMode = 'add' | 'deduct' | 'set' | 'delta';

export function computeWalletAdjustmentDelta(params: {
  currentBalance: string;
  mode: WalletAdjustMode;
  amountStr: string;
}): {
  ok: boolean;
  errorCode?: 'INVALID_AMOUNT' | 'ZERO_ADJUSTMENT' | 'NEGATIVE_BALANCE_FORBIDDEN';
  delta?: string;
  nextBalance?: string;
} {
  let current: Decimal;
  let inputAmount: Decimal;
  try {
    current = new Decimal(params.currentBalance || '0');
    inputAmount = new Decimal((params.amountStr || '').trim());
    if (!current.isFinite() || !inputAmount.isFinite()) {
      return { ok: false, errorCode: 'INVALID_AMOUNT' };
    }
  } catch {
    return { ok: false, errorCode: 'INVALID_AMOUNT' };
  }

  let delta: Decimal;
  if (params.mode === 'add') {
    if (inputAmount.lte(0)) return { ok: false, errorCode: 'INVALID_AMOUNT' };
    delta = inputAmount;
  } else if (params.mode === 'deduct') {
    if (inputAmount.lte(0)) return { ok: false, errorCode: 'INVALID_AMOUNT' };
    delta = inputAmount.neg();
  } else if (params.mode === 'set') {
    if (inputAmount.lt(0)) return { ok: false, errorCode: 'NEGATIVE_BALANCE_FORBIDDEN' };
    delta = inputAmount.minus(current);
    if (delta.eq(0)) return { ok: false, errorCode: 'ZERO_ADJUSTMENT' };
  } else {
    if (inputAmount.eq(0)) return { ok: false, errorCode: 'ZERO_ADJUSTMENT' };
    delta = inputAmount;
  }

  const next = current.plus(delta);
  if (next.lt(0)) {
    return { ok: false, errorCode: 'NEGATIVE_BALANCE_FORBIDDEN' };
  }

  return {
    ok: true,
    delta: delta.toFixed(4),
    nextBalance: next.toFixed(4),
  };
}

export function buildWalletCreditNotificationText(params: {
  addedAmount: string;
  totalBalanceAfter: string;
  note?: string;
  lang?: 'ar' | 'en';
}): { titleAr: string; bodyAr: string; telegramText: string } {
  const added = new Decimal(params.addedAmount || '0').abs().toFixed(2);
  const total = new Decimal(params.totalBalanceAfter || '0').toFixed(2);
  const noteLineAr = params.note ? `\n• الملاحظة: ${params.note}` : '';
  const noteLineEn = params.note ? `\n• Note: ${params.note}` : '';

  const titleAr = 'تم إضافة رصيد إلى محفظتك';
  const bodyAr = `تمت إضافة مبلغ +$${added} USDT إلى رصيدك بنجاح. رصيدك الإجمالي الآن هو $${total} USDT.`;

  const telegramText =
    params.lang === 'en'
      ? `💰 Wallet Balance Credited\n\n• Amount Added: +$${added} USDT\n• Total Balance: $${total} USDT${noteLineEn}`
      : `💰 تم إضافة رصيد إلى محفظتك\n\n• المبلغ المضاف: +$${added} USDT\n• رصيدك الإجمالي الآن: $${total} USDT${noteLineAr}`;

  return { titleAr, bodyAr, telegramText };
}

export async function adminAdjustWalletBalance(params: {
  targetUserId: number;
  deltaAmount: string;
  mode?: WalletAdjustMode;
  note: string;
  referenceCode?: string;
}) {
  const mode: WalletAdjustMode = params.mode || 'delta';

  return db.transaction(async (tx) => {
    const ref = (params.referenceCode || '').trim() || generateUniqueRef('ADJ');

    // Idempotency check: prevent duplicate execution on double-clicks
    const existingLedger = await tx
      .select()
      .from(walletLedger)
      .where(eq(walletLedger.referenceCode, ref))
      .limit(1);
    if (existingLedger.length > 0) {
      return {
        alreadyProcessed: true,
        referenceCode: ref,
        deltaApplied: existingLedger[0].amount,
        balanceBefore: existingLedger[0].balanceBefore,
        newBalance: existingLedger[0].balanceAfter,
        sqlNote: sql`now()`,
      };
    }

    await tx
      .insert(wallets)
      .values({ userId: params.targetUserId, currency: 'USD', availableBalance: '0.0000', reservedBalance: '0.0000' })
      .onConflictDoNothing();

    const [wallet] = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.userId, params.targetUserId))
      .for('update');

    const calc = computeWalletAdjustmentDelta({
      currentBalance: wallet.availableBalance,
      mode,
      amountStr: params.deltaAmount,
    });
    if (!calc.ok || !calc.delta || !calc.nextBalance) {
      throw new Error(calc.errorCode || 'INVALID_AMOUNT');
    }

    await tx
      .update(wallets)
      .set({ availableBalance: calc.nextBalance, updatedAt: new Date() })
      .where(eq(wallets.id, wallet.id));

    await tx.insert(walletLedger).values({
      referenceCode: ref,
      walletId: wallet.id,
      userId: params.targetUserId,
      entryType: 'admin_adjustment',
      amount: calc.delta,
      balanceBefore: wallet.availableBalance,
      balanceAfter: calc.nextBalance,
      note: params.note,
    });

    return {
      alreadyProcessed: false,
      referenceCode: ref,
      deltaApplied: calc.delta,
      balanceBefore: wallet.availableBalance,
      newBalance: calc.nextBalance,
      sqlNote: sql`now()`,
    };
  });
}
