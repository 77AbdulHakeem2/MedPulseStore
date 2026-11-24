import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Search,
  SlidersHorizontal,
  Eye,
  EyeOff,
  RotateCcw,
  Check,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { FeedbackBanner, SemanticStatus, SurfacePanel } from './ui/AdminPrimitives';

interface CustomerCustomizeViewProps {
  customerId: number;
  customerName: string;
  onBack: () => void;
  onUpdated: () => Promise<void>;
}

interface CustomizableProductItem {
  storeProductId: number;
  sku: string;
  titleAr: string;
  titleEn: string;
  iconEmoji: string;
  categoryId: number | null;
  categoryNameAr: string;
  globalIsVisible: boolean;
  globalIsPaused: boolean;
  availableStock: number;
  customerPriceUsd?: string;
  agentPriceUsd?: string;
  officialPriceUsd: string;
  officialPromoPriceUsd: string | null;
  customPriceUsd: string | null;
  isHiddenForCustomer: boolean;
  hasOverride: boolean;
  updatedAt: string | null;
}

interface ProductOverridesPayload {
  customer: {
    id: number;
    displayName: string;
    telegramUserId: string | null;
    telegramUsername: string | null;
    role: string;
    pricingTier?: 'customer' | 'agent';
    isBlocked: boolean;
  };
  summary: {
    totalProducts: number;
    customizedCount: number;
    customPriceCount: number;
    hiddenCount: number;
  };
  products: CustomizableProductItem[];
}

export default function CustomerCustomizeView({
  customerId,
  customerName,
  onBack,
  onUpdated,
}: CustomerCustomizeViewProps) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ProductOverridesPayload | null>(null);
  const [priceDrafts, setPriceDrafts] = useState<Record<number, string>>({});
  const [savingProductId, setSavingProductId] = useState<number | null>(null);
  const [resettingAll, setResettingAll] = useState(false);
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'customized' | 'hidden' | 'published'>('published');
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const loadOverrides = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<ProductOverridesPayload>(
        `/api/admin/customers/${customerId}/product-overrides`
      );
      setData(res);
      const drafts: Record<number, string> = {};
      for (const p of res.products) {
        drafts[p.storeProductId] = p.customPriceUsd ?? '';
      }
      setPriceDrafts(drafts);
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تحميل قائمة المنتجات لهذا العميل.' });
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => {
    void loadOverrides();
  }, [loadOverrides]);

  const filteredProducts = useMemo(() => {
    const list = data?.products || [];
    const q = search.trim().toLowerCase();
    return list.filter((p) => {
      if (filterMode === 'published' && (!p.globalIsVisible || p.globalIsPaused)) return false;
      if (filterMode === 'customized' && !p.hasOverride) return false;
      if (filterMode === 'hidden' && !p.isHiddenForCustomer) return false;
      if (!q) return true;
      return (
        p.titleAr.toLowerCase().includes(q) ||
        p.titleEn.toLowerCase().includes(q) ||
        p.categoryNameAr.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q)
      );
    });
  }, [data, search, filterMode]);

  const handleSaveCustomPrice = async (item: CustomizableProductItem, explicitPrice?: string | null) => {
    const rawValue = explicitPrice !== undefined ? explicitPrice : (priceDrafts[item.storeProductId] ?? '').trim();
    const payloadPrice = rawValue === '' || rawValue === null ? null : rawValue;

    setSavingProductId(item.storeProductId);
    setFeedback(null);
    try {
      const res = await apiFetch<{
        ok: boolean;
        override: { customPriceUsd: string | null; isHiddenForCustomer: boolean };
      }>(`/api/admin/customers/${customerId}/product-overrides/${item.storeProductId}`, {
        method: 'PUT',
        body: JSON.stringify({
          customPriceUsd: payloadPrice,
          isHidden: item.isHiddenForCustomer,
        }),
      });

      setFeedback({
        type: 'ok',
        text:
          res.override.customPriceUsd !== null
            ? `تم تخصيص سعر "${item.titleAr}" لهذا العميل فقط ليصبح $${res.override.customPriceUsd}.`
            : `تمت إعادة "${item.titleAr}" إلى السعر الرسمي ($${item.officialPriceUsd}) لهذا العميل.`,
      });
      await Promise.all([loadOverrides(), onUpdated()]);
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر حفظ السعر المخصص.' });
    } finally {
      setSavingProductId(null);
    }
  };

  const handleToggleHiddenForCustomer = async (item: CustomizableProductItem) => {
    const nextHidden = !item.isHiddenForCustomer;
    setSavingProductId(item.storeProductId);
    setFeedback(null);
    try {
      await apiFetch(`/api/admin/customers/${customerId}/product-overrides/${item.storeProductId}`, {
        method: 'PUT',
        body: JSON.stringify({
          customPriceUsd: item.customPriceUsd,
          isHidden: nextHidden,
        }),
      });

      setFeedback({
        type: 'ok',
        text: nextHidden
          ? `تم إخفاء "${item.titleAr}" عن هذا العميل فقط دون التأثير على بقية العملاء.`
          : `تم إظهار "${item.titleAr}" لهذا العميل مرة أخرى.`,
      });
      await Promise.all([loadOverrides(), onUpdated()]);
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تحديث حالة الظهور لهذا العميل.' });
    } finally {
      setSavingProductId(null);
    }
  };

  const handleResetAll = async () => {
    setResettingAll(true);
    setFeedback(null);
    try {
      await apiFetch(`/api/admin/customers/${customerId}/product-overrides`, {
        method: 'DELETE',
      });
      setConfirmResetAll(false);
      setFeedback({
        type: 'ok',
        text: 'تمت إعادة جميع المنتجات والأسعار لهذا العميل إلى الإعدادات الرسمية للمتجر.',
      });
      await Promise.all([loadOverrides(), onUpdated()]);
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر إعادة ضبط التخصيصات.' });
    } finally {
      setResettingAll(false);
    }
  };

  const c = data?.customer;
  const summary = data?.summary;

  return (
    <div className="space-y-4">
      {/* Top Banner Header */}
      <SurfacePanel className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3 min-w-0">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 shrink-0 transition-colors"
            >
              <ArrowRight className="h-3.5 w-3.5" />
              العودة للعملاء
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <SlidersHorizontal className="h-4 w-4 text-emerald-700 shrink-0" />
                <h2 className="text-base font-bold text-slate-900 truncate">
                  تخصيص الأسعار والمنتجات: {c?.displayName || customerName}
                </h2>
              </div>
              <p className="mt-1 text-xs text-slate-500 flex flex-wrap items-center gap-1.5">
                {c?.telegramUserId && <span className="font-mono-num">TG {c.telegramUserId}</span>}
                {c?.telegramUsername && (
                  <>
                    <span>·</span>
                    <span dir="ltr">@{c.telegramUsername}</span>
                  </>
                )}
                <span>·</span>
                <span
                  className={`font-semibold ${
                    c?.pricingTier === 'agent' ? 'text-emerald-700' : 'text-slate-700'
                  }`}
                >
                  التصنيف: {c?.pricingTier === 'agent' ? 'وكيل (يعتمد سعر الوكيل تلقائيًا)' : 'عميل (يعتمد سعر العميل تلقائيًا)'}
                </span>
                <span>·</span>
                <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  تعديلات معزولة لهذا المستخدم فقط ولا تؤثر على بقية المستخدمين
                </span>
              </p>
            </div>
          </div>

          {summary && summary.customizedCount > 0 && (
            <div className="flex items-center gap-2 shrink-0">
              {!confirmResetAll ? (
                <button
                  type="button"
                  onClick={() => setConfirmResetAll(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 transition-colors"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  إعادة ضبط الكل للرسمي ({summary.customizedCount})
                </button>
              ) : (
                <div className="flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5">
                  <span className="text-[11px] font-semibold text-rose-800">تأكيد إلغاء كل التخصيصات؟</span>
                  <button
                    type="button"
                    disabled={resettingAll}
                    onClick={() => void handleResetAll()}
                    className="rounded-md bg-rose-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-rose-800 disabled:opacity-50"
                  >
                    {resettingAll ? 'جارٍ...' : 'نعم، إعادة'}
                  </button>
                  <button
                    type="button"
                    disabled={resettingAll}
                    onClick={() => setConfirmResetAll(false)}
                    className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    إلغاء
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Mini Stats + Filter Toolbar */}
        <div className="mt-4 pt-4 border-t border-slate-100 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="inline-flex flex-wrap items-center rounded-lg bg-slate-100 p-0.5">
              {(
                [
                  { id: 'published', label: 'المنشورة في المتجر' },
                  { id: 'all', label: `كل المنتجات (${summary?.totalProducts ?? 0})` },
                  { id: 'customized', label: `المخصّصة (${summary?.customizedCount ?? 0})` },
                  { id: 'hidden', label: `المخفية عنه (${summary?.hiddenCount ?? 0})` },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilterMode(f.id)}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                    filterMode === f.id
                      ? 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.08)]'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="بحث باسم المنتج أو التصنيف..."
              className="w-full rounded-lg border border-slate-200 bg-slate-50/70 py-1.5 pr-8 pl-3 text-xs text-slate-800 focus:bg-white focus:border-emerald-600 focus:outline-none"
            />
          </div>
        </div>
      </SurfacePanel>

      {feedback && (
        <FeedbackBanner
          type={feedback.type}
          text={feedback.text}
          onDismiss={() => setFeedback(null)}
        />
      )}

      {/* Products Customization Table */}
      <SurfacePanel className="overflow-hidden">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 text-slate-500 gap-2">
            <Loader2 className="h-6 w-6 animate-spin text-emerald-700" />
            <span className="text-xs font-medium">جارٍ تحميل قائمة المنتجات...</span>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right border-collapse min-w-[880px]">
              <thead>
                <tr className="border-b border-slate-200/80 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4">المنتج</th>
                  <th className="py-3 px-4">
                    {c?.pricingTier === 'agent' ? 'سعر الوكيل الأساسي' : 'سعر العميل الأساسي'}
                  </th>
                  <th className="py-3 px-4">السعر الخاص بهذا المستخدم ($)</th>
                  <th className="py-3 px-4">حالة الظهور</th>
                  <th className="py-3 px-4">إجراء سريع</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {filteredProducts.map((item) => {
                  const isSaving = savingProductId === item.storeProductId;
                  const draftVal = priceDrafts[item.storeProductId] ?? '';
                  const isDirty = draftVal.trim() !== (item.customPriceUsd ?? '').trim();
                  return (
                    <tr
                      key={item.storeProductId}
                      className={`transition-colors ${
                        item.isHiddenForCustomer
                          ? 'bg-rose-50/35 hover:bg-rose-50/50'
                          : item.customPriceUsd !== null
                            ? 'bg-emerald-50/30 hover:bg-emerald-50/50'
                            : 'hover:bg-slate-50/80'
                      }`}
                    >
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <span className="text-base leading-none">{item.iconEmoji || '📦'}</span>
                          <div className="min-w-0">
                            <div className="font-bold text-slate-900">{item.titleAr}</div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                              <span>{item.categoryNameAr}</span>
                              <span>·</span>
                              <span className="font-mono-num">المخزون: {item.availableStock}</span>
                              {(!item.globalIsVisible || item.globalIsPaused) && (
                                <>
                                  <span>·</span>
                                  <span className="text-amber-700 font-medium">مخفي عامًّا في المتجر</span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>

                      <td className="py-3 px-4">
                        <div className="font-mono-num text-sm font-bold text-slate-800">
                          ${item.officialPriceUsd}
                        </div>
                        {item.officialPromoPriceUsd && (
                          <div className="font-mono-num text-[11px] text-emerald-700">
                            عرض رسمي: ${item.officialPromoPriceUsd}
                          </div>
                        )}
                      </td>

                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            inputMode="decimal"
                            dir="ltr"
                            aria-label={`السعر المخصص لمنتج ${item.titleAr}`}
                            value={draftVal}
                            onChange={(e) =>
                              setPriceDrafts((prev) => ({
                                ...prev,
                                [item.storeProductId]: e.target.value,
                              }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                void handleSaveCustomPrice(item);
                              }
                            }}
                            placeholder={item.officialPriceUsd}
                            className={`w-28 rounded-lg border px-2.5 py-1.5 font-mono-num text-xs focus:outline-none ${
                              item.customPriceUsd !== null
                                ? 'border-emerald-400 bg-white font-bold text-emerald-800 focus:border-emerald-600'
                                : 'border-slate-200 bg-white text-slate-800 focus:border-emerald-600'
                            }`}
                          />
                          <button
                            type="button"
                            disabled={isSaving || (!isDirty && draftVal.trim() === '')}
                            onClick={() => void handleSaveCustomPrice(item)}
                            className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-45 transition-colors"
                          >
                            {isSaving ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Check className="h-3.5 w-3.5" />
                            )}
                            حفظ
                          </button>
                          {item.customPriceUsd !== null && (
                            <button
                              type="button"
                              disabled={isSaving}
                              onClick={() => void handleSaveCustomPrice(item, null)}
                              title="إعادة هذا المنتج إلى السعر الرسمي"
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-45"
                            >
                              <RotateCcw className="h-3 w-3" />
                              الرسمي
                            </button>
                          )}
                        </div>
                      </td>

                      <td className="py-3 px-4">
                        <div className="flex flex-col gap-1">
                          <SemanticStatus
                            tone={item.isHiddenForCustomer ? 'negative' : 'positive'}
                            label={item.isHiddenForCustomer ? 'مخفي عن هذا العميل' : 'ظاهر لهذا العميل'}
                          />
                          {item.customPriceUsd !== null && !item.isHiddenForCustomer && (
                            <span className="text-[11px] font-semibold text-emerald-700">
                              سعر خاص مفعّل (${item.customPriceUsd})
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="py-3 px-4">
                        <button
                          type="button"
                          disabled={isSaving}
                          onClick={() => void handleToggleHiddenForCustomer(item)}
                          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold whitespace-nowrap disabled:opacity-50 transition-colors ${
                            item.isHiddenForCustomer
                              ? 'border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50'
                              : 'border-rose-200 bg-white text-rose-700 hover:bg-rose-50'
                          }`}
                        >
                          {item.isHiddenForCustomer ? (
                            <>
                              <Eye className="h-3.5 w-3.5" />
                              إظهار للعميل
                            </>
                          ) : (
                            <>
                              <EyeOff className="h-3.5 w-3.5" />
                              إخفاء عن العميل
                            </>
                          )}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {filteredProducts.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-sm text-slate-400">
                      لا توجد منتجات مطابقة للفلترة الحالية.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </SurfacePanel>
    </div>
  );
}
