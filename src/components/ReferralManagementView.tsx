import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Percent,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldAlert,
  Users,
  Wallet,
  ChevronRight,
  ChevronLeft,
  SlidersHorizontal,
  ReceiptText,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { formatAdminDateTime } from '../lib/operationsUtils';
import {
  FeedbackBanner,
  KpiCard,
  PageHeader,
  SectionHeader,
  SegmentedTabs,
  SemanticStatus,
  SurfacePanel,
} from './ui/AdminPrimitives';

interface ReferralManagementViewProps {
  onRefreshWorkspace?: () => Promise<void>;
}

interface ReferralOverviewData {
  settings: {
    id: number;
    isEnabled: boolean;
    defaultCommissionPercent: string;
    maxCommissionPerUserEnabled: boolean;
    maxCommissionPerUserAmount: string;
    currency: string;
    updatedAt: string;
  };
  stats: {
    totalReferredUsers: number;
    successfulReferrals: number;
    activeReferrers: number;
    completedReferredOrders: number;
    commissionOrdersCount: number;
    reversalsCount: number;
    totalReferredPurchases: string;
    totalGrossCommissions: string;
    totalReversedCommissions: string;
    netCommissionsPaid: string;
    totalPendingRecovery: string;
    accountsWithRecovery: number;
  };
  recoveryAlerts: Array<{
    userId: number;
    telegramUserId: string | null;
    displayName: string;
    pendingRecoveryBalance: string;
  }>;
  topReferrers: Array<{
    referrerUserId: number;
    displayName: string;
    telegramUserId: string | null;
    telegramUsername: string | null;
    referredCount: number;
    netEarned: string;
  }>;
}

export default function ReferralManagementView({ onRefreshWorkspace }: ReferralManagementViewProps) {
  const [subTab, setSubTab] = useState<'overview' | 'lookup' | 'ledger'>('overview');
  const [overview, setOverview] = useState<ReferralOverviewData | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [isEnabled, setIsEnabled] = useState(true);
  const [commissionPercent, setCommissionPercent] = useState('5');
  const [capEnabled, setCapEnabled] = useState(false);
  const [capAmount, setCapAmount] = useState('0');

  const [lookupQuery, setLookupQuery] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [userDossier, setUserDossier] = useState<any | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);

  const [ledgerData, setLedgerData] = useState<{
    items: any[];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  }>({ items: [], page: 0, pageSize: 15, total: 0, totalPages: 1 });
  const [ledgerSearch, setLedgerSearch] = useState('');
  const [ledgerType, setLedgerType] = useState<'all' | 'commission' | 'reversal'>('all');
  const [ledgerStatus, setLedgerStatus] = useState<string>('all');
  const [ledgerFrom, setLedgerFrom] = useState('');
  const [ledgerTo, setLedgerTo] = useState('');
  const [ledgerPage, setLedgerPage] = useState(0);
  const [ledgerLoading, setLedgerLoading] = useState(false);

  const [reverseTarget, setReverseTarget] = useState<any | null>(null);
  const [reverseReason, setReverseReason] = useState('عكس عمولة إحالة بسبب استرداد أو إلغاء الطلب');

  const loadOverview = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<ReferralOverviewData>('/api/admin/referrals/overview');
      setOverview(data);
      setIsEnabled(data.settings.isEnabled);
      setCommissionPercent(String(Number(data.settings.defaultCommissionPercent)));
      setCapEnabled(data.settings.maxCommissionPerUserEnabled);
      setCapAmount(String(Number(data.settings.maxCommissionPerUserAmount)));
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تحميل بيانات نظام الإحالات.' });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLedger = useCallback(
    async (pageOverride?: number) => {
      setLedgerLoading(true);
      try {
        const targetPage = pageOverride !== undefined ? pageOverride : ledgerPage;
        const params = new URLSearchParams();
        if (ledgerSearch.trim()) params.set('search', ledgerSearch.trim());
        if (ledgerType !== 'all') params.set('entryType', ledgerType);
        if (ledgerStatus !== 'all') params.set('status', ledgerStatus);
        if (ledgerFrom) params.set('dateFrom', ledgerFrom);
        if (ledgerTo) params.set('dateTo', ledgerTo);
        params.set('page', String(targetPage));
        params.set('pageSize', '15');

        const res = await apiFetch<any>(`/api/admin/referrals/commissions?${params.toString()}`);
        setLedgerData(res);
      } catch (err: any) {
        setFeedback({ type: 'err', text: err?.message || 'تعذر تحميل سجل العمولات.' });
      } finally {
        setLedgerLoading(false);
      }
    },
    [ledgerPage, ledgerSearch, ledgerType, ledgerStatus, ledgerFrom, ledgerTo]
  );

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (subTab === 'ledger') void loadLedger();
  }, [subTab, loadLedger]);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const parsedRate = Number(commissionPercent);
      const parsedCap = Number(capAmount);
      if (!Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 100) {
        setFeedback({ type: 'err', text: 'نسبة العمولة يجب أن تكون بين 0 و 100%.' });
        return;
      }
      if (!Number.isFinite(parsedCap) || parsedCap < 0) {
        setFeedback({ type: 'err', text: 'الحد الأقصى للعمولة يجب أن يكون 0 أو أكبر.' });
        return;
      }

      await apiFetch('/api/admin/referrals/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          isEnabled,
          defaultCommissionPercent: parsedRate,
          maxCommissionPerUserEnabled: capEnabled,
          maxCommissionPerUserAmount: parsedCap,
        }),
      });
      setFeedback({ type: 'ok', text: 'تم حفظ إعدادات نظام الإحالات وتطبيقها فورًا.' });
      await loadOverview();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر حفظ الإعدادات.' });
    } finally {
      setBusy(false);
    }
  };

  const handleLookupUser = async (queryOverride?: string) => {
    const q = (queryOverride !== undefined ? queryOverride : lookupQuery).trim();
    if (!q) return;
    setLookupLoading(true);
    setLookupError(null);
    try {
      const data = await apiFetch<any>(`/api/admin/referrals/users/${encodeURIComponent(q)}`);
      setUserDossier(data);
    } catch (err: any) {
      setUserDossier(null);
      setLookupError(err?.message || 'لم يتم العثور على المستخدم.');
    } finally {
      setLookupLoading(false);
    }
  };

  const handleCopyReferralLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleConfirmReverseCommission = async () => {
    if (!reverseTarget) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ ok: boolean; result: any }>(
        `/api/admin/referrals/commissions/${reverseTarget.orderId}/reverse`,
        {
          method: 'POST',
          body: JSON.stringify({ reason: reverseReason }),
        }
      );
      const r = res.result;
      setFeedback({
        type: 'ok',
        text:
          `تم عكس العمولة للطلب ${reverseTarget.orderNumber} (${r.operationRef}) — المخصوم: $${Number(r.walletDeduction || 0).toFixed(2)}` +
          (Number(r.unrecoveredDeficit || 0) > 0 ? ` · تسوية معلقة: $${Number(r.unrecoveredDeficit).toFixed(2)}` : ''),
      });
      setReverseTarget(null);
      await Promise.all([
        loadOverview(),
        loadLedger(),
        onRefreshWorkspace ? onRefreshWorkspace() : Promise.resolve(),
      ]);
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر عكس العمولة.' });
    } finally {
      setBusy(false);
    }
  };

  const currency = overview?.settings?.currency || 'USDT';
  const pendingRecoveryNum = Number(overview?.stats.totalPendingRecovery ?? 0);
  const reversalsCount = overview?.stats.reversalsCount ?? 0;
  const netPaidNum = Number(overview?.stats.netCommissionsPaid ?? 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="الإحالات والعمولات"
        subtitle="إعداد نسبة العمولة، متابعة المحيلين، وسجل العمولات والمرتجعات"
        actions={
          <SegmentedTabs
            value={subTab}
            onChange={setSubTab}
            items={[
              { id: 'overview', label: 'الإحصائيات والإعدادات', icon: SlidersHorizontal },
              { id: 'lookup', label: 'استعلام مستخدم', icon: Search },
              { id: 'ledger', label: 'سجل العمولات', icon: ReceiptText },
            ]}
          />
        }
      />

      {feedback && (
        <FeedbackBanner type={feedback.type} text={feedback.text} onDismiss={() => setFeedback(null)} />
      )}

      {/* TAB 1: OVERVIEW & SETTINGS */}
      {subTab === 'overview' && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label="المحالون والناجحون"
              value={overview?.stats.totalReferredUsers ?? 0}
              tone={(overview?.stats.successfulReferrals ?? 0) > 0 ? 'positive' : 'neutral'}
              direction={(overview?.stats.successfulReferrals ?? 0) > 0 ? 'up' : 'flat'}
              indicatorText={`${overview?.stats.successfulReferrals ?? 0} ناجح`}
              meta={
                <>
                  <span>المحيلون النشطون</span>
                  <strong className="font-mono-num text-slate-700">{overview?.stats.activeReferrers ?? 0}</strong>
                </>
              }
            />

            <KpiCard
              label="مشتريات الإحالات"
              value={`$${overview?.stats.totalReferredPurchases ?? '0.00'}`}
              tone={Number(overview?.stats.totalReferredPurchases ?? 0) > 0 ? 'positive' : 'neutral'}
              direction={Number(overview?.stats.totalReferredPurchases ?? 0) > 0 ? 'up' : 'flat'}
              indicatorText={`${overview?.stats.commissionOrdersCount ?? 0} طلب`}
              meta={
                <>
                  <span>النسبة الحالية</span>
                  <strong className="font-mono-num text-slate-700">
                    {Number(overview?.settings.defaultCommissionPercent ?? 5)}%
                  </strong>
                </>
              }
            />

            <KpiCard
              label="صافي العمولات المدفوعة"
              value={`$${overview?.stats.netCommissionsPaid ?? '0.00'}`}
              valueTone={netPaidNum > 0 ? 'positive' : 'default'}
              tone={netPaidNum > 0 ? 'positive' : 'neutral'}
              direction={netPaidNum > 0 ? 'up' : 'flat'}
              indicatorText={currency}
              meta={
                <>
                  <span>الممنوحة</span>
                  <strong className="font-mono-num text-emerald-700">${overview?.stats.totalGrossCommissions ?? '0.00'}</strong>
                  <span>·</span>
                  <span>المعكوسة</span>
                  <strong className={`font-mono-num ${Number(overview?.stats.totalReversedCommissions ?? 0) > 0 ? 'text-rose-600' : 'text-slate-600'}`}>
                    ${overview?.stats.totalReversedCommissions ?? '0.00'}
                  </strong>
                </>
              }
            />

            <KpiCard
              label="تسويات المرتجعات المعلقة"
              value={`$${overview?.stats.totalPendingRecovery ?? '0.00'}`}
              valueTone={pendingRecoveryNum > 0 ? 'negative' : 'positive'}
              tone={pendingRecoveryNum > 0 || reversalsCount > 0 ? 'negative' : 'positive'}
              direction={pendingRecoveryNum > 0 ? 'up' : 'flat'}
              indicatorText={pendingRecoveryNum > 0 ? `${overview?.stats.accountsWithRecovery ?? 0} حساب` : 'لا توجد ديون'}
              meta={
                <>
                  <span>إجمالي العكوسات</span>
                  <strong className={`font-mono-num ${reversalsCount > 0 ? 'text-rose-600' : 'text-slate-600'}`}>
                    {reversalsCount}
                  </strong>
                </>
              }
            />
          </div>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 items-start">
            {/* Settings Form */}
            <SurfacePanel className="lg:col-span-5">
              <SectionHeader
                title="إعدادات العمولة"
                action={
                  <SemanticStatus
                    tone={isEnabled ? 'positive' : 'negative'}
                    label={isEnabled ? 'مفعّل' : 'معطّل'}
                  />
                }
              />
              <form onSubmit={handleSaveSettings} className="p-5 space-y-4">
                <label className="flex items-center justify-between gap-3 rounded-lg border border-slate-200/80 bg-slate-50/60 px-3.5 py-2.5 cursor-pointer">
                  <span className="text-xs font-semibold text-slate-900">تفعيل نظام الإحالات والعمولات</span>
                  <input
                    type="checkbox"
                    checked={isEnabled}
                    onChange={(e) => setIsEnabled(e.target.checked)}
                    className="h-4 w-4 accent-emerald-700 shrink-0"
                  />
                </label>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">نسبة العمولة الافتراضية (%)</label>
                  <div className="relative">
                    <Percent className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      value={commissionPercent}
                      onChange={(e) => setCommissionPercent(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 pl-9 font-mono-num text-sm font-bold text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                  <div className="mt-1 text-[11px] text-slate-400">
                    شراء $100 يمنح <strong className="font-mono-num text-emerald-700">${((100 * (Number(commissionPercent) || 0)) / 100).toFixed(2)}</strong>
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200/80 p-3.5 space-y-2.5">
                  <label className="flex items-center justify-between gap-3 cursor-pointer">
                    <span className="text-xs font-semibold text-slate-800">تحديد سقف للعمولة لكل محيل</span>
                    <input
                      type="checkbox"
                      checked={capEnabled}
                      onChange={(e) => setCapEnabled(e.target.checked)}
                      className="h-4 w-4 accent-emerald-700 shrink-0"
                    />
                  </label>
                  {capEnabled && (
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={capAmount}
                      onChange={(e) => setCapAmount(e.target.value)}
                      placeholder={`الحد الأقصى (${currency})`}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono-num text-sm font-bold text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  )}
                </div>

                <div className="flex items-center justify-between border-t border-slate-100 pt-3.5">
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => void loadOverview()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    تحديث
                  </button>
                  <button
                    type="submit"
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
                  >
                    <Save className="h-3.5 w-3.5" />
                    {busy ? 'جارٍ الحفظ...' : 'حفظ الإعدادات'}
                  </button>
                </div>
              </form>
            </SurfacePanel>

            {/* Top Referrers + Recovery Alerts */}
            <div className="lg:col-span-7 space-y-5">
              <SurfacePanel className="overflow-hidden">
                <SectionHeader title="أبرز المحيلين النشطين" icon={Users} />
                <div className="overflow-x-auto">
                  <table className="w-full text-right border-collapse">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                        <th className="py-2.5 px-4">المستخدم</th>
                        <th className="py-2.5 px-4">Telegram ID</th>
                        <th className="py-2.5 px-4">المحالون</th>
                        <th className="py-2.5 px-4">صافي الأرباح</th>
                        <th className="py-2.5 px-4">الملف</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {(overview?.topReferrers || []).map((r) => (
                        <tr key={r.referrerUserId} className="hover:bg-slate-50/70 transition-colors">
                          <td className="py-2.5 px-4 font-semibold text-slate-900">{r.displayName}</td>
                          <td className="py-2.5 px-4 font-mono-num text-slate-500">{r.telegramUserId || '—'}</td>
                          <td className="py-2.5 px-4 font-mono-num font-bold text-slate-900">{r.referredCount}</td>
                          <td className="py-2.5 px-4 font-mono-num font-bold text-emerald-700">
                            +${r.netEarned}
                          </td>
                          <td className="py-2.5 px-4">
                            <button
                              type="button"
                              onClick={() => {
                                const q = r.telegramUserId || String(r.referrerUserId);
                                setLookupQuery(q);
                                setSubTab('lookup');
                                void handleLookupUser(q);
                              }}
                              className="text-xs font-semibold text-emerald-700 hover:underline"
                            >
                              عرض
                            </button>
                          </td>
                        </tr>
                      ))}
                      {(!overview?.topReferrers || overview.topReferrers.length === 0) && (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-slate-400">
                            لا توجد إحالات مسجلة بعد.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </SurfacePanel>

              <SurfacePanel>
                <SectionHeader
                  title="حسابات التسوية المعلقة"
                  icon={ShieldAlert}
                  action={
                    <SemanticStatus
                      tone={(overview?.recoveryAlerts?.length ?? 0) > 0 ? 'negative' : 'positive'}
                      label={(overview?.recoveryAlerts?.length ?? 0) > 0 ? `${overview?.recoveryAlerts.length} حساب` : 'سليم'}
                    />
                  }
                />
                {(overview?.recoveryAlerts || []).length > 0 ? (
                  <div className="divide-y divide-slate-100 px-5">
                    {overview!.recoveryAlerts.map((a) => (
                      <div key={a.userId} className="flex items-center justify-between py-3 text-xs">
                        <div>
                          <div className="font-semibold text-slate-900">{a.displayName}</div>
                          <div className="font-mono-num text-[11px] text-slate-400">
                            TG: {a.telegramUserId || a.userId}
                          </div>
                        </div>
                        <span className="font-mono-num font-bold text-rose-600">
                          -${a.pendingRecoveryBalance}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="px-5 py-6 text-center text-xs text-slate-400">
                    لا توجد أرصدة تسوية معلقة حاليًا.
                  </div>
                )}
              </SurfacePanel>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: USER LOOKUP */}
      {subTab === 'lookup' && (
        <div className="space-y-5">
          <SurfacePanel padded>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleLookupUser();
              }}
              className="flex flex-col gap-3 sm:flex-row sm:items-center"
            >
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={lookupQuery}
                  onChange={(e) => setLookupQuery(e.target.value)}
                  placeholder="ابحث بـ Telegram ID أو الاسم..."
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pr-9 pl-3 text-sm text-slate-900 focus:border-slate-900 focus:bg-white focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={lookupLoading || !lookupQuery.trim()}
                className="rounded-lg bg-slate-900 px-5 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
              >
                {lookupLoading ? 'جارٍ البحث...' : 'استعلام'}
              </button>
            </form>
          </SurfacePanel>

          {lookupError && <FeedbackBanner type="err" text={lookupError} onDismiss={() => setLookupError(null)} />}

          {userDossier && (
            <div className="space-y-5">
              <SurfacePanel padded className="space-y-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between border-b border-slate-100 pb-4">
                  <div>
                    <div className="flex items-center gap-2.5">
                      <h2 className="text-base font-bold text-slate-900">{userDossier.user.displayName}</h2>
                      <SemanticStatus
                        tone={userDossier.user.isBlocked ? 'negative' : 'positive'}
                        label={userDossier.user.isBlocked ? 'محظور' : 'نشط'}
                      />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2.5 text-xs text-slate-500">
                      <span className="font-mono-num">TG: {userDossier.user.telegramUserId || '—'}</span>
                      <span>·</span>
                      <span>الرصيد <strong className="font-mono-num text-slate-900">${userDossier.user.walletBalance}</strong></span>
                      {userDossier.referredBy && (
                        <>
                          <span>·</span>
                          <span>أُحيل عبر <strong className="text-slate-700">{userDossier.referredBy.displayName}</strong></span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5">
                    <span dir="ltr" className="font-mono-num text-xs text-slate-700 truncate max-w-[240px]">
                      {userDossier.summary.referralLink}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleCopyReferralLink(userDossier.summary.referralLink)}
                      className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-slate-800 shrink-0"
                    >
                      {copiedLink ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      {copiedLink ? 'نُسخ' : 'نسخ'}
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                  <div className="border-l border-slate-100 pl-3">
                    <div className="text-[11px] text-slate-400">المحالون (ناجح)</div>
                    <div className="mt-1 font-mono-num text-lg font-bold text-slate-900">
                      {userDossier.summary.totalReferredUsers}{' '}
                      <span className="text-xs font-semibold text-emerald-700">({userDossier.summary.successfulReferrals})</span>
                    </div>
                  </div>
                  <div className="border-l border-slate-100 pl-3">
                    <div className="text-[11px] text-slate-400">مشتريات المحالين</div>
                    <div className="mt-1 font-mono-num text-lg font-bold text-slate-900">${userDossier.summary.totalPurchases}</div>
                  </div>
                  <div className="border-l border-slate-100 pl-3">
                    <div className="text-[11px] text-slate-400">صافي الأرباح</div>
                    <div className="mt-1 font-mono-num text-lg font-bold text-emerald-700">+${userDossier.summary.totalEarned}</div>
                  </div>
                  <div className="border-l border-slate-100 pl-3">
                    <div className="text-[11px] text-slate-400">عمولات معكوسة</div>
                    <div className={`mt-1 font-mono-num text-lg font-bold ${Number(userDossier.summary.totalReversed) > 0 ? 'text-rose-600' : 'text-slate-700'}`}>
                      ${userDossier.summary.totalReversed}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-400">تسوية معلقة</div>
                    <div className={`mt-1 font-mono-num text-lg font-bold ${Number(userDossier.summary.pendingRecoveryBalance) > 0 ? 'text-rose-600' : 'text-emerald-700'}`}>
                      ${userDossier.summary.pendingRecoveryBalance}
                    </div>
                  </div>
                </div>
              </SurfacePanel>

              <SurfacePanel className="overflow-hidden">
                <SectionHeader title={`المستخدمون المحالون (${userDossier.referredUsers.length})`} />
                <div className="overflow-x-auto">
                  <table className="w-full text-right border-collapse min-w-[680px]">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                        <th className="py-2.5 px-4">المستخدم</th>
                        <th className="py-2.5 px-4">Telegram ID</th>
                        <th className="py-2.5 px-4">تاريخ التسجيل</th>
                        <th className="py-2.5 px-4">الطلبات</th>
                        <th className="py-2.5 px-4">المشتريات</th>
                        <th className="py-2.5 px-4">صافي العمولة</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {userDossier.referredUsers.map((ru: any) => (
                        <tr key={ru.referralId} className="hover:bg-slate-50/70">
                          <td className="py-2.5 px-4 font-semibold text-slate-900">{ru.displayName}</td>
                          <td className="py-2.5 px-4 font-mono-num text-slate-500">{ru.telegramUserId || '—'}</td>
                          <td className="py-2.5 px-4 font-mono-num text-slate-500">{formatAdminDateTime(ru.joinedAt)}</td>
                          <td className="py-2.5 px-4 font-mono-num font-semibold text-slate-900">{ru.completedOrdersCount}</td>
                          <td className="py-2.5 px-4 font-mono-num text-slate-900">${ru.totalPurchased}</td>
                          <td className="py-2.5 px-4 font-mono-num font-bold text-emerald-700">+${ru.netCommissionGenerated}</td>
                        </tr>
                      ))}
                      {userDossier.referredUsers.length === 0 && (
                        <tr>
                          <td colSpan={6} className="py-8 text-center text-slate-400">لا يوجد مستخدمون محالون بعد.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </SurfacePanel>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: IMMUTABLE COMMISSION LEDGER */}
      {subTab === 'ledger' && (
        <div className="space-y-4">
          <SurfacePanel className="p-4">
            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-12 items-end">
              <div className="md:col-span-4">
                <label className="block text-[11px] font-semibold text-slate-500 mb-1">بحث</label>
                <div className="relative">
                  <Search className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={ledgerSearch}
                    onChange={(e) => {
                      setLedgerSearch(e.target.value);
                      setLedgerPage(0);
                    }}
                    placeholder="مرجع، رقم طلب، أو Telegram ID..."
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pr-8 pl-3 text-xs text-slate-900 focus:border-slate-900 focus:bg-white focus:outline-none"
                  />
                </div>
              </div>
              <div className="md:col-span-2">
                <label className="block text-[11px] font-semibold text-slate-500 mb-1">النوع</label>
                <select
                  value={ledgerType}
                  onChange={(e) => {
                    setLedgerType(e.target.value as any);
                    setLedgerPage(0);
                  }}
                  className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-800 focus:border-slate-900 focus:outline-none"
                >
                  <option value="all">الكل</option>
                  <option value="commission">عمولات</option>
                  <option value="reversal">عكوسات</option>
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="block text-[11px] font-semibold text-slate-500 mb-1">من</label>
                <input
                  type="date"
                  value={ledgerFrom}
                  onChange={(e) => {
                    setLedgerFrom(e.target.value);
                    setLedgerPage(0);
                  }}
                  className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-mono-num text-slate-800 focus:border-slate-900 focus:outline-none"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-[11px] font-semibold text-slate-500 mb-1">إلى</label>
                <input
                  type="date"
                  value={ledgerTo}
                  onChange={(e) => {
                    setLedgerTo(e.target.value);
                    setLedgerPage(0);
                  }}
                  className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-mono-num text-slate-800 focus:border-slate-900 focus:outline-none"
                />
              </div>
              <div className="md:col-span-2 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void loadLedger()}
                  className="flex-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                >
                  تطبيق
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLedgerSearch('');
                    setLedgerType('all');
                    setLedgerStatus('all');
                    setLedgerFrom('');
                    setLedgerTo('');
                    setLedgerPage(0);
                  }}
                  aria-label="إعادة ضبط الفلاتر"
                  className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 hover:bg-slate-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </SurfacePanel>

          <SurfacePanel className="overflow-x-auto">
            <table className="w-full text-right border-collapse min-w-[960px]">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4">المرجع والتاريخ</th>
                  <th className="py-3 px-4">المحيل</th>
                  <th className="py-3 px-4">المحال</th>
                  <th className="py-3 px-4">الطلب</th>
                  <th className="py-3 px-4">العمولة</th>
                  <th className="py-3 px-4">المحفظة</th>
                  <th className="py-3 px-4">الحالة</th>
                  <th className="py-3 px-4">إجراء</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {ledgerData.items.map((item) => {
                  const isRev = item.entryType === 'reversal';
                  return (
                    <tr key={item.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-3 px-4">
                        <div className="font-mono-num font-semibold text-slate-900">{item.operationRef}</div>
                        <div className="mt-0.5 font-mono-num text-[11px] text-slate-400">
                          {formatAdminDateTime(item.createdAt)}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-900">{item.referrerName}</div>
                        <div className="font-mono-num text-[11px] text-slate-400">
                          {item.referrerTelegramId || item.referrerUserId}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="text-slate-700">{item.referredName}</div>
                        <div className="font-mono-num text-[11px] text-slate-400">
                          {item.referredTelegramId || item.referredUserId}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-mono-num font-semibold text-slate-900">{item.orderNumber}</div>
                        <div className="font-mono-num text-[11px] text-slate-500">${item.purchaseAmount}</div>
                      </td>
                      <td className="py-3 px-4">
                        <div className={`font-mono-num font-bold ${isRev ? 'text-rose-600' : 'text-emerald-700'}`}>
                          {isRev ? '-' : '+'}${item.grossCommissionAmount} ({item.commissionRatePercent}%)
                        </div>
                        {Number(item.offsetAppliedAmount) > 0 && !isRev && (
                          <div className="text-[11px] text-amber-700 font-mono-num">تسوية -${item.offsetAppliedAmount}</div>
                        )}
                        {Number(item.unrecoveredDeficitAmount) > 0 && isRev && (
                          <div className="text-[11px] text-rose-600 font-mono-num">معلق ${item.unrecoveredDeficitAmount}</div>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono-num text-slate-600">
                        ${item.balanceBefore} ← <strong className="text-slate-900">${item.balanceAfter}</strong>
                      </td>
                      <td className="py-3 px-4">
                        {isRev ? (
                          <SemanticStatus tone="negative" label="عكس عمولة" />
                        ) : (
                          <SemanticStatus
                            tone={item.hasReversal ? 'warning' : 'positive'}
                            label={item.hasReversal ? 'تم عكسها' : 'مضافة'}
                          />
                        )}
                      </td>
                      <td className="py-3 px-4">
                        {!isRev && !item.hasReversal ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setReverseTarget(item);
                              setReverseReason(`عكس عمولة للطلب ${item.orderNumber}`);
                            }}
                            className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 whitespace-nowrap"
                          >
                            <RotateCcw className="h-3 w-3" />
                            عكس
                          </button>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {ledgerData.items.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-10 text-center text-xs text-slate-400">
                      {ledgerLoading ? 'جارٍ التحميل...' : 'لا توجد قيود مطابقة.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </SurfacePanel>

          <div className="flex items-center justify-between text-xs text-slate-500">
            <div>
              الإجمالي: <strong className="font-mono-num text-slate-800">{ledgerData.total}</strong> · صفحة{' '}
              <strong className="font-mono-num text-slate-800">
                {ledgerData.page + 1}/{ledgerData.totalPages}
              </strong>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={ledgerPage <= 0 || ledgerLoading}
                onClick={() => setLedgerPage((p) => Math.max(0, p - 1))}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                <ChevronRight className="h-3.5 w-3.5" />
                السابق
              </button>
              <button
                type="button"
                disabled={ledgerPage + 1 >= ledgerData.totalPages || ledgerLoading}
                onClick={() => setLedgerPage((p) => p + 1)}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                التالي
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Commission Reversal Confirm Modal */}
      {reverseTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-rose-200 p-6 shadow-xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-rose-50 p-2 text-rose-600 shrink-0">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">تأكيد عكس العمولة</h3>
                <p className="mt-1 text-xs leading-relaxed text-slate-600">
                  سيتم عكس عمولة الطلب{' '}
                  <span className="font-mono-num font-bold text-slate-900">{reverseTarget.orderNumber}</span> بقيمة{' '}
                  <span className="font-mono-num font-bold text-rose-600">${reverseTarget.grossCommissionAmount}</span> من حساب{' '}
                  <span className="font-bold text-slate-900">{reverseTarget.referrerName}</span>.
                </p>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">سبب العكس</label>
              <input
                type="text"
                value={reverseReason}
                onChange={(e) => setReverseReason(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-rose-600 focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => setReverseTarget(null)}
                className="rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                تراجع
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleConfirmReverseCommission()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-2 text-xs font-bold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                <Wallet className="h-3.5 w-3.5" />
                {busy ? 'جارٍ التنفيذ...' : 'تأكيد العكس'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
