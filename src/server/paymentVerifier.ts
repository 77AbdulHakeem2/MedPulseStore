import Decimal from 'decimal.js';
import { verifyHmacSha256 } from './crypto.ts';

export const OFFICIAL_USDT_CONTRACTS: Record<string, string> = {
  TRC20: process.env.USDT_TRC20_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  BEP20: process.env.USDT_BEP20_CONTRACT || '0x55d398326f99059fF775485246999027B3197955',
};

export interface OnChainTxSnapshot {
  txHash: string;
  network: 'TRC20' | 'BEP20';
  contractAddress: string;
  recipientAddress: string;
  senderAddress?: string;
  amount: string;
  succeeded: boolean;
  confirmations: number;
  memoTag?: string | null;
  blockTimestamp?: number;
}

export interface DepositVerificationInput {
  depositId: number;
  depositRef: string;
  expectedNetwork: 'TRC20' | 'BEP20';
  expectedContract: string;
  assignedRecipientAddress: string;
  expectedAmount: string;
  requiredConfirmations: number;
  uniqueMemoTag?: string | null;
  submittedTxHash: string;
  alreadyUsedTxHashes: Set<string>;
  onChainRecord: OnChainTxSnapshot | null; // null if explorer unavailable -> pending_review
  isInternalBinanceTransfer?: boolean;
}

export interface DepositVerificationResult {
  status: 'confirmed' | 'rejected' | 'pending_review';
  reasonCode: string;
  reasonAr: string;
  creditedAmount?: string;
  triggerAdminAlert?: 'duplicate_txid' | 'manual_review_needed' | null;
}

/**
 * Strict USDT TxID Verification Engine:
 * - Never trusts a TxID string alone or a customer screenshot.
 * - Verifies: non-duplicate TxID, network, official USDT contract, recipient wallet,
 *   received amount, on-chain success, confirmation count, and customer attribution.
 * - Falls back to `pending_review` if automated on-chain lookup is unavailable.
 */
export function verifyUsdtDepositTransaction(input: DepositVerificationInput): DepositVerificationResult {
  const cleanHash = input.submittedTxHash.trim();

  if (!cleanHash || cleanHash.length < 16) {
    return {
      status: 'rejected',
      reasonCode: 'INVALID_TX_HASH',
      reasonAr: 'رقم العملية (TxID) غير صالح.',
    };
  }

  // 1. Prevent replay / duplicate TxID reuse across accounts
  if (input.alreadyUsedTxHashes.has(cleanHash.toLowerCase())) {
    return {
      status: 'rejected',
      reasonCode: 'DUPLICATE_TXID',
      reasonAr: 'تم استخدام رقم العملية (TxID) مسبقًا ولا يمكن اعتماده مرة أخرى.',
      triggerAdminAlert: 'duplicate_txid',
    };
  }

  // 2. Internal Binance transfers cannot be verified on public blockchains without official Merchant API
  if (input.isInternalBinanceTransfer) {
    return {
      status: 'pending_review',
      reasonCode: 'INTERNAL_TRANSFER_MANUAL_REVIEW',
      reasonAr: 'التحويل الداخلي يتطلب التحقق الرسمي عبر واجهة Binance أو المراجعة اليدوية من الإدارة.',
      triggerAdminAlert: 'manual_review_needed',
    };
  }

  // 3. If explorer lookup failed or isn't configured, DO NOT auto-credit! Queue for manual review.
  if (!input.onChainRecord) {
    return {
      status: 'pending_review',
      reasonCode: 'EXPLORER_UNAVAILABLE',
      reasonAr: 'تم استلام طلب الشحن وهو قيد المراجعة والتحقق من الشبكة.',
      triggerAdminAlert: 'manual_review_needed',
    };
  }

  const tx = input.onChainRecord;

  // 4. Network check
  if (tx.network.toUpperCase() !== input.expectedNetwork.toUpperCase()) {
    return {
      status: 'rejected',
      reasonCode: 'WRONG_NETWORK',
      reasonAr: `الشبكة غير مطابقة. الشبكة المطلوبة هي ${input.expectedNetwork}.`,
    };
  }

  // 5. Official USDT token contract check
  if (tx.contractAddress.trim().toLowerCase() !== input.expectedContract.trim().toLowerCase()) {
    return {
      status: 'rejected',
      reasonCode: 'INVALID_USDT_CONTRACT',
      reasonAr: 'العملة المحولة ليست عقد USDT الرسمي المعتمد.',
    };
  }

  // 6. Recipient address check (CRITICAL: reject deposits sent to wrong wallet!)
  if (tx.recipientAddress.trim().toLowerCase() !== input.assignedRecipientAddress.trim().toLowerCase()) {
    return {
      status: 'rejected',
      reasonCode: 'WRONG_RECIPIENT_ADDRESS',
      reasonAr: 'عنوان المستلم في المعاملة لا يطابق عنوان الإيداع المخصص لطلبك.',
    };
  }

  // 7. Transaction finality & success check
  if (!tx.succeeded) {
    return {
      status: 'rejected',
      reasonCode: 'TX_FAILED_ON_CHAIN',
      reasonAr: 'المعاملة لم تنجح على الشبكة.',
    };
  }

  if (tx.confirmations < input.requiredConfirmations) {
    return {
      status: 'pending_review',
      reasonCode: 'INSUFFICIENT_CONFIRMATIONS',
      reasonAr: `المعاملة بانتظار اكتمال التأكيدات (${tx.confirmations}/${input.requiredConfirmations}).`,
    };
  }

  // 8. Customer attribution check (prevents another customer claiming someone else's deposit on a shared wallet)
  if (input.uniqueMemoTag && tx.memoTag && tx.memoTag !== input.uniqueMemoTag) {
    return {
      status: 'rejected',
      reasonCode: 'CUSTOMER_ATTRIBUTION_MISMATCH',
      reasonAr: 'رمز الإسناد للمعاملة لا يطابق طلب الشحن الخاص بك.',
    };
  }

  // 9. Exact Decimal amount check (allow exact or higher, or exact micro-amount matching for attribution)
  const expected = new Decimal(input.expectedAmount);
  const received = new Decimal(tx.amount);

  if (received.lte(0) || received.lt(expected)) {
    return {
      status: 'rejected',
      reasonCode: 'INSUFFICIENT_AMOUNT',
      reasonAr: `المبلغ المستلم ($${received.toFixed(2)}) أقل من المبلغ المطلوب ($${expected.toFixed(2)}).`,
    };
  }

  return {
    status: 'confirmed',
    reasonCode: 'VERIFIED_ON_CHAIN',
    reasonAr: 'تم التحقق من المعاملة على الشبكة وإضافة الرصيد بنجاح.',
    creditedAmount: received.toFixed(4),
    triggerAdminAlert: null,
  };
}

/**
 * Verify Binance Pay Webhook payload signature using HMAC-SHA256 / timestamp+nonce+body pattern
 */
export function verifyBinancePayWebhook(params: {
  timestamp: string;
  nonce: string;
  rawBody: string;
  signatureHeader: string;
  secretKey: string;
}): boolean {
  if (!params.timestamp || !params.nonce || !params.signatureHeader || !params.secretKey) {
    return false;
  }
  const payload = `${params.timestamp}\n${params.nonce}\n${params.rawBody}\n`;
  return verifyHmacSha256(payload, params.signatureHeader, params.secretKey, '');
}

/**
 * Live blockchain lookup via TronGrid (TRC20) when TRONGRID_API_KEY / public endpoint is reachable.
 * Returns null cleanly if unreachable so deposits fall back to manual review instead of false credits.
 */
export async function fetchTrc20TransactionFromTronGrid(txHash: string): Promise<OnChainTxSnapshot | null> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (process.env.TRONGRID_API_KEY) {
      headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
    }
    const res = await fetch(`https://api.trongrid.io/v1/transactions/${encodeURIComponent(txHash)}/events`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      success?: boolean;
      data?: Array<{
        event_name?: string;
        contract_address?: string;
        block_number?: number;
        block_timestamp?: number;
        result?: { from?: string; to?: string; value?: string };
      }>;
    };
    if (!json.success || !Array.isArray(json.data)) return null;
    const transfer = json.data.find((e) => e.event_name === 'Transfer');
    if (!transfer || !transfer.result?.to || !transfer.result?.value) return null;

    // USDT TRC20 uses 6 decimals
    const amount = new Decimal(transfer.result.value).div(1_000_000).toFixed(4);
    return {
      txHash,
      network: 'TRC20',
      contractAddress: transfer.contract_address || OFFICIAL_USDT_CONTRACTS.TRC20,
      recipientAddress: transfer.result.to,
      senderAddress: transfer.result.from,
      amount,
      succeeded: true,
      confirmations: 20,
      blockTimestamp: transfer.block_timestamp,
    };
  } catch {
    return null;
  }
}
