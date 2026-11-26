import React, { useCallback, useEffect, useState } from 'react';
import { signInWithPopup, signOut } from 'firebase/auth';
import {
  LayoutDashboard,
  MessageSquareText,
  Server,
  ShoppingBag,
  ReceiptText,
  Settings,
  Menu,
  X,
  LogOut,
  LayoutGrid,
  Gift,
  Globe,
  Layers,
  ShieldCheck,
  Wallet,
  ArrowLeft,
  ArrowRight,
  Landmark,
  Users,
  KeyRound,
  Lock,
} from 'lucide-react';
import { auth, googleAuthProvider } from './lib/firebase';
import {
  apiFetch,
  hasAnyStaffPermission,
  hasStaffPermission,
  setAuthToken,
  type SessionUser,
} from './lib/api';
import {
  applyDocumentLang,
  getStoredWebLang,
  saveWebLang,
  WEB_COPY,
  type WebLang,
} from './lib/webLocale';
import OverviewDashboardView from './components/OverviewDashboardView';
import TelegramBotConsole from './components/TelegramBotConsole';
import ButtonsManagerView, { type AdminGuideSubItem } from './components/ButtonsManagerView';
import ProvidersView, { type ProviderItem } from './components/ProvidersView';
import ProductsPricingView, {
  type AdminProductItem,
  type AvailableProviderProduct,
  type CategoryItem,
} from './components/ProductsPricingView';
import OperationsView from './components/OperationsView';
import LocalDepositsCurrencyView from './components/LocalDepositsCurrencyView';
import ReferralManagementView from './components/ReferralManagementView';
import SettingsSecurityView from './components/SettingsSecurityView';
import ModeratorsAccessView from './components/ModeratorsAccessView';
import CustomerStorefront from './components/CustomerStorefront';
import { FeedbackBanner } from './components/ui/AdminPrimitives';
import type { BinanceAdminData, PaymentMethodItem } from './components/BinancePayAdminPanel';
import type { AdminBotButtonItem } from './lib/buttonTreeUtils';

type ActiveSection =
  | 'overview'
  | 'buttons'
  | 'telegram'
  | 'providers'
  | 'products'
  | 'operations'
  | 'local_finance'
  | 'referrals'
  | 'moderators'
  | 'settings';

interface BootstrapStatus {
  ownerPasswordConfigured: boolean;
  passcodeEnvConfigured: boolean;
  googleAuthEnabled: boolean;
}

export default function App() {
  const [webLang, setWebLang] = useState<WebLang>(() => getStoredWebLang());
  const [user, setUser] = useState<SessionUser | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);

  // Login / First-run Owner Claim state
  const [bootstrapStatus, setBootstrapStatus] = useState<BootstrapStatus | null>(null);
  const [forceLoginForm, setForceLoginForm] = useState(false);
  const [loginIdentifier, setLoginIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [setupEmail, setSetupEmail] = useState('');
  const [setupDisplayName, setSetupDisplayName] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [setupConfirmPassword, setSetupConfirmPassword] = useState('');

  // Own Password Change Modal (accessible to all authenticated staff)
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [ownCurrentPassword, setOwnCurrentPassword] = useState('');
  const [ownNewPassword, setOwnNewPassword] = useState('');
  const [ownConfirmPassword, setOwnConfirmPassword] = useState('');
  const [ownRevokeOthers, setOwnRevokeOthers] = useState(true);
  const [ownPwBusy, setOwnPwBusy] = useState(false);
  const [ownPwFeedback, setOwnPwFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [section, setSection] = useState<ActiveSection>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  // Admin Workspace State (PostgreSQL-backed)
  const [overview, setOverview] = useState<any>(null);
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [products, setProducts] = useState<AdminProductItem[]>([]);
  const [availableProviderProducts, setAvailableProviderProducts] = useState<AvailableProviderProduct[]>([]);
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [botButtons, setBotButtons] = useState<AdminBotButtonItem[]>([]);
  const [guides, setGuides] = useState<AdminGuideSubItem[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [deposits, setDeposits] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [ledger, setLedger] = useState<any[]>([]);
  const [coupons, setCoupons] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [storeProfile, setStoreProfile] = useState<Record<string, any>>({
    storeName: 'متجر رَقْم',
    storeNameEn: 'Raqm Store',
    isStoreOpen: true,
  });
  const [notificationPrefs, setNotificationPrefs] = useState<Record<string, boolean>>({});
  const [binanceData, setBinanceData] = useState<BinanceAdminData | null>(null);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodItem[]>([]);
  const [telegramPreview, setTelegramPreview] = useState<{
    mode: 'admin' | 'customer';
    lang?: 'ar' | 'en';
    nonce: number;
  }>({ mode: 'admin', nonce: 0 });

  // Customer-only Public Storefront State (when signed in as Customer)
  const [customerCatalog, setCustomerCatalog] = useState<any[]>([]);
  const [customerWallet, setCustomerWallet] = useState<{
    availableBalance: string;
    reservedBalance: string;
  } | null>(null);
  const [customerOrders, setCustomerOrders] = useState<any[]>([]);

  useEffect(() => {
    applyDocumentLang(webLang);
    saveWebLang(webLang);
  }, [webLang]);

  const loadBootstrapStatus = useCallback(async () => {
    try {
      const status = await apiFetch<BootstrapStatus>('/api/auth/bootstrap-status');
      setBootstrapStatus(status);
    } catch {
      setBootstrapStatus({
        ownerPasswordConfigured: true,
        passcodeEnvConfigured: false,
        googleAuthEnabled: true,
      });
    }
  }, []);

  useEffect(() => {
    void loadBootstrapStatus();
  }, [loadBootstrapStatus]);

  const toggleWebLang = useCallback(() => {
    setWebLang((prev) => (prev === 'ar' ? 'en' : 'ar'));
  }, []);

  const t = WEB_COPY[webLang];
  const isEn = webLang === 'en';
  const brandName = isEn
    ? storeProfile.storeNameEn || storeProfile.storeName || 'Raqm Store'
    : storeProfile.storeName || 'متجر رَقْم';
  const brandMonogram = brandName.trim().charAt(0).toUpperCase() || (isEn ? 'R' : 'ر');

  const safeFetch = <T,>(
    allowed: boolean,
    url: string,
    fallback: T
  ): Promise<T> => {
    if (!allowed) return Promise.resolve(fallback);
    return apiFetch<T>(url).catch(() => fallback);
  };

  const loadAdminWorkspace = useCallback(
    async (explicitUser?: SessionUser | null) => {
      const targetUser = explicitUser ?? user;
      if (!targetUser || targetUser.role === 'customer') return;

      setLoadingData(true);
      setDataError(null);
      try {
        const canOverview = hasStaffPermission(targetUser, 'overview:view');
        const canProviders = hasStaffPermission(targetUser, 'providers:manage');
        const canProducts = hasAnyStaffPermission(targetUser, ['products:manage', 'pricing:manage']);
        const canCategories = hasAnyStaffPermission(targetUser, [
          'products:manage',
          'telegram:manage',
          'pricing:manage',
        ]);
        const canTelegram = hasStaffPermission(targetUser, 'telegram:manage');
        const canOrders = hasStaffPermission(targetUser, 'orders:manage');
        const canDeposits = hasStaffPermission(targetUser, 'deposits:approve');
        const canCustomers = hasStaffPermission(targetUser, 'customers:manage');
        const canPricing = hasStaffPermission(targetUser, 'pricing:manage');
        const canAudit = hasStaffPermission(targetUser, 'audit:view');
        const canSettings = hasStaffPermission(targetUser, 'settings:manage');
        const canPayments = hasAnyStaffPermission(targetUser, ['deposits:approve', 'settings:manage']);

        const [ov, pr, pd, ct, bb, gd, or, dp, cu, cp, nt, au, st, bn, pm] = await Promise.all([
          safeFetch(canOverview, '/api/admin/overview', null),
          safeFetch(canProviders, '/api/admin/providers', { providers: [] }),
          safeFetch(canProducts, '/api/admin/products', { products: [], availableProviderProducts: [] }),
          safeFetch(canCategories, '/api/admin/categories', { categories: [] }),
          safeFetch(canTelegram, '/api/admin/bot-buttons', { buttons: [] }),
          safeFetch(canTelegram, '/api/admin/guides', { guides: [] }),
          safeFetch(canOrders, '/api/admin/orders', { orders: [] }),
          safeFetch(canDeposits, '/api/admin/deposits', { deposits: [] }),
          safeFetch(canCustomers, '/api/admin/customers', { users: [], ledger: [] }),
          safeFetch(canPricing, '/api/admin/coupons', { coupons: [] }),
          safeFetch(canAudit, '/api/admin/notifications', { notifications: [] }),
          safeFetch(canAudit, '/api/admin/audit-logs', { auditLogs: [] }),
          safeFetch(canSettings, '/api/admin/settings', {
            storeProfile: { storeName: 'متجر رَقْم', isStoreOpen: true },
            notificationPreferences: {},
          }),
          safeFetch(canPayments, '/api/admin/binance', null),
          safeFetch(canPayments, '/api/admin/payment-methods', { methods: [] }),
        ]);

        setOverview(ov);
        setProviders(pr.providers || []);
        setProducts(pd.products || []);
        setAvailableProviderProducts(pd.availableProviderProducts || []);
        setCategories(ct.categories || []);
        setBotButtons(bb.buttons || []);
        setGuides(gd.guides || []);
        setOrders(or.orders || []);
        setDeposits(dp.deposits || []);
        setCustomers(cu.users || []);
        setLedger(cu.ledger || []);
        setCoupons(cp.coupons || []);
        setNotifications(nt.notifications || []);
        setAuditLogs(au.auditLogs || []);
        setStoreProfile(st.storeProfile || { storeName: 'متجر رَقْم', isStoreOpen: true });
        setNotificationPrefs(st.notificationPreferences || {});
        setBinanceData(bn || null);
        setPaymentMethods(pm.methods || []);
      } catch (err: any) {
        setDataError(err?.message || 'تعذر تحميل بيانات لوحة الإدارة.');
      } finally {
        setLoadingData(false);
      }
    },
    [user]
  );

  const loadCustomerStorefront = useCallback(async () => {
    setLoadingData(true);
    try {
      const [prof, cat, wal, ord] = await Promise.all([
        apiFetch('/api/store/profile'),
        apiFetch('/api/store/catalog'),
        apiFetch('/api/store/wallet'),
        apiFetch('/api/store/orders'),
      ]);
      setStoreProfile(prof);
      setCustomerCatalog(cat.products || []);
      setCustomerWallet(wal.wallet);
      setCustomerOrders(ord.orders || []);
    } catch (err: any) {
      setDataError(err?.message || 'تعذر تحميل واجهة المتجر.');
    } finally {
      setLoadingData(false);
    }
  }, []);

  const handleAuthenticatedUser = async (nextUser: SessionUser) => {
    setUser(nextUser);
    if (nextUser.role === 'customer') {
      await loadCustomerStorefront();
    } else {
      await loadAdminWorkspace(nextUser);
    }
  };

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError(null);
    try {
      const res = await apiFetch<{ token: string; user: SessionUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          identifier: loginIdentifier.trim(),
          password: loginPassword,
        }),
      });
      setAuthToken(res.token);
      setLoginPassword('');
      await handleAuthenticatedUser(res.user);
    } catch (err: any) {
      setAuthError(err?.message || 'بيانات الدخول غير صحيحة.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSetupOwnerPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (setupPassword !== setupConfirmPassword) {
      setAuthError(isEn ? 'Passwords do not match.' : 'كلمتا المرور غير متطابقتين.');
      return;
    }
    setAuthLoading(true);
    setAuthError(null);
    try {
      const res = await apiFetch<{ ok: boolean; token: string; user: SessionUser }>(
        '/api/auth/setup-owner-password',
        {
          method: 'POST',
          body: JSON.stringify({
            email: setupEmail.trim() || undefined,
            displayName: setupDisplayName.trim() || undefined,
            password: setupPassword,
          }),
        }
      );
      setAuthToken(res.token);
      setSetupPassword('');
      setSetupConfirmPassword('');
      setBootstrapStatus((prev) =>
        prev ? { ...prev, ownerPasswordConfigured: true } : { ownerPasswordConfigured: true, passcodeEnvConfigured: false, googleAuthEnabled: true }
      );
      await handleAuthenticatedUser(res.user);
    } catch (err: any) {
      setAuthError(err?.message || 'تعذر إعداد كلمة مرور المالك.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const cred = await signInWithPopup(auth, googleAuthProvider);
      const idToken = await cred.user.getIdToken();
      setAuthToken(idToken);
      const me = await apiFetch<{ user: SessionUser }>('/api/auth/me');
      await handleAuthenticatedUser(me.user);
    } catch (err: any) {
      setAuthToken(null);
      setAuthError(err?.message || 'تعذر إتمام تسجيل الدخول عبر Google.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
    } catch {
      // ignore
    }
    try {
      await signOut(auth);
    } catch {
      // ignore if signed in via local session
    }
    setAuthToken(null);
    setUser(null);
    setOverview(null);
    setProviders([]);
    setProducts([]);
    setOrders([]);
    setDeposits([]);
    setCustomers([]);
    setLedger([]);
    setAuditLogs([]);
    setNotifications([]);
    setForceLoginForm(false);
    void loadBootstrapStatus();
  };

  const handleOwnPasswordUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (ownNewPassword !== ownConfirmPassword) {
      setOwnPwFeedback({ type: 'err', text: 'كلمة المرور الجديدة وتأكيدها غير متطابقتين.' });
      return;
    }
    setOwnPwBusy(true);
    setOwnPwFeedback(null);
    try {
      const res = await apiFetch<{ ok: boolean; token: string; user: SessionUser }>(
        '/api/auth/change-password',
        {
          method: 'POST',
          body: JSON.stringify({
            currentPassword: ownCurrentPassword,
            newPassword: ownNewPassword,
            revokeOtherSessions: ownRevokeOthers,
          }),
        }
      );
      if (res.token) setAuthToken(res.token);
      if (res.user) setUser(res.user);
      setOwnCurrentPassword('');
      setOwnNewPassword('');
      setOwnConfirmPassword('');
      setOwnPwFeedback({ type: 'ok', text: 'تم تحديث كلمة المرور بنجاح.' });
    } catch (err: any) {
      setOwnPwFeedback({ type: 'err', text: err?.message || 'تعذر تحديث كلمة المرور.' });
    } finally {
      setOwnPwBusy(false);
    }
  };

  // Compute permission-filtered navigation groups for signed-in staff
  const navGroups: Array<{
    groupLabel: string;
    items: Array<{
      id: ActiveSection;
      label: string;
      icon: React.ComponentType<{ className?: string }>;
      count?: number;
    }>;
  }> = user && user.role !== 'customer'
    ? [
        {
          groupLabel: t.navGroups.overview,
          items: hasStaffPermission(user, 'overview:view')
            ? [{ id: 'overview' as const, label: t.navItems.overview, icon: LayoutDashboard }]
            : [],
        },
        {
          groupLabel: t.navGroups.catalog,
          items: [
            ...(hasAnyStaffPermission(user, ['products:manage', 'pricing:manage'])
              ? [
                  {
                    id: 'products' as const,
                    label: t.navItems.products,
                    icon: ShoppingBag,
                    count: products.length,
                  },
                ]
              : []),
            ...(hasStaffPermission(user, 'providers:manage')
              ? [
                  {
                    id: 'providers' as const,
                    label: t.navItems.providers,
                    icon: Server,
                    count: providers.length,
                  },
                ]
              : []),
            ...(hasStaffPermission(user, 'telegram:manage')
              ? [
                  { id: 'telegram' as const, label: t.navItems.telegram, icon: MessageSquareText },
                  { id: 'buttons' as const, label: t.navItems.buttons, icon: LayoutGrid },
                ]
              : []),
          ],
        },
        {
          groupLabel: t.navGroups.finance,
          items: [
            ...(hasAnyStaffPermission(user, [
              'orders:manage',
              'deposits:approve',
              'customers:manage',
              'pricing:manage',
            ])
              ? [{ id: 'operations' as const, label: t.navItems.operations, icon: ReceiptText }]
              : []),
            ...(hasAnyStaffPermission(user, [
              'deposits:approve',
              'settings:manage',
              'customers:manage',
            ])
              ? [{ id: 'local_finance' as const, label: t.navItems.localFinance, icon: Landmark }]
              : []),
            ...(hasStaffPermission(user, 'referrals:manage')
              ? [{ id: 'referrals' as const, label: t.navItems.referrals, icon: Gift }]
              : []),
          ],
        },
        {
          groupLabel: t.navGroups.system,
          items: [
            ...(user.role === 'owner'
              ? [{ id: 'moderators' as const, label: t.navItems.moderators, icon: Users }]
              : []),
            ...(hasAnyStaffPermission(user, ['settings:manage', 'deposits:approve', 'audit:view'])
              ? [{ id: 'settings' as const, label: t.navItems.settings, icon: Settings }]
              : []),
          ],
        },
      ].filter((g) => g.items.length > 0)
    : [];

  const allNavItems = navGroups.flatMap((g) => g.items);

  useEffect(() => {
    if (!user || user.role === 'customer' || allNavItems.length === 0) return;
    if (!allNavItems.some((item) => item.id === section)) {
      setSection(allNavItems[0].id);
    }
  }, [user, section, allNavItems]);

  // ============================================================================
  // 1. EXECUTIVE AUTHENTICATION GATE (Split SaaS Layout — Strictly Protected)
  // ============================================================================
  if (!user) {
    const DirArrow = isEn ? ArrowRight : ArrowLeft;
    const isInitialSetup =
      bootstrapStatus !== null && !bootstrapStatus.ownerPasswordConfigured && !forceLoginForm;

    return (
      <div className="min-h-screen bg-[#f5f7fb] flex flex-col">
        {/* Top Minimal Utility Bar */}
        <header className="w-full px-5 sm:px-8 py-4 flex items-center justify-between max-w-6xl mx-auto">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white font-display font-bold text-base">
              {brandMonogram}
            </div>
            <div className="min-w-0">
              <div className="font-display font-bold text-sm text-slate-900 leading-tight">
                {brandName}
              </div>
              <div className="text-[11px] text-slate-500">{t.adminPortalBadge}</div>
            </div>
          </div>

          <button
            type="button"
            onClick={toggleWebLang}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200/90 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors whitespace-nowrap shrink-0"
          >
            <Globe className="h-3.5 w-3.5 text-emerald-700" />
            <span>{isEn ? 'العربية' : 'English'}</span>
          </button>
        </header>

        {/* Main Split Portal */}
        <main className="flex-1 flex items-center justify-center px-4 sm:px-6 pb-10 pt-2">
          <div className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 rounded-3xl border border-slate-200/90 bg-white shadow-[0_20px_50px_-24px_rgba(15,23,42,0.14)] overflow-hidden">
            {/* Brand & Architecture Showcase Panel */}
            <div className="lg:col-span-7 bg-[#0c1322] text-white p-7 sm:p-10 flex flex-col justify-between gap-8">
              <div className="space-y-4">
                <div className="text-xs font-semibold tracking-wide text-emerald-400">
                  {t.brandSubtitle}
                </div>
                <h1 className="text-2xl sm:text-3xl font-bold leading-snug text-white">
                  {t.authTitle}
                </h1>
                <p className="text-sm leading-relaxed text-slate-300 max-w-xl">{t.authDesc}</p>
              </div>

              <div className="space-y-4 border-t border-slate-800/90 pt-6">
                <div className="flex items-start gap-3.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
                    <Layers className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white">{t.authFeature1Title}</div>
                    <p className="mt-0.5 text-xs text-slate-400 leading-relaxed">
                      {t.authFeature1Desc}
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-500/15 text-sky-400">
                    <ShieldCheck className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white">{t.authFeature2Title}</div>
                    <p className="mt-0.5 text-xs text-slate-400 leading-relaxed">
                      {t.authFeature2Desc}
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-300">
                    <Wallet className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white">{t.authFeature3Title}</div>
                    <p className="mt-0.5 text-xs text-slate-400 leading-relaxed">
                      {t.authFeature3Desc}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Sign-In / First-Run Claim Card Panel */}
            <div className="lg:col-span-5 p-7 sm:p-10 flex flex-col justify-center bg-white">
              <div className="space-y-5">
                <div>
                  <div className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700 mb-2">
                    <Lock className="h-3 w-3 text-emerald-700" />
                    <span>{t.adminPortalBadge}</span>
                  </div>
                  <h2 className="text-xl font-bold text-slate-900">
                    {isInitialSetup ? t.authCardHeadingSetup : t.authCardHeading}
                  </h2>
                  <p className="mt-1 text-xs text-slate-500">
                    {isInitialSetup ? t.authCardSubheadingSetup : t.authCardSubheading}
                  </p>
                </div>

                {authError && (
                  <FeedbackBanner
                    type="err"
                    text={authError}
                    onDismiss={() => setAuthError(null)}
                  />
                )}

                {isInitialSetup ? (
                  <form onSubmit={handleSetupOwnerPassword} className="space-y-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        {t.ownerEmailLabel}
                      </label>
                      <input
                        type="email"
                        dir="ltr"
                        value={setupEmail}
                        onChange={(e) => setSetupEmail(e.target.value)}
                        placeholder="owner@raqm.store"
                        className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-600 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        {t.ownerNameLabel}
                      </label>
                      <input
                        type="text"
                        value={setupDisplayName}
                        onChange={(e) => setSetupDisplayName(e.target.value)}
                        placeholder="مالك المتجر"
                        className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-600 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        {t.passwordLabel} (8+)
                      </label>
                      <input
                        type="password"
                        required
                        minLength={8}
                        dir="ltr"
                        value={setupPassword}
                        onChange={(e) => setSetupPassword(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-600 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        {t.confirmPasswordLabel}
                      </label>
                      <input
                        type="password"
                        required
                        minLength={8}
                        dir="ltr"
                        value={setupConfirmPassword}
                        onChange={(e) => setSetupConfirmPassword(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-600 focus:outline-none"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={authLoading}
                      className="w-full inline-flex items-center justify-between gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50 transition-colors"
                    >
                      <span>{authLoading ? t.signingIn : t.setupOwnerSubmit}</span>
                      <DirArrow className="h-4 w-4 text-emerald-400 shrink-0" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setForceLoginForm(true)}
                      className="w-full text-center text-[11px] font-semibold text-slate-500 hover:text-slate-800 pt-1"
                    >
                      {t.switchToLogin}
                    </button>
                  </form>
                ) : (
                  <form onSubmit={handlePasswordLogin} className="space-y-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        {t.loginIdentifierLabel}
                      </label>
                      <input
                        type="text"
                        required
                        dir="ltr"
                        value={loginIdentifier}
                        onChange={(e) => setLoginIdentifier(e.target.value)}
                        placeholder="owner@raqm.store"
                        className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-600 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        {t.passwordLabel}
                      </label>
                      <input
                        type="password"
                        required
                        dir="ltr"
                        value={loginPassword}
                        onChange={(e) => setLoginPassword(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-600 focus:outline-none"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={authLoading}
                      className="w-full inline-flex items-center justify-between gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50 transition-colors"
                    >
                      <span>{authLoading ? t.signingIn : t.loginSubmit}</span>
                      <DirArrow className="h-4 w-4 text-emerald-400 shrink-0" />
                    </button>
                    {bootstrapStatus !== null && !bootstrapStatus.ownerPasswordConfigured && (
                      <button
                        type="button"
                        onClick={() => setForceLoginForm(false)}
                        className="w-full text-center text-[11px] font-semibold text-emerald-700 hover:underline pt-1"
                      >
                        {t.switchToSetup}
                      </button>
                    )}
                  </form>
                )}

                <div className="relative py-1 text-center">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-slate-100" />
                  </div>
                  <span className="relative bg-white px-3 text-[11px] font-medium text-slate-400">
                    {t.orContinueWith}
                  </span>
                </div>

                <button
                  type="button"
                  disabled={authLoading}
                  onClick={() => void handleGoogleLogin()}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-300 disabled:opacity-50 transition-colors"
                >
                  <span>{t.loginGoogle}</span>
                </button>

                <p className="text-[11px] leading-relaxed text-slate-400 text-center pt-1">
                  {t.publicStoreNotice}
                </p>
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // ============================================================================
  // 2. ISOLATED CUSTOMER STOREFRONT VIEW
  // ============================================================================
  if (user.role === 'customer') {
    return (
      <CustomerStorefront
        storeProfile={storeProfile}
        customerCatalog={customerCatalog}
        customerWallet={customerWallet}
        customerOrders={customerOrders}
        webLang={webLang}
        onToggleWebLang={toggleWebLang}
        onRefreshStorefront={loadCustomerStorefront}
        onLogout={handleLogout}
      />
    );
  }

  // ============================================================================
  // 3. EXECUTIVE ADMIN WORKSPACE (RBAC-Filtered)
  // ============================================================================
  const currentNavLabel = allNavItems.find((n) => n.id === section)?.label || t.adminBreadcrumbRoot;
  const userInitial = (user.displayName || 'A').trim().charAt(0).toUpperCase();
  const roleDisplay = t.roleLabels[user.role] || user.role;
  const canTelegram = hasStaffPermission(user, 'telegram:manage');

  const renderNavList = (closeMobile?: boolean) => (
    <nav
      aria-label="التنقل الرئيسي للوحة الإدارة"
      className="flex-1 overflow-y-auto px-3.5 py-4 space-y-5"
    >
      {navGroups.map((group) => (
        <div key={group.groupLabel} className="space-y-1">
          <div className="px-3 pb-1 text-[11px] font-semibold text-slate-400">
            {group.groupLabel}
          </div>
          {group.items.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setSection(item.id);
                  if (closeMobile) setMobileMenuOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-all duration-150 whitespace-nowrap ${
                  active
                    ? 'bg-slate-900 text-white shadow-[0_2px_6px_rgba(15,23,42,0.14)]'
                    : 'text-slate-600 hover:bg-slate-100/85 hover:text-slate-900'
                }`}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <Icon
                    className={`h-4 w-4 shrink-0 ${active ? 'text-emerald-400' : 'text-slate-400'}`}
                  />
                  <span className="truncate">{item.label}</span>
                </span>
                {item.count !== undefined && (
                  <span
                    className={`font-mono-num text-[11px] ${
                      active ? 'text-slate-300' : 'text-slate-400'
                    }`}
                  >
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen bg-[#f5f7fb] text-slate-900 flex overflow-x-hidden">
      {/* Desktop Logical-Start Sidebar (Works in both RTL & LTR) */}
      <aside className="hidden lg:flex lg:w-[268px] lg:flex-col lg:fixed lg:inset-y-0 lg:start-0 border-e border-slate-200/85 bg-white">
        <div className="flex h-15 items-center gap-3 border-b border-slate-100 px-5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white font-display font-bold text-sm">
            {brandMonogram}
          </div>
          <div className="min-w-0">
            <div className="font-display font-bold text-sm text-slate-900 truncate">
              {brandName}
            </div>
            <div className="text-[11px] text-slate-400 truncate">{t.storeAdminLabel}</div>
          </div>
        </div>

        {renderNavList(false)}

        <div className="border-t border-slate-100 p-3.5">
          <div className="flex items-center justify-between gap-2 rounded-xl bg-slate-50/90 border border-slate-200/70 px-3 py-2.5 text-xs">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white text-xs font-bold">
                {userInitial}
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-slate-900 truncate">{user.displayName}</div>
                <div className="text-[11px] text-slate-500">{roleDisplay}</div>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => {
                  setOwnPwFeedback(null);
                  setPasswordModalOpen(true);
                }}
                aria-label={t.changePasswordBtn}
                title={t.changePasswordBtn}
                className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors"
              >
                <KeyRound className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void handleLogout()}
                aria-label={t.logout}
                title={t.logout}
                className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile Drawer Navigation */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/45 backdrop-blur-[2px]"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative z-10 flex w-72 max-w-[85vw] flex-col bg-white h-full border-e border-slate-200 shadow-2xl">
            <div className="flex h-15 items-center justify-between border-b border-slate-100 px-4">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white font-display font-bold text-xs">
                  {brandMonogram}
                </div>
                <span className="font-display font-bold text-sm text-slate-900 truncate">
                  {brandName}
                </span>
              </div>
              <button
                type="button"
                aria-label="إغلاق القائمة"
                onClick={() => setMobileMenuOpen(false)}
                className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {renderNavList(true)}
            <div className="border-t border-slate-100 p-4 space-y-2">
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  setOwnPwFeedback(null);
                  setPasswordModalOpen(true);
                }}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                <KeyRound className="h-3.5 w-3.5" />
                {t.changePasswordBtn}
              </button>
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                <LogOut className="h-3.5 w-3.5" />
                {t.logout}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 lg:ps-[268px] min-w-0 w-full flex flex-col">
        <header className="sticky top-0 z-20 flex h-15 items-center justify-between gap-3 border-b border-slate-200/80 bg-white/90 backdrop-blur-sm px-4 lg:px-8">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              aria-label="فتح قائمة التنقل"
              onClick={() => setMobileMenuOpen(true)}
              className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden shrink-0"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-1.5 text-xs sm:text-sm min-w-0">
              <span className="text-slate-400 whitespace-nowrap hidden sm:inline">
                {t.adminBreadcrumbRoot}
              </span>
              <span className="text-slate-300 hidden sm:inline">/</span>
              <span className="font-semibold text-slate-900 truncate">{currentNavLabel}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={toggleWebLang}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors whitespace-nowrap shrink-0"
            >
              <Globe className="h-3.5 w-3.5 text-emerald-700" />
              <span>{isEn ? 'عربي' : 'EN'}</span>
            </button>

            {canTelegram && (
              <button
                type="button"
                onClick={() => setSection('telegram')}
                className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 transition-colors whitespace-nowrap shrink-0"
              >
                <MessageSquareText className="h-3.5 w-3.5" />
                <span>{t.telegramBotBtn}</span>
              </button>
            )}
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:py-7 lg:px-8 max-w-7xl w-full mx-auto min-w-0">
          {dataError && (
            <div className="mb-5">
              <FeedbackBanner type="err" text={dataError} onDismiss={() => setDataError(null)} />
            </div>
          )}

          {section === 'overview' && hasStaffPermission(user, 'overview:view') && (
            <OverviewDashboardView
              storeProfile={storeProfile}
              overview={overview}
              orders={orders}
              deposits={deposits}
              providers={providers}
              products={products}
              customers={customers}
              loadingData={loadingData}
              webLang={webLang}
              onNavigate={setSection}
            />
          )}

          {section === 'buttons' && hasStaffPermission(user, 'telegram:manage') && (
            <ButtonsManagerView
              buttons={botButtons}
              categories={categories as any}
              guides={guides}
              products={products}
              onRefresh={() => loadAdminWorkspace(user)}
            />
          )}

          {section === 'telegram' && hasStaffPermission(user, 'telegram:manage') && (
            <TelegramBotConsole
              key={`tg-${telegramPreview.mode}-${telegramPreview.lang || 'ar'}-${telegramPreview.nonce}`}
              storeName={brandName}
              initialMode={telegramPreview.mode}
              initialCustomerLang={telegramPreview.lang}
              onDataMutated={() => void loadAdminWorkspace(user)}
            />
          )}

          {section === 'providers' && hasStaffPermission(user, 'providers:manage') && (
            <ProvidersView
              providers={providers}
              availableProviderProducts={availableProviderProducts}
              categories={categories}
              onRefresh={() => loadAdminWorkspace(user)}
            />
          )}

          {section === 'products' &&
            hasAnyStaffPermission(user, ['products:manage', 'pricing:manage']) && (
              <ProductsPricingView
                products={products}
                availableProviderProducts={availableProviderProducts}
                categories={categories}
                providers={providers.map((p) => ({ id: p.id, name: p.name }))}
                onRefresh={() => loadAdminWorkspace(user)}
              />
            )}

          {section === 'operations' &&
            hasAnyStaffPermission(user, [
              'orders:manage',
              'deposits:approve',
              'customers:manage',
              'pricing:manage',
            ]) && (
              <OperationsView
                orders={orders}
                deposits={deposits}
                customers={customers}
                ledger={ledger}
                coupons={coupons}
                onRefresh={() => loadAdminWorkspace(user)}
              />
            )}

          {section === 'local_finance' &&
            hasAnyStaffPermission(user, [
              'deposits:approve',
              'settings:manage',
              'customers:manage',
            ]) && <LocalDepositsCurrencyView onRefreshWorkspace={() => loadAdminWorkspace(user)} />}

          {section === 'referrals' && hasStaffPermission(user, 'referrals:manage') && (
            <ReferralManagementView onRefreshWorkspace={() => loadAdminWorkspace(user)} />
          )}

          {section === 'moderators' && user.role === 'owner' && <ModeratorsAccessView />}

          {section === 'settings' &&
            hasAnyStaffPermission(user, ['settings:manage', 'deposits:approve', 'audit:view']) && (
              <SettingsSecurityView
                storeProfile={storeProfile}
                notificationPrefs={notificationPrefs}
                notifications={notifications}
                auditLogs={auditLogs}
                binanceData={binanceData}
                paymentMethods={paymentMethods}
                canManageSettings={hasStaffPermission(user, 'settings:manage')}
                canManagePayments={hasAnyStaffPermission(user, ['deposits:approve', 'settings:manage'])}
                canViewAudit={hasStaffPermission(user, 'audit:view')}
                isOwner={user.role === 'owner'}
                onPreviewCustomerBot={(lang) => {
                  setTelegramPreview((prev) => ({ mode: 'customer', lang, nonce: prev.nonce + 1 }));
                  setSection('telegram');
                }}
                onRefresh={() => loadAdminWorkspace(user)}
                onUserUpdated={(updated) => setUser(updated)}
              />
            )}
        </main>
      </div>

      {/* Staff Self-Service Password Rotation Modal */}
      {passwordModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-emerald-700" />
                <h3 className="text-sm font-bold text-slate-900">{t.changePasswordBtn}</h3>
              </div>
              <button
                type="button"
                onClick={() => setPasswordModalOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleOwnPasswordUpdate} className="p-5 space-y-4">
              {ownPwFeedback && (
                <FeedbackBanner
                  type={ownPwFeedback.type}
                  text={ownPwFeedback.text}
                  onDismiss={() => setOwnPwFeedback(null)}
                />
              )}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  كلمة المرور الحالية
                </label>
                <input
                  type="password"
                  dir="ltr"
                  value={ownCurrentPassword}
                  onChange={(e) => setOwnCurrentPassword(e.target.value)}
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
                  value={ownNewPassword}
                  onChange={(e) => setOwnNewPassword(e.target.value)}
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
                  value={ownConfirmPassword}
                  onChange={(e) => setOwnConfirmPassword(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                />
              </div>
              <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ownRevokeOthers}
                  onChange={(e) => setOwnRevokeOthers(e.target.checked)}
                  className="h-4 w-4 accent-emerald-700"
                />
                إنهاء جميع الجلسات الأخرى المفتوحة
              </label>
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setPasswordModalOpen(false)}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  إغلاق
                </button>
                <button
                  type="submit"
                  disabled={ownPwBusy}
                  className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  حفظ كلمة المرور
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
