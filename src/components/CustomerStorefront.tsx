import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Globe,
  Home,
  Landmark,
  LogOut,
  Package,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Wallet,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { WebLang } from '../lib/webLocale';
import {
  FeedbackBanner,
  KpiCard,
  SectionHeader,
  SemanticStatus,
  SurfacePanel,
} from './ui/AdminPrimitives';
import CustomerLocalDepositModal from './CustomerLocalDepositModal';
import TelegramHtmlRenderer from './TelegramHtmlRenderer';

export interface StorefrontProduct {
  id: number;
  sku: string;
  categoryId: number | null;
  categoryNameAr: string;
  categoryNameEn?: string;
  titleAr: string;
  titleEn?: string;
  descriptionAr: string;
  descriptionEn?: string;
  iconEmoji?: string;
  retailPrice: string;
  promoPrice: string | null;
  currency: string;
  warrantyLabelAr: string;
  warrantyLabelEn?: string;
  warrantyLabel?: string;
  durationLabel: string;
  availableQty: number;
  inStock: boolean;
}

interface CustomerStorefrontProps {
  storeProfile: Record<string, any>;
  customerCatalog: StorefrontProduct[];
  customerWallet: { availableBalance: string; reservedBalance: string } | null;
  customerOrders: any[];
  webLang?: WebLang;
  onToggleWebLang?: () => void;
  onRefreshStorefront: () => Promise<void>;
  onLogout: () => Promise<void>;
}

const PRESET_QUANTITIES = [1, 2, 3, 4, 5, 6] as const;

function makePreviewOrderRef(): string {
  const numPart = String(Math.floor(10000 + Math.random() * 90000));
  const hexPart = Math.floor(0x1000 + Math.random() * 0xefff)
    .toString(16)
    .toLowerCase();
  return `ORD-${numPart}-${hexPart}`;
}

function normalizeArabicDigits(raw: string): string {
  return raw
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

function stripTelegramHtml(raw?: string | null): string {
  if (!raw) return '';
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/blockquote>\s*<blockquote(?:\s+expandable)?>/gi, '\n\n')
    .replace(/<\/(p|div|blockquote|li|pre|h[1-6])>/gi, '\n')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_full, href: string, label: string) => {
      const cleanLabel = label.replace(/<[^>]+>/g, '').trim();
      if (!cleanLabel || cleanLabel.includes(href) || href.includes(cleanLabel)) return cleanLabel || href;
      return `${cleanLabel} (${href})`;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export default function CustomerStorefront({
  storeProfile,
  customerCatalog,
  customerWallet,
  customerOrders,
  webLang = 'ar',
  onToggleWebLang,
  onRefreshStorefront,
  onLogout,
}: CustomerStorefrontProps) {
  const isEn = webLang === 'en';
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);

  // Quantity & Transaction Confirmation State
  const [selectedQty, setSelectedQty] = useState<number | null>(null);
  const [previewOrderRef, setPreviewOrderRef] = useState<string>('');
  const [customQtyOpen, setCustomQtyOpen] = useState(false);
  const [customQtyInput, setCustomQtyInput] = useState('');
  const [qtyError, setQtyError] = useState<string | null>(null);
  const [submittingOrder, setSubmittingOrder] = useState(false);

  const [customerOrderFeedback, setCustomerOrderFeedback] = useState<{
    type: 'ok' | 'err';
    text: string;
  } | null>(null);
  const [rbacPanelOpen, setRbacPanelOpen] = useState(false);
  const [customerRbacTestMsg, setCustomerRbacTestMsg] = useState<string | null>(null);

  // Dynamic Currency (USD / YER) & Local Wallets Deposit State
  const [preferredCurrency, setPreferredCurrency] = useState<'USD' | 'YER'>('USD');
  const [exchangeRateNum, setExchangeRateNum] = useState<number | null>(null);
  const [roundingMode, setRoundingMode] = useState<'exact' | 'nearest_1' | 'nearest_10' | 'nearest_50' | 'nearest_100'>('nearest_10');
  const [localDepositsEnabled, setLocalDepositsEnabled] = useState<boolean>(true);
  const [togglingCurrency, setTogglingCurrency] = useState(false);
  const [localDepositModalOpen, setLocalDepositModalOpen] = useState(false);
  const [localDeposits, setLocalDeposits] = useState<any[]>([]);

  const loadCurrencyAndLocalDeposits = useCallback(async () => {
    try {
      const [curRes, depRes] = await Promise.all([
        apiFetch<any>('/api/store/currency'),
        apiFetch<any>('/api/store/local-deposits').catch(() => ({ deposits: [] })),
      ]);
      const pref = String(curRes?.preferredCurrency || 'USD').toUpperCase() === 'YER' ? 'YER' : 'USD';
      setPreferredCurrency(pref);
      const rateVal = curRes?.exchangeRate?.rate ?? curRes?.liveRate?.rate ?? null;
      setExchangeRateNum(rateVal ? Number(rateVal) : null);
      if (curRes?.roundingMode) setRoundingMode(curRes.roundingMode);
      if (typeof curRes?.localDepositsEnabled === 'boolean') {
        setLocalDepositsEnabled(curRes.localDepositsEnabled);
      }
      setLocalDeposits(Array.isArray(depRes?.deposits) ? depRes.deposits : []);
    } catch {
      // Keep default USD mode safely if currency endpoint fails
    }
  }, []);

  useEffect(() => {
    void loadCurrencyAndLocalDeposits();
  }, [loadCurrencyAndLocalDeposits]);

  const refreshAllStoreData = useCallback(async () => {
    await Promise.all([onRefreshStorefront(), loadCurrencyAndLocalDeposits()]);
  }, [onRefreshStorefront, loadCurrencyAndLocalDeposits]);

  const handleToggleCurrency = async () => {
    if (togglingCurrency) return;
    const targetCurrency: 'USD' | 'YER' = preferredCurrency === 'YER' ? 'USD' : 'YER';
    setTogglingCurrency(true);
    setCustomerOrderFeedback(null);
    try {
      const res = await apiFetch<any>('/api/store/currency', {
        method: 'PATCH',
        body: JSON.stringify({ currency: targetCurrency }),
      });
      setPreferredCurrency(res.preferredCurrency === 'YER' ? 'YER' : 'USD');
      const nextRate = res?.exchangeRate?.rate ?? res?.liveRate?.rate ?? null;
      if (nextRate) {
        setExchangeRateNum(Number(nextRate));
      }
      if (res?.roundingMode) {
        setRoundingMode(res.roundingMode);
      }
    } catch (err: any) {
      setCustomerOrderFeedback({
        type: 'err',
        text:
          err?.message ||
          (isEn
            ? 'Unable to verify live YER exchange rate right now.'
            : 'تعذر التحقق من سعر الصرف المباشر حاليًا.'),
      });
    } finally {
      setTogglingCurrency(false);
    }
  };

  const formatStoreMoney = useCallback(
    (usdAmount: string | number | null | undefined, overrideRate?: number | null): string => {
      const num = Number(usdAmount || 0);
      const safeNum = Number.isFinite(num) ? num : 0;
      const rate = overrideRate && overrideRate > 0 ? overrideRate : exchangeRateNum;
      if (preferredCurrency === 'YER' && rate && rate > 0) {
        const sign = safeNum < 0 ? '-' : '';
        const rawYer = Math.abs(safeNum) * rate;
        let rounded = rawYer;
        if (roundingMode === 'nearest_1') rounded = Math.round(rawYer);
        else if (roundingMode === 'nearest_10') rounded = Math.round(rawYer / 10) * 10;
        else if (roundingMode === 'nearest_50') rounded = Math.round(rawYer / 50) * 50;
        else if (roundingMode === 'nearest_100') rounded = Math.round(rawYer / 100) * 100;
        else rounded = Math.round(rawYer * 100) / 100;
        const formatted =
          roundingMode === 'exact'
            ? rounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : Math.round(rounded).toLocaleString('en-US');
        return `${sign}${formatted} ﷼`;
      }
      const sign = safeNum < 0 ? '-' : '';
      return `${sign}$${Math.abs(safeNum).toFixed(2)}`;
    },
    [preferredCurrency, exchangeRateNum, roundingMode]
  );

  const storeTitle = isEn
    ? storeProfile.storeNameEn || storeProfile.storeName || 'Raqm Store'
    : storeProfile.storeName || 'متجر رَقْم';

  const brandMonogram = storeTitle.trim().charAt(0).toUpperCase() || (isEn ? 'R' : 'ر');

  const welcomeMessage = isEn
    ? storeProfile.welcomeMessageEn || storeProfile.welcomeMessageAr || 'Instant digital subscriptions with automated delivery.'
    : storeProfile.welcomeMessageAr || 'اشتراكات ومنتجات رقمية أصلية بتسليم فوري وآمن.';

  const getProductTitle = (item: StorefrontProduct) =>
    stripTelegramHtml(isEn ? item.titleEn || item.titleAr : item.titleAr || item.titleEn || '');

  const getProductDescHtml = (item: StorefrontProduct) => {
    const raw = (isEn ? item.descriptionEn || item.descriptionAr : item.descriptionAr || item.descriptionEn || '').trim();
    if (!raw) return '';
    return raw
      .split(/\r?\n/)
      .filter(
        (line) =>
          !/منتج\s*مستورد\s*تلقائي|مخفي\s*افتراضي|حتى\s*التفعيل\s*والتسعير|auto[-\s]*imported\s*from|hidden\s*by\s*default/i.test(
            stripTelegramHtml(line)
          )
      )
      .join('\n')
      .trim();
  };

  const getWarrantyDisplay = (item: StorefrontProduct) =>
    isEn
      ? item.warrantyLabelEn || item.warrantyLabel || item.warrantyLabelAr
      : item.warrantyLabelAr || item.warrantyLabel || item.warrantyLabelEn || '';

  const getCategoryDisplay = (item: StorefrontProduct) =>
    isEn ? item.categoryNameEn || item.categoryNameAr : item.categoryNameAr || item.categoryNameEn || '';

  const categoriesList = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of customerCatalog) {
      if (item.categoryNameAr && !map.has(item.categoryNameAr)) {
        map.set(item.categoryNameAr, getCategoryDisplay(item));
      }
    }
    return Array.from(map.entries()).map(([key, label]) => ({ key, label }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerCatalog, isEn]);

  const filteredCatalog = useMemo(() => {
    if (selectedCategory === 'all') return customerCatalog;
    return customerCatalog.filter((item) => item.categoryNameAr === selectedCategory);
  }, [customerCatalog, selectedCategory]);

  const selectedProduct = useMemo(
    () => customerCatalog.find((p) => p.id === selectedProductId) || null,
    [customerCatalog, selectedProductId]
  );

  const inStockCount = useMemo(
    () => customerCatalog.filter((p) => p.availableQty > 0).length,
    [customerCatalog]
  );

  const resetPurchaseFlow = () => {
    setSelectedQty(null);
    setPreviewOrderRef('');
    setCustomQtyOpen(false);
    setCustomQtyInput('');
    setQtyError(null);
  };

  const openProductPage = (prodId: number) => {
    setSelectedProductId(prodId);
    setCustomerOrderFeedback(null);
    resetPurchaseFlow();
  };

  const handleBackToProducts = () => {
    setSelectedProductId(null);
    resetPurchaseFlow();
  };

  const handleBackToMenu = () => {
    setSelectedProductId(null);
    setSelectedCategory('all');
    resetPurchaseFlow();
  };

  const handleSelectQuantity = (qty: number) => {
    if (!selectedProduct) return;
    setQtyError(null);
    setCustomerOrderFeedback(null);

    if (qty < 1 || !Number.isInteger(qty)) {
      setQtyError(isEn ? 'Please select a valid quantity greater than 0.' : 'يرجى اختيار كمية صحيحة أكبر من 0.');
      return;
    }
    if (qty > selectedProduct.availableQty) {
      setQtyError(
        isEn
          ? `Requested quantity (${qty}) exceeds available stock (${selectedProduct.availableQty}).`
          : `الكمية المطلوبة (${qty}) أكبر من المخزون المتوفر حاليًا (${selectedProduct.availableQty}).`
      );
      return;
    }

    setCustomQtyOpen(false);
    setSelectedQty(qty);
    setPreviewOrderRef(makePreviewOrderRef());
  };

  const handleApplyCustomQuantity = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProduct) return;
    setQtyError(null);

    const normalized = normalizeArabicDigits(customQtyInput);
    if (!/^\d+$/.test(normalized)) {
      setQtyError(
        isEn
          ? 'Please enter a valid whole number greater than 0 (e.g., 7 or 15).'
          : 'يرجى إدخال رقم صحيح أكبر من 0 (مثال: 7 أو 15).'
      );
      return;
    }

    const parsed = Number.parseInt(normalized, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      setQtyError(isEn ? 'Quantity must be at least 1.' : 'يرجى إدخال كمية لا تقل عن 1.');
      return;
    }
    const maxCap = Math.min(1000, selectedProduct.availableQty);
    if (parsed > maxCap) {
      setQtyError(
        isEn
          ? `Requested quantity (${parsed}) exceeds available stock (${selectedProduct.availableQty}).`
          : `الكمية المطلوبة (${parsed}) أكبر من المخزون المتوفر حاليًا (${selectedProduct.availableQty}).`
      );
      return;
    }

    setSelectedQty(parsed);
    setPreviewOrderRef(makePreviewOrderRef());
  };

  const handleCancelTransaction = () => {
    setSelectedQty(null);
    setPreviewOrderRef('');
    setQtyError(null);
    setCustomerOrderFeedback({
      type: 'err',
      text: isEn
        ? 'Purchase cancelled. You can pick another quantity or return to products.'
        : 'تم إلغاء عملية الشراء. يمكنك اختيار كمية أخرى أو العودة إلى المنتجات.',
    });
  };

  const handleConfirmPurchase = async () => {
    if (!selectedProduct || !selectedQty || submittingOrder) return;
    setSubmittingOrder(true);
    setCustomerOrderFeedback(null);
    try {
      const res = await apiFetch<{ orderNumber: string; deliveryMessageAr?: string }>(
        '/api/store/orders',
        {
          method: 'POST',
          body: JSON.stringify({
            storeProductId: selectedProduct.id,
            quantity: selectedQty,
            idempotencyKey: `web-${selectedProduct.id}-${selectedQty}-${previewOrderRef}`,
          }),
        }
      );
      setCustomerOrderFeedback({
        type: 'ok',
        text: isEn
          ? `Order confirmed (${res.orderNumber}) — Quantity: ${selectedQty}. Your delivery is available in My Orders below.`
          : `تم تأكيد الشراء بنجاح (${res.orderNumber}) — الكمية: ${selectedQty}. تم تسليم طلبك في سجل الطلبات أدناه.`,
      });
      resetPurchaseFlow();
      await onRefreshStorefront();
    } catch (err: any) {
      setCustomerOrderFeedback({
        type: 'err',
        text: err?.message || (isEn ? 'Could not complete purchase right now.' : 'تعذر إكمال عملية الشراء حاليًا.'),
      });
    } finally {
      setSubmittingOrder(false);
    }
  };

  const attemptAdminIntrusion = async () => {
    try {
      await apiFetch('/api/admin/overview');
      setCustomerRbacTestMsg(isEn ? 'Warning: Admin endpoint was reached!' : 'تحذير: تم الوصول!');
    } catch (err: any) {
      setCustomerRbacTestMsg(
        isEn
          ? `Access blocked by server RBAC (HTTP ${err?.status || 403}): ${err?.message}`
          : `تم حظر الوصول بنجاح من الخادم (HTTP ${err?.status || 403}): ${err?.message}`
      );
    }
  };

  const unitPriceNum = selectedProduct
    ? Number(selectedProduct.promoPrice || selectedProduct.retailPrice || 0)
    : 0;
  const currentBalanceNum = Number(customerWallet?.availableBalance || 0);
  const totalAmountNum = selectedQty ? unitPriceNum * selectedQty : 0;
  const afterPurchaseNum = currentBalanceNum - totalAmountNum;

  return (
    <div className="min-h-screen bg-[#f5f7fb] text-slate-900 flex flex-col overflow-x-hidden">
      {/* Sticky Executive Storefront Header */}
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-2 sm:gap-4 px-3 sm:px-6">
          <button
            type="button"
            onClick={handleBackToMenu}
            className="flex items-center gap-2 sm:gap-2.5 text-start min-w-0 shrink group"
          >
            <span className="flex h-8 w-8 sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white font-display font-bold text-xs sm:text-sm group-hover:bg-emerald-700 transition-colors">
              {brandMonogram}
            </span>
            <span className="min-w-0">
              <span className="block font-display text-sm sm:text-base font-bold text-slate-900 leading-tight truncate max-w-[110px] sm:max-w-none">
                {storeTitle}
              </span>
              <span className="hidden sm:block text-[11px] text-slate-400 leading-tight">
                {isEn ? 'Digital Storefront' : 'متجر المنتجات الرقمية'}
              </span>
            </span>
          </button>

          <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
            <div className="hidden md:flex items-center gap-2 rounded-xl border border-slate-200/90 bg-slate-50/80 px-3 py-1.5 text-xs">
              <Wallet className="h-3.5 w-3.5 text-emerald-700 shrink-0" />
              <span className="text-slate-500">{isEn ? 'Balance:' : 'الرصيد:'}</span>
              <strong className="font-mono-num font-bold text-slate-900" data-testid="storefront-header-balance">
                {formatStoreMoney(customerWallet?.availableBalance || 0)}
              </strong>
            </div>

            {localDepositsEnabled && (
              <button
                type="button"
                onClick={() => setLocalDepositModalOpen(true)}
                className="inline-flex items-center gap-1 sm:gap-1.5 rounded-xl bg-emerald-700 px-2.5 sm:px-3 py-1.5 text-[11px] sm:text-xs font-semibold text-white hover:bg-emerald-800 transition-colors whitespace-nowrap shrink-0"
              >
                <Landmark className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden sm:inline">
                  {isEn ? 'Local Wallets Top-Up' : 'شحن بالمحافظ المحلية'}
                </span>
                <span className="sm:hidden">{isEn ? 'Top Up' : 'شحن'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => void handleToggleCurrency()}
              disabled={togglingCurrency}
              aria-label={isEn ? 'Switch display currency between USD and YER' : 'تبديل العملة بين الدولار والريال اليمني'}
              className={`inline-flex items-center gap-1 sm:gap-1.5 rounded-xl border px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs font-bold transition-colors whitespace-nowrap shrink-0 disabled:opacity-60 ${
                preferredCurrency === 'YER'
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <RefreshCw className={`h-3.5 w-3.5 text-emerald-700 shrink-0 ${togglingCurrency ? 'animate-spin' : ''}`} />
              <span>{preferredCurrency === 'YER' ? 'YER ﷼' : 'USD $'}</span>
            </button>

            {onToggleWebLang && (
              <button
                type="button"
                onClick={onToggleWebLang}
                aria-label={isEn ? 'Switch to Arabic' : 'التبديل إلى الإنجليزية'}
                className="inline-flex items-center gap-1 sm:gap-1.5 rounded-xl border border-slate-200 bg-white px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
              >
                <Globe className="h-3.5 w-3.5 text-emerald-700 shrink-0" />
                <span className="hidden xs:inline sm:inline">{isEn ? 'عربي' : 'EN'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => void onLogout()}
              aria-label={isEn ? 'Sign out' : 'خروج'}
              className="inline-flex items-center gap-1 sm:gap-1.5 rounded-xl border border-slate-200 bg-white px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              <LogOut className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">{isEn ? 'Sign out' : 'خروج'}</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl w-full flex-1 px-4 sm:px-6 py-7 space-y-7">
        {customerOrderFeedback && (
          <FeedbackBanner
            type={customerOrderFeedback.type}
            text={customerOrderFeedback.text}
            onDismiss={() => setCustomerOrderFeedback(null)}
          />
        )}

        {/* ================================================================ */}
        {/* PRODUCT DETAIL + QUANTITY SELECTOR (1-6 + CUSTOM + CONFIRMATION) */}
        {/* Preserves exact required button ordering & transaction card      */}
        {/* ================================================================ */}
        {selectedProduct ? (
          <section className="mx-auto max-w-xl space-y-4">
            {/* Product Summary Card */}
            <SurfacePanel className="p-6 space-y-4">
              <div className="border-b border-slate-100 pb-3.5 space-y-1">
                <div className="text-xs font-bold tracking-wide text-sky-700">
                  {selectedProduct.iconEmoji ? `${selectedProduct.iconEmoji} ` : '✦ '}
                  {getCategoryDisplay(selectedProduct)}
                </div>
                <h1 className="text-xl font-bold text-slate-900">
                  {getProductTitle(selectedProduct)}
                </h1>
              </div>

              <div className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50/90 border border-slate-100 p-3.5 text-sm">
                <div>
                  <div className="text-[11px] text-slate-500">
                    {isEn ? '💲 Unit Price' : '💲 السعر (Price)'}
                  </div>
                  <div className="mt-1 font-mono-num text-xl font-bold text-slate-900">
                    {formatStoreMoney(selectedProduct.promoPrice || selectedProduct.retailPrice)}
                  </div>
                </div>
                <div className="flex flex-col items-end justify-between">
                  <div className="text-[11px] text-slate-500">
                    {isEn ? '📊 Available Stock' : '📊 المخزون (Stock)'}
                  </div>
                  <div className="mt-1 font-mono-num text-base font-bold text-emerald-700">
                    {selectedProduct.availableQty}
                  </div>
                </div>
              </div>

              {(() => {
                const descHtml = getProductDescHtml(selectedProduct);
                const warrantyText = getWarrantyDisplay(selectedProduct);
                return (
                  <div className="rounded-xl bg-slate-50/70 border border-slate-100 p-4 text-xs text-slate-700 leading-relaxed space-y-2">
                    {descHtml && <TelegramHtmlRenderer html={descHtml} />}
                    <div
                      className={`${descHtml ? 'border-t border-slate-200/70 pt-2' : ''} text-slate-500`}
                    >
                      {isEn ? (
                        <>
                          Duration: {selectedProduct.durationLabel || 'Instant Delivery'}
                          {warrantyText ? ` · Warranty: ${warrantyText}` : ''}
                        </>
                      ) : (
                        <>
                          المدة: {selectedProduct.durationLabel || 'تسليم فوري'}
                          {warrantyText ? ` · الضمان: ${warrantyText}` : ''}
                        </>
                      )}
                    </div>
                  </div>
                );
              })()}

              <div className="pt-1 text-sm font-semibold text-slate-900">
                {isEn
                  ? 'Choose Buy Quantity:'
                  : 'اختر الكمية المطلوبة (Choose Buy Quantity):'}
              </div>
            </SurfacePanel>

            {/* Reference-Matched Button Grid: 1-3, 4-6 (Blue) -> Custom Quantity (Green) -> Back to Products -> Back to Menu */}
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-2" dir="ltr">
                {PRESET_QUANTITIES.slice(0, 3).map((q) => {
                  const active = selectedQty === q;
                  return (
                    <button
                      key={q}
                      type="button"
                      onClick={() => handleSelectQuantity(q)}
                      className={`rounded-xl px-4 py-3 font-mono-num text-sm font-bold text-white transition-all ${
                        active
                          ? 'bg-sky-800 ring-2 ring-sky-400 ring-offset-1'
                          : 'bg-sky-600 hover:bg-sky-700'
                      }`}
                    >
                      {q}
                    </button>
                  );
                })}
              </div>

              <div className="grid grid-cols-3 gap-2" dir="ltr">
                {PRESET_QUANTITIES.slice(3, 6).map((q) => {
                  const active = selectedQty === q;
                  return (
                    <button
                      key={q}
                      type="button"
                      onClick={() => handleSelectQuantity(q)}
                      className={`rounded-xl px-4 py-3 font-mono-num text-sm font-bold text-white transition-all ${
                        active
                          ? 'bg-sky-800 ring-2 ring-sky-400 ring-offset-1'
                          : 'bg-sky-600 hover:bg-sky-700'
                      }`}
                    >
                      {q}
                    </button>
                  );
                })}
              </div>

              {/* Full-Width Green Custom Quantity Button */}
              <button
                type="button"
                onClick={() => {
                  setCustomQtyOpen((prev) => !prev);
                  setQtyError(null);
                }}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-bold text-white hover:bg-emerald-700 transition-colors"
              >
                <ClipboardList className="h-4 w-4" />
                <span>{isEn ? 'Custom Quantity' : 'Custom Quantity — كمية مخصصة'}</span>
              </button>

              {/* Inline Manual Custom Quantity Form */}
              {customQtyOpen && (
                <form
                  onSubmit={handleApplyCustomQuantity}
                  className="rounded-xl border border-emerald-200 bg-white p-4 space-y-3 shadow-xs"
                >
                  <label
                    htmlFor="custom-qty-input"
                    className="block text-xs font-semibold text-slate-800"
                  >
                    {isEn
                      ? `Enter quantity manually (1 to ${selectedProduct.availableQty}):`
                      : `أدخل الكمية المطلوبة يدويًا (من 1 إلى ${selectedProduct.availableQty}):`}
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id="custom-qty-input"
                      type="text"
                      inputMode="numeric"
                      value={customQtyInput}
                      onChange={(e) => setCustomQtyInput(e.target.value)}
                      placeholder={isEn ? 'e.g. 7 or 15' : 'مثال: 7 أو 15'}
                      className="flex-1 rounded-xl border border-slate-300 px-3.5 py-2 text-sm font-mono-num text-slate-900 focus:border-emerald-600 focus:outline-none"
                    />
                    <button
                      type="submit"
                      className="rounded-xl bg-emerald-700 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-800 whitespace-nowrap"
                    >
                      {isEn ? 'Apply' : 'اعتماد الكمية'}
                    </button>
                  </div>
                </form>
              )}

              {qtyError && (
                <FeedbackBanner type="err" text={qtyError} onDismiss={() => setQtyError(null)} />
              )}

              {/* Full-Width Blue Back to Products Button */}
              <button
                type="button"
                onClick={handleBackToProducts}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-3 text-sm font-bold text-white hover:bg-sky-700 transition-colors"
              >
                <ArrowLeft className="h-4 w-4" />
                <span>{isEn ? 'Back to Products' : 'رجوع إلى المنتجات (Back to Products)'}</span>
              </button>

              {/* Full-Width Blue Back to Menu Button */}
              <button
                type="button"
                onClick={handleBackToMenu}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-3 text-sm font-bold text-white hover:bg-sky-700 transition-colors"
              >
                <Home className="h-4 w-4" />
                <span>{isEn ? 'Back to Menu' : 'الرجوع للقائمة الرئيسية (Back to Menu)'}</span>
              </button>
            </div>

            {/* ============================================================ */}
            {/* TRANSACTION CONFIRMATION MESSAGE — DIRECTLY BELOW QUANTITIES */}
            {/* ============================================================ */}
            {selectedQty !== null && (
              <div className="pt-2 space-y-2.5" data-testid="transaction-confirmation-panel">
                <SurfacePanel className="p-5 space-y-3 border-slate-300/90">
                  <div className="flex items-center gap-2 text-base font-bold text-slate-900 border-b border-slate-100 pb-2.5">
                    <ShoppingCart className="h-4 w-4 text-emerald-700" />
                    <span>{isEn ? 'CONFIRM PURCHASE' : 'تأكيد الشراء — CONFIRM PURCHASE'}</span>
                  </div>

                  <div className="space-y-1.5 text-sm text-slate-800">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-600">
                        {isEn ? '🧾 Order ID:' : '🧾 رقم الطلب (Order ID):'}
                      </span>
                      <span className="font-mono-num font-semibold text-slate-900">
                        {previewOrderRef}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-600">
                        {isEn ? '🏪 Product:' : '🏪 المنتج (Product):'}
                      </span>
                      <span className="font-semibold text-slate-900 truncate max-w-[240px]">
                        {getProductTitle(selectedProduct)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-600">
                        {isEn ? '🧮 Quantity:' : '🧮 الكمية (Quantity):'}
                      </span>
                      <span className="font-mono-num font-bold text-slate-900">{selectedQty}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-600">
                        {isEn ? '💲 Unit Price:' : '💲 سعر الوحدة (Unit Price):'}
                      </span>
                      <span className="font-mono-num font-semibold text-slate-900">
                        {formatStoreMoney(unitPriceNum)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-600">
                        {isEn ? '💰 Total:' : '💰 الإجمالي (Total):'}
                      </span>
                      <span className="font-mono-num text-base font-bold text-slate-900">
                        {formatStoreMoney(totalAmountNum)}
                      </span>
                    </div>
                  </div>

                  <div className="border-t border-slate-100 pt-2.5 space-y-1.5 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-600">
                        {isEn ? '💎 Your Balance:' : '💎 رصيدك الحالي (Your Balance):'}
                      </span>
                      <span className="font-mono-num font-semibold text-slate-900">
                        {formatStoreMoney(currentBalanceNum)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-600">
                        {isEn ? '💎 After Purchase:' : '💎 الرصيد بعد الشراء (After Purchase):'}
                      </span>
                      <span
                        className={`font-mono-num font-bold ${
                          afterPurchaseNum >= 0 ? 'text-emerald-700' : 'text-rose-600'
                        }`}
                      >
                        {formatStoreMoney(afterPurchaseNum)}
                      </span>
                    </div>
                  </div>

                  <div className="pt-1 text-sm font-semibold text-slate-900">
                    {isEn
                      ? 'Confirm your purchase?'
                      : 'هل تؤكد إتمام عملية الشراء؟ (Confirm your purchase?)'}
                  </div>
                </SurfacePanel>

                {/* Two Side-by-Side Action Buttons Directly Below Transaction Message */}
                <div className="grid grid-cols-2 gap-2.5" dir="ltr">
                  <button
                    type="button"
                    disabled={submittingOrder}
                    onClick={() => void handleConfirmPurchase()}
                    className="flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                  >
                    <Check className="h-4 w-4" />
                    <span>
                      {submittingOrder
                        ? isEn
                          ? 'Confirming...'
                          : 'جارٍ التأكيد...'
                        : isEn
                          ? 'Confirm'
                          : 'Confirm — تأكيد'}
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={submittingOrder}
                    onClick={handleCancelTransaction}
                    className="flex items-center justify-center gap-2 rounded-xl bg-rose-600 px-4 py-3 text-sm font-bold text-white hover:bg-rose-700 disabled:opacity-50 transition-colors"
                  >
                    <X className="h-4 w-4" />
                    <span>{isEn ? 'Cancel' : 'Cancel — إلغاء'}</span>
                  </button>
                </div>
              </div>
            )}
          </section>
        ) : (
          <>
            {/* Storefront Header + 3 Executive Customer KPI Cards */}
            <section className="space-y-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between border-b border-slate-200/80 pb-5">
                <div className="min-w-0">
                  <h1 className="text-2xl sm:text-[28px] font-bold text-slate-900 tracking-tight">
                    {isEn ? 'Digital Catalog' : 'المنتجات الرقمية المتوفرة'}
                  </h1>
                  <p className="mt-1.5 text-sm text-slate-500 max-w-2xl">{welcomeMessage}</p>
                </div>
                <SemanticStatus
                  tone="positive"
                  label={isEn ? 'Instant Automated Delivery' : 'تسليم فوري تلقائي'}
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <KpiCard
                  icon={Wallet}
                  label={isEn ? 'Available Balance' : 'رصيد المحفظة المتاح'}
                  value={formatStoreMoney(customerWallet?.availableBalance || 0)}
                  valueTone={currentBalanceNum > 0 ? 'positive' : 'default'}
                  tone={currentBalanceNum > 0 ? 'positive' : 'neutral'}
                  indicatorText={
                    preferredCurrency === 'YER'
                      ? isEn
                        ? 'YER ﷼ Live'
                        : 'بالريال اليمني'
                      : isEn
                        ? 'Ready'
                        : 'جاهز للشراء'
                  }
                />
                <KpiCard
                  icon={ShoppingBag}
                  label={isEn ? 'Available Products' : 'المنتجات المتوفرة'}
                  value={inStockCount}
                  tone={inStockCount > 0 ? 'positive' : 'warning'}
                  indicatorText={`${customerCatalog.length} ${isEn ? 'total' : 'إجمالي'}`}
                />
                <KpiCard
                  icon={ReceiptText}
                  label={isEn ? 'My Orders' : 'طلباتي المكتملة'}
                  value={customerOrders.length}
                  tone={customerOrders.length > 0 ? 'positive' : 'neutral'}
                  indicatorText={isEn ? 'Instant history' : 'سجل التسليمات'}
                />
              </div>

              {categoriesList.length > 1 && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setSelectedCategory('all')}
                    className={`rounded-xl px-4 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                      selectedCategory === 'all'
                        ? 'bg-slate-900 text-white shadow-xs'
                        : 'border border-slate-200/90 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {isEn ? `All (${customerCatalog.length})` : `الكل (${customerCatalog.length})`}
                  </button>
                  {categoriesList.map((cat) => (
                    <button
                      key={cat.key}
                      type="button"
                      onClick={() => setSelectedCategory(cat.key)}
                      className={`rounded-xl px-4 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                        selectedCategory === cat.key
                          ? 'bg-emerald-700 text-white shadow-xs'
                          : 'border border-slate-200/90 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              )}
            </section>

            {/* Executive 3-Column Product Catalog Grid */}
            <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredCatalog.map((item) => {
                const inStock = item.availableQty > 0;
                return (
                  <div
                    key={item.id}
                    className="bg-white border border-slate-200/85 hover:border-slate-300 rounded-2xl p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)] flex flex-col justify-between gap-5 transition-all duration-150"
                  >
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                        <span className="truncate font-medium">
                          {getCategoryDisplay(item)} ·{' '}
                          {item.durationLabel || (isEn ? 'Instant' : 'تسليم فوري')}
                        </span>
                        <span
                          className={`font-semibold shrink-0 ${
                            inStock ? 'text-emerald-700' : 'text-rose-600'
                          }`}
                        >
                          {isEn ? 'Stock: ' : 'المخزون: '}
                          <span className="font-mono-num">{item.availableQty}</span>
                        </span>
                      </div>

                      <h2 className="text-base font-bold text-slate-900 leading-snug">
                        {getProductTitle(item)}
                      </h2>

                      {getProductDescHtml(item) && (
                        <TelegramHtmlRenderer
                          html={getProductDescHtml(item)}
                          compact
                          className="text-xs text-slate-600 leading-relaxed line-clamp-3"
                        />
                      )}

                      {getWarrantyDisplay(item) && (
                        <div className="text-[11px] text-slate-400 flex items-center gap-1.5">
                          <Package className="h-3 w-3 shrink-0" />
                          <span className="truncate">{getWarrantyDisplay(item)}</span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
                      <div>
                        <div className="text-[10px] text-slate-400">
                          {isEn ? 'Price' : 'السعر'}
                        </div>
                        <span className="font-mono-num text-xl font-bold text-slate-900">
                          {formatStoreMoney(item.promoPrice || item.retailPrice)}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => openProductPage(item.id)}
                        className="rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white hover:bg-emerald-700 whitespace-nowrap transition-colors shrink-0"
                      >
                        {isEn ? 'Open Product' : 'فتح المنتج'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </section>
          </>
        )}

        {/* Customer Orders & Instant Deliveries */}
        {customerOrders.length > 0 && (
          <SurfacePanel className="overflow-hidden">
            <SectionHeader
              title={isEn ? 'My Orders & Deliveries' : 'طلباتي وتسليماتي'}
              subtitle={
                isEn
                  ? `${customerOrders.length} recorded deliveries`
                  : `${customerOrders.length} طلبات مسجلة في حسابك`
              }
              icon={ReceiptText}
            />
            <div className="divide-y divide-slate-100 px-5 text-xs">
              {customerOrders.map((o) => (
                <div
                  key={o.orderNumber}
                  className="py-3.5 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <span className="font-mono-num font-bold text-slate-900">{o.orderNumber}</span>
                    <span className="mx-2 text-slate-300">·</span>
                    <span className="text-slate-700 font-medium">{o.items?.[0]?.titleAr}</span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="font-mono-num text-emerald-700 font-semibold">
                      {o.delivery?.payloadItems?.[0] || (isEn ? 'Delivering...' : 'جاري التسليم')}
                    </span>
                    <span className="font-mono-num font-bold text-slate-900">
                      {formatStoreMoney(
                        o.totalRetail,
                        o.displayExchangeRate ? Number(o.displayExchangeRate) : undefined
                      )}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </SurfacePanel>
        )}

        {/* Customer Local Wallets Deposit Requests */}
        {localDeposits.length > 0 && (
          <SurfacePanel className="overflow-hidden">
            <SectionHeader
              title={isEn ? 'Local Wallet Deposits (YER)' : 'طلبات الشحن عبر المحافظ المحلية'}
              subtitle={
                isEn
                  ? `${localDeposits.length} deposit requests`
                  : `${localDeposits.length} طلب إيداع محلي`
              }
              icon={Landmark}
            />
            <div className="divide-y divide-slate-100 px-5 text-xs">
              {localDeposits.map((ld) => {
                const statusTone =
                  ld.status === 'approved'
                    ? 'positive'
                    : ld.status === 'rejected'
                      ? 'negative'
                      : 'warning';
                const statusLabel =
                  ld.status === 'approved'
                    ? isEn
                      ? 'Approved'
                      : 'تمت الموافقة'
                    : ld.status === 'rejected'
                      ? isEn
                        ? 'Rejected'
                        : 'مرفوض'
                      : isEn
                        ? 'Pending Review'
                        : 'قيد المراجعة';
                return (
                  <div
                    key={ld.id}
                    className="py-3.5 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono-num font-bold text-slate-900">{ld.depositRef}</span>
                        <span className="text-slate-300">·</span>
                        <span className="font-semibold text-slate-700">{ld.walletNameSnapshot}</span>
                        <SemanticStatus tone={statusTone} label={statusLabel} />
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {isEn ? 'Depositor:' : 'اسم المودع:'} {ld.depositorNameUsed}
                        {ld.status === 'rejected' && ld.rejectionReason ? (
                          <span className="text-rose-600 font-medium">
                            {' '}— {ld.rejectionReason}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 font-mono-num font-bold text-slate-900">
                      {preferredCurrency === 'YER'
                        ? `${Math.round(Number(ld.amountYer || 0)).toLocaleString('en-US')} ﷼`
                        : `${Math.round(Number(ld.amountYer || 0)).toLocaleString('en-US')} ﷼ ($${Number(ld.equivalentUsd || 0).toFixed(2)})`}
                    </div>
                  </div>
                );
              })}
            </div>
          </SurfacePanel>
        )}

        <CustomerLocalDepositModal
          open={localDepositModalOpen}
          webLang={webLang}
          onClose={() => setLocalDepositModalOpen(false)}
          onSubmitted={refreshAllStoreData}
        />

        {/* Compact Collapsible RBAC Security Verification Strip */}
        <footer className="pt-2">
          <div className="rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-3">
            <button
              type="button"
              onClick={() => setRbacPanelOpen((prev) => !prev)}
              className="flex w-full items-center justify-between gap-2 text-xs font-medium text-slate-500 hover:text-slate-800 transition-colors"
            >
              <span className="inline-flex items-center gap-2">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-700 shrink-0" />
                <span>
                  {isEn
                    ? 'Isolated Customer Session — Server RBAC Protection Check'
                    : 'جلسة عميل معزولة — التحقق المباشر من حماية صلاحيات الخادم (RBAC)'}
                </span>
              </span>
              {rbacPanelOpen ? (
                <ChevronUp className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              )}
            </button>

            {rbacPanelOpen && (
              <div className="mt-3 border-t border-slate-100 pt-3 space-y-2.5">
                <p className="text-xs text-slate-500">
                  {isEn ? (
                    <>
                      Signed in as a standard customer. Test calling{' '}
                      <span className="font-mono-num text-slate-700">/api/admin/overview</span>{' '}
                      directly to verify server-side authorization.
                    </>
                  ) : (
                    <>
                      أنت مسجل حاليًا كعميل عادي. اضغط لاختبار محاولة طلب{' '}
                      <span className="font-mono-num text-slate-700">/api/admin/overview</span>{' '}
                      مباشرة من الخادم.
                    </>
                  )}
                </p>
                <button
                  type="button"
                  onClick={() => void attemptAdminIntrusion()}
                  className="rounded-xl border border-slate-200 bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors"
                >
                  {isEn ? 'Test Admin API Isolation' : 'محاولة الوصول المباشر إلى API الإدارة'}
                </button>
                {customerRbacTestMsg && (
                  <FeedbackBanner
                    type="ok"
                    text={customerRbacTestMsg}
                    onDismiss={() => setCustomerRbacTestMsg(null)}
                  />
                )}
              </div>
            )}
          </div>
        </footer>
      </main>
    </div>
  );
}
