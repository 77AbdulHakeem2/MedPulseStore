import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  XCircle,
  Plus,
  Megaphone,
  Calendar,
  Search,
  Wallet,
  Ban,
  ShieldCheck,
  Trash2,
  AlertTriangle,
  RotateCcw,
  Bell,
  ReceiptText,
  ArrowDownToLine,
  Users,
  Tag,
  Send,
  Loader2,
  History,
  SlidersHorizontal,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import CustomerHistoryModal from './CustomerHistoryModal';
import CustomerCustomizeView from './CustomerCustomizeView';
import {
  classifyOperationStatusVisual,
  filterOperationsByDateRange,
  formatAdminDateTime,
  type DatePreset,
  type OperationVisualCategory,
} from '../lib/operationsUtils';
import {
  PageHeader,
  SegmentedTabs,
  KpiCard,
  SurfacePanel,
  SectionHeader,
  SemanticStatus,
  FeedbackBanner,
} from './ui/AdminPrimitives';

interface OperationsViewProps {
  initialSubTab?: 'orders' | 'deposits' | 'wallets' | 'coupons';
  orders: any[];
  deposits: any[];
  customers: any[];
  ledger: any[];
  coupons: any[];
  onRefresh: () => Promise<void>;
}

type WalletMode = 'add' | 'deduct' | 'set';

const DATE_PRESETS: Array<{ id: DatePreset; label: string }> = [
  { id: 'all', label: 'الكل' },
  { id: 'today', label: 'اليوم' },
  { id: '7d', label: '7 أيام' },
  { id: '30d', label: '30 يومًا' },
];

const STATUS_FILTERS: Array<{ id: 'all' | OperationVisualCategory; label: string }> = [
  { id: 'all', label: 'الكل' },
  { id: 'success', label: 'ناجحة' },
  { id: 'failed', label: 'فاشلة' },
  { id: 'pending', label: 'معلقة' },
];

function statusTone(category: OperationVisualCategory): 'positive' | 'negative' | 'warning' {
  if (category === 'success') return 'positive';
  if (category === 'failed') return 'negative';
  return 'warning';
}

export default function OperationsView({
  initialSubTab = 'orders',
  orders,
  deposits,
  customers,
  ledger,
  coupons,
  onRefresh,
}: OperationsViewProps) {
  const [subTab, setSubTab] = useState<'orders' | 'deposits' | 'wallets' | 'coupons'>(initialSubTab);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Shared Date & Status Filter State for Orders, Deposits & Ledger
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | OperationVisualCategory>('all');
  const [opsSearch, setOpsSearch] = useState('');

  // Customers filter state
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerStateFilter, setCustomerStateFilter] = useState<'all' | 'agents' | 'active' | 'blocked'>('all');
  const [tierBusyUserId, setTierBusyUserId] = useState<number | null>(null);

  // Coupon form
  const [couponForm, setCouponForm] = useState({
    code: '',
    discountType: 'percent',
    discountValue: '10',
    maxUses: '100',
    minOrderAmount: '2',
  });

  // Broadcast form & live Telegram delivery summary
  const [broadcast, setBroadcast] = useState<{
    title: string;
    message: string;
    audience: 'customers' | 'all_telegram' | 'admins_only';
  }>({ title: '', message: '', audience: 'customers' });
  const [broadcastSending, setBroadcastSending] = useState(false);
  const [broadcastSummary, setBroadcastSummary] = useState<{
    botAvailable: boolean;
    botUsername: string | null;
    botState: string;
    botReasonAr: string | null;
    counts: {
      customers: number;
      all_telegram: number;
      admins_only: number;
      skippedBlocked: number;
      skippedNoTelegram: number;
    };
    recentBroadcasts: Array<{
      id: number;
      title: string;
      audience: string;
      totalEligible: number;
      sentCount: number | null;
      failedCount: number | null;
      blockedCount: number | null;
      createdAt: string;
    }>;
  } | null>(null);
  const [broadcastSummaryLoading, setBroadcastSummaryLoading] = useState(false);
  const [lastBroadcastReport, setLastBroadcastReport] = useState<{
    ok: boolean;
    totalEligible: number;
    sentCount: number;
    failedCount: number;
    blockedCount: number;
    audience: string;
    messageAr: string;
    errorsSample: Array<{ displayName: string; telegramUserId: string; reason: string }>;
  } | null>(null);

  const loadBroadcastSummary = useCallback(async () => {
    setBroadcastSummaryLoading(true);
    try {
      const data = await apiFetch<typeof broadcastSummary>('/api/admin/broadcast/summary');
      setBroadcastSummary(data);
    } catch {
      // Keep previous summary if transient error occurs
    } finally {
      setBroadcastSummaryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (subTab === 'coupons') {
      void loadBroadcastSummary();
    }
  }, [subTab, loadBroadcastSummary]);

  // Full Balance Control Modal
  const [adjustTarget, setAdjustTarget] = useState<any | null>(null);
  const [adjustMode, setAdjustMode] = useState<WalletMode>('add');
  const [adjustAmount, setAdjustAmount] = useState('10.00');
  const [adjustNote, setAdjustNote] = useState('إضافة رصيد يدوية من الإدارة');

  // In-app Delete User Confirmation Modal
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);

  // In-app Refund Order & Auto Commission Reversal Modal
  const [refundOrderTarget, setRefundOrderTarget] = useState<any | null>(null);
  const [refundOrderReason, setRefundOrderReason] = useState('استرداد طلب مكتمل من لوحة الإدارة');

  // Per-Customer History Modal & Product/Price Customization View
  const [historyTarget, setHistoryTarget] = useState<{ id: number; displayName: string } | null>(null);
  const [customizeTarget, setCustomizeTarget] = useState<{ id: number; displayName: string } | null>(null);

  const resetDateFilters = () => {
    setDatePreset('all');
    setFromDate('');
    setToDate('');
    setStatusFilter('all');
    setOpsSearch('');
  };

  const handleSelectPreset = (preset: DatePreset) => {
    setDatePreset(preset);
    if (preset !== 'custom') {
      setFromDate('');
      setToDate('');
    }
  };

  const handleFromDateChange = (val: string) => {
    setFromDate(val);
    setDatePreset(val || toDate ? 'custom' : 'all');
  };

  const handleToDateChange = (val: string) => {
    setToDate(val);
    setDatePreset(fromDate || val ? 'custom' : 'all');
  };

  // Filtered Orders + KPIs
  const filteredOrders = useMemo(() => {
    const byDateAndStatus = filterOperationsByDateRange(orders, {
      preset: datePreset,
      fromDate,
      toDate,
      statusCategory: statusFilter,
    });
    const q = opsSearch.trim().toLowerCase();
    if (!q) return byDateAndStatus;
    return byDateAndStatus.filter((o) => {
      const orderNum = String(o.orderNumber || '').toLowerCase();
      const customer = String(o.customerName || '').toLowerCase();
      const itemTitle = String(o.items?.[0]?.title || '').toLowerCase();
      const providerName = String(o.providerName || '').toLowerCase();
      return orderNum.includes(q) || customer.includes(q) || itemTitle.includes(q) || providerName.includes(q);
    });
  }, [orders, datePreset, fromDate, toDate, statusFilter, opsSearch]);

  const orderKpis = useMemo(() => {
    let successCount = 0;
    let failedCount = 0;
    let pendingCount = 0;
    let totalProfit = 0;
    let totalSales = 0;
    for (const o of filteredOrders) {
      const cat = classifyOperationStatusVisual(o.status).category;
      if (cat === 'success') {
        successCount += 1;
        totalProfit += Number(o.netProfit || 0);
        totalSales += Number(o.totalRetail || 0);
      } else if (cat === 'failed') {
        failedCount += 1;
      } else {
        pendingCount += 1;
      }
    }
    const decided = successCount + failedCount;
    const successRate = decided > 0 ? Math.round((successCount / decided) * 100) : 100;
    return {
      total: filteredOrders.length,
      successCount,
      failedCount,
      pendingCount,
      successRate,
      totalProfitNum: totalProfit,
      totalProfit: totalProfit.toFixed(2),
      totalSales: totalSales.toFixed(2),
    };
  }, [filteredOrders]);

  // Filtered Deposits + KPIs
  const filteredDeposits = useMemo(() => {
    const byDateAndStatus = filterOperationsByDateRange(deposits, {
      preset: datePreset,
      fromDate,
      toDate,
      statusCategory: statusFilter,
    });
    const q = opsSearch.trim().toLowerCase();
    if (!q) return byDateAndStatus;
    return byDateAndStatus.filter((d) => {
      const ref = String(d.depositRef || '').toLowerCase();
      const customer = String(d.customerName || '').toLowerCase();
      const tx = String(d.binanceTransactionId || d.txHash || '').toLowerCase();
      return ref.includes(q) || customer.includes(q) || tx.includes(q);
    });
  }, [deposits, datePreset, fromDate, toDate, statusFilter, opsSearch]);

  const depositKpis = useMemo(() => {
    let successCount = 0;
    let failedCount = 0;
    let pendingCount = 0;
    let approvedSum = 0;
    let pendingSum = 0;
    for (const d of filteredDeposits) {
      const cat = classifyOperationStatusVisual(d.status).category;
      if (cat === 'success') {
        successCount += 1;
        approvedSum += Number(d.expectedAmount || 0);
      } else if (cat === 'failed') {
        failedCount += 1;
      } else {
        pendingCount += 1;
        pendingSum += Number(d.expectedAmount || 0);
      }
    }
    return {
      total: filteredDeposits.length,
      successCount,
      failedCount,
      pendingCount,
      approvedSum: approvedSum.toFixed(2),
      pendingSum: pendingSum.toFixed(2),
    };
  }, [filteredDeposits]);

  // Filtered Customers
  const filteredCustomers = useMemo(() => {
    const q = customerSearch.trim().toLowerCase();
    return customers.filter((u) => {
      if (customerStateFilter === 'agents' && (u.pricingTier || 'customer') !== 'agent') return false;
      if (customerStateFilter === 'active' && u.isBlocked) return false;
      if (customerStateFilter === 'blocked' && !u.isBlocked) return false;
      if (!q) return true;
      return (
        String(u.displayName || '').toLowerCase().includes(q) ||
        String(u.telegramUserId || '').toLowerCase().includes(q) ||
        String(u.telegramUsername || '').toLowerCase().includes(q) ||
        String(u.email || '').toLowerCase().includes(q)
      );
    });
  }, [customers, customerSearch, customerStateFilter]);

  const customerKpis = useMemo(() => {
    const blockedCount = customers.filter((u) => u.isBlocked).length;
    const agentsCount = customers.filter((u) => (u.pricingTier || 'customer') === 'agent').length;
    const totalBalance = customers.reduce((sum, u) => sum + Number(u.availableBalance || 0), 0);
    const totalSpent = customers.reduce((sum, u) => sum + Number(u.totalSpent || 0), 0);
    return {
      total: customers.length,
      activeCount: customers.length - blockedCount,
      agentsCount,
      blockedCount,
      totalBalance: totalBalance.toFixed(2),
      totalSpent: totalSpent.toFixed(2),
    };
  }, [customers]);

  // Filtered Ledger by date
  const filteredLedger = useMemo(() => {
    return filterOperationsByDateRange(ledger, {
      preset: datePreset,
      fromDate,
      toDate,
      statusCategory: 'all',
    });
  }, [ledger, datePreset, fromDate, toDate]);

  // Balance preview calculation for modal
  const balancePreview = useMemo(() => {
    if (!adjustTarget) return null;
    const current = Number(adjustTarget.availableBalance || 0);
    const parsed = Number(adjustAmount);
    if (!Number.isFinite(parsed)) {
      return { valid: false, next: current, delta: 0, error: 'أدخل قيمة رقمية صالحة.' };
    }
    if (adjustMode === 'add') {
      if (parsed <= 0) return { valid: false, next: current, delta: 0, error: 'يجب أن يكون مبلغ الإضافة أكبر من الصفر.' };
      return { valid: true, next: current + parsed, delta: parsed, error: '' };
    }
    if (adjustMode === 'deduct') {
      if (parsed <= 0) return { valid: false, next: current, delta: 0, error: 'يجب أن يكون مبلغ الخصم أكبر من الصفر.' };
      if (current - parsed < 0) return { valid: false, next: current - parsed, delta: -parsed, error: 'الرصيد بعد الخصم لا يمكن أن يكون سالبًا.' };
      return { valid: true, next: current - parsed, delta: -parsed, error: '' };
    }
    if (parsed < 0) return { valid: false, next: parsed, delta: parsed - current, error: 'لا يمكن تعيين رصيد سالب.' };
    const delta = parsed - current;
    if (Math.abs(delta) < 0.0001) {
      return { valid: false, next: current, delta: 0, error: 'القيمة مطابقة للرصيد الحالي.' };
    }
    return { valid: true, next: parsed, delta, error: '' };
  }, [adjustTarget, adjustMode, adjustAmount]);

  const openAdjustModal = (user: any, initialMode: WalletMode = 'add') => {
    setAdjustTarget(user);
    setAdjustMode(initialMode);
    if (initialMode === 'set') {
      setAdjustAmount(Number(user.availableBalance || 0).toFixed(2));
      setAdjustNote('تعديل مباشر للرصيد من لوحة الإدارة');
    } else if (initialMode === 'deduct') {
      setAdjustAmount('5.00');
      setAdjustNote('خصم يدوي موثق من الإدارة');
    } else {
      setAdjustAmount('10.00');
      setAdjustNote('إضافة رصيد يدوية من الإدارة');
    }
  };

  const handleSwitchAdjustMode = (mode: WalletMode) => {
    setAdjustMode(mode);
    if (!adjustTarget) return;
    if (mode === 'set') {
      setAdjustAmount(Number(adjustTarget.availableBalance || 0).toFixed(2));
      setAdjustNote('تعديل مباشر للرصيد من لوحة الإدارة');
    } else if (mode === 'deduct') {
      setAdjustAmount('5.00');
      setAdjustNote('خصم يدوي موثق من الإدارة');
    } else {
      setAdjustAmount('10.00');
      setAdjustNote('إضافة رصيد يدوية من الإدارة');
    }
  };

  const reviewDeposit = async (depId: number, decision: 'approve' | 'reject') => {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ alreadyCredited?: boolean; telegramNotified?: boolean; newBalance?: string }>(
        `/api/admin/deposits/${depId}/review`,
        {
          method: 'POST',
          body: JSON.stringify({ decision }),
        }
      );
      setFeedback({
        type: 'ok',
        text:
          decision === 'approve'
            ? res.alreadyCredited
              ? 'هذا الإيداع معتمد مسبقًا ولم يُكرر الرصيد.'
              : `تم اعتماد الإيداع وإضافة الرصيد للمحفظة (الرصيد الجديد $${res.newBalance || '—'})${
                  res.telegramNotified ? ' وإرسال إشعار فوري على تيليجرام.' : ' وحفظ الإشعار في حساب المستخدم.'
                }`
            : 'تم رفض الإيداع وتسجيل القرار.',
      });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر معالجة الإيداع.' });
    } finally {
      setBusy(false);
    }
  };

  const handleWalletAdjust = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustTarget || !balancePreview?.valid) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{
        referenceCode: string;
        deltaApplied: string;
        newBalance: string;
        notificationSaved?: boolean;
        telegramNotified?: boolean;
      }>(`/api/admin/customers/${adjustTarget.id}/wallet-adjust`, {
        method: 'POST',
        body: JSON.stringify({
          mode: adjustMode,
          amount: adjustAmount,
          note: adjustNote,
        }),
      });
      const addedPositive = Number(res.deltaApplied || 0) > 0;
      const notifyMsg = addedPositive
        ? res.telegramNotified
          ? ' — تم إشعار المستخدم على تيليجرام بالمبلغ المضاف والرصيد الإجمالي.'
          : ' — تم حفظ إشعار إضافة الرصيد تلقائيًا في حساب المستخدم.'
        : '';
      setFeedback({
        type: 'ok',
        text: `تم تحديث رصيد ${adjustTarget.displayName} (مرجع ${res.referenceCode}) — الرصيد الآن $${res.newBalance}${notifyMsg}`,
      });
      setAdjustTarget(null);
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تعديل الرصيد.' });
    } finally {
      setBusy(false);
    }
  };

  const handleToggleBlockUser = async (user: any) => {
    setBusy(true);
    setFeedback(null);
    try {
      const nextBlocked = !user.isBlocked;
      await apiFetch(`/api/admin/customers/${user.id}/block`, {
        method: 'PATCH',
        body: JSON.stringify({ isBlocked: nextBlocked }),
      });
      setFeedback({
        type: 'ok',
        text: nextBlocked
          ? `تم حظر المستخدم "${user.displayName}" وإيقاف وصوله فورًا.`
          : `تم فك الحظر عن المستخدم "${user.displayName}" وإعادة تفعيل حسابه.`,
      });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تحديث حالة الحظر.' });
    } finally {
      setBusy(false);
    }
  };

  const handleChangePricingTier = async (user: any, nextTier: 'customer' | 'agent') => {
    const currentTier = (user.pricingTier || 'customer') === 'agent' ? 'agent' : 'customer';
    if (currentTier === nextTier) return;
    setTierBusyUserId(user.id);
    setFeedback(null);
    try {
      await apiFetch(`/api/admin/customers/${user.id}/tier`, {
        method: 'PATCH',
        body: JSON.stringify({ pricingTier: nextTier }),
      });
      setFeedback({
        type: 'ok',
        text:
          nextTier === 'agent'
            ? `تم تحويل "${user.displayName}" إلى تصنيف (وكيل) — ستُطبّق عليه أسعار الوكلاء تلقائيًا على جميع المنتجات.`
            : `تم تحويل "${user.displayName}" إلى تصنيف (عميل) — ستُطبّق عليه أسعار العملاء تلقائيًا على جميع المنتجات.`,
      });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تحديث تصنيف المستخدم.' });
    } finally {
      setTierBusyUserId(null);
    }
  };

  const handleConfirmDeleteUser = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    setFeedback(null);
    try {
      await apiFetch(`/api/admin/customers/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      setFeedback({
        type: 'ok',
        text: `تم حذف المستخدم "${deleteTarget.displayName}" مع محفظته وسجلاته المرتبطة نهائيًا.`,
      });
      setDeleteTarget(null);
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر حذف المستخدم.' });
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmRefundOrder = async () => {
    if (!refundOrderTarget) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{
        ok: boolean;
        orderNumber?: string;
        refundedAmount?: string;
        commissionReversal?: { reversed?: boolean; totalReversedCommission?: string };
      }>(`/api/admin/orders/${refundOrderTarget.id}/refund`, {
        method: 'POST',
        body: JSON.stringify({ reason: refundOrderReason }),
      });
      const revSuffix = res.commissionReversal?.reversed
        ? ` — وعُكست عمولة الإحالة تلقائيًا ($${Number(res.commissionReversal.totalReversedCommission || 0).toFixed(2)}).`
        : '.';
      setFeedback({
        type: 'ok',
        text: `تم استرداد الطلب ${res.orderNumber || refundOrderTarget.orderNumber} وإعادة $${res.refundedAmount || refundOrderTarget.totalRetail} لمحفظة المشتري${revSuffix}`,
      });
      setRefundOrderTarget(null);
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر استرداد الطلب.' });
    } finally {
      setBusy(false);
    }
  };

  const handleCreateCoupon = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      await apiFetch('/api/admin/coupons', {
        method: 'POST',
        body: JSON.stringify(couponForm),
      });
      setCouponForm({ code: '', discountType: 'percent', discountValue: '10', maxUses: '100', minOrderAmount: '2' });
      setFeedback({ type: 'ok', text: 'تم إنشاء كوبون الخصم بنجاح.' });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر إنشاء الكوبون.' });
    } finally {
      setBusy(false);
    }
  };

  const handleToggleCoupon = async (id: number, current: boolean) => {
    await apiFetch(`/api/admin/coupons/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: !current }),
    });
    await onRefresh();
  };

  const handleBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    setBroadcastSending(true);
    setBusy(true);
    setFeedback(null);
    setLastBroadcastReport(null);
    try {
      const res = await apiFetch<{
        ok: boolean;
        recipients: number;
        totalEligible: number;
        sentCount: number;
        failedCount: number;
        blockedCount: number;
        audience: string;
        errorsSample?: Array<{ displayName: string; telegramUserId: string; reason: string }>;
        messageAr?: string;
      }>('/api/admin/broadcast', {
        method: 'POST',
        body: JSON.stringify(broadcast),
      });

      const report = {
        ok: Boolean(res.ok),
        totalEligible: Number(res.totalEligible || 0),
        sentCount: Number(res.sentCount || 0),
        failedCount: Number(res.failedCount || 0),
        blockedCount: Number(res.blockedCount || 0),
        audience: res.audience || broadcast.audience,
        messageAr:
          res.messageAr ||
          (res.ok
            ? `تم إرسال الإعلان فعليًا عبر تيليجرام إلى ${res.sentCount} من أصل ${res.totalEligible} مستلم.`
            : 'تعذر توصيل الإعلان عبر تيليجرام لأي مستلم.'),
        errorsSample: Array.isArray(res.errorsSample) ? res.errorsSample : [],
      };
      setLastBroadcastReport(report);

      if (res.ok) {
        setBroadcast((prev) => ({ ...prev, title: '', message: '' }));
        setFeedback({ type: 'ok', text: report.messageAr });
      } else {
        setFeedback({ type: 'err', text: report.messageAr });
      }

      await Promise.all([onRefresh(), loadBroadcastSummary()]);
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر إرسال الإعلان عبر تيليجرام.' });
    } finally {
      setBroadcastSending(false);
      setBusy(false);
    }
  };

  const hasActiveDateOrStatusFilter =
    datePreset !== 'all' || Boolean(fromDate) || Boolean(toDate) || statusFilter !== 'all' || Boolean(opsSearch.trim());

  const renderDateAndStatusToolbar = (showSearchAndStatus: boolean) => (
    <SurfacePanel className="p-3.5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 ml-1">
            <Calendar className="h-3.5 w-3.5 text-slate-400" />
            الفترة:
          </span>
          <div className="inline-flex items-center rounded-lg bg-slate-100 p-0.5">
            {DATE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => handleSelectPreset(p.id)}
                className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                  datePreset === p.id
                    ? 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.08)]'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            <span>من</span>
            <input
              type="date"
              aria-label="من تاريخ"
              value={fromDate}
              onChange={(e) => handleFromDateChange(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-mono-num text-slate-800 focus:border-emerald-600 focus:outline-none"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            <span>إلى</span>
            <input
              type="date"
              aria-label="إلى تاريخ"
              value={toDate}
              onChange={(e) => handleToDateChange(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-mono-num text-slate-800 focus:border-emerald-600 focus:outline-none"
            />
          </label>
          {hasActiveDateOrStatusFilter && (
            <button
              type="button"
              onClick={resetDateFilters}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              إعادة ضبط
            </button>
          )}
        </div>
      </div>

      {showSearchAndStatus && (
        <div className="flex flex-col gap-3 border-t border-slate-100 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="inline-flex items-center rounded-lg bg-slate-100 p-0.5 self-start">
            {STATUS_FILTERS.map((sf) => {
              const active = statusFilter === sf.id;
              return (
                <button
                  key={sf.id}
                  type="button"
                  onClick={() => setStatusFilter(sf.id)}
                  className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                    active
                      ? sf.id === 'success'
                        ? 'bg-emerald-700 text-white'
                        : sf.id === 'failed'
                          ? 'bg-rose-700 text-white'
                          : sf.id === 'pending'
                            ? 'bg-amber-600 text-white'
                            : 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.08)]'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {sf.label}
                </button>
              );
            })}
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={opsSearch}
              onChange={(e) => setOpsSearch(e.target.value)}
              placeholder="بحث بالرقم، العميل، أو المنتج..."
              className="w-full rounded-lg border border-slate-200 bg-slate-50/70 py-1.5 pr-8 pl-3 text-xs text-slate-800 placeholder:text-slate-400 focus:bg-white focus:border-emerald-600 focus:outline-none"
            />
          </div>
        </div>
      )}
    </SurfacePanel>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="الطلبات والإيداعات والمحافظ"
        subtitle="مراجعة الطلبات، اعتماد الإيداعات، والتحكم الكامل بالعملاء والأرصدة."
        actions={
          <SegmentedTabs
            value={subTab}
            onChange={setSubTab}
            items={[
              { id: 'orders', label: 'الطلبات', count: orders.length, icon: ReceiptText },
              { id: 'deposits', label: 'الإيداعات', count: deposits.length, icon: ArrowDownToLine },
              { id: 'wallets', label: 'العملاء والمحافظ', count: customers.length, icon: Users },
              { id: 'coupons', label: 'الكوبونات والإعلانات', icon: Tag },
            ]}
          />
        }
      />

      {feedback && (
        <FeedbackBanner
          type={feedback.type}
          text={feedback.text}
          onDismiss={() => setFeedback(null)}
        />
      )}

      {/* 1. Orders Tab */}
      {subTab === 'orders' && (
        <div className="space-y-4">
          {renderDateAndStatusToolbar(true)}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="إجمالي الطلبات"
              value={orderKpis.total}
              tone="neutral"
              meta={
                <span>
                  إجمالي المبيعات الناجحة: <span className="font-mono-num font-semibold text-slate-700">${orderKpis.totalSales}</span>
                </span>
              }
            />
            <KpiCard
              label="العمليات الناجحة"
              value={orderKpis.successCount}
              tone="positive"
              valueTone="positive"
              direction={orderKpis.successCount > 0 ? 'up' : 'flat'}
              indicatorText={`${orderKpis.successRate}% نجاح`}
              meta={<span>تم التسليم والاكتمال</span>}
            />
            <KpiCard
              label="العمليات الفاشلة"
              value={orderKpis.failedCount}
              tone={orderKpis.failedCount > 0 ? 'negative' : 'positive'}
              valueTone={orderKpis.failedCount > 0 ? 'negative' : 'default'}
              direction={orderKpis.failedCount > 0 ? 'up' : 'flat'}
              indicatorText={orderKpis.failedCount > 0 ? 'تتطلب مراجعة' : 'سجل نظيف'}
              meta={<span>فاشلة أو مسترجعة الرصيد</span>}
            />
            <KpiCard
              label="صافي الربح"
              value={`+$${orderKpis.totalProfit}`}
              tone={orderKpis.totalProfitNum > 0 ? 'positive' : 'neutral'}
              valueTone={orderKpis.totalProfitNum > 0 ? 'positive' : 'default'}
              direction={orderKpis.totalProfitNum > 0 ? 'up' : 'flat'}
              indicatorText="للفترة المحددة"
              meta={
                <span>
                  قيد المعالجة: <span className="font-mono-num font-semibold text-slate-700">{orderKpis.pendingCount}</span>
                </span>
              }
            />
          </div>

          <SurfacePanel className="overflow-hidden">
            <SectionHeader
              title="سجل الطلبات"
              subtitle={`عرض ${filteredOrders.length} من أصل ${orders.length} طلب`}
              icon={ReceiptText}
            />
            <div className="overflow-x-auto">
              <table className="w-full text-right border-collapse min-w-[940px]">
                <thead>
                  <tr className="border-b border-slate-200/80 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                    <th className="py-3 px-4">الطلب والتاريخ</th>
                    <th className="py-3 px-4">العميل</th>
                    <th className="py-3 px-4">المنتج</th>
                    <th className="py-3 px-4">المزود والمرجع</th>
                    <th className="py-3 px-4">البيع</th>
                    <th className="py-3 px-4">الجملة</th>
                    <th className="py-3 px-4">الربح</th>
                    <th className="py-3 px-4">الحالة والإجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {filteredOrders.map((o) => {
                    const visual = classifyOperationStatusVisual(o.status);
                    return (
                      <tr
                        key={o.id}
                        className={`transition-colors ${
                          visual.category === 'failed' ? 'bg-rose-50/20 hover:bg-rose-50/45' : 'hover:bg-slate-50/80'
                        }`}
                      >
                        <td className="py-3 px-4">
                          <div className="font-mono-num font-bold text-slate-900">{o.orderNumber}</div>
                          <div className="mt-0.5 font-mono-num text-[11px] text-slate-400">
                            {formatAdminDateTime(o.createdAt)}
                          </div>
                        </td>
                        <td className="py-3 px-4 font-medium text-slate-800">{o.customerName}</td>
                        <td className="py-3 px-4 text-slate-800 max-w-[230px]">
                          <div className="truncate font-medium">
                            {o.items?.[0]?.title || 'منتج رقمي'} <span className="font-mono-num text-slate-500">(×{o.items?.[0]?.qty || 1})</span>
                          </div>
                          {visual.category === 'failed' && o.failureReason && (
                            <div className="mt-0.5 truncate text-[11px] text-rose-600" title={o.failureReason}>
                              {o.failureReason}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-600">
                          <span className="font-medium text-slate-700">{o.providerName}</span>
                          <span className="mx-1.5 text-slate-300">·</span>
                          <span className="font-mono-num text-[11px] text-slate-500">{o.providerOrderId}</span>
                        </td>
                        <td className="py-3 px-4 font-mono-num font-bold text-slate-900">${o.totalRetail}</td>
                        <td className="py-3 px-4 font-mono-num text-slate-500">${o.totalWholesale}</td>
                        <td
                          className={`py-3 px-4 font-mono-num font-bold ${
                            visual.category === 'failed' ? 'text-rose-600 line-through' : 'text-emerald-700'
                          }`}
                        >
                          +${o.netProfit}
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex flex-wrap items-center gap-2.5">
                            <SemanticStatus tone={statusTone(visual.category)} label={visual.labelAr} />
                            {o.status === 'completed' && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  setRefundOrderTarget(o);
                                  setRefundOrderReason(`استرداد الطلب ${o.orderNumber} من الإدارة`);
                                }}
                                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-rose-700 hover:border-rose-200 hover:bg-rose-50 whitespace-nowrap transition-colors"
                              >
                                <RotateCcw className="h-3 w-3" />
                                استرداد
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {filteredOrders.length === 0 && (
                    <tr>
                      <td colSpan={8} className="py-10 text-center text-sm text-slate-400">
                        لا توجد طلبات مطابقة للفلترة الحالية.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </SurfacePanel>
        </div>
      )}

      {/* 2. Deposits Review Tab */}
      {subTab === 'deposits' && (
        <div className="space-y-4">
          {renderDateAndStatusToolbar(true)}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="إجمالي الإيداعات"
              value={depositKpis.total}
              tone="neutral"
              meta={<span>ضمن النطاق الزمني المحدد</span>}
            />
            <KpiCard
              label="إيداعات معتمدة"
              value={depositKpis.successCount}
              tone="positive"
              valueTone="positive"
              direction={depositKpis.successCount > 0 ? 'up' : 'flat'}
              indicatorText="مكتملة"
              meta={
                <span>
                  إجمالي الشحن: <span className="font-mono-num font-semibold text-emerald-700">${depositKpis.approvedSum} USDT</span>
                </span>
              }
            />
            <KpiCard
              label="مرفوضة / فاشلة"
              value={depositKpis.failedCount}
              tone={depositKpis.failedCount > 0 ? 'negative' : 'positive'}
              valueTone={depositKpis.failedCount > 0 ? 'negative' : 'default'}
              direction={depositKpis.failedCount > 0 ? 'up' : 'flat'}
              indicatorText={depositKpis.failedCount > 0 ? 'مرفوضة' : 'صفر مرفوضات'}
              meta={<span>لم تُضف للمحفظة</span>}
            />
            <KpiCard
              label="بانتظار المراجعة"
              value={depositKpis.pendingCount}
              tone={depositKpis.pendingCount > 0 ? 'warning' : 'positive'}
              valueTone={depositKpis.pendingCount > 0 ? 'warning' : 'default'}
              direction={depositKpis.pendingCount > 0 ? 'up' : 'flat'}
              indicatorText={depositKpis.pendingCount > 0 ? 'معلقة' : 'لا يوجد معلق'}
              meta={
                <span>
                  القيمة المعلقة: <span className="font-mono-num font-semibold text-slate-700">${depositKpis.pendingSum}</span>
                </span>
              }
            />
          </div>

          <SurfacePanel className="overflow-hidden">
            <SectionHeader
              title="طلبات شحن الرصيد"
              subtitle={`عرض ${filteredDeposits.length} إيداع`}
              icon={ArrowDownToLine}
            />
            <div className="overflow-x-auto">
              <table className="w-full text-right border-collapse min-w-[920px]">
                <thead>
                  <tr className="border-b border-slate-200/80 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                    <th className="py-3 px-4">المرجع والتاريخ</th>
                    <th className="py-3 px-4">العميل</th>
                    <th className="py-3 px-4">الوسيلة والشبكة</th>
                    <th className="py-3 px-4">المبلغ</th>
                    <th className="py-3 px-4">TxID والتأكيدات</th>
                    <th className="py-3 px-4">الحالة</th>
                    <th className="py-3 px-4">الإجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {filteredDeposits.map((d) => {
                    const visual = classifyOperationStatusVisual(d.status);
                    return (
                      <tr
                        key={d.id}
                        className={`transition-colors ${
                          visual.category === 'failed' ? 'bg-rose-50/20 hover:bg-rose-50/45' : 'hover:bg-slate-50/80'
                        }`}
                      >
                        <td className="py-3 px-4">
                          <div className="font-mono-num font-bold text-slate-900">{d.depositRef}</div>
                          <div className="mt-0.5 font-mono-num text-[11px] text-slate-400">
                            {formatAdminDateTime(d.createdAt)}
                          </div>
                        </td>
                        <td className="py-3 px-4 font-medium text-slate-800">{d.customerName}</td>
                        <td className="py-3 px-4 text-slate-600">
                          {d.method} <span className="text-slate-300 mx-1">·</span> {d.network}
                        </td>
                        <td className="py-3 px-4 font-mono-num font-bold text-slate-900">${d.expectedAmount}</td>
                        <td className="py-3 px-4">
                          <div className="font-mono-num text-[11px] text-slate-700 max-w-[180px] truncate">
                            {d.binanceTransactionId || d.txHash || 'لم يُرسل بعد'}
                          </div>
                          <div className="text-[11px] text-slate-400 truncate max-w-[210px]">
                            {d.method === 'binance_id'
                              ? d.verificationNote || `محاولات التحقق: ${d.verificationAttempts ?? 0}`
                              : `تأكيدات: ${d.confirmations}/${d.requiredConfirmations} · إسناد: ${d.uniqueMemoTag || '—'}`}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <SemanticStatus tone={statusTone(visual.category)} label={visual.labelAr} />
                        </td>
                        <td className="py-3 px-4">
                          {d.status !== 'paid' && d.status !== 'confirmed' && d.status !== 'rejected' ? (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void reviewDeposit(d.id, 'approve')}
                                className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 whitespace-nowrap disabled:opacity-50 transition-colors"
                              >
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                اعتماد وإشعار
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void reviewDeposit(d.id, 'reject')}
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:border-rose-200 hover:bg-rose-50 whitespace-nowrap disabled:opacity-50 transition-colors"
                              >
                                <XCircle className="h-3.5 w-3.5" />
                                رفض
                              </button>
                            </div>
                          ) : (
                            <span className="text-slate-400">مكتمل</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {filteredDeposits.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-sm text-slate-400">
                        لا توجد إيداعات مطابقة للفلترة الحالية.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </SurfacePanel>
        </div>
      )}

      {/* 3. Customers, Full Balance Control, Spending, Isolated History & Product Customization */}
      {subTab === 'wallets' && customizeTarget !== null && (
        <CustomerCustomizeView
          customerId={customizeTarget.id}
          customerName={customizeTarget.displayName}
          onBack={() => setCustomizeTarget(null)}
          onUpdated={onRefresh}
        />
      )}

      {subTab === 'wallets' && customizeTarget === null && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="إجمالي المستخدمين"
              value={customerKpis.total}
              tone="neutral"
              meta={
                <span>
                  نشط: {customerKpis.activeCount} · وكلاء: {customerKpis.agentsCount} · محظور: {customerKpis.blockedCount}
                </span>
              }
            />
            <KpiCard
              label="إجمالي إنفاق العملاء"
              value={`$${customerKpis.totalSpent}`}
              tone="positive"
              valueTone="positive"
              indicatorText="طلبات ناجحة"
              meta={<span>مجموع المشتريات المكتملة تلقائيًا</span>}
            />
            <KpiCard
              label="إجمالي الأرصدة المتاحة"
              value={`$${customerKpis.totalBalance}`}
              tone="neutral"
              meta={<span>مجموع أرصدة محافظ العملاء</span>}
            />
            <KpiCard
              label="حسابات محظورة"
              value={customerKpis.blockedCount}
              tone={customerKpis.blockedCount > 0 ? 'negative' : 'positive'}
              valueTone={customerKpis.blockedCount > 0 ? 'negative' : 'default'}
              direction={customerKpis.blockedCount > 0 ? 'up' : 'flat'}
              indicatorText={customerKpis.blockedCount > 0 ? 'موقوفة' : 'صفر حظر'}
              meta={<span>ممنوعة من استخدام البوت</span>}
            />
          </div>

          {/* Customers Management Table */}
          <SurfacePanel className="overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <Users className="h-4 w-4 text-slate-500 shrink-0" />
                <div>
                  <h2 className="text-sm font-bold text-slate-900">إدارة العملاء والأرصدة</h2>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    تصنيف المستخدمين (عميل / وكيل)، تتبع الإنفاق، عرض السجل المستقل، تخصيص الأسعار، والتحكم بالرصيد.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex items-center rounded-lg bg-slate-100 p-0.5">
                  {(
                    [
                      ['all', 'الكل'],
                      ['agents', `الوكلاء (${customerKpis.agentsCount})`],
                      ['active', 'النشطون'],
                      ['blocked', 'المحظورون'],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setCustomerStateFilter(id)}
                      className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                        customerStateFilter === id
                          ? 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.08)]'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="relative w-full sm:w-56">
                  <Search className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={customerSearch}
                    onChange={(e) => setCustomerSearch(e.target.value)}
                    placeholder="بحث بالاسم أو المعرف..."
                    className="w-full rounded-lg border border-slate-200 bg-slate-50/70 py-1.5 pr-8 pl-3 text-xs text-slate-800 focus:bg-white focus:border-emerald-600 focus:outline-none"
                  />
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-right border-collapse min-w-[1080px]">
                <thead>
                  <tr className="border-b border-slate-200/80 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                    <th className="py-3 px-4">المستخدم</th>
                    <th className="py-3 px-4">تصنيف السعر والحالة</th>
                    <th className="py-3 px-4">الإنفاق</th>
                    <th className="py-3 px-4">الرصيد المتاح</th>
                    <th className="py-3 px-4">الإجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {filteredCustomers.map((u) => {
                    const isOwner = u.role === 'owner';
                    const tier: 'customer' | 'agent' = (u.pricingTier || 'customer') === 'agent' ? 'agent' : 'customer';
                    const isTierBusy = tierBusyUserId === u.id;
                    const customCount = Number(u.customOverridesCount || 0);
                    return (
                      <tr
                        key={u.id}
                        className={`transition-colors ${
                          u.isBlocked ? 'bg-rose-50/25 hover:bg-rose-50/45' : 'hover:bg-slate-50/80'
                        }`}
                      >
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-slate-900">{u.displayName}</span>
                            {isOwner && (
                              <span className="text-[10px] font-semibold text-slate-500">(مالك)</span>
                            )}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                            <span className="font-mono-num">{u.telegramUserId ? `TG ${u.telegramUserId}` : u.email}</span>
                            {u.telegramUsername && (
                              <>
                                <span>·</span>
                                <span dir="ltr">@{u.telegramUsername}</span>
                              </>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <div
                              role="group"
                              aria-label={`تصنيف السعر للمستخدم ${u.displayName}`}
                              className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-100 p-0.5"
                            >
                              <button
                                type="button"
                                disabled={busy || isTierBusy}
                                aria-pressed={tier === 'customer'}
                                onClick={() => void handleChangePricingTier(u, 'customer')}
                                className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50 ${
                                  tier === 'customer'
                                    ? 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.08)]'
                                    : 'text-slate-500 hover:text-slate-900'
                                }`}
                              >
                                عميل
                              </button>
                              <button
                                type="button"
                                disabled={busy || isTierBusy}
                                aria-pressed={tier === 'agent'}
                                onClick={() => void handleChangePricingTier(u, 'agent')}
                                className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50 ${
                                  tier === 'agent'
                                    ? 'bg-emerald-700 text-white shadow-[0_1px_2px_rgba(15,23,42,0.12)]'
                                    : 'text-slate-500 hover:text-emerald-800'
                                }`}
                              >
                                وكيل
                              </button>
                            </div>
                            <SemanticStatus
                              tone={u.isBlocked ? 'negative' : 'positive'}
                              label={u.isBlocked ? 'محظور' : 'نشط'}
                            />
                          </div>
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <div
                            className={`font-mono-num text-sm ${
                              Number(u.totalSpent || 0) > 0
                                ? 'font-bold text-emerald-700'
                                : 'font-medium text-slate-400'
                            }`}
                          >
                            ${u.totalSpent ?? '0.00'}
                          </div>
                          <div className="text-[11px] text-slate-400 font-mono-num">
                            {u.completedOrdersCount ?? 0} ناجح / {u.ordersCount ?? 0} طلب
                          </div>
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <div className="font-mono-num text-sm font-bold text-slate-900">${u.availableBalance}</div>
                          {Number(u.reservedBalance || 0) > 0 && (
                            <div className="font-mono-num text-[11px] text-amber-700">
                              محجوز: ${u.reservedBalance}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-3">
                          <div className="flex flex-wrap xl:flex-nowrap items-center gap-1.5">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => openAdjustModal(u, 'add')}
                              className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-slate-800 whitespace-nowrap disabled:opacity-50 transition-colors"
                            >
                              <Wallet className="h-3.5 w-3.5" />
                              الرصيد
                            </button>

                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setHistoryTarget({ id: u.id, displayName: u.displayName })}
                              aria-label={`السجل الخاص بالعميل ${u.displayName}`}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:border-slate-300 hover:bg-slate-50 whitespace-nowrap disabled:opacity-50 transition-colors"
                            >
                              <History className="h-3.5 w-3.5 text-slate-500" />
                              السجل
                            </button>

                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setCustomizeTarget({ id: u.id, displayName: u.displayName })}
                              aria-label={`تخصيص المنتجات والأسعار للعميل ${u.displayName}`}
                              className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold whitespace-nowrap disabled:opacity-50 transition-colors ${
                                customCount > 0
                                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                                  : 'border-slate-200 bg-white text-slate-700 hover:border-emerald-300 hover:bg-emerald-50/50 hover:text-emerald-800'
                              }`}
                            >
                              <SlidersHorizontal className="h-3.5 w-3.5" />
                              تخصيص
                              {customCount > 0 && (
                                <span className="font-mono-num text-[10px] font-bold">({customCount})</span>
                              )}
                            </button>

                            <button
                              type="button"
                              disabled={busy || isOwner}
                              title={isOwner ? 'لا يمكن حظر حساب مالك النظام' : u.isBlocked ? 'فك حظر المستخدم' : 'حظر المستخدم'}
                              onClick={() => void handleToggleBlockUser(u)}
                              className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] font-semibold whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${
                                u.isBlocked
                                  ? 'border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50'
                                  : 'border-slate-200 bg-white text-amber-700 hover:border-amber-200 hover:bg-amber-50'
                              }`}
                            >
                              {u.isBlocked ? (
                                <>
                                  <ShieldCheck className="h-3.5 w-3.5" />
                                  فك الحظر
                                </>
                              ) : (
                                <>
                                  <Ban className="h-3.5 w-3.5" />
                                  حظر
                                </>
                              )}
                            </button>

                            <button
                              type="button"
                              disabled={busy || isOwner}
                              title={isOwner ? 'لا يمكن حذف حساب مالك النظام' : 'حذف المستخدم ورصيده'}
                              onClick={() => setDeleteTarget(u)}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] font-semibold text-rose-700 hover:border-rose-200 hover:bg-rose-50 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              حذف
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {filteredCustomers.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-10 text-center text-sm text-slate-400">
                        لا يوجد مستخدمون مطابقون للبحث الحالي.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </SurfacePanel>

          {/* Immutable Wallet Ledger with Date Filter */}
          <div className="space-y-3">
            {renderDateAndStatusToolbar(false)}

            <SurfacePanel className="overflow-hidden">
              <SectionHeader
                title="السجل المالي للمحافظ (Wallet Ledger)"
                subtitle={`${filteredLedger.length} حركة مسجلة`}
                icon={Wallet}
              />
              <div className="overflow-x-auto">
                <table className="w-full text-right border-collapse min-w-[760px]">
                  <thead>
                    <tr className="border-b border-slate-200/80 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                      <th className="py-2.5 px-4">المرجع والتاريخ</th>
                      <th className="py-2.5 px-4">العميل</th>
                      <th className="py-2.5 px-4">النوع والبيان</th>
                      <th className="py-2.5 px-4">المبلغ</th>
                      <th className="py-2.5 px-4">الرصيد بعد العملية</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {filteredLedger.map((l) => {
                      const isPositive = Number(l.amount) >= 0;
                      return (
                        <tr key={l.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="py-2.5 px-4">
                            <div className="font-mono-num font-semibold text-slate-800">{l.referenceCode}</div>
                            <div className="font-mono-num text-[11px] text-slate-400">
                              {formatAdminDateTime(l.createdAt)}
                            </div>
                          </td>
                          <td className="py-2.5 px-4 font-medium text-slate-800">{l.customerName || `#${l.userId}`}</td>
                          <td className="py-2.5 px-4">
                            <div className="font-semibold text-slate-700">{l.entryType}</div>
                            <div className="text-[11px] text-slate-500 truncate max-w-[280px]">{l.note}</div>
                          </td>
                          <td
                            className={`py-2.5 px-4 font-mono-num font-bold ${
                              isPositive ? 'text-emerald-700' : 'text-rose-600'
                            }`}
                          >
                            {isPositive ? `+$${Number(l.amount).toFixed(2)}` : `-$${Math.abs(Number(l.amount)).toFixed(2)}`}
                          </td>
                          <td className="py-2.5 px-4 font-mono-num font-semibold text-slate-800">${l.balanceAfter}</td>
                        </tr>
                      );
                    })}
                    {filteredLedger.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-slate-400">
                          لا توجد حركات مالية خلال الفترة المحددة.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </SurfacePanel>
          </div>
        </div>
      )}

      {/* 4. Coupons & Broadcast Announcements */}
      {subTab === 'coupons' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <SurfacePanel className="lg:col-span-7 overflow-hidden">
            <SectionHeader title="كوبونات الخصم" subtitle={`${coupons.length} كوبون مسجل`} icon={Tag} />
            <div className="p-5 space-y-4">
              <form onSubmit={handleCreateCoupon} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <input
                  type="text"
                  required
                  placeholder="الكود"
                  value={couponForm.code}
                  onChange={(e) => setCouponForm({ ...couponForm, code: e.target.value })}
                  className="rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-mono-num uppercase focus:border-emerald-600 focus:outline-none"
                />
                <select
                  value={couponForm.discountType}
                  onChange={(e) => setCouponForm({ ...couponForm, discountType: e.target.value })}
                  className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs focus:border-emerald-600 focus:outline-none"
                >
                  <option value="percent">نسبة %</option>
                  <option value="fixed">مبلغ ثابت $</option>
                </select>
                <input
                  type="number"
                  step="0.01"
                  required
                  placeholder="القيمة"
                  value={couponForm.discountValue}
                  onChange={(e) => setCouponForm({ ...couponForm, discountValue: e.target.value })}
                  className="rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-mono-num focus:border-emerald-600 focus:outline-none"
                />
                <input
                  type="number"
                  required
                  placeholder="الحد الأقصى"
                  value={couponForm.maxUses}
                  onChange={(e) => setCouponForm({ ...couponForm, maxUses: e.target.value })}
                  className="rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-mono-num focus:border-emerald-600 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex items-center justify-center gap-1 rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-800 transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  إنشاء
                </button>
              </form>

              <div className="divide-y divide-slate-100 border-t border-slate-100">
                {coupons.map((c) => (
                  <div key={c.id} className="flex items-center justify-between py-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono-num font-bold text-slate-900">{c.code}</span>
                      <span className="text-slate-300">·</span>
                      <span className="font-mono-num text-slate-600">
                        {c.discountType === 'percent' ? `${Number(c.discountValue)}%` : `$${Number(c.discountValue).toFixed(2)}`}
                      </span>
                      <span className="text-slate-300">·</span>
                      <span className="font-mono-num text-slate-500">
                        استخدام {c.usedCount}/{c.maxUses}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <SemanticStatus tone={c.isActive ? 'positive' : 'neutral'} label={c.isActive ? 'نشط' : 'متوقف'} />
                      <button
                        type="button"
                        onClick={() => void handleToggleCoupon(c.id, c.isActive)}
                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        {c.isActive ? 'إيقاف' : 'تفعيل'}
                      </button>
                    </div>
                  </div>
                ))}
                {coupons.length === 0 && (
                  <div className="py-6 text-center text-xs text-slate-400">لا توجد كوبونات مضافة بعد.</div>
                )}
              </div>
            </div>
          </SurfacePanel>

          <SurfacePanel className="lg:col-span-5 overflow-hidden">
            <SectionHeader
              title="إعلان جماعي للعملاء"
              subtitle="إرسال فعلي مباشر عبر بوت تيليجرام للعملاء المرتبطين"
              icon={Megaphone}
              action={
                broadcastSummary ? (
                  <SemanticStatus
                    tone={broadcastSummary.botAvailable ? 'positive' : 'negative'}
                    label={
                      broadcastSummary.botAvailable
                        ? broadcastSummary.botUsername
                          ? `@${broadcastSummary.botUsername}`
                          : 'البوت جاهز'
                        : 'البوت غير مربوط'
                    }
                  />
                ) : null
              }
            />
            <form onSubmit={handleBroadcast} className="p-5 space-y-3.5">
              {broadcastSummary && !broadcastSummary.botAvailable && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                  {broadcastSummary.botReasonAr || 'توكن بوت تيليجرام غير مضبوط بعد. اربط البوت أولًا لتفعيل الإرسال.'}
                </div>
              )}

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-slate-700">الجمهور المستهدف عبر تيليجرام</label>
                  <span className="text-[11px] text-slate-500 font-mono-num">
                    {broadcastSummaryLoading
                      ? 'جارٍ الحساب...'
                      : broadcastSummary
                        ? `${broadcastSummary.counts[broadcast.audience]} مستلم مؤهل`
                        : '—'}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1.5 rounded-lg bg-slate-100 p-1">
                  {(
                    [
                      {
                        id: 'customers',
                        label: 'العملاء فقط',
                        count: broadcastSummary?.counts.customers,
                      },
                      {
                        id: 'all_telegram',
                        label: 'العملاء + الإدارة',
                        count: broadcastSummary?.counts.all_telegram,
                      },
                      {
                        id: 'admins_only',
                        label: 'تجربة للإدارة',
                        count: broadcastSummary?.counts.admins_only,
                      },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setBroadcast((prev) => ({ ...prev, audience: opt.id }))}
                      className={`rounded-md px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                        broadcast.audience === opt.id
                          ? 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.08)]'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {opt.label}
                      {typeof opt.count === 'number' ? (
                        <span className="mr-1 font-mono-num text-[10px] text-slate-500">({opt.count})</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label htmlFor="broadcast-title" className="block text-xs font-medium text-slate-700 mb-1">
                  عنوان الإعلان
                </label>
                <input
                  id="broadcast-title"
                  type="text"
                  required
                  maxLength={180}
                  placeholder="مثال: عروض جديدة في المتجر"
                  value={broadcast.title}
                  onChange={(e) => setBroadcast((prev) => ({ ...prev, title: e.target.value }))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label htmlFor="broadcast-message" className="text-xs font-medium text-slate-700">
                    نص الرسالة
                  </label>
                  <span
                    className={`text-[11px] font-mono-num ${
                      broadcast.title.length + broadcast.message.length > 3950
                        ? 'text-rose-600 font-semibold'
                        : 'text-slate-400'
                    }`}
                  >
                    {broadcast.title.length + broadcast.message.length} / 4000
                  </span>
                </div>
                <textarea
                  id="broadcast-message"
                  rows={4}
                  required
                  placeholder="اكتب نص الإعلان أو التنبيه الذي سيصل للعملاء مباشرة على تيليجرام..."
                  value={broadcast.message}
                  onChange={(e) => setBroadcast((prev) => ({ ...prev, message: e.target.value }))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={
                  busy ||
                  broadcastSending ||
                  (broadcastSummary !== null && !broadcastSummary.botAvailable) ||
                  (broadcastSummary !== null && broadcastSummary.counts[broadcast.audience] === 0)
                }
                className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white hover:bg-slate-800 transition-colors disabled:opacity-50"
              >
                {broadcastSending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    جارٍ الإرسال عبر تيليجرام...
                  </>
                ) : (
                  <>
                    <Send className="h-3.5 w-3.5" />
                    {broadcast.audience === 'admins_only'
                      ? 'إرسال نسخة تجريبية للإدارة عبر تيليجرام'
                      : broadcast.audience === 'all_telegram'
                        ? `إرسال الإعلان للعملاء والإدارة (${broadcastSummary?.counts.all_telegram ?? '—'})`
                        : `إرسال الإعلان لجميع العملاء عبر تيليجرام (${broadcastSummary?.counts.customers ?? '—'})`}
                  </>
                )}
              </button>

              {lastBroadcastReport && (
                <div
                  className={`rounded-lg border p-3 text-xs space-y-2 ${
                    lastBroadcastReport.ok
                      ? 'border-emerald-200 bg-emerald-50/70 text-emerald-950'
                      : 'border-rose-200 bg-rose-50/70 text-rose-950'
                  }`}
                >
                  <div className="font-semibold">{lastBroadcastReport.messageAr}</div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-md bg-white/80 border border-slate-200/70 px-2 py-1.5">
                      <div className="text-[10px] text-slate-500">وصل فعليًا</div>
                      <div className="font-mono-num text-sm font-bold text-emerald-700">
                        {lastBroadcastReport.sentCount}
                      </div>
                    </div>
                    <div className="rounded-md bg-white/80 border border-slate-200/70 px-2 py-1.5">
                      <div className="text-[10px] text-slate-500">حظروا البوت</div>
                      <div className="font-mono-num text-sm font-bold text-amber-700">
                        {lastBroadcastReport.blockedCount}
                      </div>
                    </div>
                    <div className="rounded-md bg-white/80 border border-slate-200/70 px-2 py-1.5">
                      <div className="text-[10px] text-slate-500">فشل أخرى</div>
                      <div className="font-mono-num text-sm font-bold text-rose-700">
                        {Math.max(0, lastBroadcastReport.failedCount - lastBroadcastReport.blockedCount)}
                      </div>
                    </div>
                  </div>
                  {lastBroadcastReport.errorsSample.length > 0 && (
                    <div className="space-y-1 pt-1 border-t border-slate-200/70 text-[11px] text-slate-700">
                      <div className="font-medium">عينة من أسباب عدم التوصيل:</div>
                      {lastBroadcastReport.errorsSample.map((item, idx) => (
                        <div key={`${item.telegramUserId}-${idx}`} className="flex items-center justify-between gap-2">
                          <span className="truncate">{item.displayName}</span>
                          <span className="text-rose-700 shrink-0">{item.reason}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {broadcastSummary && broadcastSummary.recentBroadcasts.length > 0 && (
                <div className="pt-3 border-t border-slate-100 space-y-2">
                  <div className="text-[11px] font-semibold text-slate-500">أحدث الإعلانات المرسلة</div>
                  <div className="space-y-1.5 max-h-44 overflow-y-auto">
                    {broadcastSummary.recentBroadcasts.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 bg-slate-50/70 px-2.5 py-2 text-[11px]"
                      >
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-800 truncate">{item.title}</div>
                          <div className="text-[10px] text-slate-400">{formatAdminDateTime(item.createdAt)}</div>
                        </div>
                        <div className="shrink-0 text-left">
                          {item.sentCount !== null ? (
                            <span
                              className={`font-mono-num font-semibold ${
                                item.sentCount > 0 ? 'text-emerald-700' : 'text-rose-700'
                              }`}
                            >
                              وصل {item.sentCount}/{item.totalEligible}
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-400">سجل قديم</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </form>
          </SurfacePanel>
        </div>
      )}

      {/* Full Balance Control Modal (Add / Deduct / Set Exact Balance + Automatic Credit Notification) */}
      {adjustTarget !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 p-6 shadow-xl space-y-4">
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900">التحكم الكامل برصيد العميل</h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  {adjustTarget.displayName} · الرصيد الحالي:{' '}
                  <span className="font-mono-num font-bold text-slate-900">${adjustTarget.availableBalance}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAdjustTarget(null)}
                className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50"
              >
                إغلاق
              </button>
            </div>

            <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => handleSwitchAdjustMode('add')}
                className={`rounded-lg py-2 text-xs font-bold transition-colors ${
                  adjustMode === 'add'
                    ? 'bg-emerald-700 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                إضافة رصيد
              </button>
              <button
                type="button"
                onClick={() => handleSwitchAdjustMode('deduct')}
                className={`rounded-lg py-2 text-xs font-bold transition-colors ${
                  adjustMode === 'deduct'
                    ? 'bg-rose-700 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                خصم رصيد
              </button>
              <button
                type="button"
                onClick={() => handleSwitchAdjustMode('set')}
                className={`rounded-lg py-2 text-xs font-bold transition-colors ${
                  adjustMode === 'set'
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                تعيين مباشر
              </button>
            </div>

            <form onSubmit={handleWalletAdjust} className="space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {adjustMode === 'add'
                    ? 'مبلغ الإضافة ($ USDT)'
                    : adjustMode === 'deduct'
                      ? 'مبلغ الخصم ($ USDT)'
                      : 'الرصيد الجديد المطلوب ($ USDT)'}
                </label>
                <input
                  type="number"
                  step="0.01"
                  min={adjustMode === 'set' ? '0' : '0.01'}
                  required
                  value={adjustAmount}
                  onChange={(e) => setAdjustAmount(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono-num focus:border-emerald-600 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">البيان الموثق في السجل المالي</label>
                <input
                  type="text"
                  required
                  value={adjustNote}
                  onChange={(e) => setAdjustNote(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                />
              </div>

              {balancePreview && (
                <div
                  className={`rounded-xl border p-3 text-xs space-y-1.5 ${
                    !balancePreview.valid
                      ? 'border-rose-200 bg-rose-50 text-rose-800'
                      : balancePreview.delta > 0
                        ? 'border-emerald-200 bg-emerald-50/70 text-emerald-900'
                        : 'border-amber-200 bg-amber-50/70 text-amber-900'
                  }`}
                >
                  {!balancePreview.valid ? (
                    <div className="font-semibold">{balancePreview.error}</div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between">
                        <span>مقدار التغيير:</span>
                        <span className="font-mono-num font-bold">
                          {balancePreview.delta > 0
                            ? `+$${balancePreview.delta.toFixed(2)}`
                            : `-$${Math.abs(balancePreview.delta).toFixed(2)}`}
                        </span>
                      </div>
                      <div className="flex items-center justify-between border-t border-black/10 pt-1.5">
                        <span className="font-semibold">الرصيد الإجمالي بعد العملية:</span>
                        <span className="font-mono-num text-sm font-bold">${balancePreview.next.toFixed(2)}</span>
                      </div>
                      {balancePreview.delta > 0 && (
                        <div className="flex items-center gap-1.5 pt-1 text-[11px] font-medium text-emerald-800">
                          <Bell className="h-3.5 w-3.5 shrink-0" />
                          <span>سيصل للمستخدم إشعار تلقائي يوضح المبلغ المضاف ورصيده الجديد.</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setAdjustTarget(null)}
                  className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={busy || !balancePreview?.valid}
                  className={`rounded-lg px-4 py-2 text-xs font-bold text-white disabled:opacity-45 ${
                    adjustMode === 'deduct'
                      ? 'bg-rose-700 hover:bg-rose-800'
                      : adjustMode === 'set'
                        ? 'bg-slate-900 hover:bg-slate-800'
                        : 'bg-emerald-700 hover:bg-emerald-800'
                  }`}
                >
                  {adjustMode === 'add'
                    ? 'تأكيد الإضافة وإرسال الإشعار'
                    : adjustMode === 'deduct'
                      ? 'تأكيد الخصم'
                      : 'حفظ الرصيد الجديد'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* In-App Delete User Confirmation Modal */}
      {deleteTarget !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-rose-200 p-6 shadow-xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-rose-100 p-2.5 text-rose-700 shrink-0">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">تأكيد حذف المستخدم ورصيده نهائيًا</h3>
                <p className="mt-1 text-xs leading-relaxed text-slate-600">
                  سيتم حذف حساب <span className="font-bold text-slate-900">{deleteTarget.displayName}</span> مع محفظته
                  ورصيده الحالي (<span className="font-mono-num font-bold text-rose-700">${deleteTarget.availableBalance}</span>)
                  وسجلات الطلبات والإيداعات المرتبطة به نهائيًا ولا يمكن التراجع عن هذه العملية.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                تراجع
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleConfirmDeleteUser()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-700 px-4 py-2 text-xs font-bold text-white hover:bg-rose-800 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                تأكيد الحذف النهائي
              </button>
            </div>
          </div>
        </div>
      )}

      {/* In-App Refund Order & Automatic Referral Commission Reversal Modal */}
      {refundOrderTarget !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-rose-200 p-6 shadow-xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-rose-100 p-2.5 text-rose-700 shrink-0">
                <RotateCcw className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">تأكيد استرداد الطلب وعكس العمولة</h3>
                <p className="mt-1 text-xs leading-relaxed text-slate-600">
                  سيتم إعادة مبلغ{' '}
                  <span className="font-mono-num font-bold text-slate-900">${refundOrderTarget.totalRetail}</span> إلى
                  محفظة المشتري <span className="font-bold text-slate-900">{refundOrderTarget.customerName}</span> للطلب{' '}
                  <span className="font-mono-num font-bold text-slate-900">{refundOrderTarget.orderNumber}</span>،
                  وسيتم عكس أي عمولة إحالة مرتبطة بهذا الطلب تلقائيًا وبأمان.
                </p>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">سبب الاسترداد</label>
              <input
                type="text"
                value={refundOrderReason}
                onChange={(e) => setRefundOrderReason(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-rose-600 focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => setRefundOrderTarget(null)}
                className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                تراجع
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleConfirmRefundOrder()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-700 px-4 py-2 text-xs font-bold text-white hover:bg-rose-800 disabled:opacity-50"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {busy ? 'جارٍ التنفيذ...' : 'تأكيد الاسترداد وعكس العمولة'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Per-Customer Isolated History Modal (Orders + Wallet Ledger + Deposits) */}
      {historyTarget !== null && (
        <CustomerHistoryModal
          customerId={historyTarget.id}
          customerName={historyTarget.displayName}
          onClose={() => setHistoryTarget(null)}
        />
      )}
    </div>
  );
}
