import React, { useState } from 'react';
import {
  ShieldCheck,
  RefreshCw,
  KeyRound,
  Plus,
  History,
  AlertTriangle,
  CreditCard,
  FileCheck2,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import {
  KpiCard,
  SurfacePanel,
  SectionHeader,
  SemanticStatus,
  FeedbackBanner,
} from './ui/AdminPrimitives';

export interface BinanceAdminData {
  config: {
    binanceReceiverId: string;
    hasApiKey: boolean;
    apiKeyFingerprint: string | null;
    hasApiSecret: boolean;
    apiSecretFingerprint: string | null;
    recvWindowMs: number;
    autoVerifyEnabled: boolean;
    eligibilityStatus: string;
    eligibilityMessageAr: string | null;
    eligibilityCheckedAt: string | null;
    lastSyncAt: string | null;
    lastSyncCount: number;
  };
  stats: {
    paidCount: number;
    pendingCount: number;
    rejectedCount: number;
    totalUsedReferences: number;
  };
  usedTransactions: Array<{
    id: number;
    transactionId: string;
    depositRef: string;
    customerName: string;
    amount: string;
    currency: string;
    orderType: string;
    receiverId: string | null;
    transactionTime: string;
    verifiedAt: string;
  }>;
}

export interface PaymentMethodItem {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string;
  providerType: string;
  currency: string;
  isEnabled: boolean;
  autoVerifySupported: boolean;
  instructionsAr: string;
  instructionsEn: string;
}

interface BinancePayAdminPanelProps {
  binanceData: BinanceAdminData | null;
  paymentMethods: PaymentMethodItem[];
  onRefresh: () => Promise<void>;
}

export default function BinancePayAdminPanel({
  binanceData,
  paymentMethods,
  onRefresh,
}: BinancePayAdminPanelProps) {
  const cfg = binanceData?.config;
  const stats = binanceData?.stats;

  const [receiverId, setReceiverId] = useState(cfg?.binanceReceiverId || '');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [testTxId, setTestTxId] = useState('');
  const [testAmount, setTestAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [eligibilitySteps, setEligibilitySteps] = useState<
    Array<{ name: string; ok: boolean; detail: string }> | null
  >(null);
  const [inspectedRecords, setInspectedRecords] = useState<
    Array<{
      transactionId: string;
      orderType: string;
      amount: string;
      currency: string;
      direction: string;
      transactionTime: number;
    }> | null
  >(null);

  const [showAddMethod, setShowAddMethod] = useState(false);
  const [newMethod, setNewMethod] = useState({
    nameAr: '',
    nameEn: '',
    currency: 'USDT',
    accountRef: '',
    instructionsAr: '',
    instructionsEn: '',
  });

  const handleSaveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      await apiFetch('/api/admin/binance/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          binanceReceiverId: receiverId,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(apiSecret.trim() ? { apiSecret: apiSecret.trim() } : {}),
        }),
      });
      setApiKey('');
      setApiSecret('');
      setFeedback({
        type: 'ok',
        text: 'تم حفظ Binance ID والمفاتيح المشفرة بنجاح. شغّل اختبار الأهلية قبل تفعيل التحقق التلقائي.',
      });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر حفظ إعدادات Binance.' });
    } finally {
      setBusy(false);
    }
  };

  const handleTestEligibility = async () => {
    setBusy(true);
    setFeedback(null);
    setEligibilitySteps(null);
    try {
      const res = await apiFetch<{
        eligible: boolean;
        status: string;
        messageAr: string;
        steps: Array<{ name: string; ok: boolean; detail: string }>;
      }>('/api/admin/binance/test-connection', {
        method: 'POST',
        body: JSON.stringify({
          testTransactionId: testTxId.trim() || undefined,
          testAmount: testAmount.trim() || undefined,
        }),
      });
      setEligibilitySteps(res.steps || []);
      setFeedback({
        type: res.eligible ? 'ok' : 'warn',
        text: res.messageAr,
      });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تنفيذ اختبار الاتصال بـ Binance.' });
    } finally {
      setBusy(false);
    }
  };

  const handleInspectHistory = async () => {
    setBusy(true);
    setFeedback(null);
    setInspectedRecords(null);
    try {
      const res = await apiFetch<{
        ok: boolean;
        errorMessageAr?: string;
        records: Array<{
          transactionId: string;
          orderType: string;
          amount: string;
          currency: string;
          direction: string;
          transactionTime: number;
        }>;
      }>('/api/admin/binance/inspect-history', { method: 'POST' });

      if (!res.ok) {
        setFeedback({ type: 'warn', text: res.errorMessageAr || 'تعذر جلب سجل التحويلات من Binance.' });
      } else {
        setInspectedRecords(res.records || []);
        setFeedback({
          type: 'ok',
          text: `تم فحص سجل Binance Pay بنجاح (${res.records?.length || 0} معاملة).`,
        });
      }
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر فحص سجل التحويلات.' });
    } finally {
      setBusy(false);
    }
  };

  const handleToggleAutoVerify = async () => {
    if (!cfg) return;
    setBusy(true);
    setFeedback(null);
    try {
      await apiFetch('/api/admin/binance/settings', {
        method: 'PATCH',
        body: JSON.stringify({ autoVerifyEnabled: !cfg.autoVerifyEnabled }),
      });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تغيير حالة التحقق التلقائي.' });
    } finally {
      setBusy(false);
    }
  };

  const handleToggleMethod = async (m: PaymentMethodItem) => {
    setBusy(true);
    try {
      await apiFetch(`/api/admin/payment-methods/${m.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isEnabled: !m.isEnabled }),
      });
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleAddPaymentMethod = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMethod.nameAr.trim()) return;
    setBusy(true);
    setFeedback(null);
    try {
      await apiFetch('/api/admin/payment-methods', {
        method: 'POST',
        body: JSON.stringify(newMethod),
      });
      setNewMethod({ nameAr: '', nameEn: '', currency: 'USDT', accountRef: '', instructionsAr: '', instructionsEn: '' });
      setShowAddMethod(false);
      setFeedback({ type: 'ok', text: 'تمت إضافة طريقة الدفع الجديدة وستظهر فورًا في بوت المشتري.' });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر إضافة طريقة الدفع.' });
    } finally {
      setBusy(false);
    }
  };

  const autoVerifyMeta = (() => {
    if (cfg?.autoVerifyEnabled && cfg.eligibilityStatus === 'eligible') {
      return { value: 'مفعّل', tone: 'positive' as const, valueTone: 'positive' as const, indicator: 'يعمل تلقائيًا' };
    }
    if (cfg?.eligibilityStatus === 'failed_region') {
      return { value: 'محظور 451', tone: 'negative' as const, valueTone: 'negative' as const, indicator: 'حظر جغرافي' };
    }
    if (cfg?.eligibilityStatus === 'failed_permissions') {
      return { value: 'خطأ صلاحيات', tone: 'negative' as const, valueTone: 'negative' as const, indicator: 'راجع المفتاح' };
    }
    if (cfg?.eligibilityStatus === 'failed_no_incoming') {
      return { value: 'بدون وارد', tone: 'warning' as const, valueTone: 'warning' as const, indicator: 'بانتظار تحويل' };
    }
    return { value: 'غير مفعّل', tone: 'neutral' as const, valueTone: 'default' as const, indicator: 'بانتظار الاختبار' };
  })();

  const paidCount = stats?.paidCount ?? 0;
  const pendingCount = stats?.pendingCount ?? 0;
  const usedCount = stats?.totalUsedReferences ?? 0;

  return (
    <div className="space-y-6">
      {feedback && (
        <FeedbackBanner
          type={feedback.type}
          text={feedback.text}
          onDismiss={() => setFeedback(null)}
        />
      )}

      {/* Top Meaning-Aware KPI Strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="التحقق التلقائي (Binance)"
          value={<span className="font-sans text-xl">{autoVerifyMeta.value}</span>}
          tone={autoVerifyMeta.tone}
          valueTone={autoVerifyMeta.valueTone}
          indicatorText={autoVerifyMeta.indicator}
          meta={<span>{cfg?.binanceReceiverId ? `ID: ${cfg.binanceReceiverId}` : 'غير مضبوط بعد'}</span>}
        />
        <KpiCard
          label="إيداعات ناجحة (PAID)"
          value={paidCount}
          tone="positive"
          valueTone="positive"
          direction={paidCount > 0 ? 'up' : 'flat'}
          indicatorText="مؤكدة"
          meta={<span>أُضيفت تلقائيًا للمحافظ</span>}
        />
        <KpiCard
          label="إيداعات معلقة (PENDING)"
          value={pendingCount}
          tone={pendingCount > 0 ? 'warning' : 'positive'}
          valueTone={pendingCount > 0 ? 'warning' : 'default'}
          direction={pendingCount > 0 ? 'up' : 'flat'}
          indicatorText={pendingCount > 0 ? 'قيد المتابعة' : 'لا يوجد معلق'}
          meta={<span>مرفوضة: {stats?.rejectedCount ?? 0}</span>}
        />
        <KpiCard
          label="المراجع الفريدة المسجلة"
          value={usedCount}
          tone="neutral"
          meta={<span>قيد UNIQUE لمنع التكرار</span>}
        />
      </div>

      {/* Credentials & Official Eligibility Tester */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <SurfacePanel className="lg:col-span-6 overflow-hidden">
          <SectionHeader
            title="بيانات اتصال Binance Pay (قراءة فقط)"
            subtitle="GET /sapi/v1/pay/transactions — صلاحية Enable Reading فقط"
            icon={KeyRound}
          />
          <form onSubmit={handleSaveCredentials} className="p-5 space-y-4">
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  معرّف الاستقبال (Binance Receiver ID)
                </label>
                <input
                  type="text"
                  value={receiverId}
                  onChange={(e) => setReceiverId(e.target.value)}
                  placeholder="مثال: 123456789"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono-num placeholder:font-sans focus:border-emerald-600 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  BINANCE_API_KEY (يُحفظ مشفرًا)
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={cfg?.apiKeyFingerprint ? `محفوظ: \u2066${cfg.apiKeyFingerprint}\u2069` : 'أدخل مفتاح القراءة فقط'}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono-num placeholder:font-sans focus:border-emerald-600 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  BINANCE_API_SECRET
                </label>
                <input
                  type="password"
                  value={apiSecret}
                  onChange={(e) => setApiSecret(e.target.value)}
                  placeholder={cfg?.apiSecretFingerprint ? `محفوظ: \u2066${cfg.apiSecretFingerprint}\u2069` : 'أدخل المفتاح السري'}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono-num placeholder:font-sans focus:border-emerald-600 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 transition-colors"
              >
                حفظ المفاتيح المشفرة
              </button>
              <button
                type="button"
                disabled={busy || cfg?.eligibilityStatus !== 'eligible'}
                onClick={() => void handleToggleAutoVerify()}
                className={`rounded-lg border px-3.5 py-2 text-xs font-semibold disabled:opacity-40 transition-colors ${
                  cfg?.autoVerifyEnabled
                    ? 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
                    : 'border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800'
                }`}
              >
                {cfg?.autoVerifyEnabled ? 'إيقاف التحقق التلقائي' : 'تفعيل التحقق التلقائي'}
              </button>
            </div>
          </form>
        </SurfacePanel>

        <SurfacePanel className="lg:col-span-6 overflow-hidden">
          <SectionHeader
            title="اختبار الأهلية وفحص السجل"
            subtitle="التحقق المباشر من صلاحيات المفتاح والتحويلات الواردة"
            icon={ShieldCheck}
          />
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  رقم مرجعي للاختبار (اختياري)
                </label>
                <input
                  type="text"
                  value={testTxId}
                  onChange={(e) => setTestTxId(e.target.value)}
                  placeholder="Transaction ID"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono-num focus:border-emerald-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  المبلغ التجريبي (USDT)
                </label>
                <input
                  type="text"
                  value={testAmount}
                  onChange={(e) => setTestAmount(e.target.value)}
                  placeholder="1.00"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono-num focus:border-emerald-600 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleTestEligibility()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50 transition-colors"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
                اختبار الاتصال والأهلية
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleInspectHistory()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors"
              >
                <History className="h-3.5 w-3.5" />
                فحص سجل التحويلات
              </button>
            </div>

            {cfg?.eligibilityMessageAr && (
              <div className="rounded-lg border border-slate-200/80 bg-slate-50/70 p-3 text-xs text-slate-700 leading-relaxed flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" />
                <span>{cfg.eligibilityMessageAr}</span>
              </div>
            )}

            {eligibilitySteps && eligibilitySteps.length > 0 && (
              <div className="space-y-2 border-t border-slate-100 pt-3">
                {eligibilitySteps.map((s) => (
                  <div key={s.name} className="text-xs flex items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold text-slate-900">{s.name}</div>
                      <div className="text-slate-500">{s.detail}</div>
                    </div>
                    <SemanticStatus tone={s.ok ? 'positive' : 'negative'} label={s.ok ? 'ناجح' : 'فشل'} />
                  </div>
                ))}
              </div>
            )}

            {inspectedRecords && (
              <div className="border-t border-slate-100 pt-3 space-y-2">
                <div className="text-xs font-semibold text-slate-900">
                  سجل Binance Pay ({inspectedRecords.length})
                </div>
                {inspectedRecords.length === 0 ? (
                  <div className="text-xs text-slate-400">لا توجد معاملات في النطاق الزمني الحالي.</div>
                ) : (
                  <div className="max-h-40 overflow-y-auto divide-y divide-slate-100 text-xs">
                    {inspectedRecords.map((r) => (
                      <div key={r.transactionId} className="py-1.5 flex items-center justify-between gap-2">
                        <span className="font-mono-num text-slate-800 truncate">{r.transactionId}</span>
                        <span
                          className={`font-mono-num font-semibold whitespace-nowrap ${
                            r.direction === 'incoming' ? 'text-emerald-700' : 'text-slate-500'
                          }`}
                        >
                          {r.amount} {r.currency}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </SurfacePanel>
      </div>

      {/* Used Binance Transaction IDs Ledger */}
      <SurfacePanel className="overflow-hidden">
        <SectionHeader
          title="سجل المراجع المستخدمة"
          subtitle="مقيدة بقيد UNIQUE في قاعدة البيانات لمنع تكرار الإيداع"
          icon={FileCheck2}
        />
        <div className="overflow-x-auto">
          <table className="w-full text-right border-collapse min-w-[640px]">
            <thead>
              <tr className="border-b border-slate-200/80 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                <th className="py-2.5 px-4">الرقم المرجعي (Transaction ID)</th>
                <th className="py-2.5 px-4">طلب الإيداع</th>
                <th className="py-2.5 px-4">العميل</th>
                <th className="py-2.5 px-4">المبلغ</th>
                <th className="py-2.5 px-4">النوع</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {(binanceData?.usedTransactions || []).map((tx) => (
                <tr key={tx.id} className="hover:bg-slate-50/80 transition-colors">
                  <td className="py-2.5 px-4 font-mono-num font-semibold text-slate-900">{tx.transactionId}</td>
                  <td className="py-2.5 px-4 font-mono-num text-slate-600">{tx.depositRef}</td>
                  <td className="py-2.5 px-4 text-slate-700">{tx.customerName}</td>
                  <td className="py-2.5 px-4 font-mono-num font-bold text-emerald-700">
                    +${tx.amount} {tx.currency}
                  </td>
                  <td className="py-2.5 px-4 font-mono-num text-slate-500">{tx.orderType}</td>
                </tr>
              ))}
              {(!binanceData?.usedTransactions || binanceData.usedTransactions.length === 0) && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate-400">
                    لا توجد مراجع Binance ID مسجلة بعد.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </SurfacePanel>

      {/* Extensible Payment Methods Section */}
      <SurfacePanel className="overflow-hidden">
        <SectionHeader
          title="وسائل الدفع المتاحة للعملاء"
          subtitle="تظهر فورًا في بوت المشتري باللغتين"
          icon={CreditCard}
          action={
            <button
              type="button"
              onClick={() => setShowAddMethod((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              إضافة وسيلة دفع
            </button>
          }
        />

        <div className="p-5 space-y-4">
          {showAddMethod && (
            <form onSubmit={handleAddPaymentMethod} className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <input
                  type="text"
                  required
                  value={newMethod.nameAr}
                  onChange={(e) => setNewMethod({ ...newMethod, nameAr: e.target.value })}
                  placeholder="الاسم بالعربية (مثال: تحويل بنكي)"
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs focus:border-emerald-600 focus:outline-none"
                />
                <input
                  type="text"
                  value={newMethod.nameEn}
                  onChange={(e) => setNewMethod({ ...newMethod, nameEn: e.target.value })}
                  placeholder="Name in English"
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs focus:border-emerald-600 focus:outline-none"
                />
                <input
                  type="text"
                  value={newMethod.currency}
                  onChange={(e) => setNewMethod({ ...newMethod, currency: e.target.value })}
                  placeholder="العملة (USDT / USD / SAR)"
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono-num focus:border-emerald-600 focus:outline-none"
                />
                <input
                  type="text"
                  value={newMethod.accountRef}
                  onChange={(e) => setNewMethod({ ...newMethod, accountRef: e.target.value })}
                  placeholder="رقم الحساب / المعرّف"
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono-num focus:border-emerald-600 focus:outline-none"
                />
                <input
                  type="text"
                  value={newMethod.instructionsAr}
                  onChange={(e) => setNewMethod({ ...newMethod, instructionsAr: e.target.value })}
                  placeholder="تعليمات التحويل بالعربية"
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs focus:border-emerald-600 focus:outline-none"
                />
                <input
                  type="text"
                  value={newMethod.instructionsEn}
                  onChange={(e) => setNewMethod({ ...newMethod, instructionsEn: e.target.value })}
                  placeholder="Transfer instructions in English"
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs focus:border-emerald-600 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800 transition-colors"
              >
                حفظ وسيلة الدفع
              </button>
            </form>
          )}

          <div className="divide-y divide-slate-100">
            {paymentMethods.map((m) => (
              <div key={m.id} className="py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div>
                  <div className="font-semibold text-slate-900">
                    {m.nameAr} <span className="text-slate-400 font-normal">· {m.nameEn}</span>
                  </div>
                  <div className="text-slate-500 mt-0.5">
                    العملة: <span className="font-mono-num">{m.currency}</span> ·{' '}
                    {m.autoVerifySupported ? 'تحقق آلي' : 'مراجعة يدوية'}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <SemanticStatus tone={m.isEnabled ? 'positive' : 'neutral'} label={m.isEnabled ? 'مفعّلة' : 'معطّلة'} />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleToggleMethod(m)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
                  >
                    {m.isEnabled ? 'تعطيل' : 'تفعيل'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </SurfacePanel>
    </div>
  );
}
