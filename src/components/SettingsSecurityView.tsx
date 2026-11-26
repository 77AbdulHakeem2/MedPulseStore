import React, { useEffect, useState } from 'react';
import {
  ShieldCheck,
  Bell,
  Globe,
  Wallet,
  Eye,
  ScrollText,
  RefreshCw,
  KeyRound,
} from 'lucide-react';
import { apiFetch, setAuthToken, type SessionUser } from '../lib/api';
import BinancePayAdminPanel, {
  type BinanceAdminData,
  type PaymentMethodItem,
} from './BinancePayAdminPanel';
import {
  PageHeader,
  SegmentedTabs,
  KpiCard,
  SurfacePanel,
  SectionHeader,
  SemanticStatus,
  FeedbackBanner,
} from './ui/AdminPrimitives';

interface SettingsSecurityViewProps {
  storeProfile: Record<string, any>;
  notificationPrefs: Record<string, boolean>;
  notifications: any[];
  auditLogs: any[];
  binanceData: BinanceAdminData | null;
  paymentMethods: PaymentMethodItem[];
  canManageSettings?: boolean;
  canManagePayments?: boolean;
  canViewAudit?: boolean;
  onPreviewCustomerBot: (lang: 'ar' | 'en') => void;
  onRefresh: () => Promise<void>;
  onUserUpdated?: (user: SessionUser) => void;
}

const ALERT_LABELS: Record<string, string> = {
  new_deposit: 'إيداع جديد',
  order_success: 'طلب ناجح',
  order_failed: 'طلب فاشل',
  low_provider_balance: 'انخفاض رصيد مزود',
  out_of_stock: 'نفاد مخزون منتج',
  wholesale_price_increase: 'ارتفاع سعر الجملة',
  api_offline: 'توقف اتصال API',
  webhook_failed: 'فشل Webhook',
  stale_pending_order: 'طلب معلق لمدة طويلة',
  duplicate_txid: 'محاولة تكرار TxID / Transaction ID',
};

type SettingsTab = 'binance' | 'languages' | 'security';

export default function SettingsSecurityView({
  storeProfile,
  notificationPrefs,
  notifications,
  auditLogs,
  binanceData,
  paymentMethods,
  canManageSettings = true,
  canManagePayments = true,
  canViewAudit = true,
  onPreviewCustomerBot,
  onRefresh,
  onUserUpdated,
}: SettingsSecurityViewProps) {
  const defaultTab: SettingsTab = canManagePayments
    ? 'binance'
    : canManageSettings
      ? 'languages'
      : 'security';
  const [activeTab, setActiveTab] = useState<SettingsTab>(defaultTab);
  const [profile, setProfile] = useState<Record<string, any>>(storeProfile);
  const [prefs, setPrefs] = useState<Record<string, boolean>>(notificationPrefs);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [securityChecks, setSecurityChecks] = useState<Array<{ name: string; passed: boolean }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [revokeOtherSessions, setRevokeOtherSessions] = useState(true);

  useEffect(() => {
    setProfile(storeProfile);
  }, [storeProfile]);

  useEffect(() => {
    setPrefs(notificationPrefs);
  }, [notificationPrefs]);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    const arEnabled = profile.arEnabled !== false;
    const enEnabled = profile.enEnabled !== false;
    if (!arEnabled && !enEnabled) {
      setFeedback({ type: 'err', text: 'يجب تفعيل لغة واحدة على الأقل لبوت العملاء.' });
      return;
    }

    setBusy(true);
    setFeedback(null);
    try {
      const normalizedProfile = {
        ...profile,
        arEnabled,
        enEnabled,
        defaultLanguage:
          profile.defaultLanguage === 'en' && enEnabled
            ? 'en'
            : arEnabled
              ? 'ar'
              : 'en',
      };
      await apiFetch('/api/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify({ storeProfile: normalizedProfile, notificationPreferences: prefs }),
      });
      setFeedback({ type: 'ok', text: 'تم حفظ إعدادات اللغات وهوية المتجر والتنبيهات بنجاح.' });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر حفظ الإعدادات.' });
    } finally {
      setBusy(false);
    }
  };

  const runLiveSecurityAudit = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ checks: Array<{ name: string; passed: boolean }> }>(
        '/api/admin/security-check',
        { method: 'POST' }
      );
      setSecurityChecks(res.checks);
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تشغيل فحص الأمان.' });
    } finally {
      setBusy(false);
    }
  };

  const markAllRead = async () => {
    await apiFetch('/api/admin/notifications/read-all', { method: 'PATCH' });
    await onRefresh();
  };

  const handleChangeOwnPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmNewPassword) {
      setFeedback({ type: 'err', text: 'كلمة المرور الجديدة وتأكيدها غير متطابقتين.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ ok: boolean; token: string; user: SessionUser }>(
        '/api/auth/change-password',
        {
          method: 'POST',
          body: JSON.stringify({
            currentPassword,
            newPassword,
            revokeOtherSessions,
          }),
        }
      );
      if (res.token) setAuthToken(res.token);
      if (res.user && onUserUpdated) onUserUpdated(res.user);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
      setFeedback({
        type: 'ok',
        text: revokeOtherSessions
          ? 'تم تحديث كلمة المرور وإبطال جميع الجلسات الأخرى بنجاح.'
          : 'تم تحديث كلمة المرور بنجاح.',
      });
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تحديث كلمة المرور.' });
    } finally {
      setBusy(false);
    }
  };

  const unreadNotifications = notifications.filter((n) => !n.isRead).length;
  const failedChecksCount = securityChecks ? securityChecks.filter((c) => !c.passed).length : 0;
  const passedChecksCount = securityChecks ? securityChecks.filter((c) => c.passed).length : 0;

  const visibleTabs = [
    ...(canManagePayments ? [{ id: 'binance' as const, label: 'Binance ID والدفع', icon: Wallet }] : []),
    ...(canManageSettings ? [{ id: 'languages' as const, label: 'اللغات والمتجر', icon: Globe }] : []),
    ...(canViewAudit ? [{ id: 'security' as const, label: 'الأمان والتدقيق', icon: ShieldCheck }] : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="الإعدادات والأمان"
        subtitle="بوابات الدفع، اللغات وهوية المتجر، وفحص الأمان والتدقيق."
        actions={
          <SegmentedTabs
            value={activeTab}
            onChange={setActiveTab}
            items={visibleTabs}
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

      {/* TAB 1: BINANCE ID AUTO-VERIFICATION & EXTENSIBLE PAYMENT METHODS */}
      {activeTab === 'binance' && (
        <BinancePayAdminPanel
          binanceData={binanceData}
          paymentMethods={paymentMethods}
          onRefresh={onRefresh}
        />
      )}

      {/* TAB 2: BILINGUAL BOT SETTINGS (AR / EN) + STORE IDENTITY */}
      {activeTab === 'languages' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <SurfacePanel className="lg:col-span-8 overflow-hidden">
            <SectionHeader
              title="اللغات وهوية المتجر"
              subtitle="تُطبّق فورًا على بوت المشتري باللغتين العربية والإنجليزية"
              icon={Globe}
            />
            <form onSubmit={handleSaveSettings} className="p-5 space-y-5">
              {/* Language Controls */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 pb-4 border-b border-slate-100">
                <label className="flex items-center gap-2.5 rounded-lg border border-slate-200 p-3 text-xs font-semibold text-slate-800 cursor-pointer hover:bg-slate-50 transition-colors">
                  <input
                    type="checkbox"
                    checked={profile.arEnabled !== false}
                    onChange={(e) => setProfile({ ...profile, arEnabled: e.target.checked })}
                    className="accent-emerald-700 h-4 w-4"
                  />
                  <span>العربية (AR)</span>
                </label>

                <label className="flex items-center gap-2.5 rounded-lg border border-slate-200 p-3 text-xs font-semibold text-slate-800 cursor-pointer hover:bg-slate-50 transition-colors">
                  <input
                    type="checkbox"
                    checked={profile.enEnabled !== false}
                    onChange={(e) => setProfile({ ...profile, enEnabled: e.target.checked })}
                    className="accent-emerald-700 h-4 w-4"
                  />
                  <span>الإنجليزية (EN)</span>
                </label>

                <div>
                  <label className="block text-[11px] font-medium text-slate-500 mb-1">اللغة الافتراضية</label>
                  <select
                    aria-label="اللغة الافتراضية للمتجر"
                    value={profile.defaultLanguage === 'en' ? 'en' : 'ar'}
                    onChange={(e) => setProfile({ ...profile, defaultLanguage: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800 focus:border-emerald-600 focus:outline-none"
                  >
                    <option value="ar">العربية (ar)</option>
                    <option value="en">English (en)</option>
                  </select>
                </div>
              </div>

              {/* Bilingual Store Identity */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 pb-4 border-b border-slate-100">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">اسم المتجر (AR)</label>
                  <input
                    type="text"
                    value={profile.storeName || ''}
                    onChange={(e) => setProfile({ ...profile, storeName: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">اسم المتجر (EN)</label>
                  <input
                    type="text"
                    dir="ltr"
                    value={profile.storeNameEn || ''}
                    onChange={(e) => setProfile({ ...profile, storeNameEn: e.target.value })}
                    placeholder="Raqm Digital Store"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">رسالة الترحيب (AR)</label>
                  <textarea
                    rows={2}
                    value={profile.welcomeMessageAr || ''}
                    onChange={(e) => setProfile({ ...profile, welcomeMessageAr: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Welcome Message (EN)</label>
                  <textarea
                    rows={2}
                    dir="ltr"
                    value={profile.welcomeMessageEn || ''}
                    onChange={(e) => setProfile({ ...profile, welcomeMessageEn: e.target.value })}
                    placeholder="Welcome to Raqm Digital Store"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">الشروط والضمان (AR)</label>
                  <textarea
                    rows={2}
                    value={profile.termsAr || ''}
                    onChange={(e) => setProfile({ ...profile, termsAr: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs focus:border-emerald-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Terms & Warranty (EN)</label>
                  <textarea
                    rows={2}
                    dir="ltr"
                    value={profile.termsEn || ''}
                    onChange={(e) => setProfile({ ...profile, termsEn: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs focus:border-emerald-600 focus:outline-none"
                  />
                </div>
              </div>

              {/* Support & On-Chain Wallets */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 pb-4 border-b border-slate-100">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">حساب الدعم (تيليجرام)</label>
                  <input
                    type="text"
                    dir="ltr"
                    value={profile.supportHandle || ''}
                    onChange={(e) => setProfile({ ...profile, supportHandle: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono-num focus:border-emerald-600 focus:outline-none"
                  />
                </div>
                <div className="flex items-end pb-2">
                  <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={profile.isStoreOpen !== false}
                      onChange={(e) => setProfile({ ...profile, isStoreOpen: e.target.checked })}
                      className="accent-emerald-700 h-4 w-4"
                    />
                    المتجر مفتوح ويستقبل الطلبات
                  </label>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">محفظة USDT (TRC20)</label>
                  <input
                    type="text"
                    dir="ltr"
                    value={profile.usdtTrc20Wallet || ''}
                    onChange={(e) => setProfile({ ...profile, usdtTrc20Wallet: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono-num focus:border-emerald-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">محفظة USDT (BEP20)</label>
                  <input
                    type="text"
                    dir="ltr"
                    value={profile.usdtBep20Wallet || ''}
                    onChange={(e) => setProfile({ ...profile, usdtBep20Wallet: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono-num focus:border-emerald-600 focus:outline-none"
                  />
                </div>
              </div>

              {/* Notification Toggles */}
              <div className="space-y-2.5">
                <h3 className="text-xs font-bold text-slate-700">تفضيلات تنبيهات الإدارة</h3>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 text-xs">
                  {Object.entries(ALERT_LABELS).map(([key, label]) => (
                    <label key={key} className="inline-flex items-center gap-2 text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={prefs[key] !== false}
                        onChange={(e) => setPrefs({ ...prefs, [key]: e.target.checked })}
                        className="accent-emerald-700"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="pt-1">
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-lg bg-emerald-700 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50 transition-colors"
                >
                  حفظ إعدادات المتجر
                </button>
              </div>
            </form>
          </SurfacePanel>

          {/* Clean Live Customer Bot Preview */}
          <div className="lg:col-span-4 space-y-4">
            <SurfacePanel className="overflow-hidden">
              <SectionHeader
                title="معاينة بوت المشتري"
                subtitle="اختبار فوري للواجهة باللغتين"
                icon={Eye}
              />
              <div className="p-5 space-y-3">
                <button
                  type="button"
                  onClick={() => onPreviewCustomerBot('ar')}
                  className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white hover:bg-slate-800 transition-colors"
                >
                  معاينة البوت بالعربية (AR)
                </button>
                <button
                  type="button"
                  onClick={() => onPreviewCustomerBot('en')}
                  className="w-full rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors"
                >
                  Preview Customer Bot (EN)
                </button>
              </div>
            </SurfacePanel>
          </div>
        </div>
      )}

      {/* TAB 3: SECURITY AUDIT, NOTIFICATIONS & AUDIT LOGS */}
      {activeTab === 'security' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <KpiCard
              label="حالة فحص الأمان"
              value={
                securityChecks ? (
                  `${passedChecksCount}/${securityChecks.length}`
                ) : (
                  <span className="font-sans text-xl">جاهز للفحص</span>
                )
              }
              tone={
                !securityChecks
                  ? 'neutral'
                  : failedChecksCount > 0
                    ? 'negative'
                    : 'positive'
              }
              valueTone={
                !securityChecks
                  ? 'default'
                  : failedChecksCount > 0
                    ? 'negative'
                    : 'positive'
              }
              indicatorText={
                !securityChecks
                  ? 'فحص فوري'
                  : failedChecksCount > 0
                    ? `${failedChecksCount} ملاحظات`
                    : 'جميع الفحوصات سليمة'
              }
              meta={<span>عزل بيانات المزودين وصلاحيات المفاتيح</span>}
            />
            <KpiCard
              label="تنبيهات غير مقروءة"
              value={unreadNotifications}
              tone={unreadNotifications > 0 ? 'warning' : 'positive'}
              valueTone={unreadNotifications > 0 ? 'warning' : 'default'}
              indicatorText={unreadNotifications > 0 ? 'بانتظار المراجعة' : 'مقروءة بالكامل'}
              meta={<span>إجمالي التنبيهات: {notifications.length}</span>}
            />
            <KpiCard
              label="سجل التدقيق (Audit)"
              value={auditLogs.length}
              tone="neutral"
              meta={<span>عمليات إدارية موثقة</span>}
            />
          </div>

          <SurfacePanel className="overflow-hidden">
            <SectionHeader
              title="فحص الأمان وعزل بيانات المزودين"
              subtitle="يتحقق من قاعدة البيانات، عزل أسعار الجملة والمفاتيح، وتوافق الكتالوج باللغتين"
              icon={ShieldCheck}
              action={
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runLiveSecurityAudit()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap disabled:opacity-50 transition-colors"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
                  تشغيل الفحص الآن
                </button>
              }
            />
            <div className="p-5">
              {securityChecks ? (
                <div className="divide-y divide-slate-100">
                  {securityChecks.map((c) => (
                    <div key={c.name} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                      <span className="font-medium text-slate-800">{c.name}</span>
                      <SemanticStatus tone={c.passed ? 'positive' : 'negative'} label={c.passed ? 'ناجح' : 'فشل'} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-6 text-center text-xs text-slate-400">
                  اضغط «تشغيل الفحص الآن» للتحقق المباشر من جاهزية النظام وعزل بيانات المزودين.
                </div>
              )}
            </div>
          </SurfacePanel>

          <SurfacePanel className="overflow-hidden">
            <SectionHeader
              title="تغيير كلمة مرور الحساب وإبطال الجلسات"
              subtitle="تحديث كلمة المرور المشفرة بـ scrypt مع إمكانية إنهاء جميع الجلسات المفتوحة على الأجهزة الأخرى"
              icon={KeyRound}
            />
            <form onSubmit={handleChangeOwnPassword} className="p-5 space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    كلمة المرور الحالية
                  </label>
                  <input
                    type="password"
                    dir="ltr"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="اتركه فارغًا إذا لم تُعيّن مسبقًا (للمالك)"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    كلمة المرور الجديدة (8 أحرف على الأقل)
                  </label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    dir="ltr"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    تأكيد كلمة المرور الجديدة
                  </label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    dir="ltr"
                    value={confirmNewPassword}
                    onChange={(e) => setConfirmNewPassword(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={revokeOtherSessions}
                    onChange={(e) => setRevokeOtherSessions(e.target.checked)}
                    className="h-4 w-4 accent-emerald-700"
                  />
                  إبطال جميع الجلسات الأخرى فور التحديث (تدوير tokenVersion)
                </label>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  تحديث كلمة المرور
                </button>
              </div>
            </form>
          </SurfacePanel>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <SurfacePanel className="overflow-hidden">
              <SectionHeader
                title={`تنبيهات الإدارة (${notifications.length})`}
                icon={Bell}
                action={
                  unreadNotifications > 0 ? (
                    <button
                      type="button"
                      onClick={() => void markAllRead()}
                      className="text-xs font-semibold text-emerald-700 hover:underline"
                    >
                      تحديد الكل كمقروء
                    </button>
                  ) : undefined
                }
              />
              <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto px-5">
                {notifications.map((n) => (
                  <div key={n.id} className="py-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`font-semibold ${n.isRead ? 'text-slate-600' : 'text-slate-900'}`}>
                        {n.titleAr}
                      </span>
                      {!n.isRead && <span className="text-[11px] font-semibold text-amber-700">جديد</span>}
                    </div>
                    <div className="mt-0.5 text-slate-500 leading-relaxed">{n.bodyAr}</div>
                  </div>
                ))}
                {notifications.length === 0 && (
                  <div className="py-8 text-center text-xs text-slate-400">لا توجد تنبيهات حاليًا.</div>
                )}
              </div>
            </SurfacePanel>

            <SurfacePanel className="overflow-hidden">
              <SectionHeader title="سجل العمليات التدقيقي" subtitle="آخر الإجراءات الإدارية" icon={ScrollText} />
              <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto px-5 text-xs">
                {auditLogs.map((log) => (
                  <div key={log.id} className="py-2.5 flex items-center justify-between gap-2">
                    <div className="min-w-0 truncate">
                      <span className="font-mono-num font-semibold text-slate-800">{log.action}</span>
                      <span className="mx-1.5 text-slate-300">·</span>
                      <span className="text-slate-500">
                        {log.entityType} #{log.entityId}
                      </span>
                    </div>
                    <span className="text-slate-400 font-mono-num shrink-0">{log.actorRole}</span>
                  </div>
                ))}
                {auditLogs.length === 0 && (
                  <div className="py-8 text-center text-xs text-slate-400">لا توجد سجلات تدقيق بعد.</div>
                )}
              </div>
            </SurfacePanel>
          </div>
        </div>
      )}
    </div>
  );
}
