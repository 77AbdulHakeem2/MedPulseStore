import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Code2,
  Download,
  Eye,
  FolderOpen,
  ImageOff,
  KeyRound,
  Layers,
  Package,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import TelegramHtmlRenderer from './TelegramHtmlRenderer';
import type { CategoryItem } from './ProductsPricingView';
import type { ProviderItem } from './ProvidersView';

export interface SupplierBrowserProductItem {
  externalProductId: string;
  externalVariantId: string;
  itemKey: string;
  rawName: string;
  rawDescription: string;
  previewSafeHtml: string;
  cleanedImportHtml: string;
  plainDescriptionPreview: string;
  hasHtmlFormatting: boolean;
  hasCustomEmoji: boolean;
  imageUrl: string;
  wholesalePrice: string;
  suggestedRetailPrice: string | null;
  currency: string;
  stockCount: number;
  isAvailable: boolean;
  minQty: number;
  maxQty: number;
  deliveryType: 'code' | 'link' | 'account' | 'manual';
  deliveryInstructions: string;
  durationLabel: string;
  warrantyDays: number;
  warrantyLabel: string;
  productType: string;
  categoryName: string;
  features: string[];
  variantsSummary: Array<{
    id: string;
    name: string;
    price?: string;
    stock?: number;
    durationLabel?: string;
  }>;
  pricingTiers?: Array<{ minQty: number; maxQty: number | null; price: string }>;
  extraMetadata: Record<string, string | number | boolean>;
  importStatus: 'not_imported' | 'imported';
  existingProviderProductId: number | null;
  existingStoreProductId: number | null;
  existingStoreProductTitle: string | null;
  existingCategoryId: number | null;
  existingStoreVisible: boolean | null;
  existingDescriptionEmpty: boolean;
}

interface BrowseCatalogResponse {
  ok: boolean;
  provider: {
    id: number;
    code: string;
    name: string;
    baseUrl: string;
    status: string;
    hasApiKey: boolean;
  };
  items: SupplierBrowserProductItem[];
  totalCatalogCount: number;
  inStockCatalogCount?: number;
  outOfStockCatalogCount?: number;
  importedCount: number;
  notImportedCount: number;
  totalMatched: number;
  page: number;
  pageSize: number;
  totalPages: number;
  categories: string[];
  fetchedAt: string;
  fromCache: boolean;
}

interface ImportSelectedResponse {
  ok: boolean;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  messageAr: string;
  results: Array<{
    externalProductId: string;
    externalVariantId: string;
    rawName: string;
    status: 'created' | 'updated' | 'skipped' | 'failed';
    storeProductId?: number;
    message: string;
  }>;
}

interface SupplierProductBrowserProps {
  provider: ProviderItem;
  storeCategories: CategoryItem[];
  onClose: () => void;
  onImported: () => Promise<void>;
  onOpenApiKeyModal: (provider: ProviderItem) => void;
}

function SafeSupplierThumbnail({
  src,
  alt,
  size = 'md',
}: {
  src?: string;
  alt: string;
  size?: 'md' | 'lg';
}) {
  const [failed, setFailed] = useState(false);
  const isSafe = Boolean(src && /^https?:\/\//i.test(src));
  const dims = size === 'lg' ? 'h-24 w-24 rounded-xl' : 'h-12 w-12 rounded-lg';

  if (!isSafe || failed) {
    return (
      <div
        className={`${dims} border border-slate-200 bg-slate-50 flex items-center justify-center text-slate-400 shrink-0`}
        aria-hidden="true"
      >
        {isSafe && failed ? <ImageOff className="h-5 w-5" /> : <Package className="h-5 w-5" />}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`${dims} border border-slate-200 bg-white object-cover shrink-0`}
    />
  );
}

const DELIVERY_LABELS: Record<string, string> = {
  code: 'كود تفعيل',
  link: 'رابط تفعيل',
  account: 'حساب جاهز',
  manual: 'تنفيذ يدوي',
};

function normalizeComparableText(input: string): string {
  return input
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function hasDistinctDeliveryInstructions(item: SupplierBrowserProductItem): boolean {
  const instr = (item.deliveryInstructions || '').trim();
  if (!instr) return false;
  const normInstr = normalizeComparableText(instr);
  if (!normInstr) return false;
  const normRaw = normalizeComparableText(item.rawDescription || '');
  const normPlain = normalizeComparableText(item.plainDescriptionPreview || '');
  if (normRaw && (normInstr === normRaw || normRaw.includes(normInstr))) return false;
  if (normPlain && (normInstr === normPlain || normPlain.includes(normInstr))) return false;
  return true;
}

export default function SupplierProductBrowser({
  provider,
  storeCategories,
  onClose,
  onImported,
  onOpenApiKeyModal,
}: SupplierProductBrowserProps) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const [catalogMeta, setCatalogMeta] = useState<{
    totalCatalogCount: number;
    inStockCatalogCount: number;
    outOfStockCatalogCount: number;
    importedCount: number;
    notImportedCount: number;
    totalMatched: number;
    page: number;
    pageSize: number;
    totalPages: number;
    categories: string[];
    fetchedAt: string;
    fromCache: boolean;
  }>({
    totalCatalogCount: 0,
    inStockCatalogCount: 0,
    outOfStockCatalogCount: 0,
    importedCount: 0,
    notImportedCount: 0,
    totalMatched: 0,
    page: 1,
    pageSize: 24,
    totalPages: 1,
    categories: [],
    fetchedAt: '',
    fromCache: false,
  });

  const [items, setItems] = useState<SupplierBrowserProductItem[]>([]);
  const [itemCacheByKey, setItemCacheByKey] = useState<Record<string, SupplierBrowserProductItem>>({});

  // Query controls
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [supplierCategoryFilter, setSupplierCategoryFilter] = useState('all');
  const [importStatusFilter, setImportStatusFilter] = useState<'all' | 'not_imported' | 'imported'>('all');
  const [stockFilter, setStockFilter] = useState<'in_stock' | 'all' | 'out_of_stock'>('in_stock');
  const [page, setPage] = useState(1);

  // Selection & per-item overrides
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [bulkCategoryId, setBulkCategoryId] = useState<string>('');
  const [perItemCategoryMap, setPerItemCategoryMap] = useState<Record<string, string>>({});
  const [updateImportedOnConflict, setUpdateImportedOnConflict] = useState(true);
  const [publishOnImport, setPublishOnImport] = useState(false);

  // Import state & banner
  const [importing, setImporting] = useState(false);
  const [importBanner, setImportBanner] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Preview Modal
  const [previewItem, setPreviewItem] = useState<SupplierBrowserProductItem | null>(null);
  const [showRawHtmlSource, setShowRawHtmlSource] = useState(false);

  // Debounce search input cleanly
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
      setPage(1);
    }, 240);
    return () => clearTimeout(t);
  }, [searchInput]);

  const fetchCatalog = useCallback(
    async (forceRefresh = false) => {
      if (forceRefresh) setRefreshing(true);
      else setLoading(true);
      setErrorMsg(null);
      setErrorCode(null);

      try {
        const qs = new URLSearchParams({
          page: String(page),
          pageSize: '24',
          status: importStatusFilter,
          stock: stockFilter,
        });
        if (debouncedSearch) qs.set('search', debouncedSearch);
        if (supplierCategoryFilter && supplierCategoryFilter !== 'all') {
          qs.set('category', supplierCategoryFilter);
        }
        if (forceRefresh) qs.set('refresh', '1');

        const res = await apiFetch<BrowseCatalogResponse>(
          `/api/admin/providers/${provider.id}/browse-catalog?${qs.toString()}`
        );

        setItems(res.items);
        setItemCacheByKey((prev) => {
          const next = { ...prev };
          for (const it of res.items) next[it.itemKey] = it;
          return next;
        });
        setCatalogMeta({
          totalCatalogCount: res.totalCatalogCount,
          inStockCatalogCount: res.inStockCatalogCount ?? res.totalCatalogCount,
          outOfStockCatalogCount: res.outOfStockCatalogCount ?? 0,
          importedCount: res.importedCount,
          notImportedCount: res.notImportedCount,
          totalMatched: res.totalMatched,
          page: res.page,
          pageSize: res.pageSize,
          totalPages: res.totalPages,
          categories: res.categories,
          fetchedAt: res.fetchedAt,
          fromCache: res.fromCache,
        });
      } catch (err: any) {
        setItems([]);
        setErrorMsg(err?.message || 'تعذر الاتصال بواجهة API الخاصة بالخادم.');
        setErrorCode(err?.code || null);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [provider.id, page, debouncedSearch, supplierCategoryFilter, importStatusFilter, stockFilter]
  );

  useEffect(() => {
    void fetchCatalog(false);
  }, [fetchCatalog]);

  const toggleSelectItem = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const allOnPageSelected = useMemo(
    () => items.length > 0 && items.every((it) => selectedKeys.has(it.itemKey)),
    [items, selectedKeys]
  );

  const toggleSelectAllOnPage = () => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        for (const it of items) next.delete(it.itemKey);
      } else {
        for (const it of items) next.add(it.itemKey);
      }
      return next;
    });
  };

  const clearSelection = () => {
    setSelectedKeys(new Set());
  };

  const resolveEffectiveCategoryId = (item: SupplierBrowserProductItem): string => {
    const override = perItemCategoryMap[item.itemKey];
    if (override) return override;
    if (bulkCategoryId) return bulkCategoryId;
    if (item.existingCategoryId) return String(item.existingCategoryId);
    return '';
  };

  const missingCategorySelectionCount = useMemo(() => {
    let missing = 0;
    for (const key of selectedKeys) {
      const cached = itemCacheByKey[key];
      const override = perItemCategoryMap[key];
      const eff = override || bulkCategoryId || (cached?.existingCategoryId ? String(cached.existingCategoryId) : '');
      if (!eff) missing += 1;
    }
    return missing;
  }, [selectedKeys, perItemCategoryMap, bulkCategoryId, itemCacheByKey]);

  const executeImport = async (keysToImport: string[], explicitCategoryId?: string) => {
    if (keysToImport.length === 0) return;
    setImporting(true);
    setImportBanner(null);

    try {
      const payloadItems = keysToImport.map((key) => {
        const cached = itemCacheByKey[key];
        const parts = key.split('::');
        const extId = cached?.externalProductId ?? parts[0] ?? '';
        const extVarId = cached?.externalVariantId ?? parts.slice(1).join('::') ?? '';
        const targetCatStr =
          explicitCategoryId ||
          perItemCategoryMap[key] ||
          bulkCategoryId ||
          (cached?.existingCategoryId ? String(cached.existingCategoryId) : '');

        return {
          externalProductId: extId,
          externalVariantId: extVarId,
          targetCategoryId: targetCatStr ? Number(targetCatStr) : null,
          action:
            cached?.importStatus === 'imported'
              ? updateImportedOnConflict
                ? ('update' as const)
                : ('skip' as const)
              : ('create' as const),
        };
      });

      const missingCat = payloadItems.some((it) => !it.targetCategoryId);
      if (missingCat) {
        setImportBanner({
          type: 'err',
          text: 'يرجى تحديد قسم المتجر المستهدف قبل الاستيراد (لا يتم إنشاء أقسام تلقائيًا).',
        });
        setImporting(false);
        return;
      }

      const res = await apiFetch<ImportSelectedResponse>(
        `/api/admin/providers/${provider.id}/import-selected`,
        {
          method: 'POST',
          body: JSON.stringify({
            items: payloadItems,
            defaultCategoryId: bulkCategoryId ? Number(bulkCategoryId) : null,
            makeVisible: publishOnImport,
          }),
        }
      );

      setImportBanner({
        type: res.failedCount > 0 && res.createdCount === 0 && res.updatedCount === 0 ? 'err' : 'ok',
        text: res.messageAr,
      });

      // Unselect newly created/updated items cleanly
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        for (const r of res.results) {
          if (r.status === 'created' || r.status === 'updated') {
            next.delete(`${r.externalProductId}::${r.externalVariantId || ''}`);
          }
        }
        return next;
      });

      await Promise.all([fetchCatalog(false), onImported()]);
    } catch (err: any) {
      setImportBanner({
        type: 'err',
        text: err?.message || 'حدث خطأ أثناء استيراد المنتجات المحددة.',
      });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div
      data-testid="supplier-product-browser-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-2 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-7xl h-[95vh] sm:h-[94vh] flex flex-col rounded-2xl bg-slate-50 border border-slate-200 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* TOP HEADER */}
        <div className="bg-white border-b border-slate-200 px-3 py-2.5 sm:px-6 sm:py-3.5 flex flex-col gap-2 sm:gap-3 sm:flex-row sm:items-center sm:justify-between shrink-0">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm sm:text-lg font-bold text-slate-900 truncate">
                تصفح منتجات الخادم — {provider.name}
              </h2>
              <span dir="ltr" className="font-mono-num text-xs text-slate-400">
                #{provider.code}
              </span>
            </div>
            <div className="mt-0.5 sm:mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] sm:text-xs text-slate-500">
              <span>
                بمخزون:{' '}
                <strong className="font-mono-num tabular-nums text-emerald-700">
                  {catalogMeta.inStockCatalogCount}
                </strong>
                {' '}من أصل{' '}
                <strong className="font-mono-num tabular-nums text-slate-900">
                  {catalogMeta.totalCatalogCount}
                </strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                غير مستورد:{' '}
                <strong className="font-mono-num tabular-nums text-emerald-700">
                  {catalogMeta.notImportedCount}
                </strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                مستورد مسبقًا:{' '}
                <strong className="font-mono-num tabular-nums text-slate-700">
                  {catalogMeta.importedCount}
                </strong>
              </span>
              {catalogMeta.fetchedAt && (
                <>
                  <span aria-hidden="true" className="hidden sm:inline">·</span>
                  <span className="hidden sm:inline text-[11px] text-slate-400">
                    آخر جلب:{' '}
                    {new Date(catalogMeta.fetchedAt).toLocaleTimeString('ar-EG', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {catalogMeta.fromCache ? ' (ذاكرة مؤقتة)' : ' (مباشر)'}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={loading || refreshing}
              onClick={() => void fetchCatalog(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 sm:px-3 sm:py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              تحديث من الخادم
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="إغلاق متصفح منتجات الخادم"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 sm:px-3 sm:py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 hover:text-slate-900 whitespace-nowrap"
            >
              <X className="h-3.5 w-3.5" />
              إغلاق
            </button>
          </div>
        </div>

        {/* FILTER & BULK IMPORT TOOLBAR */}
        <div className="bg-white border-b border-slate-200 px-3 py-2 sm:px-6 sm:py-3 space-y-2 sm:space-y-2.5 shrink-0">
          <div className="grid grid-cols-2 lg:grid-cols-12 gap-2 sm:gap-2.5">
            {/* Search by Name / ID */}
            <div className="relative col-span-2 lg:col-span-4">
              <Search className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="بحث باسم المنتج أو Product ID..."
                className="w-full rounded-lg border border-slate-200 bg-slate-50 pr-8 pl-3 py-1.5 sm:py-2 text-xs text-slate-900 focus:border-slate-900 focus:bg-white focus:outline-none"
              />
            </div>

            {/* Filter by Supplier Type / Category */}
            <div className="col-span-1 lg:col-span-3">
              <select
                aria-label="تصفية حسب تصنيف المورد"
                value={supplierCategoryFilter}
                onChange={(e) => {
                  setSupplierCategoryFilter(e.target.value);
                  setPage(1);
                }}
                className="w-full rounded-lg border border-slate-200 bg-white px-2 sm:px-3 py-1.5 sm:py-2 text-xs text-slate-800 focus:border-slate-900 focus:outline-none"
              >
                <option value="all">جميع التصنيفات</option>
                {catalogMeta.categories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>

            {/* Filter by Stock & Import Status */}
            <div className="col-span-1 lg:col-span-2 flex gap-1.5">
              <select
                aria-label="تصفية حسب توفر المخزون"
                value={stockFilter}
                onChange={(e) => {
                  setStockFilter(e.target.value as 'in_stock' | 'all' | 'out_of_stock');
                  setPage(1);
                }}
                className="flex-1 min-w-0 rounded-lg border border-emerald-200 bg-emerald-50/40 px-2 py-1.5 sm:py-2 text-xs font-semibold text-emerald-950 focus:border-slate-900 focus:outline-none"
              >
                <option value="in_stock">بمخزون فقط ({catalogMeta.inStockCatalogCount})</option>
                <option value="out_of_stock">نفد ({catalogMeta.outOfStockCatalogCount})</option>
                <option value="all">الكل</option>
              </select>
              <select
                aria-label="تصفية حسب حالة الاستيراد"
                value={importStatusFilter}
                onChange={(e) => {
                  setImportStatusFilter(e.target.value as 'all' | 'not_imported' | 'imported');
                  setPage(1);
                }}
                className="flex-1 min-w-0 rounded-lg border border-slate-200 bg-white px-2 py-1.5 sm:py-2 text-xs text-slate-800 focus:border-slate-900 focus:outline-none"
              >
                <option value="all">الكل</option>
                <option value="not_imported">غير مستورد فقط</option>
                <option value="imported">مستورد مسبقًا</option>
              </select>
            </div>

            {/* Target MedPulse Store Category (Required before import, NO auto-create) */}
            <div className="col-span-2 lg:col-span-3">
              <select
                data-testid="bulk-target-category-select"
                aria-label="القسم المستهدف في المتجر"
                value={bulkCategoryId}
                onChange={(e) => setBulkCategoryId(e.target.value)}
                className={`w-full rounded-lg border px-2.5 sm:px-3 py-1.5 sm:py-2 text-xs font-semibold focus:outline-none ${
                  selectedKeys.size > 0 && !bulkCategoryId && missingCategorySelectionCount > 0
                    ? 'border-amber-400 bg-amber-50 text-amber-950'
                    : 'border-slate-300 bg-white text-slate-900 focus:border-slate-900'
                }`}
              >
                <option value="">القسم المستهدف بالمتجر (مطلوب للاستيراد)...</option>
                {storeCategories.map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.iconEmoji ? `${c.iconEmoji} ` : ''}
                    {c.nameAr}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Selection & Action Row */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={items.length === 0}
                onClick={toggleSelectAllOnPage}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
              >
                {allOnPageSelected ? <CheckSquare className="h-3.5 w-3.5 text-emerald-700" /> : <Square className="h-3.5 w-3.5" />}
                {allOnPageSelected ? 'إلغاء تحديد الصفحة' : `تحديد الصفحة (${items.length})`}
              </button>

              {selectedKeys.size > 0 && (
                <button
                  type="button"
                  onClick={clearSelection}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 whitespace-nowrap"
                >
                  <X className="h-3.5 w-3.5" />
                  مسح التحديد ({selectedKeys.size})
                </button>
              )}

              <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={updateImportedOnConflict}
                  onChange={(e) => setUpdateImportedOnConflict(e.target.checked)}
                  className="rounded border-slate-300 text-emerald-700 focus:ring-emerald-600"
                />
                <span>تحديث المستورد مسبقًا بدل إنشاء تكرار</span>
              </label>

              <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={publishOnImport}
                  onChange={(e) => setPublishOnImport(e.target.checked)}
                  className="rounded border-slate-300 text-emerald-700 focus:ring-emerald-600"
                />
                <span>نشر مباشرة للعملاء</span>
              </label>
            </div>

            <div className="flex items-center gap-2">
              {selectedKeys.size > 0 && missingCategorySelectionCount > 0 && (
                <span className="text-[11px] font-semibold text-amber-700">
                  اختر قسم المتجر لـ {missingCategorySelectionCount} منتج محدد
                </span>
              )}
              <button
                type="button"
                data-testid="import-selected-btn"
                disabled={importing || selectedKeys.size === 0 || missingCategorySelectionCount > 0}
                onClick={() => void executeImport(Array.from(selectedKeys))}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-1.5 sm:px-3.5 sm:py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-45 transition-colors whitespace-nowrap shrink-0"
              >
                <Download className="h-3.5 w-3.5" />
                {importing ? 'جارٍ الاستيراد...' : `استيراد المحدد (${selectedKeys.size})`}
              </button>
            </div>
          </div>

          {importBanner && (
            <div
              className={`rounded-lg border px-3 py-2 text-xs flex items-center justify-between gap-2 ${
                importBanner.type === 'ok'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : 'border-rose-200 bg-rose-50 text-rose-800'
              }`}
            >
              <span>{importBanner.text}</span>
              <button type="button" onClick={() => setImportBanner(null)} className="text-current opacity-70 hover:opacity-100">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* MAIN SCROLLABLE CATALOG BODY */}
        <div className="flex-1 overflow-y-auto p-3 sm:p-6">
          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
              {Array.from({ length: 6 }).map((_, idx) => (
                <div
                  key={idx}
                  className="rounded-xl border border-slate-200 bg-white p-4 space-y-3 animate-pulse"
                >
                  <div className="flex items-start gap-3">
                    <div className="h-12 w-12 rounded-lg bg-slate-200 shrink-0" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 w-3/4 rounded bg-slate-200" />
                      <div className="h-3 w-1/2 rounded bg-slate-100" />
                    </div>
                  </div>
                  <div className="h-10 rounded bg-slate-100" />
                  <div className="h-8 rounded bg-slate-100" />
                </div>
              ))}
            </div>
          ) : errorMsg ? (
            <div className="mx-auto max-w-lg rounded-2xl border border-rose-200 bg-white p-6 text-center space-y-3 my-8">
              <div className="mx-auto h-11 w-11 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <h3 className="text-sm font-bold text-slate-900">تعذر جلب المنتجات من {provider.name}</h3>
              <p className="text-xs text-rose-700 leading-relaxed">{errorMsg}</p>
              <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                {errorCode === 'NO_API_KEY' && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpenApiKeyModal(provider);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    إدخال مفتاح API للخادم
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void fetchCatalog(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  إعادة المحاولة
                </button>
              </div>
            </div>
          ) : items.length === 0 ? (
            <div className="mx-auto max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center space-y-2.5 my-8">
              <FolderOpen className="mx-auto h-8 w-8 text-slate-400" />
              <div className="text-sm font-bold text-slate-800">لا توجد منتجات مطابقة في كتالوج الخادم</div>
              <p className="text-xs text-slate-500">
                {stockFilter === 'in_stock' && catalogMeta.outOfStockCatalogCount > 0
                  ? `المنتجات المعروضة حاليًا هي المتوفرة بالمخزون فقط (يوجد ${catalogMeta.outOfStockCatalogCount} منتج نافد المخزون مخفي تلقائيًا).`
                  : 'جرب تغيير كلمات البحث أو إعادة تعيين التصفية لعرض جميع المنتجات المتاحة.'}
              </p>
              {(debouncedSearch || supplierCategoryFilter !== 'all' || importStatusFilter !== 'all' || stockFilter !== 'all') && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchInput('');
                    setDebouncedSearch('');
                    setSupplierCategoryFilter('all');
                    setImportStatusFilter('all');
                    setStockFilter('all');
                    setPage(1);
                  }}
                  className="inline-flex items-center rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  عرض جميع المنتجات ({catalogMeta.totalCatalogCount})
                </button>
              )}
            </div>
          ) : (
            <div
              data-testid="supplier-catalog-grid"
              className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5"
            >
              {items.map((item) => {
                const isSelected = selectedKeys.has(item.itemKey);
                const effCat = resolveEffectiveCategoryId(item);
                const isImported = item.importStatus === 'imported';
                const extraCount = Object.keys(item.extraMetadata || {}).length;

                return (
                  <div
                    key={item.itemKey}
                    data-testid={`browser-product-card-${item.externalProductId}`}
                    className={`rounded-xl border bg-white p-3.5 flex flex-col justify-between gap-3 transition-colors ${
                      isSelected
                        ? 'border-emerald-600 ring-1 ring-emerald-600/20'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    {/* Card Header: Checkbox + Image + Original Title + IDs */}
                    <div className="space-y-2.5">
                      <div className="flex items-start gap-2.5 min-w-0">
                        <button
                          type="button"
                          aria-label={`تحديد المنتج ${item.rawName}`}
                          onClick={() => toggleSelectItem(item.itemKey)}
                          className="mt-0.5 text-slate-400 hover:text-emerald-700 shrink-0"
                        >
                          {isSelected ? (
                            <CheckSquare className="h-4.5 w-4.5 text-emerald-700" />
                          ) : (
                            <Square className="h-4.5 w-4.5" />
                          )}
                        </button>

                        <SafeSupplierThumbnail src={item.imageUrl} alt={item.rawName} />

                        <div className="min-w-0 flex-1">
                          <h3
                            dir="auto"
                            className="text-xs sm:text-[13px] font-bold text-slate-900 leading-snug line-clamp-2"
                            title={item.rawName}
                          >
                            {item.rawName}
                          </h3>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                            <span dir="ltr" className="font-mono-num text-slate-700">
                              ID: {item.externalProductId}
                            </span>
                            {item.externalVariantId && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span dir="ltr" className="font-mono-num text-slate-500">
                                  Var: {item.externalVariantId}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Inline Metadata Row (Zero Pill Clutter) */}
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
                        <span dir="auto">{item.categoryName || item.productType || DELIVERY_LABELS[item.deliveryType]}</span>
                        {item.durationLabel && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-slate-700 font-medium">{item.durationLabel}</span>
                          </>
                        )}
                        <span aria-hidden="true">·</span>
                        <span className={item.isAvailable && item.stockCount > 0 ? 'text-emerald-700 font-semibold' : 'text-rose-600 font-semibold'}>
                          {item.isAvailable && item.stockCount > 0
                            ? `متوفر (${item.stockCount})`
                            : 'غير متوفر'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          الكمية:{' '}
                          <span dir="ltr" className="inline-block font-mono-num">
                            {item.minQty}–{item.maxQty}
                          </span>
                        </span>
                      </div>

                      {/* Pricing Bar */}
                      <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 border border-slate-200/70 px-2.5 py-2 text-xs">
                        <div className="text-start">
                          <div className="text-[10px] text-slate-400">سعر الجملة</div>
                          <div className="font-bold text-slate-900">
                            <span dir="ltr" className="inline-block font-mono-num tabular-nums">
                              ${item.wholesalePrice}
                            </span>{' '}
                            <span className="text-[10px] font-normal text-slate-500">{item.currency}</span>
                          </div>
                        </div>
                        <div className="text-start">
                          <div className="text-[10px] text-slate-400">السعر المقترح</div>
                          <div className="font-semibold text-slate-700">
                            {item.suggestedRetailPrice ? (
                              <span dir="ltr" className="inline-block font-mono-num tabular-nums">
                                ${item.suggestedRetailPrice}
                              </span>
                            ) : (
                              '—'
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Short Description Snippet */}
                      <div className="rounded-lg border border-slate-100 bg-slate-50/50 px-2.5 py-2 text-[11px] text-slate-600 space-y-1">
                        {item.plainDescriptionPreview ? (
                          <p dir="auto" className="line-clamp-3 leading-relaxed whitespace-pre-line">
                            {item.plainDescriptionPreview}
                          </p>
                        ) : (
                          <p className="text-slate-400 italic">لم يرسل الخادم نص وصف لهذا المنتج</p>
                        )}
                        {(item.hasHtmlFormatting || item.hasCustomEmoji || item.features.length > 0 || extraCount > 0) && (
                          <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-400 pt-0.5">
                            {item.hasHtmlFormatting && <span>تنسيق Telegram HTML</span>}
                            {item.hasCustomEmoji && (
                              <span className="inline-flex items-center gap-0.5 text-emerald-700 font-medium">
                                <Sparkles className="h-2.5 w-2.5" />
                                إيموجي مخصص
                              </span>
                            )}
                            {item.features.length > 0 && <span>{item.features.length} ميزة</span>}
                            {extraCount > 0 && <span>+{extraCount} حقل إضافي</span>}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Card Footer: Duplicate Status + Per-Item Store Category + Preview Button */}
                    <div className="space-y-2 border-t border-slate-100 pt-2.5">
                      {isImported && (
                        <div className="flex items-center justify-between gap-2 text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200/70 rounded-md px-2 py-1">
                          <span className="inline-flex items-center gap-1 font-semibold truncate">
                            <Check className="h-3 w-3 shrink-0" />
                            مستورد مسبقًا (#{item.existingStoreProductId})
                          </span>
                          {item.existingDescriptionEmpty && (
                            <span className="text-[10px] text-amber-700 font-semibold shrink-0">
                              وصفه فارغ بالمتجر
                            </span>
                          )}
                        </div>
                      )}

                      <div className="flex items-center gap-1.5">
                        <select
                          aria-label={`قسم المتجر للمنتج ${item.rawName}`}
                          value={perItemCategoryMap[item.itemKey] || (item.existingCategoryId ? String(item.existingCategoryId) : '')}
                          onChange={(e) =>
                            setPerItemCategoryMap((prev) => ({
                              ...prev,
                              [item.itemKey]: e.target.value,
                            }))
                          }
                          className="flex-1 min-w-0 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-slate-700 focus:border-slate-900 focus:outline-none"
                        >
                          <option value="">
                            {bulkCategoryId ? 'استخدام القسم العام المحدد' : 'اختر قسم المتجر...'}
                          </option>
                          {storeCategories.map((c) => (
                            <option key={c.id} value={String(c.id)}>
                              {c.nameAr}
                            </option>
                          ))}
                        </select>

                        <button
                          type="button"
                          data-testid={`preview-product-btn-${item.externalProductId}`}
                          onClick={() => {
                            setPreviewItem(item);
                            setShowRawHtmlSource(false);
                          }}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-800 hover:bg-slate-50 whitespace-nowrap shrink-0"
                        >
                          <Eye className="h-3.5 w-3.5 text-emerald-700" />
                          معاينة كاملة
                        </button>
                      </div>

                      {!effCat && isSelected && (
                        <div className="text-[10px] text-amber-700 font-medium">
                          مطلوب اختيار قسم المتجر قبل الاستيراد
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* PAGINATION FOOTER */}
        <div className="bg-white border-t border-slate-200 px-3 py-2 sm:px-6 sm:py-3 flex flex-wrap items-center justify-between gap-2 shrink-0 text-xs">
          <div className="text-slate-500">
            عرض{' '}
            <strong className="font-mono-num text-slate-900">{items.length}</strong> من أصل{' '}
            <strong className="font-mono-num text-slate-900">{catalogMeta.totalMatched}</strong> منتج مطابق
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={loading || page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              <ChevronRight className="h-3.5 w-3.5" />
              السابق
            </button>
            <span className="text-xs font-semibold text-slate-700 px-1.5">
              صفحة{' '}
              <span dir="ltr" className="inline-block font-mono-num tabular-nums">
                {catalogMeta.page}
              </span>{' '}
              من{' '}
              <span dir="ltr" className="inline-block font-mono-num tabular-nums">
                {catalogMeta.totalPages}
              </span>
            </span>
            <button
              type="button"
              disabled={loading || page >= catalogMeta.totalPages}
              onClick={() => setPage((p) => Math.min(catalogMeta.totalPages, p + 1))}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              التالي
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* FULL PRODUCT INSPECTION MODAL (BEFORE IMPORT) */}
      {previewItem && (
        <div
          data-testid="supplier-product-preview-modal"
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/65 p-3 sm:p-5"
          onClick={() => setPreviewItem(null)}
        >
          <div
            className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl bg-white border border-slate-200 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Preview Header */}
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <div className="flex items-start gap-3.5 min-w-0">
                <SafeSupplierThumbnail src={previewItem.imageUrl} alt={previewItem.rawName} size="lg" />
                <div className="min-w-0 space-y-1">
                  <h3 dir="auto" className="text-base font-bold text-slate-900 leading-snug">
                    {previewItem.rawName}
                  </h3>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span dir="ltr" className="font-mono-num text-slate-700">
                      Product ID: {previewItem.externalProductId}
                    </span>
                    {previewItem.externalVariantId && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span dir="ltr" className="font-mono-num">
                          Variant ID: {previewItem.externalVariantId}
                        </span>
                      </>
                    )}
                    {previewItem.categoryName && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span dir="auto">{previewItem.categoryName}</span>
                      </>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs pt-0.5">
                    <span className="font-bold text-emerald-700">
                      الجملة:{' '}
                      <span dir="ltr" className="inline-block font-mono-num tabular-nums">
                        ${previewItem.wholesalePrice} {previewItem.currency}
                      </span>
                    </span>
                    {previewItem.suggestedRetailPrice && (
                      <span className="text-slate-600">
                        المقترح:{' '}
                        <span dir="ltr" className="inline-block font-mono-num tabular-nums font-semibold">
                          ${previewItem.suggestedRetailPrice}
                        </span>
                      </span>
                    )}
                    <span className={previewItem.isAvailable && previewItem.stockCount > 0 ? 'text-emerald-700 font-semibold' : 'text-rose-600 font-semibold'}>
                      المخزون:{' '}
                      <span dir="ltr" className="inline-block font-mono-num tabular-nums">
                        {previewItem.stockCount}
                      </span>
                    </span>
                  </div>
                </div>
              </div>

              <button
                type="button"
                aria-label="إغلاق معاينة المنتج"
                onClick={() => setPreviewItem(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Preview Body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
              {/* Structured Attributes Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                  <div className="text-[10px] text-slate-400">النوع / التسليم</div>
                  <div className="mt-0.5 font-semibold text-slate-800">
                    {previewItem.productType || DELIVERY_LABELS[previewItem.deliveryType]}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                  <div className="text-[10px] text-slate-400">المدة</div>
                  <div className="mt-0.5 font-semibold text-slate-800">
                    {previewItem.durationLabel || 'غير محدد بالمصدر'}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                  <div className="text-[10px] text-slate-400">الضمان</div>
                  <div className="mt-0.5 font-semibold text-slate-800">
                    {previewItem.warrantyLabel || `${previewItem.warrantyDays} يوم`}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                  <div className="text-[10px] text-slate-400">حدود الطلب</div>
                  <div className="mt-0.5 font-mono-num font-semibold text-slate-800">
                    {previewItem.minQty} – {previewItem.maxQty}
                  </div>
                </div>
              </div>

              {/* Full Original Description (Unaltered Formatting & Custom Emoji Preview) */}
              <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3.5 py-2">
                  <span className="font-bold text-slate-800">
                    الوصف الكامل من الخادم (كما هو في المصدر)
                  </span>
                  {previewItem.rawDescription && (
                    <button
                      type="button"
                      onClick={() => setShowRawHtmlSource((v) => !v)}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900"
                    >
                      <Code2 className="h-3 w-3" />
                      {showRawHtmlSource ? 'عرض المعاينة المنسقة' : 'عرض المصدر الخام HTML'}
                    </button>
                  )}
                </div>
                <div dir="auto" className="p-3.5 text-[13px] text-slate-800 leading-relaxed">
                  {!previewItem.rawDescription ? (
                    <span className="text-slate-400 italic">لا يوجد وصف نصي مرفق لهذا المنتج في استجابة الخادم.</span>
                  ) : showRawHtmlSource ? (
                    <pre
                      dir="ltr"
                      className="overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] text-slate-100 whitespace-pre-wrap break-words"
                    >
                      {previewItem.rawDescription}
                    </pre>
                  ) : (
                    <TelegramHtmlRenderer html={previewItem.previewSafeHtml || previewItem.rawDescription} />
                  )}
                </div>
              </div>

              {/* Delivery Instructions if distinct from main description */}
              {hasDistinctDeliveryInstructions(previewItem) && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-1">
                  <div className="font-bold text-slate-800">تعليمات التفعيل والتسليم</div>
                  {/<[a-zA-Z/]/.test(previewItem.deliveryInstructions) ? (
                    <div dir="auto" className="text-xs text-slate-700 leading-relaxed">
                      <TelegramHtmlRenderer html={previewItem.deliveryInstructions} />
                    </div>
                  ) : (
                    <p dir="auto" className="text-xs text-slate-700 whitespace-pre-line">
                      {previewItem.deliveryInstructions}
                    </p>
                  )}
                </div>
              )}

              {/* Features List */}
              {previewItem.features.length > 0 && (
                <div className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-1.5">
                  <div className="font-bold text-slate-800">تفاصيل ومميزات المنتج</div>
                  <ul className="list-disc pr-4 space-y-1 text-slate-700">
                    {previewItem.features.map((feat, idx) => (
                      <li key={idx} dir="auto">{feat}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Variants Summary */}
              {previewItem.variantsSummary.length > 0 && (
                <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                  <div className="border-b border-slate-100 bg-slate-50 px-3.5 py-2 font-bold text-slate-800 flex items-center gap-1.5">
                    <Layers className="h-3.5 w-3.5 text-slate-500" />
                    المتغيرات والخيارات المتاحة ({previewItem.variantsSummary.length})
                  </div>
                  <div className="divide-y divide-slate-100">
                    {previewItem.variantsSummary.map((v, idx) => (
                      <div key={idx} className="flex items-center justify-between px-3.5 py-2 text-xs">
                        <span className="font-medium text-slate-800">
                          {v.name} {v.id ? `(#${v.id})` : ''}
                        </span>
                        <span className="font-mono-num text-slate-600">
                          {v.price ? `$${v.price}` : ''} {v.stock !== undefined ? `· مخزون ${v.stock}` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Pricing Tiers */}
              {previewItem.pricingTiers && previewItem.pricingTiers.length > 0 && (
                <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                  <div className="border-b border-slate-100 bg-slate-50 px-3.5 py-2 font-bold text-slate-800">
                    شرائح أسعار الكميات
                  </div>
                  <div className="divide-y divide-slate-100">
                    {previewItem.pricingTiers.map((tier, idx) => (
                      <div key={idx} className="flex items-center justify-between px-3.5 py-2 font-mono-num">
                        <span>
                          من {tier.minQty} {tier.maxQty ? `إلى ${tier.maxQty}` : 'فأكثر'}
                        </span>
                        <strong className="text-slate-900">${tier.price}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Remaining Extra Raw Metadata */}
              {Object.keys(previewItem.extraMetadata || {}).length > 0 && (
                <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                  <div className="border-b border-slate-100 bg-slate-50 px-3.5 py-2 font-bold text-slate-800">
                    بيانات إضافية من الخادم
                  </div>
                  <div className="divide-y divide-slate-100">
                    {Object.entries(previewItem.extraMetadata).map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between gap-4 px-3.5 py-1.5">
                        <span dir="ltr" className="font-mono-num text-[11px] text-slate-500">
                          {k}
                        </span>
                        <span dir="auto" className="font-mono-num text-[11px] text-slate-800 text-left break-all">
                          {String(v)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Preview Footer: Direct Import / Select */}
            <div className="border-t border-slate-200 bg-slate-50 px-5 py-3.5 flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                <select
                  aria-label="اختيار قسم المتجر للاستيراد المباشر"
                  value={resolveEffectiveCategoryId(previewItem)}
                  onChange={(e) =>
                    setPerItemCategoryMap((prev) => ({
                      ...prev,
                      [previewItem.itemKey]: e.target.value,
                    }))
                  }
                  className="w-full max-w-xs rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 focus:border-slate-900 focus:outline-none"
                >
                  <option value="">اختر قسم المتجر للاستيراد...</option>
                  {storeCategories.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.nameAr}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    toggleSelectItem(previewItem.itemKey);
                    setPreviewItem(null);
                  }}
                  className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                >
                  {selectedKeys.has(previewItem.itemKey) ? 'إزالة من التحديد' : 'إضافة للتحديد'}
                </button>
                <button
                  type="button"
                  disabled={importing || !resolveEffectiveCategoryId(previewItem)}
                  onClick={async () => {
                    const catId = resolveEffectiveCategoryId(previewItem);
                    await executeImport([previewItem.itemKey], catId);
                    setPreviewItem(null);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-45 whitespace-nowrap"
                >
                  <Download className="h-3.5 w-3.5" />
                  {previewItem.importStatus === 'imported' ? 'تحديث المنتج بالمتجر' : 'استيراد إلى المتجر الآن'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
