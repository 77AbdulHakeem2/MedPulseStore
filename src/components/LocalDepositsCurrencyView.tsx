import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Banknote,
  Check,
  CheckCircle2,
  Clock,
  Edit3,
  Eye,
  Landmark,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Trash2,
  UserCheck,
  X,
  XCircle,
} from 'lucide-react';
import { apiFetch, getAuthToken } from '../lib/api';
import {
  EmptyState,
  FeedbackBanner,
  KpiCard,
  SectionHeader,
  SemanticStatus,
  SurfacePanel,
  SegmentedTabs,
} from './ui/AdminPrimitives';

interface LocalWalletItem {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string;
  accountNumber: string;
  accountHolderName: string;
  instructionsAr: string;
  instructionsEn: string;
  logoUrl: string;
  minAmountYer: string | null;
  maxAmountYer: string | null;
  isEnabled: boolean;
  sortOrder: number;
}

interface LocalDepositItem {
  id: number;
  depositRef: string;
  userId: number;
  userDisplayName: string;
  userTelegramId: string;
  userTelegramUsername: string;
  walletNameSnapshot: string;
  recipientAccountSnapshot: string;
  recipientHolderSnapshot: string;
  depositorNameUsed: string;
  depositorNameIsTemporary: boolean;
  senderWalletNumber: string;
  amountYer: string;
  equivalentUsd: string;
  exchangeRateUsed: string;
  exchangeRateMarket: string;
  status: 'pending_review' | 'approved' | 'rejected' | 'cancelled';
  rejectionReason: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  creditedAt: string | null;
  hasProofImage: boolean;
  createdAt: string;
}

interface CurrencySettingsDTO {
  localDepositsEnabled: boolean;
  market: 'sanaa' | 'aden';
  rateType: 'buy' | 'sell' | 'mid';
  roundingMode: 'exact' | 'nearest_1' | 'nearest_10' | 'nearest_50' | 'nearest_100';
  maxRateAgeMinutes: number;
  minDepositYer: number;
  maxDepositYer: number;
  reviewChannelId: string;
  reviewChannelTitle: string;
  reviewChannelVerified: boolean;
  reviewChannelVerifiedAt: string | null;
}

interface LiveRateDTO {
  ok: boolean;
  rate: string | null;
  buyRate: string | null;
  sellRate: string | null;
  market: string;
  rateType: string;
  source: string;
  providerLastVerifiedAt: string | null;
  providerLastPriceChange: string | null;
  fetchedAt: string;
  errorMessageAr?: string;
}

interface DepositorNameItem {
  id: number;
  displayName: string;
  telegramUserId: string | null;
  telegramUsername: string | null;
  preferredCurrency: string;
  savedDepositorName: string;
  updatedAt: string;
}

const REJECT_PRESETS = [
  'صورة إثبات التحويل غير واضحة أو ناقصة',
  'المبلغ المحول غير مطابق للمبلغ المطلوب',
  'لم يصل التحويل إلى حساب المحفظة المحدد',
  'بيانات اسم المرسل غير مطابقة للحوالة',
  'إيصال التحويل مستخدم مسبقًا',
];

function fmtYer(val: string | number): string {
  const num = Number(val || 0);
  if (!Number.isFinite(num)) return '0 ﷼';
  return `${Math.round(num).toLocaleString('en-US')} ﷼`;
}

export default function LocalDepositsCurrencyView({
  onRefreshWorkspace,
}: {
  onRefreshWorkspace?: () => Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState<'requests' | 'wallets' | 'settings' | 'depositors'>(
    'requests'
  );
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Deposits state
  const [deposits, setDeposits] = useState<LocalDepositItem[]>([]);
  const [depositSummary, setDepositSummary] = useState({
    totalCount: 0,
    pendingCount: 0,
    approvedCount: 0,
    rejectedCount: 0,
    approvedTotalYer: '0.00',
    approvedTotalUsd: '0.00',
  });
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Wallets state
  const [wallets, setWallets] = useState<LocalWalletItem[]>([]);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [editingWallet, setEditingWallet] = useState<LocalWalletItem | null>(null);
  const [walletForm, setWalletForm] = useState({
    nameAr: '',
    nameEn: '',
    accountNumber: '',
    accountHolderName: '',
    instructionsAr: '',
    instructionsEn: '',
    logoUrl: '',
    minAmountYer: '',
    maxAmountYer: '',
    isEnabled: true,
  });

  // Settings & Live Rate state
  const [currencySettings, setCurrencySettings] = useState<CurrencySettingsDTO>({
    localDepositsEnabled: true,
    market: 'sanaa',
    rateType: 'buy',
    roundingMode: 'nearest_10',
    maxRateAgeMinutes: 720,
    minDepositYer: 1000,
    maxDepositYer: 500000,
    reviewChannelId: '',
    reviewChannelTitle: '',
    reviewChannelVerified: false,
    reviewChannelVerifiedAt: null,
  });
  const [liveRate, setLiveRate] = useState<LiveRateDTO | null>(null);
  const [refreshingRate, setRefreshingRate] = useState(false);
  const [testingChannel, setTestingChannel] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [channelTestResult, setChannelTestResult] = useState<{
    ok: boolean;
    text: string;
    warningAr?: string;
    channelId?: string;
    channelTitle?: string;
    botUsername?: string;
  } | null>(null);

  // Saved Depositor Names state
  const [depositorNames, setDepositorNames] = useState<DepositorNameItem[]>([]);
  const [depositorSearch, setDepositorSearch] = useState('');
  const [editingDepositorId, setEditingDepositorId] = useState<number | null>(null);
  const [editingDepositorVal, setEditingDepositorVal] = useState('');

  // Modals: Proof viewer & Rejection modal
  const [proofModal, setProofModal] = useState<{
    deposit: LocalDepositItem;
    blobUrl: string | null;
    loading: boolean;
    error?: string;
  } | null>(null);
  const [rejectModalDeposit, setRejectModalDeposit] = useState<LocalDepositItem | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [processingId, setProcessingId] = useState<number | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [depRes, walRes, setRes, nameRes] = await Promise.all([
        apiFetch<{ deposits: LocalDepositItem[]; summary: typeof depositSummary }>(
          `/api/admin/local-deposits?status=${encodeURIComponent(statusFilter)}&search=${encodeURIComponent(searchQuery)}`
        ),
        apiFetch<{ wallets: LocalWalletItem[] }>('/api/admin/local-wallets'),
        apiFetch<{ settings: CurrencySettingsDTO; liveRate: LiveRateDTO }>(
          '/api/admin/currency-settings'
        ),
        apiFetch<{ items: DepositorNameItem[] }>(
          `/api/admin/depositor-names?search=${encodeURIComponent(depositorSearch)}`
        ),
      ]);
      setDeposits(depRes.deposits || []);
      if (depRes.summary) setDepositSummary(depRes.summary);
      setWallets(walRes.wallets || []);
      if (setRes.settings) setCurrencySettings(setRes.settings);
      if (setRes.liveRate) setLiveRate(setRes.liveRate);
      setDepositorNames(nameRes.items || []);
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تحميل بيانات المحافظ المحلية.' });
    } finally {
      setLoading(false);
    }
  }, [statusFilter, searchQuery, depositorSearch]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const openProofViewer = async (dep: LocalDepositItem) => {
    setProofModal({ deposit: dep, blobUrl: null, loading: true });
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/admin/local-deposits/${dep.id}/proof`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        throw new Error('صورة الإثبات غير متوفرة حاليًا.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setProofModal({ deposit: dep, blobUrl: url, loading: false });
    } catch (err: any) {
      setProofModal({
        deposit: dep,
        blobUrl: null,
        loading: false,
        error: err?.message || 'تعذر تحميل صورة الإثبات.',
      });
    }
  };

  const closeProofViewer = () => {
    if (proofModal?.blobUrl) {
      URL.revokeObjectURL(proofModal.blobUrl);
    }
    setProofModal(null);
  };

  const handleApproveDeposit = async (dep: LocalDepositItem) => {
    setProcessingId(dep.id);
    setFeedback(null);
    try {
      const res = await apiFetch<{ messageAr: string }>(
        `/api/admin/local-deposits/${dep.id}/approve`,
        { method: 'POST' }
      );
      setFeedback({ type: 'ok', text: res.messageAr || 'تمت الموافقة على الإيداع بنجاح.' });
      await loadAll();
      if (onRefreshWorkspace) await onRefreshWorkspace();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر اعتماد الإيداع.' });
    } finally {
      setProcessingId(null);
    }
  };

  const handleConfirmRejectDeposit = async () => {
    if (!rejectModalDeposit) return;
    setProcessingId(rejectModalDeposit.id);
    setFeedback(null);
    try {
      const res = await apiFetch<{ messageAr: string }>(
        `/api/admin/local-deposits/${rejectModalDeposit.id}/reject`,
        {
          method: 'POST',
          body: JSON.stringify({ reason: rejectReason.trim() }),
        }
      );
      setFeedback({ type: 'ok', text: res.messageAr || 'تم رفض الإيداع.' });
      setRejectModalDeposit(null);
      setRejectReason('');
      await loadAll();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر رفض الإيداع.' });
    } finally {
      setProcessingId(null);
    }
  };

  const openCreateWallet = () => {
    setEditingWallet(null);
    setWalletForm({
      nameAr: '',
      nameEn: '',
      accountNumber: '',
      accountHolderName: '',
      instructionsAr: '',
      instructionsEn: '',
      logoUrl: '',
      minAmountYer: '',
      maxAmountYer: '',
      isEnabled: true,
    });
    setWalletModalOpen(true);
  };

  const openEditWallet = (w: LocalWalletItem) => {
    setEditingWallet(w);
    setWalletForm({
      nameAr: w.nameAr,
      nameEn: w.nameEn || '',
      accountNumber: w.accountNumber,
      accountHolderName: w.accountHolderName,
      instructionsAr: w.instructionsAr || '',
      instructionsEn: w.instructionsEn || '',
      logoUrl: w.logoUrl || '',
      minAmountYer: w.minAmountYer ? String(Math.round(Number(w.minAmountYer))) : '',
      maxAmountYer: w.maxAmountYer ? String(Math.round(Number(w.maxAmountYer))) : '',
      isEnabled: w.isEnabled,
    });
    setWalletModalOpen(true);
  };

  const handleSaveWallet = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    try {
      const payload = {
        nameAr: walletForm.nameAr.trim(),
        nameEn: walletForm.nameEn.trim() || walletForm.nameAr.trim(),
        accountNumber: walletForm.accountNumber.trim(),
        accountHolderName: walletForm.accountHolderName.trim(),
        instructionsAr: walletForm.instructionsAr.trim(),
        instructionsEn: walletForm.instructionsEn.trim(),
        logoUrl: walletForm.logoUrl.trim(),
        minAmountYer: walletForm.minAmountYer.trim() ? Number(walletForm.minAmountYer) : null,
        maxAmountYer: walletForm.maxAmountYer.trim() ? Number(walletForm.maxAmountYer) : null,
        isEnabled: walletForm.isEnabled,
      };
      if (editingWallet) {
        await apiFetch(`/api/admin/local-wallets/${editingWallet.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        setFeedback({ type: 'ok', text: `تم تحديث المحفظة «${payload.nameAr}» بنجاح.` });
      } else {
        await apiFetch('/api/admin/local-wallets', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setFeedback({ type: 'ok', text: `تمت إضافة المحفظة المحلية «${payload.nameAr}» بنجاح.` });
      }
      setWalletModalOpen(false);
      await loadAll();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر حفظ بيانات المحفظة.' });
    }
  };

  const handleToggleWallet = async (w: LocalWalletItem) => {
    try {
      await apiFetch(`/api/admin/local-wallets/${w.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isEnabled: !w.isEnabled }),
      });
      await loadAll();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تغيير حالة المحفظة.' });
    }
  };

  const handleDeleteWallet = async (w: LocalWalletItem) => {
    try {
      await apiFetch(`/api/admin/local-wallets/${w.id}`, { method: 'DELETE' });
      setFeedback({ type: 'ok', text: `تم حذف المحفظة «${w.nameAr}».` });
      await loadAll();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر حذف المحفظة.' });
    }
  };

  const handleMoveWallet = async (index: number, direction: -1 | 1) => {
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= wallets.length) return;
    const copy = [...wallets];
    const [moved] = copy.splice(index, 1);
    copy.splice(targetIdx, 0, moved);
    setWallets(copy);
    try {
      await apiFetch('/api/admin/local-wallets/reorder', {
        method: 'POST',
        body: JSON.stringify({ orderedIds: copy.map((w) => w.id) }),
      });
    } catch {
      await loadAll();
    }
  };

  const handleSaveCurrencySettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSettings(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ settings: CurrencySettingsDTO; liveRate: LiveRateDTO }>(
        '/api/admin/currency-settings',
        {
          method: 'PATCH',
          body: JSON.stringify(currencySettings),
        }
      );
      setCurrencySettings(res.settings);
      setLiveRate(res.liveRate);
      setFeedback({ type: 'ok', text: 'تم حفظ إعدادات العملة اليمنية والمحافظ المحلية بنجاح.' });
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر حفظ الإعدادات.' });
    } finally {
      setSavingSettings(false);
    }
  };

  const handleRefreshLiveRate = async () => {
    setRefreshingRate(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ ok: boolean; liveRate: LiveRateDTO }>(
        '/api/admin/currency-settings/refresh-rate',
        { method: 'POST' }
      );
      setLiveRate(res.liveRate);
      setFeedback({
        type: res.ok ? 'ok' : 'err',
        text: res.ok
          ? `تم تحديث سعر الصرف المباشر بنجاح: 1$ = ${Number(res.liveRate.rate).toFixed(2)} ﷼`
          : res.liveRate?.errorMessageAr || 'تعذر جلب سعر الصرف المباشر حاليًا.',
      });
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تحديث سعر الصرف.' });
    } finally {
      setRefreshingRate(false);
    }
  };

  const handleTestChannel = async () => {
    setTestingChannel(true);
    setFeedback(null);
    setChannelTestResult(null);
    try {
      const res = await apiFetch<{
        ok: boolean;
        messageAr: string;
        warningAr?: string;
        channelId?: string;
        channelTitle?: string;
        botUsername?: string;
        settings?: CurrencySettingsDTO;
      }>('/api/admin/currency-settings/test-channel', {
        method: 'POST',
        body: JSON.stringify({ reviewChannelId: currencySettings.reviewChannelId }),
      });
      if (res.settings) {
        setCurrencySettings(res.settings);
      } else if (res.ok && res.channelId) {
        setCurrencySettings((p) => ({
          ...p,
          reviewChannelId: res.channelId || p.reviewChannelId,
          reviewChannelTitle: res.channelTitle || p.reviewChannelTitle,
          reviewChannelVerified: true,
        }));
      }
      setChannelTestResult({
        ok: Boolean(res.ok),
        text: res.messageAr || (res.ok ? 'تم التحقق من صلاحيات القناة بنجاح.' : 'تعذر التحقق من صلاحيات القناة.'),
        warningAr: res.warningAr,
        channelId: res.channelId,
        channelTitle: res.channelTitle,
        botUsername: res.botUsername,
      });
      setFeedback({ type: res.ok ? 'ok' : 'err', text: res.messageAr });
    } catch (err: any) {
      const msg = err?.message || 'تعذر فحص صلاحيات القناة.';
      setChannelTestResult({ ok: false, text: msg });
      setFeedback({ type: 'err', text: msg });
    } finally {
      setTestingChannel(false);
    }
  };

  const handleSaveDepositorName = async (userId: number, newVal: string) => {
    setFeedback(null);
    try {
      await apiFetch(`/api/admin/depositor-names/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ savedDepositorName: newVal }),
      });
      setEditingDepositorId(null);
      setFeedback({
        type: 'ok',
        text: newVal.trim() ? 'تم تحديث الاسم الرباعي للمستخدم بنجاح.' : 'تم مسح الاسم الرباعي المحفوظ للمستخدم.',
      });
      await loadAll();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تعديل الاسم الرباعي.' });
    }
  };

  const activeWalletsCount = wallets.filter((w) => w.isEnabled).length;
  const liveRateDisplay =
    liveRate?.ok && liveRate.rate ? `${Number(liveRate.rate).toFixed(0)} ﷼` : 'غير متاح';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            المحافظ المحلية والريال اليمني
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            إدارة المحافظ اليمنية، مراجعة طلبات الإيداع اليدوي، وسعر الصرف المباشر من ye-rial.com
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void handleRefreshLiveRate()}
            disabled={refreshingRate}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshingRate ? 'animate-spin' : ''}`} />
            <span>تحديث سعر الصرف</span>
          </button>
          <button
            type="button"
            onClick={openCreateWallet}
            className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-800"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>إضافة محفظة محلية</span>
          </button>
        </div>
      </div>

      {feedback && (
        <FeedbackBanner
          type={feedback.type}
          text={feedback.text}
          onDismiss={() => setFeedback(null)}
        />
      )}

      {/* Executive KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          icon={Clock}
          label="إيداعات بانتظار المراجعة"
          value={depositSummary.pendingCount}
          tone={depositSummary.pendingCount > 0 ? 'warning' : 'positive'}
          valueTone={depositSummary.pendingCount > 0 ? 'default' : 'positive'}
          indicatorText={`${depositSummary.totalCount} إجمالي الطلبات`}
        />
        <KpiCard
          icon={Banknote}
          label="إجمالي الإيداعات المعتمدة"
          value={fmtYer(depositSummary.approvedTotalYer)}
          tone="positive"
          valueTone="positive"
          indicatorText={`≈ $${Number(depositSummary.approvedTotalUsd || 0).toFixed(2)} USD`}
        />
        <KpiCard
          icon={RefreshCw}
          label={`سعر الصرف الحي (${currencySettings.market === 'aden' ? 'عدن' : 'صنعاء'})`}
          value={liveRateDisplay}
          tone={liveRate?.ok ? 'positive' : 'negative'}
          valueTone={liveRate?.ok ? 'positive' : 'negative'}
          indicatorText={
            liveRate?.ok && liveRate.buyRate && liveRate.sellRate
              ? `شراء ${Number(liveRate.buyRate).toFixed(0)} · بيع ${Number(liveRate.sellRate).toFixed(0)}`
              : 'المصدر غير متصل'
          }
        />
        <KpiCard
          icon={Landmark}
          label="المحافظ المحلية المفعّلة"
          value={activeWalletsCount}
          tone={activeWalletsCount > 0 && currencySettings.reviewChannelVerified ? 'positive' : 'warning'}
          indicatorText={
            currencySettings.reviewChannelVerified
              ? `قناة المراجعة: متصلة`
              : 'قناة المراجعة: غير مفحوصة'
          }
        />
      </div>

      {/* Sub-Tabs */}
      <SegmentedTabs
        value={activeTab}
        onChange={(next) => setActiveTab(next)}
        items={[
          {
            id: 'requests',
            label: 'طلبات الإيداع المحلي',
            count: depositSummary.pendingCount,
          },
          {
            id: 'wallets',
            label: 'المحافظ المحلية',
            count: wallets.length,
          },
          {
            id: 'settings',
            label: 'سعر الصرف وقناة المراجعة',
          },
          {
            id: 'depositors',
            label: 'أسماء المودعين المحفوظة',
            count: depositorNames.length,
          },
        ]}
      />

      {/* ================================================================= */}
      {/* TAB 1: LOCAL DEPOSIT REQUESTS                                     */}
      {/* ================================================================= */}
      {activeTab === 'requests' && (
        <SurfacePanel className="overflow-hidden">
          <div className="border-b border-slate-100 p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-1.5">
              {[
                { key: 'all', label: `الكل (${depositSummary.totalCount})` },
                { key: 'pending_review', label: `قيد المراجعة (${depositSummary.pendingCount})` },
                { key: 'approved', label: `موافق عليها (${depositSummary.approvedCount})` },
                { key: 'rejected', label: `مرفوضة (${depositSummary.rejectedCount})` },
              ].map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setStatusFilter(f.key)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                    statusFilter === f.key
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="بحث برقم العملية أو User ID أو الاسم..."
                className="w-full rounded-xl border border-slate-200 bg-slate-50/70 py-2 pe-3 ps-9 text-xs text-slate-800 focus:border-emerald-600 focus:bg-white focus:outline-none"
              />
            </div>
          </div>

          {deposits.length === 0 ? (
            <div className="p-8">
              <EmptyState
                icon={Banknote}
                title="لا توجد طلبات إيداع محلي مطابقة"
                description="عند إرسال العملاء طلبات إيداع عبر المحافظ المحلية اليمنية ستظهر هنا فورًا مع صور الإثبات."
              />
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {deposits.map((dep) => {
                const isPending = dep.status === 'pending_review';
                const busy = processingId === dep.id;
                return (
                  <div
                    key={dep.id}
                    className="p-4 sm:p-5 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between hover:bg-slate-50/60 transition-colors"
                  >
                    <div className="space-y-1.5 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono-num text-sm font-bold text-slate-900">
                          {dep.depositRef}
                        </span>
                        <SemanticStatus
                          tone={
                            dep.status === 'approved'
                              ? 'positive'
                              : dep.status === 'rejected'
                              ? 'negative'
                              : 'warning'
                          }
                          label={
                            dep.status === 'approved'
                              ? 'تمت الموافقة'
                              : dep.status === 'rejected'
                              ? 'مرفوض'
                              : 'قيد المراجعة'
                          }
                        />
                        <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200/70 rounded-lg px-2 py-0.5 font-mono-num">
                          {fmtYer(dep.amountYer)}
                        </span>
                        <span className="text-xs text-slate-500 font-mono-num">
                          ≈ ${Number(dep.equivalentUsd).toFixed(2)} USD (سعر {Number(dep.exchangeRateUsed).toFixed(0)} ﷼)
                        </span>
                      </div>

                      <div className="text-xs text-slate-700 flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span>
                          <strong className="text-slate-900">المستخدم:</strong>{' '}
                          {dep.userDisplayName}
                          {dep.userTelegramUsername ? ` (@${dep.userTelegramUsername})` : ''} · ID:{' '}
                          <span className="font-mono-num">{dep.userTelegramId || dep.userId}</span>
                        </span>
                        <span>
                          <strong className="text-slate-900">المحفظة:</strong> {dep.walletNameSnapshot} (
                          <span className="font-mono-num">{dep.recipientAccountSnapshot}</span>)
                        </span>
                      </div>

                      <div className="text-xs text-slate-600 flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span>
                          <strong className="text-slate-900">اسم المودع الرباعي:</strong>{' '}
                          {dep.depositorNameUsed}
                          {dep.depositorNameIsTemporary && (
                            <span className="ms-1.5 text-[11px] font-semibold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">
                              مؤقت لهذه العملية
                            </span>
                          )}
                        </span>
                        <span className="text-slate-400 font-mono-num">
                          {new Date(dep.createdAt).toLocaleString('ar-YE')}
                        </span>
                      </div>

                      {dep.reviewedByName && (
                        <div className="text-[11px] text-slate-500">
                          تمت المراجعة بواسطة <strong>{dep.reviewedByName}</strong>
                          {dep.reviewedAt ? ` · ${new Date(dep.reviewedAt).toLocaleString('ar-YE')}` : ''}
                          {dep.rejectionReason ? ` — السبب: ${dep.rejectionReason}` : ''}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {dep.hasProofImage && (
                        <button
                          type="button"
                          onClick={() => void openProofViewer(dep)}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          <Eye className="h-3.5 w-3.5 text-sky-600" />
                          <span>صورة الإثبات</span>
                        </button>
                      )}

                      {isPending && (
                        <>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleApproveDeposit(dep)}
                            className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
                          >
                            <Check className="h-3.5 w-3.5" />
                            <span>{busy ? 'جارٍ الاعتماد...' : 'موافقة وإضافة الرصيد'}</span>
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setRejectModalDeposit(dep);
                              setRejectReason('');
                            }}
                            className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-3.5 py-2 text-xs font-bold text-white hover:bg-rose-700 disabled:opacity-50"
                          >
                            <X className="h-3.5 w-3.5" />
                            <span>رفض</span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SurfacePanel>
      )}

      {/* ================================================================= */}
      {/* TAB 2: LOCAL WALLETS CRUD & REORDERING                            */}
      {/* ================================================================= */}
      {activeTab === 'wallets' && (
        <SurfacePanel className="overflow-hidden">
          <SectionHeader
            title="المحافظ الإلكترونية اليمنية المحلية"
            subtitle="أضف وعدّل ورتّب المحافظ التي تظهر للعملاء داخل قسم «🇾🇪 المحافظ المحلية» في البوت والموقع"
            icon={Landmark}
            action={
              <button
                type="button"
                onClick={openCreateWallet}
                className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>محفظة جديدة</span>
              </button>
            }
          />

          {wallets.length === 0 ? (
            <div className="p-8">
              <EmptyState
                icon={Landmark}
                title="لا توجد محافظ محلية مضافة بعد"
                description="أضف محافظ مثل جوالي، الكريمي، كاش، ون كاش، أو أي محفظة يمنية أخرى مع رقم الحساب وتعليمات التحويل."
              />
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {wallets.map((w, idx) => (
                <div
                  key={w.id}
                  className="p-4 sm:p-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold text-sm text-slate-900">{w.nameAr}</span>
                      {w.nameEn && w.nameEn !== w.nameAr && (
                        <span className="text-xs text-slate-400">({w.nameEn})</span>
                      )}
                      <SemanticStatus
                        tone={w.isEnabled ? 'positive' : 'neutral'}
                        label={w.isEnabled ? 'مفعّلة' : 'معطّلة'}
                      />
                    </div>
                    <div className="text-xs text-slate-600 flex flex-wrap gap-x-4 gap-y-1">
                      <span>
                        رقم الحساب: <strong className="font-mono-num text-slate-900">{w.accountNumber}</strong>
                      </span>
                      <span>
                        المستلم: <strong className="text-slate-900">{w.accountHolderName}</strong>
                      </span>
                      {(w.minAmountYer || w.maxAmountYer) && (
                        <span className="font-mono-num text-slate-500">
                          الحدود: {w.minAmountYer ? fmtYer(w.minAmountYer) : 'افتراضي'} —{' '}
                          {w.maxAmountYer ? fmtYer(w.maxAmountYer) : 'افتراضي'}
                        </span>
                      )}
                    </div>
                    {w.instructionsAr && (
                      <p className="text-xs text-slate-500 line-clamp-2">{w.instructionsAr}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => void handleMoveWallet(idx, -1)}
                      title="تحريك لأعلى"
                      className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50 disabled:opacity-30"
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={idx === wallets.length - 1}
                      onClick={() => void handleMoveWallet(idx, 1)}
                      title="تحريك لأسفل"
                      className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50 disabled:opacity-30"
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleToggleWallet(w)}
                      className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                        w.isEnabled
                          ? 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
                          : 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                      }`}
                    >
                      {w.isEnabled ? 'تعطيل' : 'تفعيل'}
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditWallet(w)}
                      className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50"
                      title="تعديل"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteWallet(w)}
                      className="rounded-lg border border-rose-200 p-2 text-rose-600 hover:bg-rose-50"
                      title="حذف"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SurfacePanel>
      )}

      {/* ================================================================= */}
      {/* TAB 3: EXCHANGE RATE & ADMIN REVIEW CHANNEL SETTINGS              */}
      {/* ================================================================= */}
      {activeTab === 'settings' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Exchange Rate & Limits Form */}
          <SurfacePanel className="overflow-hidden">
            <SectionHeader
              title="إعدادات سعر الصرف والريال اليمني"
              subtitle="يتم جلب السعر الحي مباشرة من ye-rial.com والتحقق من صلاحيته قبل أي عملية مالية"
              icon={Settings2}
            />
            <form onSubmit={(e) => void handleSaveCurrencySettings(e)} className="p-5 space-y-4">
              <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3">
                <div>
                  <div className="text-xs font-bold text-slate-900">تفعيل نظام الإيداع عبر المحافظ المحلية</div>
                  <div className="text-[11px] text-slate-500">إظهار زر «🇾🇪 المحافظ المحلية» في البوت والموقع</div>
                </div>
                <input
                  type="checkbox"
                  checked={currencySettings.localDepositsEnabled}
                  onChange={(e) =>
                    setCurrencySettings((p) => ({ ...p, localDepositsEnabled: e.target.checked }))
                  }
                  className="h-4 w-4 accent-emerald-700"
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">سوق الصرف المعتمد</label>
                  <select
                    value={currencySettings.market}
                    onChange={(e) =>
                      setCurrencySettings((p) => ({
                        ...p,
                        market: e.target.value === 'aden' ? 'aden' : 'sanaa',
                      }))
                    }
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-900 bg-white"
                  >
                    <option value="sanaa">صنعاء (Sanaa — الطبعة القديمة)</option>
                    <option value="aden">عدن (Aden — الطبعة الجديدة)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">السعر المعتمد للتحويل</label>
                  <select
                    value={currencySettings.rateType}
                    onChange={(e) =>
                      setCurrencySettings((p) => ({ ...p, rateType: e.target.value as any }))
                    }
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-900 bg-white"
                  >
                    <option value="buy">سعر الشراء (Buy)</option>
                    <option value="sell">سعر البيع (Sell)</option>
                    <option value="mid">متوسط الشراء والبيع (Mid)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">قاعدة تقريب الأسعار بالريال</label>
                  <select
                    value={currencySettings.roundingMode}
                    onChange={(e) =>
                      setCurrencySettings((p) => ({ ...p, roundingMode: e.target.value as any }))
                    }
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-900 bg-white"
                  >
                    <option value="nearest_10">أقرب 10 ﷼ (موصى به)</option>
                    <option value="nearest_50">أقرب 50 ﷼</option>
                    <option value="nearest_100">أقرب 100 ﷼</option>
                    <option value="nearest_1">أقرب 1 ﷼</option>
                    <option value="exact">دقيق (خانتين عشريتين)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    تنبيه قدم تحديث المزود (دقيقة — لا يوقف التحويل)
                  </label>
                  <input
                    type="number"
                    min={5}
                    max={10080}
                    value={currencySettings.maxRateAgeMinutes}
                    onChange={(e) =>
                      setCurrencySettings((p) => ({
                        ...p,
                        maxRateAgeMinutes: Number(e.target.value) || 720,
                      }))
                    }
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-mono-num text-slate-900"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    الحد الأدنى للإيداع المحلي (﷼)
                  </label>
                  <input
                    type="number"
                    min={100}
                    value={currencySettings.minDepositYer}
                    onChange={(e) =>
                      setCurrencySettings((p) => ({ ...p, minDepositYer: Number(e.target.value) || 1000 }))
                    }
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-mono-num text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    الحد الأقصى للإيداع المحلي (﷼)
                  </label>
                  <input
                    type="number"
                    min={1000}
                    value={currencySettings.maxDepositYer}
                    onChange={(e) =>
                      setCurrencySettings((p) => ({
                        ...p,
                        maxDepositYer: Number(e.target.value) || 500000,
                      }))
                    }
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-mono-num text-slate-900"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={savingSettings}
                className="w-full rounded-xl bg-slate-900 py-2.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
              >
                {savingSettings ? 'جارٍ الحفظ...' : 'حفظ إعدادات العملة والحدود'}
              </button>
            </form>
          </SurfacePanel>

          {/* Telegram Review Channel Config + Live Rate Card */}
          <div className="space-y-6">
            <SurfacePanel className="overflow-hidden">
              <SectionHeader
                title="قناة المراجعة الإدارية على تيليجرام"
                subtitle="تُرسل إليها صور إثباتات التحويل مع أزرار الموافقة والرفض الفورية"
                icon={Send}
              />
              <div className="p-5 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    معرّف القناة (Channel ID أو @username أو رابط رسالة)
                  </label>
                  <input
                    type="text"
                    dir="ltr"
                    value={currencySettings.reviewChannelId}
                    onChange={(e) => {
                      setChannelTestResult(null);
                      setCurrencySettings((p) => ({ ...p, reviewChannelId: e.target.value }));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleTestChannel();
                      }
                    }}
                    placeholder="-1001234567890 أو @your_review_channel أو https://t.me/c/..."
                    className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-xs font-mono-num text-slate-900"
                  />
                  <p className="mt-1.5 text-[11px] text-slate-500">
                    أضف البوت كمسؤول في القناة بصلاحية «نشر الرسائل»، ثم أدخل المعرّف مثل{' '}
                    <span className="font-mono-num text-slate-700">-100xxxxxxxxxx</span> أو انسخ رابط أي رسالة من القناة{' '}
                    <span className="font-mono-num text-slate-700">t.me/c/...</span>.
                  </p>
                </div>

                <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3.5 text-xs space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500">حالة الاتصال والصلاحيات:</span>
                    <SemanticStatus
                      tone={currencySettings.reviewChannelVerified ? 'positive' : 'warning'}
                      label={
                        currencySettings.reviewChannelVerified
                          ? `متصلة (${currencySettings.reviewChannelTitle || currencySettings.reviewChannelId})`
                          : 'بانتظار فحص الصلاحيات'
                      }
                    />
                  </div>
                  {currencySettings.reviewChannelVerifiedAt && (
                    <div className="text-[11px] text-slate-400">
                      آخر تحقق: {new Date(currencySettings.reviewChannelVerifiedAt).toLocaleString('ar-YE')}
                    </div>
                  )}
                </div>

                {channelTestResult && (
                  <div
                    role="status"
                    className={`rounded-xl border p-3.5 text-xs space-y-1.5 ${
                      channelTestResult.ok
                        ? 'border-emerald-200 bg-emerald-50/90 text-emerald-900'
                        : 'border-rose-200 bg-rose-50/90 text-rose-900'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      {channelTestResult.ok ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                      ) : (
                        <XCircle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
                      )}
                      <div className="space-y-1 min-w-0">
                        <div className="font-semibold leading-relaxed">{channelTestResult.text}</div>
                        {channelTestResult.warningAr && (
                          <div className="text-[11px] text-amber-800">{channelTestResult.warningAr}</div>
                        )}
                        {channelTestResult.ok && channelTestResult.channelId && (
                          <div className="text-[11px] text-emerald-700 font-mono-num">
                            المعرّف المعتمد: {channelTestResult.channelId}
                            {channelTestResult.botUsername ? ` · البوت: @${channelTestResult.botUsername}` : ''}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={testingChannel}
                    onClick={() => void handleTestChannel()}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-700 px-4 py-2.5 text-xs font-bold text-white hover:bg-emerald-800 disabled:opacity-50"
                  >
                    <ShieldCheck className="h-4 w-4" />
                    <span>{testingChannel ? 'جارٍ فحص الصلاحيات...' : 'فحص صلاحيات البوت في القناة'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={savingSettings}
                    onClick={(e) => void handleSaveCurrencySettings(e as any)}
                    className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    حفظ المعرّف
                  </button>
                </div>
              </div>
            </SurfacePanel>

            {/* Live Rate Status Box */}
            <SurfacePanel className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-bold text-slate-900">حالة سعر الصرف المباشر (ye-rial.com)</div>
                <SemanticStatus
                  tone={liveRate?.ok ? 'positive' : 'negative'}
                  label={liveRate?.ok ? 'متصل ومحدّث' : 'متوقف / غير متاح'}
                />
              </div>
              {liveRate?.ok ? (
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-slate-50 border border-slate-100 p-3">
                    <div className="text-[11px] text-slate-500">الشراء (Buy)</div>
                    <div className="mt-1 font-mono-num text-base font-bold text-slate-900">
                      {Number(liveRate.buyRate || 0).toFixed(0)} ﷼
                    </div>
                  </div>
                  <div className="rounded-xl bg-slate-50 border border-slate-100 p-3">
                    <div className="text-[11px] text-slate-500">البيع (Sell)</div>
                    <div className="mt-1 font-mono-num text-base font-bold text-slate-900">
                      {Number(liveRate.sellRate || 0).toFixed(0)} ﷼
                    </div>
                  </div>
                  <div className="rounded-xl bg-emerald-50 border border-emerald-200/70 p-3">
                    <div className="text-[11px] text-emerald-700">المعتمد حاليًا</div>
                    <div className="mt-1 font-mono-num text-base font-bold text-emerald-800">
                      {Number(liveRate.rate || 0).toFixed(2)} ﷼
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs text-rose-700">
                  {liveRate?.errorMessageAr || 'تعذر الاتصال بخدمة أسعار الصرف. تم تعليق التحويلات المالية تلقائيًا.'}
                </div>
              )}
              {liveRate?.providerLastVerifiedAt && (
                <div className="text-[11px] text-slate-400">
                  آخر تحقق من المزود: {new Date(liveRate.providerLastVerifiedAt).toLocaleString('ar-YE')}
                </div>
              )}
            </SurfacePanel>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB 4: SAVED DEPOSITOR QUADRUPLE NAMES                            */}
      {/* ================================================================= */}
      {activeTab === 'depositors' && (
        <SurfacePanel className="overflow-hidden">
          <div className="border-b border-slate-100 p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-bold text-slate-900">أسماء المودعين الرباعية المحفوظة</h2>
              <p className="text-xs text-slate-500">
                يمكن للإدارة مراجعة أو تعديل أو مسح الاسم الرباعي الدائم لأي مستخدم عند الحاجة
              </p>
            </div>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={depositorSearch}
                onChange={(e) => setDepositorSearch(e.target.value)}
                placeholder="بحث بالاسم أو Telegram ID..."
                className="w-full rounded-xl border border-slate-200 bg-slate-50/70 py-2 pe-3 ps-9 text-xs text-slate-800 focus:border-emerald-600 focus:bg-white focus:outline-none"
              />
            </div>
          </div>

          {depositorNames.length === 0 ? (
            <div className="p-8">
              <EmptyState
                icon={UserCheck}
                title="لا توجد أسماء مودعين محفوظة بعد"
                description="عند قيام أي مستخدم بأول عملية إيداع محلي سيُحفظ اسمه الرباعي هنا تلقائيًا."
              />
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {depositorNames.map((item) => {
                const isEditing = editingDepositorId === item.id;
                return (
                  <div
                    key={item.id}
                    className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="text-xs text-slate-500">
                        <strong className="text-slate-900">{item.displayName}</strong>
                        {item.telegramUsername ? ` (@${item.telegramUsername})` : ''} · ID:{' '}
                        <span className="font-mono-num">{item.telegramUserId || item.id}</span>
                      </div>
                      {isEditing ? (
                        <input
                          type="text"
                          value={editingDepositorVal}
                          onChange={(e) => setEditingDepositorVal(e.target.value)}
                          className="w-full sm:w-96 rounded-xl border border-emerald-300 px-3 py-1.5 text-xs text-slate-900 focus:outline-none"
                          placeholder="أدخل الاسم الرباعي الجديد..."
                        />
                      ) : (
                        <div className="text-sm font-bold text-slate-900">
                          🪪 {item.savedDepositorName}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void handleSaveDepositorName(item.id, editingDepositorVal)}
                            className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-800"
                          >
                            حفظ
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingDepositorId(null)}
                            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600"
                          >
                            إلغاء
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingDepositorId(item.id);
                              setEditingDepositorVal(item.savedDepositorName);
                            }}
                            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            تعديل الاسم
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleSaveDepositorName(item.id, '')}
                            className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50"
                          >
                            مسح
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SurfacePanel>
      )}

      {/* ================================================================= */}
      {/* MODAL: ADD / EDIT LOCAL WALLET                                    */}
      {/* ================================================================= */}
      {walletModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <h3 className="text-base font-bold text-slate-900">
                {editingWallet ? `تعديل المحفظة — ${editingWallet.nameAr}` : 'إضافة محفظة يمنية محلية جديدة'}
              </h3>
              <button
                type="button"
                aria-label="إغلاق"
                onClick={() => setWalletModalOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={(e) => void handleSaveWallet(e)} className="p-5 space-y-3.5 overflow-y-auto">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">اسم المحفظة (عربي) *</label>
                  <input
                    type="text"
                    required
                    value={walletForm.nameAr}
                    onChange={(e) => setWalletForm((p) => ({ ...p, nameAr: e.target.value }))}
                    placeholder="مثال: محفظة جوالي"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">اسم المحفظة (إنجليزي)</label>
                  <input
                    type="text"
                    dir="ltr"
                    value={walletForm.nameEn}
                    onChange={(e) => setWalletForm((p) => ({ ...p, nameEn: e.target.value }))}
                    placeholder="e.g. Jawali Wallet"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-900"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">رقم الحساب / المحفظة *</label>
                  <input
                    type="text"
                    required
                    dir="ltr"
                    value={walletForm.accountNumber}
                    onChange={(e) => setWalletForm((p) => ({ ...p, accountNumber: e.target.value }))}
                    placeholder="771234567"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-mono-num text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">اسم صاحب الحساب المستلم *</label>
                  <input
                    type="text"
                    required
                    value={walletForm.accountHolderName}
                    onChange={(e) => setWalletForm((p) => ({ ...p, accountHolderName: e.target.value }))}
                    placeholder="الاسم الكامل للمستلم"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-900"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">تعليمات التحويل للعميل (عربي)</label>
                <textarea
                  rows={2}
                  value={walletForm.instructionsAr}
                  onChange={(e) => setWalletForm((p) => ({ ...p, instructionsAr: e.target.value }))}
                  placeholder="مثال: يرجى التحويل بالريال اليمني القديم (صنعاء) وإرفاق لقطة شاشة واضحة للإشعار."
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-900"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">حد أدنى خاص (﷼ — اختياري)</label>
                  <input
                    type="number"
                    value={walletForm.minAmountYer}
                    onChange={(e) => setWalletForm((p) => ({ ...p, minAmountYer: e.target.value }))}
                    placeholder="افتراضي"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-mono-num text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">حد أقصى خاص (﷼ — اختياري)</label>
                  <input
                    type="number"
                    value={walletForm.maxAmountYer}
                    onChange={(e) => setWalletForm((p) => ({ ...p, maxAmountYer: e.target.value }))}
                    placeholder="افتراضي"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-mono-num text-slate-900"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  id="lw-enabled"
                  type="checkbox"
                  checked={walletForm.isEnabled}
                  onChange={(e) => setWalletForm((p) => ({ ...p, isEnabled: e.target.checked }))}
                  className="h-4 w-4 accent-emerald-700"
                />
                <label htmlFor="lw-enabled" className="text-xs font-semibold text-slate-700">
                  تفعيل المحفظة فورًا للعملاء
                </label>
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
                <button
                  type="button"
                  onClick={() => setWalletModalOpen(false)}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="rounded-xl bg-emerald-700 px-5 py-2 text-xs font-bold text-white hover:bg-emerald-800"
                >
                  {editingWallet ? 'حفظ التعديلات' : 'إضافة المحفظة'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* MODAL: PROOF SCREENSHOT VIEWER                                    */}
      {/* ================================================================= */}
      {proofModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
              <div className="text-sm font-bold text-slate-900">
                صورة إثبات التحويل — {proofModal.deposit.depositRef} ({fmtYer(proofModal.deposit.amountYer)})
              </div>
              <button
                type="button"
                aria-label="إغلاق"
                onClick={closeProofViewer}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-5 bg-slate-50 flex items-center justify-center min-h-[280px] max-h-[70vh] overflow-auto">
              {proofModal.loading ? (
                <div className="text-xs text-slate-500">جارٍ تحميل صورة الإثبات...</div>
              ) : proofModal.error ? (
                <div className="text-xs text-rose-600">{proofModal.error}</div>
              ) : proofModal.blobUrl ? (
                <img
                  src={proofModal.blobUrl}
                  alt={`إثبات التحويل ${proofModal.deposit.depositRef}`}
                  className="max-h-[62vh] rounded-xl border border-slate-200 shadow-sm object-contain"
                />
              ) : null}
            </div>
            <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 bg-white text-xs">
              <span className="text-slate-600">
                المودع: <strong>{proofModal.deposit.depositorNameUsed}</strong> · المحفظة:{' '}
                <strong>{proofModal.deposit.walletNameSnapshot}</strong>
              </span>
              {proofModal.deposit.status === 'pending_review' && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const dep = proofModal.deposit;
                      closeProofViewer();
                      void handleApproveDeposit(dep);
                    }}
                    className="rounded-lg bg-emerald-600 px-3.5 py-1.5 font-bold text-white hover:bg-emerald-700"
                  >
                    <CheckCircle2 className="inline h-3.5 w-3.5 me-1" />
                    موافقة
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const dep = proofModal.deposit;
                      closeProofViewer();
                      setRejectModalDeposit(dep);
                    }}
                    className="rounded-lg bg-rose-600 px-3.5 py-1.5 font-bold text-white hover:bg-rose-700"
                  >
                    <XCircle className="inline h-3.5 w-3.5 me-1" />
                    رفض
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* MODAL: REJECT LOCAL DEPOSIT WITH REASON                           */}
      {/* ================================================================= */}
      {rejectModalDeposit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <h3 className="text-sm font-bold text-slate-900">
                رفض الإيداع المحلي — {rejectModalDeposit.depositRef}
              </h3>
              <button
                type="button"
                aria-label="إغلاق"
                onClick={() => setRejectModalDeposit(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-5 space-y-3.5">
              <div className="text-xs text-slate-600">
                سيتم إشعار المستخدم تلقائيًا برفض العملية وسبب الرفض مع زر مباشر للتواصل مع الدعم الفني.
              </div>
              <div className="flex flex-wrap gap-1.5">
                {REJECT_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setRejectReason(preset)}
                    className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      rejectReason === preset
                        ? 'border-rose-400 bg-rose-50 text-rose-800'
                        : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  سبب الرفض (اختياري — يُعتمد سبب افتراضي إن تُرك فارغًا)
                </label>
                <textarea
                  rows={3}
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="اكتب سبب رفض العملية..."
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-900"
                />
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
                <button
                  type="button"
                  onClick={() => setRejectModalDeposit(null)}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600"
                >
                  تراجع
                </button>
                <button
                  type="button"
                  disabled={processingId === rejectModalDeposit.id}
                  onClick={() => void handleConfirmRejectDeposit()}
                  className="rounded-xl bg-rose-600 px-4 py-2 text-xs font-bold text-white hover:bg-rose-700 disabled:opacity-50"
                >
                  {processingId === rejectModalDeposit.id ? 'جارٍ الرفض...' : 'تأكيد الرفض'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {loading && deposits.length === 0 && wallets.length === 0 && (
        <div className="text-center py-6 text-xs text-slate-400">جارٍ تحميل البيانات...</div>
      )}
    </div>
  );
}
