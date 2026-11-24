import React, { useEffect, useMemo, useState } from 'react';
import {
  KeyRound,
  RefreshCw,
  Play,
  EyeOff,
  Eye,
  Plus,
  Power,
  ExternalLink,
  Trash2,
  PackageSearch,
  Server,
  Search,
  AlertTriangle,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { classifyOfferBrand, groupOffersByBrand } from '../lib/offerClassifier';
import {
  extractServerHostLabel,
  filterServersForGrid,
  getServerAppIconStyle,
  type ServerGridStatusFilter,
} from '../lib/serverGridUtils';
import {
  FeedbackBanner,
  KpiCard,
  PageHeader,
  SegmentedTabs,
  SemanticStatus,
  SurfacePanel,
} from './ui/AdminPrimitives';
import type { AvailableProviderProduct, CategoryItem } from './ProductsPricingView';

export interface ProviderItem {
  id: number;
  code: string;
  name: string;
  baseUrl: string;
  docsUrl: string;
  authType: string;
  authHeader: string;
  rateLimitPerMin: number;
  supportsIdempotency: boolean;
  supportsWebhooks: boolean;
  supportsQuote: boolean;
  status: string;
  isEnabled: boolean;
  cachedBalance: string;
  lowBalanceThreshold: string;
  priority: number;
  lastSyncAt: string | null;
  lastError: string | null;
  hasApiKey: boolean;
  keyFingerprint: string | null;
  productsCount: number;
  publishedCount: number;
  hiddenCount: number;
  ordersCount: number;
}

interface ProvidersViewProps {
  providers: ProviderItem[];
  availableProviderProducts: AvailableProviderProduct[];
  categories: CategoryItem[];
  onRefresh: () => Promise<void>;
}

const AUTH_PRESETS = [
  { id: 'x_api_key', label: 'X-API-Key (AIVault, Warzone, Sajid, Renqis)', authType: 'x_api_key', authHeader: 'X-API-Key' },
  { id: 'bearer', label: 'Authorization: Bearer (Pandora, QORIX, Pixora)', authType: 'bearer', authHeader: 'Authorization' },
  { id: 'api_key', label: 'Api-Key (DigitalCore)', authType: 'api_key', authHeader: 'Api-Key' },
  { id: 'x_buyer_key', label: 'x-buyer-key (Canboso)', authType: 'x_api_key', authHeader: 'x-buyer-key' },
  { id: 'partner_pair', label: 'X-User-Id + X-Api-Key (LukuAI)', authType: 'partner_pair', authHeader: 'X-Api-Key' },
] as const;

export default function ProvidersView({
  providers,
  availableProviderProducts,
  categories,
  onRefresh,
}: ProvidersViewProps) {
  const [activeTab, setActiveTab] = useState<'servers' | 'offers'>('servers');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [togglingProductId, setTogglingProductId] = useState<number | null>(null);
  const [updatingOfferCatId, setUpdatingOfferCatId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [keyModalProv, setKeyModalProv] = useState<ProviderItem | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [webhookSecretInput, setWebhookSecretInput] = useState('');

  const [deleteTarget, setDeleteTarget] = useState<ProviderItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [showAddModal, setShowAddModal] = useState(false);
  const [newProv, setNewProv] = useState({
    code: '',
    name: '',
    baseUrl: '',
    docsUrl: '',
    authPreset: 'x_api_key',
    authHeader: 'X-API-Key',
    authType: 'x_api_key',
    apiKey: '',
  });

  const [selectedServerId, setSelectedServerId] = useState<number | null>(null);
  const [selectedBrandKey, setSelectedBrandKey] = useState<string>('all');
  const [offerSearch, setOfferSearch] = useState('');

  // Compact App-Icon Grid controls (purely UI presentation & filtering)
  const [serverSearch, setServerSearch] = useState('');
  const [serverStatusFilter, setServerStatusFilter] = useState<ServerGridStatusFilter>('all');
  const [inspectServerId, setInspectServerId] = useState<number | null>(null);

  useEffect(() => {
    if (providers.length === 0) {
      setSelectedServerId(null);
      return;
    }
    if (!selectedServerId || !providers.some((p) => p.id === selectedServerId)) {
      const withOffers = providers.find((p) => p.productsCount > 0) || providers[0];
      setSelectedServerId(withOffers.id);
    }
  }, [providers, selectedServerId]);

  const kpis = useMemo(() => {
    const connected = providers.filter((p) => p.isEnabled && p.status === 'connected').length;
    const disconnected = providers.length - connected;
    const withOffers = providers.filter((p) => p.productsCount > 0).length;
    const errors = providers.filter((p) => p.status === 'error').length;
    const totalBalance = providers.reduce((s, p) => s + Number(p.cachedBalance || 0), 0);
    return {
      connected,
      disconnected,
      withOffers,
      errors,
      totalBalance: totalBalance.toFixed(2),
      totalOffers: availableProviderProducts.length,
    };
  }, [providers, availableProviderProducts]);

  const filteredServers = useMemo(
    () =>
      filterServersForGrid(providers, {
        search: serverSearch,
        statusFilter: serverStatusFilter,
      }),
    [providers, serverSearch, serverStatusFilter]
  );

  const inspectedServer = useMemo(
    () => providers.find((p) => p.id === inspectServerId) || null,
    [providers, inspectServerId]
  );

  const selectedServer = useMemo(
    () => providers.find((p) => p.id === selectedServerId) || null,
    [providers, selectedServerId]
  );

  const serverOffers = useMemo(() => {
    if (!selectedServerId) return [];
    return availableProviderProducts.filter((o) => o.providerId === selectedServerId);
  }, [availableProviderProducts, selectedServerId]);

  const brandBuckets = useMemo(() => groupOffersByBrand(serverOffers), [serverOffers]);

  const filteredServerOffers = useMemo(() => {
    return serverOffers.filter((offer) => {
      if (selectedBrandKey !== 'all') {
        const brand = classifyOfferBrand(offer.rawName, offer.rawDescription || '');
        if (brand.key !== selectedBrandKey) return false;
      }
      if (offerSearch.trim()) {
        const q = offerSearch.trim().toLowerCase();
        const hay = `${offer.rawName} ${offer.rawDescription || ''} ${offer.externalProductId || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [serverOffers, selectedBrandKey, offerSearch]);

  const openOffersForServer = (p: ProviderItem) => {
    setSelectedServerId(p.id);
    setSelectedBrandKey('all');
    setOfferSearch('');
    setActiveTab('offers');
  };

  const handleTest = async (p: ProviderItem) => {
    setBusyId(p.id);
    setFeedback(null);
    try {
      const res = await apiFetch<{ ok: boolean; messageAr: string }>(`/api/admin/providers/${p.id}/test`, {
        method: 'POST',
      });
      setFeedback({ type: res.ok ? 'ok' : 'err', text: res.messageAr });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'فشل اختبار الاتصال.' });
    } finally {
      setBusyId(null);
    }
  };

  const handleSync = async (p: ProviderItem) => {
    setBusyId(p.id);
    setFeedback(null);
    try {
      const res = await apiFetch<{ messageAr: string }>(`/api/admin/providers/${p.id}/sync`, {
        method: 'POST',
      });
      setFeedback({ type: 'ok', text: res.messageAr });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'فشلت مزامنة المنتجات.' });
    } finally {
      setBusyId(null);
    }
  };

  const handleHideAll = async (p: ProviderItem) => {
    setBusyId(p.id);
    setFeedback(null);
    try {
      const res = await apiFetch<{ hiddenCount: number }>(`/api/admin/providers/${p.id}/hide-all`, {
        method: 'POST',
      });
      setFeedback({ type: 'ok', text: `تم إخفاء ${res.hiddenCount} منتج تابع للخادم ${p.name}.` });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر إخفاء المنتجات.' });
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleEnabled = async (p: ProviderItem) => {
    setBusyId(p.id);
    try {
      await apiFetch(`/api/admin/providers/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isEnabled: !p.isEnabled }),
      });
      setFeedback({
        type: 'ok',
        text: !p.isEnabled ? `تم تفعيل الخادم ${p.name}.` : `تم تعطيل الخادم ${p.name}.`,
      });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تحديث حالة الخادم.' });
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setFeedback(null);
    try {
      await apiFetch(`/api/admin/providers/${deleteTarget.id}`, { method: 'DELETE' });
      setFeedback({ type: 'ok', text: `تم حذف الخادم "${deleteTarget.name}" بنجاح.` });
      if (selectedServerId === deleteTarget.id) setSelectedServerId(null);
      setDeleteTarget(null);
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر حذف الخادم.' });
    } finally {
      setDeleting(false);
    }
  };

  const handleSaveKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyModalProv || !apiKeyInput.trim()) return;
    setBusyId(keyModalProv.id);
    try {
      const res = await apiFetch<{ keyFingerprint: string }>(
        `/api/admin/providers/${keyModalProv.id}/credentials`,
        {
          method: 'POST',
          body: JSON.stringify({
            apiKey: apiKeyInput.trim(),
            webhookSecret: webhookSecretInput.trim() || undefined,
          }),
        }
      );
      setFeedback({
        type: 'ok',
        text: `تم حفظ مفتاح API للخادم ${keyModalProv.name} (${res.keyFingerprint}).`,
      });
      setKeyModalProv(null);
      setApiKeyInput('');
      setWebhookSecretInput('');
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر حفظ المفتاح.' });
    } finally {
      setBusyId(null);
    }
  };

  const handlePresetChange = (presetId: string) => {
    const found = AUTH_PRESETS.find((p) => p.id === presetId);
    if (!found) return;
    setNewProv((prev) => ({
      ...prev,
      authPreset: presetId,
      authType: found.authType,
      authHeader: found.authHeader,
    }));
  };

  const handleAddProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    try {
      const res = await apiFetch<{ provider: { name: string; hasApiKey?: boolean } }>('/api/admin/providers', {
        method: 'POST',
        body: JSON.stringify({
          code: newProv.code,
          name: newProv.name,
          baseUrl: newProv.baseUrl,
          docsUrl: newProv.docsUrl || newProv.baseUrl,
          authType: newProv.authType,
          authHeader: newProv.authHeader,
          apiKey: newProv.apiKey.trim() || undefined,
        }),
      });
      setShowAddModal(false);
      setNewProv({
        code: '',
        name: '',
        baseUrl: '',
        docsUrl: '',
        authPreset: 'x_api_key',
        authHeader: 'X-API-Key',
        authType: 'x_api_key',
        apiKey: '',
      });
      setFeedback({
        type: 'ok',
        text: `تمت إضافة الخادم "${res.provider?.name || ''}" بنجاح.`,
      });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر إضافة الخادم.' });
    }
  };

  const handleQuickToggleOfferVisibility = async (offer: AvailableProviderProduct) => {
    if (!offer.linkedStoreProductId) return;
    setTogglingProductId(offer.linkedStoreProductId);
    setFeedback(null);
    try {
      const nextVis = !offer.linkedIsVisible;
      const res = await apiFetch<{ ok: boolean; autoAssignedCategory?: string | null }>(
        `/api/admin/products/${offer.linkedStoreProductId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ isVisible: nextVis }),
        }
      );
      setFeedback({
        type: 'ok',
        text: nextVis
          ? res.autoAssignedCategory
            ? `تم نشر "${offer.rawName}" في قسم "${res.autoAssignedCategory}".`
            : `تم نشر "${offer.rawName}" في المتجر.`
          : `تم إخفاء "${offer.rawName}".`,
      });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تحديث حالة العرض.' });
    } finally {
      setTogglingProductId(null);
    }
  };

  const handleQuickChangeOfferCategory = async (offer: AvailableProviderProduct, nextCategoryIdStr: string) => {
    if (!offer.linkedStoreProductId) return;
    setUpdatingOfferCatId(offer.linkedStoreProductId);
    setFeedback(null);
    try {
      const nextCategoryId = nextCategoryIdStr ? Number(nextCategoryIdStr) : null;
      await apiFetch(`/api/admin/products/${offer.linkedStoreProductId}`, {
        method: 'PATCH',
        body: JSON.stringify({ categoryId: nextCategoryId }),
      });
      const catLabel = nextCategoryId
        ? categories.find((c) => c.id === nextCategoryId)?.nameAr || 'القسم المحدد'
        : 'غير مصنف';
      setFeedback({ type: 'ok', text: `تم نقل "${offer.rawName}" إلى "${catLabel}".` });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تغيير قسم العرض.' });
    } finally {
      setUpdatingOfferCatId(null);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="الخوادم ومزودو API"
        subtitle="إدارة مفاتيح الاتصال، المزامنة، وتصفح عروض كل خادم"
        actions={
          <div className="flex flex-wrap items-center gap-2.5">
            <SegmentedTabs
              value={activeTab}
              onChange={setActiveTab}
              items={[
                { id: 'servers', label: 'الخوادم', count: providers.length, icon: Server },
                { id: 'offers', label: 'تصفح العروض', count: availableProviderProducts.length, icon: PackageSearch },
              ]}
            />
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              إضافة خادم
            </button>
          </div>
        }
      />

      {feedback && (
        <FeedbackBanner type={feedback.type} text={feedback.text} onDismiss={() => setFeedback(null)} />
      )}

      {/* Meaning-Aware Providers KPI Strip */}
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <KpiCard
          label="الخوادم المتصلة"
          value={`${kpis.connected}/${providers.length}`}
          valueTone={kpis.connected > 0 ? 'positive' : 'negative'}
          tone={kpis.connected > 0 ? 'positive' : 'negative'}
          direction={kpis.connected > 0 ? 'up' : 'down'}
          indicatorText={kpis.connected > 0 ? 'تعمل الآن' : 'غير متصل'}
        />
        <KpiCard
          label="أخطاء الاتصال"
          value={kpis.errors}
          valueTone={kpis.errors > 0 ? 'negative' : 'positive'}
          tone={kpis.errors > 0 ? 'negative' : 'positive'}
          direction={kpis.errors > 0 ? 'up' : 'flat'}
          indicatorText={kpis.errors > 0 ? 'يتطلب مراجعة' : 'سليم'}
        />
        <KpiCard
          label="إجمالي الأرصدة"
          value={`$${kpis.totalBalance}`}
          tone="neutral"
          indicatorText="USDT"
        />
        <KpiCard
          label="العروض المتاحة"
          value={kpis.totalOffers}
          tone="neutral"
          indicatorText="عرض"
        />
      </div>

      {/* TAB 1: COMPACT APP-ICON SQUARE SERVERS GRID */}
      {activeTab === 'servers' && (
        <div className="space-y-3">
          {/* Compact Search & Filter Bar */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1">
              {(
                [
                  { id: 'all', label: 'الكل', count: providers.length },
                  { id: 'connected', label: 'متصل', count: kpis.connected },
                  { id: 'disconnected', label: 'غير متصل', count: kpis.disconnected },
                  { id: 'has_offers', label: 'بها عروض', count: kpis.withOffers },
                ] as const
              ).map((tab) => {
                const active = serverStatusFilter === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setServerStatusFilter(tab.id)}
                    className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                      active
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <span>{tab.label}</span>
                    <span className="font-mono-num text-[11px] text-slate-400">({tab.count})</span>
                  </button>
                );
              })}
            </div>

            <div className="relative w-full sm:w-64 shrink-0">
              <Search className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={serverSearch}
                onChange={(e) => setServerSearch(e.target.value)}
                placeholder="بحث سريع عن خادم أو رابط..."
                className="w-full rounded-lg border border-slate-200 bg-white pr-8 pl-3 py-1.5 text-xs text-slate-900 focus:border-slate-900 focus:outline-none"
              />
            </div>
          </div>

          {/* Responsive Square App-Tile Grid (2 cols mobile -> 3 sm -> 4 md -> 5 xl -> 6 2xl) */}
          {filteredServers.length === 0 ? (
            <SurfacePanel padded className="py-10 text-center space-y-2">
              <div className="text-sm font-semibold text-slate-700">لا توجد خوادم مطابقة للبحث الحالي</div>
              <button
                type="button"
                onClick={() => {
                  setServerSearch('');
                  setServerStatusFilter('all');
                }}
                className="inline-flex items-center rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                عرض جميع الخوادم ({providers.length})
              </button>
            </SurfacePanel>
          ) : (
            <div
              data-testid="servers-app-grid"
              className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 sm:gap-3"
            >
              {filteredServers.map((p) => {
                const isBusy = busyId === p.id;
                const isConnected = p.isEnabled && p.status === 'connected';
                const iconVisual = getServerAppIconStyle(p.code, p.name);
                const hostLabel = extractServerHostLabel(p.baseUrl);
                const statusTextClass = isConnected
                  ? 'text-emerald-700'
                  : p.status === 'error'
                    ? 'text-rose-600'
                    : !p.isEnabled
                      ? 'text-amber-700'
                      : 'text-slate-500';
                const statusLabel = isConnected
                  ? 'متصل'
                  : !p.isEnabled
                    ? 'معطّل'
                    : p.status === 'error'
                      ? 'خطأ'
                      : 'غير متصل';

                return (
                  <div
                    key={p.id}
                    data-testid={`server-tile-${p.code}`}
                    className={`group rounded-xl border bg-white p-2.5 sm:p-3 flex flex-col justify-between gap-2.5 min-w-0 transition-all hover:border-slate-300 hover:shadow-xs ${
                      isConnected
                        ? 'border-emerald-200/80'
                        : p.status === 'error'
                          ? 'border-rose-200/80'
                          : 'border-slate-200/80'
                    } ${!p.isEnabled ? 'opacity-75' : ''}`}
                  >
                    {/* Top: App Icon + Live Status + Docs Link */}
                    <div className="flex items-start justify-between gap-1.5 min-w-0">
                      <button
                        type="button"
                        onClick={() => setInspectServerId(p.id)}
                        title={`عرض تفاصيل ${p.name}`}
                        aria-label={`فتح تفاصيل الخادم ${p.name}`}
                        className={`relative h-10 w-10 sm:h-11 sm:w-11 rounded-xl border flex items-center justify-center font-mono-num text-xs sm:text-sm font-bold tracking-tight shrink-0 transition-transform group-hover:scale-[1.03] ${iconVisual.bgClass} ${iconVisual.textClass} ${iconVisual.borderClass}`}
                      >
                        {iconVisual.monogram}
                        {isConnected && (
                          <span
                            aria-hidden="true"
                            className="absolute -bottom-0.5 -left-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-white"
                          />
                        )}
                      </button>

                      <div className="flex flex-col items-end gap-1 min-w-0">
                        <span className={`text-[11px] font-bold leading-none whitespace-nowrap ${statusTextClass}`}>
                          {statusLabel}
                        </span>
                        <a
                          href={p.docsUrl}
                          target="_blank"
                          rel="noreferrer"
                          title={`توثيق ${p.name}`}
                          aria-label={`توثيق ${p.name}`}
                          className="inline-flex items-center gap-0.5 text-[10px] font-medium text-slate-400 hover:text-emerald-700 transition-colors whitespace-nowrap"
                        >
                          <span>توثيق</span>
                          <ExternalLink className="h-2.5 w-2.5" />
                        </a>
                      </div>
                    </div>

                    {/* Middle: Server Name + Host/Key + Compact Metrics (click opens details) */}
                    <button
                      type="button"
                      onClick={() => setInspectServerId(p.id)}
                      className="text-right space-y-1.5 min-w-0 w-full focus:outline-none"
                    >
                      <div className="min-w-0">
                        <h2
                          className="text-[13px] font-bold text-slate-900 truncate leading-snug group-hover:text-emerald-800 transition-colors"
                          title={p.name}
                        >
                          {p.name}
                        </h2>
                        <div className="mt-0.5 flex items-center gap-1 text-[10px] text-slate-400 min-w-0">
                          <span dir="ltr" className="font-mono-num truncate min-w-0" title={p.baseUrl}>
                            {hostLabel}
                          </span>
                          <span aria-hidden="true" className="shrink-0">·</span>
                          <span className={`shrink-0 ${p.hasApiKey ? 'text-emerald-700 font-medium' : 'text-slate-400'}`}>
                            {p.hasApiKey ? 'مفتاح' : 'بلا مفتاح'}
                          </span>
                        </div>
                      </div>

                      {/* Compact 3-Column Tabular Metrics */}
                      <div className="grid grid-cols-3 gap-1 border-t border-slate-100 pt-1.5 text-center">
                        <div className="min-w-0">
                          <div className="text-[9px] text-slate-400 leading-none">الرصيد</div>
                          <div className="mt-0.5 font-mono-num text-[11px] font-bold text-slate-900 truncate tabular-nums">
                            ${Number(p.cachedBalance || 0).toFixed(2)}
                          </div>
                        </div>
                        <div className="min-w-0">
                          <div className="text-[9px] text-slate-400 leading-none">العروض</div>
                          <div className="mt-0.5 font-mono-num text-[11px] font-semibold text-slate-800 tabular-nums">
                            {p.productsCount}
                          </div>
                        </div>
                        <div className="min-w-0">
                          <div className="text-[9px] text-slate-400 leading-none">الطلبات</div>
                          <div className="mt-0.5 font-mono-num text-[11px] font-semibold text-slate-800 tabular-nums">
                            {p.ordersCount}
                          </div>
                        </div>
                      </div>

                      {p.lastError && (
                        <div className="text-[10px] text-rose-600 truncate leading-tight" title={p.lastError}>
                          {p.lastError}
                        </div>
                      )}
                    </button>

                    {/* Bottom: Compact 2-Row Action Dock (ALL 7 original controls preserved!) */}
                    <div className="space-y-1.5 pt-1 border-t border-slate-100">
                      <div className="grid grid-cols-2 gap-1">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleSync(p)}
                          title={`جلب العروض من ${p.name}`}
                          aria-label={`جلب العروض من ${p.name}`}
                          className="inline-flex items-center justify-center gap-1 rounded-lg bg-emerald-700 px-2 py-1.5 text-[11px] font-semibold text-white hover:bg-emerald-800 disabled:opacity-50 transition-colors whitespace-nowrap min-w-0"
                        >
                          <RefreshCw className={`h-3 w-3 shrink-0 ${isBusy ? 'animate-spin' : ''}`} />
                          <span className="truncate">جلب</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => openOffersForServer(p)}
                          title={`تصفح عروض ${p.name}`}
                          aria-label={`تصفح عروض ${p.name}`}
                          className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap min-w-0"
                        >
                          <PackageSearch className="h-3 w-3 shrink-0 text-emerald-700" />
                          <span className="font-mono-num truncate">{p.productsCount}</span>
                        </button>
                      </div>

                      <div className="grid grid-cols-5 gap-1">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleTest(p)}
                          title="اختبار الاتصال"
                          aria-label={`اختبار ${p.name}`}
                          className="flex h-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-50 transition-colors"
                        >
                          <Play className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setKeyModalProv(p);
                            setApiKeyInput('');
                            setWebhookSecretInput('');
                          }}
                          title={p.hasApiKey ? `تحديث المفتاح (${p.keyFingerprint || ''})` : 'إضافة مفتاح API'}
                          aria-label={`مفتاح API للخادم ${p.name}`}
                          className={`flex h-7 items-center justify-center rounded-md border transition-colors ${
                            p.hasApiKey
                              ? 'border-emerald-200 bg-emerald-50/70 text-emerald-700 hover:bg-emerald-100/70'
                              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                          }`}
                        >
                          <KeyRound className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleHideAll(p)}
                          title="إخفاء جميع منتجات الخادم"
                          aria-label={`إخفاء منتجات ${p.name}`}
                          className="flex h-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:border-amber-300 hover:text-amber-700 disabled:opacity-50 transition-colors"
                        >
                          <EyeOff className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleToggleEnabled(p)}
                          title={p.isEnabled ? 'تعطيل الخادم' : 'تفعيل الخادم'}
                          aria-label={p.isEnabled ? `تعطيل ${p.name}` : `تفعيل ${p.name}`}
                          className={`flex h-7 items-center justify-center rounded-md border transition-colors disabled:opacity-50 ${
                            p.isEnabled
                              ? 'border-slate-200 bg-white text-emerald-700 hover:border-slate-300'
                              : 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                          }`}
                        >
                          <Power className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => setDeleteTarget(p)}
                          title="حذف الخادم"
                          aria-label={`حذف الخادم ${p.name}`}
                          className="flex h-7 items-center justify-center rounded-md border border-rose-200 bg-white text-rose-600 hover:bg-rose-50 disabled:opacity-50 transition-colors"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: CATEGORIZED SERVER -> BRAND -> OFFERS BROWSER */}
      {activeTab === 'offers' && (
        <div className="space-y-4">
          <SurfacePanel padded className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-slate-100 pb-3.5">
              <div className="flex flex-wrap items-center gap-1.5 max-h-28 overflow-y-auto">
                {providers.map((p) => {
                  const isSelected = p.id === selectedServerId;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setSelectedServerId(p.id);
                        setSelectedBrandKey('all');
                        setOfferSearch('');
                      }}
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                        isSelected
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span>{p.name}</span>
                      <span className={`font-mono-num text-[11px] ${isSelected ? 'text-slate-300' : 'text-slate-400'}`}>
                        ({p.productsCount})
                      </span>
                    </button>
                  );
                })}
              </div>

              {selectedServer && (
                <button
                  type="button"
                  disabled={busyId === selectedServer.id}
                  onClick={() => void handleSync(selectedServer)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50 whitespace-nowrap shrink-0 self-start"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${busyId === selectedServer.id ? 'animate-spin' : ''}`} />
                  تحديث {selectedServer.name}
                </button>
              )}
            </div>

            {selectedServer && serverOffers.length === 0 ? (
              <div className="py-10 text-center space-y-3">
                <div className="text-sm font-semibold text-slate-700">
                  لا توجد عروض مسحوبة من «{selectedServer.name}» بعد
                </div>
                <div className="flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setKeyModalProv(selectedServer);
                      setApiKeyInput('');
                      setWebhookSecretInput('');
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    إدخال المفتاح
                  </button>
                  <button
                    type="button"
                    disabled={busyId === selectedServer.id}
                    onClick={() => void handleSync(selectedServer)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${busyId === selectedServer.id ? 'animate-spin' : ''}`} />
                    جلب العروض
                  </button>
                </div>
              </div>
            ) : (
              selectedServer && (
                <div className="space-y-3.5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => setSelectedBrandKey('all')}
                        className={`rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors ${
                          selectedBrandKey === 'all'
                            ? 'border-emerald-700 bg-emerald-700 text-white'
                            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        الكل ({serverOffers.length})
                      </button>
                      {brandBuckets.map((bucket) => {
                        const active = selectedBrandKey === bucket.brand.key;
                        return (
                          <button
                            key={bucket.brand.key}
                            type="button"
                            onClick={() => setSelectedBrandKey(bucket.brand.key)}
                            className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors ${
                              active
                                ? 'border-emerald-700 bg-emerald-700 text-white'
                                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                            }`}
                          >
                            <span>{bucket.brand.labelAr}</span>
                            <span className="font-mono-num opacity-75">({bucket.count})</span>
                          </button>
                        );
                      })}
                    </div>

                    <div className="relative w-full sm:w-60 shrink-0">
                      <Search className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                      <input
                        type="text"
                        value={offerSearch}
                        onChange={(e) => setOfferSearch(e.target.value)}
                        placeholder="بحث داخل العروض..."
                        className="w-full rounded-lg border border-slate-200 bg-slate-50 pr-8 pl-3 py-1.5 text-xs focus:border-slate-900 focus:bg-white focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="overflow-x-auto border border-slate-200/80 rounded-xl">
                    <table className="w-full text-right border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                          <th className="py-2.5 px-3.5">العرض</th>
                          <th className="py-2.5 px-3.5">القسم</th>
                          <th className="py-2.5 px-3.5">الجملة</th>
                          <th className="py-2.5 px-3.5">المخزون</th>
                          <th className="py-2.5 px-3.5">الحالة</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-xs">
                        {filteredServerOffers.map((offer) => {
                          const brand = classifyOfferBrand(offer.rawName, offer.rawDescription || '');
                          return (
                            <tr key={offer.id} className="hover:bg-slate-50/70 transition-colors">
                              <td className="py-2.5 px-3.5">
                                <div className="font-semibold text-slate-900">{offer.rawName}</div>
                                <div className="mt-0.5 text-[11px] text-slate-400 flex items-center gap-1.5">
                                  <span>{brand.labelAr}</span>
                                  {offer.durationLabel && (
                                    <>
                                      <span>·</span>
                                      <span>{offer.durationLabel}</span>
                                    </>
                                  )}
                                  {offer.externalProductId && (
                                    <>
                                      <span>·</span>
                                      <span className="font-mono-num">#{offer.externalProductId}</span>
                                    </>
                                  )}
                                </div>
                              </td>
                              <td className="py-2.5 px-3.5 whitespace-nowrap">
                                {offer.linkedStoreProductId ? (
                                  <select
                                    aria-label={`قسم المتجر للعرض ${offer.rawName}`}
                                    disabled={updatingOfferCatId === offer.linkedStoreProductId}
                                    value={offer.linkedCategoryId ? String(offer.linkedCategoryId) : ''}
                                    onChange={(e) => void handleQuickChangeOfferCategory(offer, e.target.value)}
                                    className={`rounded-lg border px-2 py-1 text-[11px] font-semibold focus:outline-none ${
                                      !offer.linkedCategoryId
                                        ? 'border-amber-300 bg-amber-50 text-amber-900'
                                        : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400'
                                    }`}
                                  >
                                    <option value="">غير مصنف</option>
                                    {categories.map((c) => (
                                      <option key={c.id} value={String(c.id)}>
                                        {c.nameAr}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <span className="text-slate-400">—</span>
                                )}
                              </td>
                              <td className="py-2.5 px-3.5 font-mono-num font-bold text-slate-900 whitespace-nowrap">
                                ${offer.wholesalePrice}
                              </td>
                              <td className="py-2.5 px-3.5 font-mono-num whitespace-nowrap">
                                <span
                                  className={`font-bold ${
                                    offer.stockCount > 0 ? 'text-emerald-700' : 'text-rose-600'
                                  }`}
                                >
                                  {offer.stockCount}
                                </span>
                              </td>
                              <td className="py-2.5 px-3.5 whitespace-nowrap">
                                {offer.linkedStoreProductId ? (
                                  <button
                                    type="button"
                                    disabled={togglingProductId === offer.linkedStoreProductId}
                                    onClick={() => void handleQuickToggleOfferVisibility(offer)}
                                    className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors ${
                                      offer.linkedIsVisible
                                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                                    }`}
                                  >
                                    {offer.linkedIsVisible ? (
                                      <>
                                        <Eye className="h-3.5 w-3.5" />
                                        ظاهر
                                      </>
                                    ) : (
                                      <>
                                        <EyeOff className="h-3.5 w-3.5" />
                                        مخفي
                                      </>
                                    )}
                                  </button>
                                ) : (
                                  <span className="text-slate-400">غير منشور</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                        {filteredServerOffers.length === 0 && (
                          <tr>
                            <td colSpan={5} className="py-8 text-center text-slate-400">
                              لا توجد عروض مطابقة.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            )}
          </SurfacePanel>
        </div>
      )}

      {/* Server Quick Inspector Modal (opened when clicking a server tile icon/title) */}
      {inspectedServer && (() => {
        const p = inspectedServer;
        const isBusy = busyId === p.id;
        const iconVisual = getServerAppIconStyle(p.code, p.name);
        const statusTone =
          p.isEnabled && p.status === 'connected'
            ? 'positive'
            : p.status === 'error'
              ? 'negative'
              : 'neutral';
        const statusLabel =
          p.isEnabled && p.status === 'connected'
            ? 'متصل'
            : !p.isEnabled
              ? 'معطّل'
              : p.status === 'error'
                ? 'خطأ اتصال'
                : 'غير متصل';

        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
            onClick={() => setInspectServerId(null)}
          >
            <div
              className="w-full max-w-lg rounded-2xl bg-white border border-slate-200 p-5 space-y-4 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`h-11 w-11 rounded-xl border flex items-center justify-center font-mono-num text-sm font-bold shrink-0 ${iconVisual.bgClass} ${iconVisual.textClass} ${iconVisual.borderClass}`}
                  >
                    {iconVisual.monogram}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-bold text-slate-900 truncate">{p.name}</h3>
                      <span className="font-mono-num text-xs text-slate-400">#{p.code}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                      <span dir="ltr" className="font-mono-num">{p.authHeader}</span>
                      <span aria-hidden="true">·</span>
                      <span dir="ltr" className="font-mono-num">
                        {p.hasApiKey ? p.keyFingerprint : 'بدون مفتاح'}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <SemanticStatus tone={statusTone} label={statusLabel} />
                  <button
                    type="button"
                    aria-label="إغلاق نافذة تفاصيل الخادم"
                    onClick={() => setInspectServerId(null)}
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="space-y-1.5 rounded-xl bg-slate-50 border border-slate-200/70 p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500 shrink-0">رابط API</span>
                  <span dir="ltr" className="font-mono-num text-slate-800 truncate" title={p.baseUrl}>
                    {p.baseUrl}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500 shrink-0">التوثيق</span>
                  <a
                    href={p.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    dir="ltr"
                    className="font-mono-num text-emerald-700 hover:underline inline-flex items-center gap-1 truncate"
                  >
                    <span className="truncate">{p.docsUrl}</span>
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                </div>
              </div>

              <div className="grid grid-cols-4 gap-2 border-y border-slate-100 py-3 text-center">
                <div>
                  <div className="text-[11px] text-slate-400">الرصيد</div>
                  <div className="mt-0.5 font-mono-num text-sm font-bold text-slate-900">${p.cachedBalance}</div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-400">العروض</div>
                  <div className="mt-0.5 font-mono-num text-sm font-semibold text-slate-800">{p.productsCount}</div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-400">منشور / مخفي</div>
                  <div className="mt-0.5 font-mono-num text-sm font-semibold">
                    <span className="text-emerald-700">{p.publishedCount}</span>
                    <span className="text-slate-300 mx-1">/</span>
                    <span className="text-slate-500">{p.hiddenCount}</span>
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-400">الطلبات</div>
                  <div className="mt-0.5 font-mono-num text-sm font-semibold text-slate-800">{p.ordersCount}</div>
                </div>
              </div>

              {p.lastError && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  آخر خطأ: {p.lastError}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handleSync(p)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50 whitespace-nowrap"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${isBusy ? 'animate-spin' : ''}`} />
                    جلب العروض
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setInspectServerId(null);
                      openOffersForServer(p);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 whitespace-nowrap"
                  >
                    <PackageSearch className="h-3.5 w-3.5 text-emerald-700" />
                    العروض ({p.productsCount})
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handleTest(p)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                  >
                    <Play className="h-3 w-3" />
                    اختبار
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setInspectServerId(null);
                      setKeyModalProv(p);
                      setApiKeyInput('');
                      setWebhookSecretInput('');
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                  >
                    <KeyRound className="h-3 w-3" />
                    المفتاح
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handleHideAll(p)}
                    title="إخفاء جميع منتجات الخادم"
                    className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 hover:text-amber-700 hover:border-amber-300"
                  >
                    <EyeOff className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handleToggleEnabled(p)}
                    title={p.isEnabled ? 'تعطيل الخادم' : 'تفعيل الخادم'}
                    className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 hover:text-slate-900 hover:border-slate-300"
                  >
                    <Power className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => {
                      setInspectServerId(null);
                      setDeleteTarget(p);
                    }}
                    title="حذف الخادم"
                    className="rounded-lg border border-rose-200 bg-white p-1.5 text-rose-600 hover:bg-rose-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* API Key Vault Modal */}
      {keyModalProv && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 p-6 space-y-4 shadow-xl">
            <h3 className="text-base font-bold text-slate-900">مفتاح API — {keyModalProv.name}</h3>
            {keyModalProv.authType === 'partner_pair' && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                أدخل المفتاح بصيغة <span className="font-mono-num font-bold">USER_ID:pk_your_key</span>
              </div>
            )}
            <form onSubmit={handleSaveKey} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  مفتاح API ({keyModalProv.authHeader})
                </label>
                <input
                  type="password"
                  required
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder={keyModalProv.authType === 'partner_pair' ? '847291036:pk_xxxx' : 'أدخل مفتاح API...'}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono-num focus:border-slate-900 focus:outline-none"
                />
              </div>
              {keyModalProv.supportsWebhooks && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    سر توقيع Webhook (اختياري)
                  </label>
                  <input
                    type="password"
                    value={webhookSecretInput}
                    onChange={(e) => setWebhookSecretInput(e.target.value)}
                    placeholder="whsec_..."
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono-num focus:border-slate-900 focus:outline-none"
                  />
                </div>
              )}
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setKeyModalProv(null)}
                  className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800"
                >
                  حفظ مشفرًا
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Server Confirm Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-rose-200 p-6 space-y-4 shadow-xl">
            <div className="flex items-center gap-2.5 text-rose-700">
              <AlertTriangle className="h-5 w-5 shrink-0" />
              <h3 className="text-base font-bold">تأكيد حذف الخادم</h3>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              سيتم حذف الخادم <strong className="text-slate-900">{deleteTarget.name}</strong> ومفتاحه وعروضه المرتبطة مع الإبقاء على سجل الطلبات السابقة.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => void handleConfirmDelete()}
                className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {deleting ? 'جارٍ الحذف...' : 'حذف الخادم'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Custom Provider Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white border border-slate-200 p-6 space-y-4 max-h-[90vh] overflow-y-auto shadow-xl">
            <h3 className="text-base font-bold text-slate-900">إضافة خادم مزود API</h3>
            <form onSubmit={handleAddProvider} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">اسم الخادم</label>
                  <input
                    type="text"
                    required
                    value={newProv.name}
                    onChange={(e) => setNewProv({ ...newProv, name: e.target.value })}
                    placeholder="Warzone Shop"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">المعرّف (إنجليزي)</label>
                  <input
                    type="text"
                    required
                    value={newProv.code}
                    onChange={(e) => setNewProv({ ...newProv, code: e.target.value })}
                    placeholder="warzoneshop"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono-num focus:border-slate-900 focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Base URL</label>
                <input
                  type="url"
                  required
                  value={newProv.baseUrl}
                  onChange={(e) => setNewProv({ ...newProv, baseUrl: e.target.value })}
                  placeholder="https://api.example.com/api/v1"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono-num focus:border-slate-900 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">طريقة المصادقة</label>
                <select
                  value={newProv.authPreset}
                  onChange={(e) => handlePresetChange(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs focus:border-slate-900 focus:outline-none"
                >
                  {AUTH_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">مفتاح API (اختياري)</label>
                <input
                  type="password"
                  value={newProv.apiKey}
                  onChange={(e) => setNewProv({ ...newProv, apiKey: e.target.value })}
                  placeholder="يُشفّر فورًا بـ AES-256-GCM"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono-num focus:border-slate-900 focus:outline-none"
                />
              </div>
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                >
                  حفظ الخادم
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
