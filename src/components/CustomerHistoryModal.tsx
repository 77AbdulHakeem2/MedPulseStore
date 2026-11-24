import React, { useEffect, useState } from 'react';
import {
  X,
  History,
  ReceiptText,
  Wallet,
  ArrowDownToLine,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { classifyOperationStatusVisual, formatAdminDateTime } from '../lib/operationsUtils';
import { SemanticStatus } from './ui/AdminPrimitives';

interface CustomerHistoryModalProps {
  customerId: number;
  customerName: string;
  onClose: () => void;
}

interface CustomerHistoryResponse {
  customer: {
    id: number;
    displayName: string;
    email: string | null;
    telegramUserId: string | null;
    telegramUsername: string | null;
    role: string;
    pricingTier?: 'customer' | 'agent';
    isBlocked: boolean;
    availableBalance: string;
    reservedBalance: string;
    totalSpent: string;
    completedOrdersCount: number;
    failedOrdersCount: number;
    refundedOrdersCount: number;
    totalOrdersCount: number;
    createdAt: string;
  };
  orders: Array<{
    id: number;
    orderNumber: string;
    productTitle: string;
    quantity: number;
    unitRetail: string;
    totalRetail: string;
    netProfit: string;
    currency: string;
    displayCurrency: string;
    status: string;
    failureReason: string | null;
    createdAt: string;
  }>;
  ledger: Array<{
    id: number;
    referenceCode: string;
    entryType: string;
    amount: string;
    balanceBefore: string;
    balanceAfter: string;
    note: string;
    createdAt: string;
  }>;
  deposits: Array<{
    id: string;
    depositRef: string;
    sourceType: 'crypto' | 'local';
    methodLabel: string;
    amountUsd: string;
    amountYer: string | null;
    status: string;
    note: string;
    createdAt: string;
  }>;
}

function ledgerEntryLabelAr(entryType: string): { label: string; isCredit: boolean } {
  const t = (entryType || '').toLowerCase();
  if (t.includes('deposit') || t === 'topup') return { label: 'إيداع رصيد', isCredit: true };
  if (t.includes('refund') || t.includes('release')) return { label: 'استرداد رصيد', isCredit: true };
  if (t.includes('commission')) return { label: 'عمولة إحالة', isCredit: !t.includes('reversal') };
  if (t.includes('adjust')) return { label: 'تعديل إداري', isCredit: true };
  if (t.includes('reserve')) return { label: 'حجز للطلب', isCredit: false };
  if (t.includes('capture') || t.includes('purchase') || t.includes('debit')) {
    return { label: 'خصم شراء', isCredit: false };
  }
  return { label: entryType || 'عملية مالية', isCredit: true };
}

function statusTone(status: string): 'positive' | 'negative' | 'warning' {
  const visual = classifyOperationStatusVisual(status);
  if (visual.category === 'success') return 'positive';
  if (visual.category === 'failed') return 'negative';
  return 'warning';
}

export default function CustomerHistoryModal({
  customerId,
  customerName,
  onClose,
}: CustomerHistoryModalProps) {
  const [tab, setTab] = useState<'orders' | 'ledger' | 'deposits'>('orders');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CustomerHistoryResponse | null>(null);

  const loadHistory = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<CustomerHistoryResponse>(`/api/admin/customers/${customerId}/history`);
      setData(res);
    } catch (err: any) {
      setError(err?.message || 'تعذر تحميل سجل هذا العميل.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadHistory();
  }, [customerId]);

  const c = data?.customer;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 p-3 sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-label={`سجل العميل ${customerName}`}
    >
      <div className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-2xl bg-white border border-slate-200 shadow-xl overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4 bg-slate-50/70">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white">
              <History className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h3 className="text-base font-bold text-slate-900 truncate">
                سجل العميل: {c?.displayName || customerName}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5 flex flex-wrap items-center gap-1.5">
                {c?.telegramUserId ? (
                  <span className="font-mono-num">TG {c.telegramUserId}</span>
                ) : c?.email ? (
                  <span>{c.email}</span>
                ) : null}
                {c?.telegramUsername && (
                  <>
                    <span>·</span>
                    <span dir="ltr">@{c.telegramUsername}</span>
                  </>
                )}
                <span>·</span>
                <span
                  className={`font-semibold ${
                    c?.pricingTier === 'agent' ? 'text-emerald-700' : 'text-slate-600'
                  }`}
                >
                  التصنيف: {c?.pricingTier === 'agent' ? 'وكيل' : 'عميل'}
                </span>
                <span>·</span>
                <span>عمليات وطلبات هذا العميل فقط</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => void loadHistory()}
              disabled={loading}
              aria-label="تحديث السجل"
              className="rounded-lg border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="إغلاق السجل"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <X className="h-3.5 w-3.5" />
              إغلاق
            </button>
          </div>
        </div>

        {/* Summary Strip */}
        {c && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 border-b border-slate-100 px-5 py-3.5 bg-white">
            <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 px-3.5 py-2.5">
              <div className="text-[11px] font-medium text-slate-500">إجمالي الإنفاق</div>
              <div className="mt-1 font-mono-num text-base font-bold text-emerald-700">${c.totalSpent}</div>
              <div className="text-[10px] text-slate-400">من الطلبات المكتملة</div>
            </div>
            <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 px-3.5 py-2.5">
              <div className="text-[11px] font-medium text-slate-500">الرصيد المتاح</div>
              <div className="mt-1 font-mono-num text-base font-bold text-slate-900">${c.availableBalance}</div>
              {Number(c.reservedBalance || 0) > 0 ? (
                <div className="text-[10px] text-amber-700 font-mono-num">محجوز: ${c.reservedBalance}</div>
              ) : (
                <div className="text-[10px] text-slate-400">الرصيد الفعلي الحالي</div>
              )}
            </div>
            <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 px-3.5 py-2.5">
              <div className="text-[11px] font-medium text-slate-500">الطلبات الناجحة</div>
              <div className="mt-1 font-mono-num text-base font-bold text-slate-900">
                {c.completedOrdersCount}
                <span className="text-xs font-normal text-slate-400"> / {c.totalOrdersCount}</span>
              </div>
              <div className="text-[10px] text-slate-400">
                فاشلة: {c.failedOrdersCount} · مسترجعة: {c.refundedOrdersCount}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 px-3.5 py-2.5">
              <div className="text-[11px] font-medium text-slate-500">الحركات المالية</div>
              <div className="mt-1 font-mono-num text-base font-bold text-slate-900">
                {data?.ledger.length ?? 0}
              </div>
              <div className="text-[10px] text-slate-400">إيداعات: {data?.deposits.length ?? 0}</div>
            </div>
          </div>
        )}

        {/* Sub-Tabs */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-2.5 bg-white">
          <div className="inline-flex items-center rounded-lg bg-slate-100 p-1" role="tablist">
            {(
              [
                { id: 'orders', label: 'الطلبات', count: data?.orders.length ?? 0, icon: ReceiptText },
                { id: 'ledger', label: 'المعاملات المالية', count: data?.ledger.length ?? 0, icon: Wallet },
                { id: 'deposits', label: 'الإيداعات', count: data?.deposits.length ?? 0, icon: ArrowDownToLine },
              ] as const
            ).map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  onClick={() => setTab(item.id)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                    tab === item.id
                      ? 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.08)]'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{item.label}</span>
                  <span className="font-mono-num text-[11px] text-slate-400">({item.count})</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-14 text-slate-500 gap-2">
              <Loader2 className="h-6 w-6 animate-spin text-emerald-700" />
              <span className="text-xs font-medium">جارٍ تحميل سجل العميل...</span>
            </div>
          ) : error ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-800">{error}</div>
          ) : tab === 'orders' ? (
            <div className="overflow-x-auto rounded-xl border border-slate-200/80">
              <table className="w-full text-right border-collapse min-w-[660px]">
                <thead>
                  <tr className="border-b border-slate-200/80 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                    <th className="py-2.5 px-3.5">الطلب والتاريخ</th>
                    <th className="py-2.5 px-3.5">المنتج</th>
                    <th className="py-2.5 px-3.5">المبلغ</th>
                    <th className="py-2.5 px-3.5">الربح</th>
                    <th className="py-2.5 px-3.5">الحالة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {(data?.orders || []).map((o) => {
                    const visual = classifyOperationStatusVisual(o.status);
                    return (
                      <tr key={o.id} className="hover:bg-slate-50/70">
                        <td className="py-2.5 px-3.5">
                          <div className="font-mono-num font-bold text-slate-900">{o.orderNumber}</div>
                          <div className="font-mono-num text-[11px] text-slate-400">
                            {formatAdminDateTime(o.createdAt)}
                          </div>
                        </td>
                        <td className="py-2.5 px-3.5">
                          <div className="font-semibold text-slate-800">
                            {o.productTitle}{' '}
                            <span className="font-mono-num text-slate-400">(×{o.quantity})</span>
                          </div>
                          {o.failureReason && (
                            <div
                              dir="auto"
                              className="mt-0.5 text-[11px] text-rose-600 break-words leading-relaxed max-w-[280px]"
                            >
                              {o.failureReason}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 px-3.5 font-mono-num font-bold text-slate-900">
                          ${o.totalRetail}
                        </td>
                        <td
                          className={`py-2.5 px-3.5 font-mono-num font-semibold ${
                            o.status === 'completed' ? 'text-emerald-700' : 'text-slate-400'
                          }`}
                        >
                          {o.status === 'completed' ? `+$${o.netProfit}` : '—'}
                        </td>
                        <td className="py-2.5 px-3.5">
                          <SemanticStatus tone={statusTone(o.status)} label={visual.labelAr} />
                        </td>
                      </tr>
                    );
                  })}
                  {(data?.orders || []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-10 text-center text-xs text-slate-400">
                        لا توجد طلبات مسجلة لهذا العميل حتى الآن.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : tab === 'ledger' ? (
            <div className="overflow-x-auto rounded-xl border border-slate-200/80">
              <table className="w-full text-right border-collapse min-w-[660px]">
                <thead>
                  <tr className="border-b border-slate-200/80 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                    <th className="py-2.5 px-3.5">المرجع والتاريخ</th>
                    <th className="py-2.5 px-3.5">النوع</th>
                    <th className="py-2.5 px-3.5">المبلغ</th>
                    <th className="py-2.5 px-3.5">الرصيد (قبل ← بعد)</th>
                    <th className="py-2.5 px-3.5">التفاصيل</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {(data?.ledger || []).map((l) => {
                    const meta = ledgerEntryLabelAr(l.entryType);
                    const numericAmt = Number(l.amount || 0);
                    const isPositive = numericAmt >= 0 && meta.isCredit;
                    return (
                      <tr key={l.id} className="hover:bg-slate-50/70">
                        <td className="py-2.5 px-3.5">
                          <div className="font-mono-num font-semibold text-slate-800">{l.referenceCode}</div>
                          <div className="font-mono-num text-[11px] text-slate-400">
                            {formatAdminDateTime(l.createdAt)}
                          </div>
                        </td>
                        <td className="py-2.5 px-3.5 font-medium text-slate-700">{meta.label}</td>
                        <td
                          className={`py-2.5 px-3.5 font-mono-num font-bold ${
                            isPositive ? 'text-emerald-700' : 'text-rose-700'
                          }`}
                        >
                          {isPositive ? '+' : '-'}${Math.abs(numericAmt).toFixed(2)}
                        </td>
                        <td className="py-2.5 px-3.5 font-mono-num text-slate-600">
                          ${l.balanceBefore} → <strong className="text-slate-900">${l.balanceAfter}</strong>
                        </td>
                        <td className="py-2.5 px-3.5 text-slate-600 max-w-[240px] truncate">{l.note || '—'}</td>
                      </tr>
                    );
                  })}
                  {(data?.ledger || []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-10 text-center text-xs text-slate-400">
                        لا توجد حركات مالية مسجلة لهذا العميل حتى الآن.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200/80">
              <table className="w-full text-right border-collapse min-w-[620px]">
                <thead>
                  <tr className="border-b border-slate-200/80 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                    <th className="py-2.5 px-3.5">المرجع والتاريخ</th>
                    <th className="py-2.5 px-3.5">طريقة الإيداع</th>
                    <th className="py-2.5 px-3.5">المبلغ</th>
                    <th className="py-2.5 px-3.5">الحالة</th>
                    <th className="py-2.5 px-3.5">ملاحظة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {(data?.deposits || []).map((d) => {
                    const visual = classifyOperationStatusVisual(d.status);
                    return (
                      <tr key={d.id} className="hover:bg-slate-50/70">
                        <td className="py-2.5 px-3.5">
                          <div className="font-mono-num font-bold text-slate-900">{d.depositRef}</div>
                          <div className="font-mono-num text-[11px] text-slate-400">
                            {formatAdminDateTime(d.createdAt)}
                          </div>
                        </td>
                        <td className="py-2.5 px-3.5 font-medium text-slate-700">{d.methodLabel}</td>
                        <td className="py-2.5 px-3.5">
                          <div className="font-mono-num font-bold text-emerald-700">${d.amountUsd}</div>
                          {d.amountYer && (
                            <div className="font-mono-num text-[11px] text-slate-500">
                              {Number(d.amountYer).toLocaleString('en-US')} ﷼
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 px-3.5">
                          <SemanticStatus tone={statusTone(d.status)} label={visual.labelAr} />
                        </td>
                        <td className="py-2.5 px-3.5 text-slate-500 max-w-[200px] truncate">{d.note || '—'}</td>
                      </tr>
                    );
                  })}
                  {(data?.deposits || []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-10 text-center text-xs text-slate-400">
                        لا توجد عمليات إيداع مسجلة لهذا العميل حتى الآن.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
