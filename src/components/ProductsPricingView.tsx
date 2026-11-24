import React, { useEffect, useMemo, useState } from 'react';
import Decimal from 'decimal.js';
import {
  Eye,
  EyeOff,
  Pencil,
  Layers,
  PauseCircle,
  PlayCircle,
  Plus,
  Search,
  Trash2,
  Check,
  Wand2,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  Crown,
  Link2,
  Unlink,
  Sparkles,
  Server,
  Languages,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { classifyOfferBrand } from '../lib/offerClassifier';
import {
  FeedbackBanner,
  KpiCard,
  PageHeader,
  SectionHeader,
  SemanticStatus,
  SurfacePanel,
} from './ui/AdminPrimitives';

export type ProviderRoutingState =
  | 'active_now'
  | 'standby'
  | 'out_of_stock'
  | 'low_balance'
  | 'offline'
  | 'paused';

export interface AdminProductOffer {
  mappingId: number;
  providerId: number;
  providerName: string;
  providerStatus: string;
  providerEnabled?: boolean;
  providerBalance?: string;
  providerProductId: number;
  externalProductId: string;
  rawName: string;
  wholesalePrice: string;
  stockCount: number;
  roleType: string;
  priority: number;
  routingState?: ProviderRoutingState;
  isActiveRoutingTarget?: boolean;
  selectionStrategy: string;
  durationLabel: string | null;
  warrantyDays: number;
  deliveryType?: string;
  isActive: boolean;
}

export interface AdminProductItem {
  id: number;
  sku: string;
  categoryId: number | null;
  categoryNameAr: string;
  titleAr: string;
  titleEn?: string | null;
  descriptionAr: string;
  descriptionEn?: string | null;
  imageUrl: string | null;
  warrantyLabelAr: string;
  warrantyLabelEn?: string | null;
  deliveryInstructionsAr: string | null;
  deliveryInstructionsEn?: string | null;
  durationLabel: string;
  deliveryType: string;
  isVisible: boolean;
  isPaused: boolean;
  autoHideOutOfStock: boolean;
  isFeaturedOffer: boolean;
  sortOrder: number;
  primaryProviderId: number | null;
  primaryProviderName: string;
  activeRoutingProviderId?: number | null;
  activeRoutingProviderName?: string | null;
  activeRoutingRank?: number | null;
  wholesalePrice: string;
  retailPrice: string;
  agentPrice?: string;
  paymentFee: string;
  expectedNetProfit: string;
  marginPercent: string;
  agentExpectedNetProfit?: string;
  agentMarginPercent?: string;
  totalStock: number;
  pricingRule: {
    pricingMode: 'manual' | 'fixed_margin' | 'percent_margin';
    retailPrice: string;
    agentPrice?: string | null;
    fixedMargin: string;
    percentMargin: string;
    paymentFeePercent: string;
    extraFixedCost: string;
    promoPrice: string | null;
    lockManualPrice: boolean;
  } | null;
  providerOffers: AdminProductOffer[];
}

export interface AvailableProviderProduct {
  id: number;
  providerId: number;
  providerName: string;
  providerCode?: string;
  providerStatus?: string;
  providerEnabled?: boolean;
  providerBalance?: string;
  externalProductId?: string;
  rawName: string;
  rawDescription?: string;
  wholesalePrice: string;
  stockCount: number;
  durationLabel: string | null;
  deliveryType: string;
  warrantyDays: number;
  linkedStoreProductId?: number | null;
  linkedStoreProductTitle?: string | null;
  linkedIsVisible?: boolean;
  linkedCategoryId?: number | null;
  linkedCategoryName?: string | null;
}

export interface CategoryItem {
  id: number;
  slug: string;
  nameAr: string;
  nameEn?: string | null;
  iconEmoji?: string;
}

interface ProductsPricingViewProps {
  products: AdminProductItem[];
  availableProviderProducts: AvailableProviderProduct[];
  categories: CategoryItem[];
  providers: Array<{ id: number; name: string }>;
  onRefresh: () => Promise<void>;
}

function getRoutingStatus(state?: ProviderRoutingState): {
  label: string;
  tone: 'positive' | 'warning' | 'negative' | 'neutral';
} {
  switch (state) {
    case 'active_now':
      return { label: 'نشط الآن', tone: 'positive' };
    case 'standby':
      return { label: 'احتياطي جاهز', tone: 'neutral' };
    case 'out_of_stock':
      return { label: 'نفد المخزون', tone: 'negative' };
    case 'low_balance':
      return { label: 'رصيد غير كافٍ', tone: 'warning' };
    case 'paused':
      return { label: 'متوقف مؤقتًا', tone: 'neutral' };
    default:
      return { label: 'غير متصل', tone: 'negative' };
  }
}

export default function ProductsPricingView({
  products,
  availableProviderProducts,
  categories,
  providers,
  onRefresh,
}: ProductsPricingViewProps) {
  const [search, setSearch] = useState('');
  const [filterVis, setFilterVis] = useState<'all' | 'visible' | 'hidden'>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [quickPrice, setQuickPrice] = useState('');
  const [quickAgentPrice, setQuickAgentPrice] = useState('');
  const [newCatName, setNewCatName] = useState('');

  const [matcherOnlyRelevant, setMatcherOnlyRelevant] = useState(true);
  const [matcherServerId, setMatcherServerId] = useState<string>('all');
  const [matcherSearch, setMatcherSearch] = useState('');

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState({
    title: '',
    description: '',
    categoryId: '',
    retailPrice: '1.00',
    agentPrice: '0.85',
    durationLabel: '6 أشهر',
    warrantyLabel: 'ضمان التشغيل طوال المدة',
    isVisible: true,
  });
  const [createTitlePreview, setCreateTitlePreview] = useState<{ textAr: string; textEn: string } | null>(null);
  const [createDescPreview, setCreateDescPreview] = useState<{ textAr: string; textEn: string } | null>(null);
  const [translatingKey, setTranslatingKey] = useState<string | null>(null);
  const [modalTranslateNotice, setModalTranslateNotice] = useState<string | null>(null);
  const [createSelectedOfferIds, setCreateSelectedOfferIds] = useState<number[]>([]);
  const [createOfferSearch, setCreateOfferSearch] = useState('');

  const [showAutoCatModal, setShowAutoCatModal] = useState(false);
  const [autoCatScope, setAutoCatScope] = useState<'uncategorized' | 'all'>('uncategorized');
  const [autoCatCreateMissing, setAutoCatCreateMissing] = useState(true);

  const [deleteTarget, setDeleteTarget] = useState<AdminProductItem | null>(null);

  const [editing, setEditing] = useState<AdminProductItem | null>(null);
  const [editManualBilingual, setEditManualBilingual] = useState(false);
  const [editTitlePreview, setEditTitlePreview] = useState<{ textAr: string; textEn: string } | null>(null);
  const [editDescPreview, setEditDescPreview] = useState<{ textAr: string; textEn: string } | null>(null);
  const [editForm, setEditForm] = useState({
    title: '',
    description: '',
    titleAr: '',
    titleEn: '',
    descriptionAr: '',
    descriptionEn: '',
    warrantyLabel: '',
    warrantyLabelAr: '',
    warrantyLabelEn: '',
    categoryId: '',
    durationLabel: '',
    sortOrder: 10,
    isVisible: false,
    isFeaturedOffer: false,
    autoHideOutOfStock: true,
    pricingMode: 'manual' as 'manual' | 'fixed_margin' | 'percent_margin',
    retailPrice: '3.00',
    agentPrice: '2.50',
    fixedMargin: '2.00',
    percentMargin: '100',
    paymentFeePercent: '1.50',
    extraFixedCost: '0.00',
    promoPrice: '',
    lockManualPrice: true,
  });

  const { categoryCounts, uncategorizedCount, publishedCount, hiddenCount, outOfStockPublished } = useMemo(() => {
    const counts = new Map<number, number>();
    let uncat = 0;
    let pub = 0;
    let hid = 0;
    let oos = 0;
    for (const p of products) {
      if (p.categoryId === null) uncat += 1;
      else counts.set(p.categoryId, (counts.get(p.categoryId) || 0) + 1);
      if (p.isVisible && !p.isPaused) {
        pub += 1;
        if (p.totalStock <= 0) oos += 1;
      } else {
        hid += 1;
      }
    }
    return {
      categoryCounts: counts,
      uncategorizedCount: uncat,
      publishedCount: pub,
      hiddenCount: hid,
      outOfStockPublished: oos,
    };
  }, [products]);

  const filteredProducts = useMemo(() => {
    const list = products.filter((p) => {
      if (filterVis === 'visible' && (!p.isVisible || p.isPaused)) return false;
      if (filterVis === 'hidden' && p.isVisible) return false;
      if (filterCategory === 'uncategorized') {
        if (p.categoryId !== null) return false;
      } else if (filterCategory !== 'all' && String(p.categoryId) !== filterCategory) {
        return false;
      }
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const hay = `${p.titleAr} ${p.titleEn || ''} ${p.sku} ${p.categoryNameAr}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    return [...list].sort((a, b) => {
      const aVis = a.isVisible && !a.isPaused ? 1 : 0;
      const bVis = b.isVisible && !b.isPaused ? 1 : 0;
      if (aVis !== bVis) return bVis - aVis;
      if (a.providerOffers.length !== b.providerOffers.length) {
        return b.providerOffers.length - a.providerOffers.length;
      }
      return a.sortOrder - b.sortOrder;
    });
  }, [products, filterVis, filterCategory, search]);

  useEffect(() => {
    if (filteredProducts.length === 0) {
      setSelectedProductId(null);
      return;
    }
    if (!selectedProductId || !filteredProducts.some((p) => p.id === selectedProductId)) {
      setSelectedProductId(filteredProducts[0].id);
    }
  }, [filteredProducts, selectedProductId]);

  const selectedProduct = useMemo(
    () => products.find((p) => p.id === selectedProductId) || null,
    [products, selectedProductId]
  );

  useEffect(() => {
    if (selectedProduct) {
      setQuickPrice(Number(selectedProduct.retailPrice).toFixed(2));
      setQuickAgentPrice(Number(selectedProduct.agentPrice ?? selectedProduct.retailPrice).toFixed(2));
    }
  }, [selectedProduct?.id, selectedProduct?.retailPrice, selectedProduct?.agentPrice]);

  const smartCandidateOffers = useMemo(() => {
    if (!selectedProduct) return [];
    const linkedIds = new Set(selectedProduct.providerOffers.map((o) => o.providerProductId));
    const prodBrand = classifyOfferBrand(
      `${selectedProduct.titleAr} ${selectedProduct.titleEn || ''} ${selectedProduct.categoryNameAr}`,
      selectedProduct.descriptionAr || ''
    );
    const stopTokens = new Set([
      'plus', 'pro', 'month', 'months', 'year', 'years', '12m', '6m', '1m', '3m', '24m',
      'free', 'trial', 'plan', 'offer', 'link', 'links', 'account', 'super', 'premium',
      'ultra', 'basic', 'max', 'auto', 'instant', 'card', 'needed', 'education', 'business',
      'family', 'individual', 'official', 'recharge', 'cdk', 'slot', 'private',
      'اشتراك', 'أشهر', 'شهر', 'فوري', 'تفعيل', 'سنة', 'باقة', 'كاملة', 'واحد',
    ]);
    const titleTokens = `${selectedProduct.titleAr} ${selectedProduct.titleEn || ''}`
      .toLowerCase()
      .split(/[\s\-—_/()[\]]+/)
      .filter((tok) => tok.length >= 3 && !stopTokens.has(tok));

    const pool = availableProviderProducts.filter((ap) => !linkedIds.has(ap.id));

    const scored = pool
      .map((ap) => {
        const offerBrand = classifyOfferBrand(ap.rawName, ap.rawDescription || '');
        const lowName = `${ap.rawName} ${ap.rawDescription || ''}`.toLowerCase();
        const brandMatch = prodBrand.key !== 'other' && offerBrand.key === prodBrand.key;
        const tokenHits = titleTokens.filter((tok) => lowName.includes(tok)).length;
        const relevant = prodBrand.key !== 'other' ? brandMatch : tokenHits > 0;
        const score = (brandMatch ? 100 : 0) + tokenHits * 25 + (ap.stockCount > 0 ? 10 : 0);
        return { ap, relevant, score, offerBrand };
      })
      .filter(({ ap, relevant }) => {
        if (matcherServerId !== 'all' && String(ap.providerId) !== matcherServerId) return false;
        if (matcherSearch.trim()) {
          const q = matcherSearch.trim().toLowerCase();
          const hay = `${ap.rawName} ${ap.providerName} ${ap.externalProductId || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
          return true;
        }
        if (matcherOnlyRelevant && (prodBrand.key !== 'other' || titleTokens.length > 0)) {
          return relevant;
        }
        return true;
      });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aStock = a.ap.stockCount > 0 ? 1 : 0;
      const bStock = b.ap.stockCount > 0 ? 1 : 0;
      if (aStock !== bStock) return bStock - aStock;
      return Number(a.ap.wholesalePrice) - Number(b.ap.wholesalePrice);
    });

    return scored;
  }, [selectedProduct, availableProviderProducts, matcherOnlyRelevant, matcherServerId, matcherSearch]);

  const createMatchingOffers = useMemo(() => {
    const selectedCat = categories.find((c) => String(c.id) === createForm.categoryId);
    const seedText = `${createForm.title} ${selectedCat?.nameAr || ''} ${selectedCat?.nameEn || ''}`;
    const targetBrand = classifyOfferBrand(seedText, '');
    const q = createOfferSearch.trim().toLowerCase();

    return [...availableProviderProducts]
      .filter((ap) => {
        if (q) return `${ap.rawName} ${ap.providerName}`.toLowerCase().includes(q);
        if (targetBrand.key !== 'other') {
          return classifyOfferBrand(ap.rawName, ap.rawDescription || '').key === targetBrand.key;
        }
        return true;
      })
      .sort((a, b) => {
        const aSel = createSelectedOfferIds.includes(a.id) ? 1 : 0;
        const bSel = createSelectedOfferIds.includes(b.id) ? 1 : 0;
        if (aSel !== bSel) return bSel - aSel;
        if ((b.stockCount > 0 ? 1 : 0) !== (a.stockCount > 0 ? 1 : 0)) {
          return (b.stockCount > 0 ? 1 : 0) - (a.stockCount > 0 ? 1 : 0);
        }
        return Number(a.wholesalePrice) - Number(b.wholesalePrice);
      })
      .slice(0, 40);
  }, [availableProviderProducts, createForm.title, createForm.categoryId, categories, createOfferSearch, createSelectedOfferIds]);

  const liveProfitPreview = useMemo(() => {
    if (!editing) return null;
    try {
      const wholesale = new Decimal(editing.wholesalePrice || '0');
      let retail = new Decimal(editForm.retailPrice || '0');
      if (editForm.pricingMode === 'fixed_margin') {
        retail = wholesale.plus(editForm.fixedMargin || '0');
      } else if (editForm.pricingMode === 'percent_margin') {
        retail = wholesale.times(new Decimal(1).plus(new Decimal(editForm.percentMargin || '0').div(100)));
      }
      if (editForm.promoPrice && new Decimal(editForm.promoPrice).gt(0)) {
        retail = new Decimal(editForm.promoPrice);
      }
      const feePct = new Decimal(editForm.paymentFeePercent || '0').div(100);
      const fee = retail.times(feePct);
      const extra = new Decimal(editForm.extraFixedCost || '0');
      const net = retail.minus(wholesale).minus(fee).minus(extra);

      const agentRaw = editForm.agentPrice.trim() ? new Decimal(editForm.agentPrice) : retail;
      const agentFee = agentRaw.times(feePct);
      const agentNet = agentRaw.minus(wholesale).minus(agentFee).minus(extra);

      return {
        retail: retail.toFixed(2),
        fee: fee.toFixed(2),
        net: net.toFixed(2),
        negative: net.lte(0),
        agentPrice: agentRaw.toFixed(2),
        agentNet: agentNet.toFixed(2),
        agentNegative: agentNet.lte(0),
      };
    } catch {
      return null;
    }
  }, [editing, editForm]);

  const handleAddCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCatName.trim()) return;
    setBusy(true);
    try {
      await apiFetch('/api/admin/categories', {
        method: 'POST',
        body: JSON.stringify({ nameAr: newCatName.trim() }),
      });
      setNewCatName('');
      setFeedback({ type: 'ok', text: `تمت إضافة القسم "${newCatName.trim()}" بنجاح.` });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر إضافة القسم.' });
    } finally {
      setBusy(false);
    }
  };

  const previewTranslation = async (
    key: 'create_title' | 'create_desc' | 'edit_title' | 'edit_desc',
    text: string,
    context: 'product_title' | 'product_description'
  ) => {
    const clean = text.trim();
    if (!clean) return;
    setTranslatingKey(key);
    setModalTranslateNotice(null);
    try {
      const res = await apiFetch<{ ok: boolean; textAr: string; textEn: string }>('/api/admin/translate', {
        method: 'POST',
        body: JSON.stringify({ text: clean, context }),
      });
      const pair = { textAr: res.textAr || clean, textEn: res.textEn || clean };
      if (key === 'create_title') setCreateTitlePreview(pair);
      else if (key === 'create_desc') setCreateDescPreview(pair);
      else if (key === 'edit_title') setEditTitlePreview(pair);
      else if (key === 'edit_desc') setEditDescPreview(pair);
    } catch (err: any) {
      setModalTranslateNotice(err?.message || 'تعذر معاينة الترجمة حاليًا.');
    } finally {
      setTranslatingKey(null);
    }
  };

  const handleCreateProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createForm.title.trim()) return;
    const customerNum = Number(createForm.retailPrice);
    const agentNum = Number(createForm.agentPrice);
    if (!Number.isFinite(customerNum) || customerNum <= 0) {
      setFeedback({ type: 'err', text: 'يرجى إدخال سعر عميل صالح أكبر من 0.' });
      return;
    }
    if (!Number.isFinite(agentNum) || agentNum <= 0) {
      setFeedback({ type: 'err', text: 'يرجى إدخال سعر وكيل صالح أكبر من 0.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ ok: boolean; product: { id: number; titleAr: string; titleEn?: string } }>(
        '/api/admin/products',
        {
          method: 'POST',
          body: JSON.stringify({
            title: createForm.title.trim(),
            description: createForm.description.trim(),
            categoryId: createForm.categoryId ? Number(createForm.categoryId) : null,
            retailPrice: customerNum.toFixed(2),
            agentPrice: agentNum.toFixed(2),
            durationLabel: createForm.durationLabel.trim(),
            warrantyLabel: createForm.warrantyLabel.trim(),
            isVisible: createForm.isVisible,
            initialProviderProductIds: createSelectedOfferIds,
          }),
        }
      );
      setShowCreateModal(false);
      setCreateSelectedOfferIds([]);
      setCreateOfferSearch('');
      setCreateTitlePreview(null);
      setCreateDescPreview(null);
      setCreateForm({
        title: '',
        description: '',
        categoryId: filterCategory !== 'all' && filterCategory !== 'uncategorized' ? filterCategory : '',
        retailPrice: '1.00',
        agentPrice: '0.85',
        durationLabel: '6 أشهر',
        warrantyLabel: 'ضمان التشغيل طوال المدة',
        isVisible: true,
      });
      if (res.product?.id) setSelectedProductId(res.product.id);
      setFeedback({
        type: 'ok',
        text: `تم إنشاء "${res.product?.titleAr}" بسعر العميل $${customerNum.toFixed(2)} وسعر الوكيل $${agentNum.toFixed(2)}.`,
      });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر إنشاء المنتج.' });
    } finally {
      setBusy(false);
    }
  };

  const quickToggleVisibility = async (p: AdminProductItem) => {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ ok: boolean; autoAssignedCategory?: string | null }>(`/api/admin/products/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isVisible: !p.isVisible }),
      });
      setFeedback({
        type: 'ok',
        text: !p.isVisible
          ? res.autoAssignedCategory
            ? `تم نشر "${p.titleAr}" في "${res.autoAssignedCategory}".`
            : `تم نشر "${p.titleAr}" بسعر $${p.retailPrice}.`
          : `تم إخفاء "${p.titleAr}".`,
      });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تغيير حالة الظهور.' });
    } finally {
      setBusy(false);
    }
  };

  const quickChangeCategory = async (p: AdminProductItem, nextCategoryIdStr: string) => {
    setBusy(true);
    setFeedback(null);
    try {
      const nextCategoryId = nextCategoryIdStr ? Number(nextCategoryIdStr) : null;
      await apiFetch(`/api/admin/products/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ categoryId: nextCategoryId }),
      });
      const catLabel = nextCategoryId
        ? categories.find((c) => c.id === nextCategoryId)?.nameAr || 'القسم المحدد'
        : 'غير مصنف';
      setFeedback({ type: 'ok', text: `تم نقل "${p.titleAr}" إلى "${catLabel}".` });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تحديث القسم.' });
    } finally {
      setBusy(false);
    }
  };

  const quickSavePrice = async (p: AdminProductItem) => {
    const customerNum = Number(quickPrice);
    const agentNum = Number(quickAgentPrice);
    if (!Number.isFinite(customerNum) || customerNum <= 0) {
      setFeedback({ type: 'err', text: 'أدخل سعر عميل أكبر من 0.' });
      return;
    }
    if (!Number.isFinite(agentNum) || agentNum <= 0) {
      setFeedback({ type: 'err', text: 'أدخل سعر وكيل أكبر من 0.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      await apiFetch(`/api/admin/products/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          pricingMode: 'manual',
          retailPrice: customerNum.toFixed(2),
          agentPrice: agentNum.toFixed(2),
        }),
      });
      setFeedback({
        type: 'ok',
        text: `تم تحديث أسعار "${p.titleAr}" — العميل: $${customerNum.toFixed(2)} · الوكيل: $${agentNum.toFixed(2)}.`,
      });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تحديث الأسعار.' });
    } finally {
      setBusy(false);
    }
  };

  const handleAttachOffer = async (offer: AvailableProviderProduct) => {
    if (!selectedProduct) return;
    setBusy(true);
    setFeedback(null);
    try {
      const nextRank = selectedProduct.providerOffers.length + 1;
      await apiFetch(`/api/admin/products/${selectedProduct.id}/mappings`, {
        method: 'POST',
        body: JSON.stringify({
          providerProductId: offer.id,
          roleType: nextRank === 1 ? 'primary' : 'backup',
          priority: nextRank,
          selectionStrategy: 'priority',
        }),
      });
      setFeedback({
        type: 'ok',
        text: `تم ربط "${offer.providerName}" كمزود #${nextRank}.`,
      });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر ربط المزود.' });
    } finally {
      setBusy(false);
    }
  };

  const handleReorderProviders = async (orderedMappingIds: number[]) => {
    if (!selectedProduct) return;
    setBusy(true);
    setFeedback(null);
    try {
      await apiFetch(`/api/admin/products/${selectedProduct.id}/mappings/reorder`, {
        method: 'PUT',
        body: JSON.stringify({ orderedMappingIds }),
      });
      setFeedback({ type: 'ok', text: 'تم حفظ ترتيب أولوية المزودين.' });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تحديث الترتيب.' });
    } finally {
      setBusy(false);
    }
  };

  const moveProviderIndex = (index: number, delta: -1 | 1) => {
    if (!selectedProduct) return;
    const list = [...selectedProduct.providerOffers];
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const [moved] = list.splice(index, 1);
    list.splice(target, 0, moved);
    void handleReorderProviders(list.map((o) => o.mappingId));
  };

  const promoteProviderToFirst = (index: number) => {
    if (!selectedProduct || index <= 0) return;
    const list = [...selectedProduct.providerOffers];
    const [moved] = list.splice(index, 1);
    list.unshift(moved);
    void handleReorderProviders(list.map((o) => o.mappingId));
  };

  const toggleProviderActive = async (offer: AdminProductOffer) => {
    if (!selectedProduct) return;
    setBusy(true);
    setFeedback(null);
    try {
      await apiFetch(`/api/admin/products/${selectedProduct.id}/mappings/${offer.mappingId}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !offer.isActive }),
      });
      setFeedback({
        type: 'ok',
        text: !offer.isActive ? `تم تفعيل "${offer.providerName}".` : `تم إيقاف "${offer.providerName}" مؤقتًا.`,
      });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تحديث المزود.' });
    } finally {
      setBusy(false);
    }
  };

  const handleUnlinkProvider = async (mappingId: number, providerName: string) => {
    if (!selectedProduct) return;
    setBusy(true);
    setFeedback(null);
    try {
      await apiFetch(`/api/admin/products/${selectedProduct.id}/mappings/${mappingId}`, {
        method: 'DELETE',
      });
      setFeedback({ type: 'ok', text: `تم فك ارتباط "${providerName}".` });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر فك ارتباط المزود.' });
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmDeleteProduct = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    setFeedback(null);
    try {
      await apiFetch(`/api/admin/products/${deleteTarget.id}`, { method: 'DELETE' });
      setFeedback({ type: 'ok', text: `تم حذف "${deleteTarget.titleAr}".` });
      setDeleteTarget(null);
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر حذف المنتج.' });
      setDeleteTarget(null);
    } finally {
      setBusy(false);
    }
  };

  const runSmartAutoCategorize = async (scope: 'uncategorized' | 'all', createMissingCategories: boolean) => {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ ok: boolean; messageAr: string }>('/api/admin/products/auto-categorize', {
        method: 'POST',
        body: JSON.stringify({ scope, createMissingCategories }),
      });
      setShowAutoCatModal(false);
      setFeedback({ type: 'ok', text: res.messageAr });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تشغيل التصنيف الذكي.' });
    } finally {
      setBusy(false);
    }
  };

  const openFullEditor = (p: AdminProductItem) => {
    const cleanExistingDescAr = /منتج\s*مستورد\s*تلقائي|مخفي\s*افتراضي/i.test(p.descriptionAr || '')
      ? ''
      : p.descriptionAr || '';
    const cleanExistingDescEn = /منتج\s*مستورد\s*تلقائي|مخفي\s*افتراضي|auto[-\s]*imported|hidden\s*by\s*default/i.test(
      p.descriptionEn || ''
    )
      ? ''
      : p.descriptionEn || '';

    setEditing(p);
    setEditManualBilingual(false);
    setModalTranslateNotice(null);
    setEditTitlePreview(
      p.titleAr || p.titleEn ? { textAr: p.titleAr, textEn: p.titleEn || p.titleAr } : null
    );
    setEditDescPreview(
      cleanExistingDescAr || cleanExistingDescEn
        ? { textAr: cleanExistingDescAr, textEn: cleanExistingDescEn || cleanExistingDescAr }
        : null
    );
    setEditForm({
      title: p.titleAr || p.titleEn || '',
      description: cleanExistingDescAr || cleanExistingDescEn || '',
      titleAr: p.titleAr,
      titleEn: p.titleEn || '',
      descriptionAr: cleanExistingDescAr,
      descriptionEn: cleanExistingDescEn,
      warrantyLabel: p.warrantyLabelAr || p.warrantyLabelEn || '',
      warrantyLabelAr: p.warrantyLabelAr,
      warrantyLabelEn: p.warrantyLabelEn || '',
      categoryId: p.categoryId ? String(p.categoryId) : '',
      durationLabel: p.durationLabel || '',
      sortOrder: p.sortOrder,
      isVisible: p.isVisible,
      isFeaturedOffer: p.isFeaturedOffer,
      autoHideOutOfStock: p.autoHideOutOfStock,
      pricingMode: p.pricingRule?.pricingMode || 'manual',
      retailPrice: Number(p.pricingRule?.retailPrice || p.retailPrice).toFixed(2),
      agentPrice: Number(p.pricingRule?.agentPrice || p.agentPrice || p.retailPrice).toFixed(2),
      fixedMargin: Number(p.pricingRule?.fixedMargin || '1').toFixed(2),
      percentMargin: Number(p.pricingRule?.percentMargin || '30').toFixed(2),
      paymentFeePercent: Number(p.pricingRule?.paymentFeePercent || '1.5').toFixed(2),
      extraFixedCost: Number(p.pricingRule?.extraFixedCost || '0').toFixed(2),
      promoPrice: p.pricingRule?.promoPrice ? Number(p.pricingRule.promoPrice).toFixed(2) : '',
      lockManualPrice: p.pricingRule?.lockManualPrice ?? true,
    });
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    setFeedback(null);
    try {
      const payload: Record<string, any> = {
        categoryId: editForm.categoryId ? Number(editForm.categoryId) : null,
        durationLabel: editForm.durationLabel.trim(),
        sortOrder: editForm.sortOrder,
        isVisible: editForm.isVisible,
        isFeaturedOffer: editForm.isFeaturedOffer,
        autoHideOutOfStock: editForm.autoHideOutOfStock,
        pricingMode: editForm.pricingMode,
        retailPrice: editForm.retailPrice,
        agentPrice: editForm.agentPrice.trim() ? editForm.agentPrice.trim() : null,
        fixedMargin: editForm.fixedMargin,
        percentMargin: editForm.percentMargin,
        paymentFeePercent: editForm.paymentFeePercent,
        extraFixedCost: editForm.extraFixedCost,
        promoPrice: editForm.promoPrice.trim() ? editForm.promoPrice.trim() : null,
        lockManualPrice: editForm.lockManualPrice,
      };

      if (editManualBilingual) {
        payload.titleAr = editForm.titleAr.trim();
        payload.titleEn = editForm.titleEn.trim();
        payload.descriptionAr = editForm.descriptionAr.trim();
        payload.descriptionEn = editForm.descriptionEn.trim();
        payload.warrantyLabelAr = editForm.warrantyLabelAr.trim();
        payload.warrantyLabelEn = editForm.warrantyLabelEn.trim();
      } else {
        const initialTitle = (editing.titleAr || editing.titleEn || '').trim();
        const nextTitle = editForm.title.trim();
        if (nextTitle && nextTitle !== initialTitle) {
          payload.title = nextTitle;
        }

        const initialDesc = (/منتج\s*مستورد\s*تلقائي|مخفي\s*افتراضي/i.test(editing.descriptionAr || '')
          ? ''
          : editing.descriptionAr || editing.descriptionEn || ''
        ).trim();
        const nextDesc = editForm.description.trim();
        if (nextDesc !== initialDesc || /منتج\s*مستورد\s*تلقائي|مخفي\s*افتراضي/i.test(editing.descriptionAr || '')) {
          payload.description = nextDesc;
        }

        const initialWarranty = (editing.warrantyLabelAr || editing.warrantyLabelEn || '').trim();
        const nextWarranty = editForm.warrantyLabel.trim();
        if (nextWarranty !== initialWarranty) {
          payload.warrantyLabel = nextWarranty;
        }
      }

      await apiFetch(`/api/admin/products/${editing.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      setEditing(null);
      setFeedback({
        type: 'ok',
        text: `تم حفظ تعديلات "${editManualBilingual ? editForm.titleAr : editForm.title}" مع الترجمة التلقائية.`,
      });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر حفظ التعديلات.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="المنتجات والأسعار"
        subtitle="إدارة الكتالوج، التسعير الدقيق، وترتيب أولوية المزودين (1 ← 2 ← 3)"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <form onSubmit={handleAddCategory} className="flex items-center gap-1.5">
              <input
                type="text"
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                placeholder="قسم جديد..."
                className="w-28 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs focus:border-slate-900 focus:outline-none"
              />
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                + قسم
              </button>
            </form>
            <button
              type="button"
              disabled={busy}
              onClick={() => setShowAutoCatModal(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap"
            >
              <Wand2 className="h-3.5 w-3.5 text-emerald-700" />
              تصنيف ذكي
            </button>
            <button
              type="button"
              onClick={() => {
                setCreateForm((prev) => ({
                  ...prev,
                  categoryId:
                    filterCategory !== 'all' && filterCategory !== 'uncategorized'
                      ? filterCategory
                      : categories[0]
                        ? String(categories[0].id)
                        : '',
                }));
                setCreateSelectedOfferIds([]);
                setCreateOfferSearch('');
                setShowCreateModal(true);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap"
            >
              <Plus className="h-3.5 w-3.5" />
              منتج جديد
            </button>
          </div>
        }
      />

      {feedback && (
        <FeedbackBanner type={feedback.type} text={feedback.text} onDismiss={() => setFeedback(null)} />
      )}

      {/* Meaning-Aware Catalog KPI Strip */}
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <KpiCard
          label="منشور للمشتري"
          value={publishedCount}
          valueTone="positive"
          tone="positive"
          direction="up"
          indicatorText="نشط في البوت"
        />
        <KpiCard
          label="مخفي / مسودة"
          value={hiddenCount}
          tone="neutral"
          indicatorText={`من ${products.length}`}
        />
        <KpiCard
          label="منشور نافذ المخزون"
          value={outOfStockPublished}
          valueTone={outOfStockPublished > 0 ? 'negative' : 'positive'}
          tone={outOfStockPublished > 0 ? 'negative' : 'positive'}
          direction={outOfStockPublished > 0 ? 'up' : 'flat'}
          indicatorText={outOfStockPublished > 0 ? 'يحتاج مزود' : 'متوفر بالكامل'}
        />
        <KpiCard
          label="غير مصنف"
          value={uncategorizedCount}
          valueTone={uncategorizedCount > 0 ? 'warning' : 'positive'}
          tone={uncategorizedCount > 0 ? 'warning' : 'positive'}
          direction={uncategorizedCount > 0 ? 'up' : 'flat'}
          indicatorText={uncategorizedCount > 0 ? 'يحتاج تصنيف' : 'مصنّف بالكامل'}
        />
      </div>

      {/* Streamlined Categories Filter Bar */}
      <SurfacePanel className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setFilterCategory('all')}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
              filterCategory === 'all'
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            <span>الكل</span>
            <span className="font-mono-num opacity-75">({products.length})</span>
          </button>
          {categories.map((cat) => {
            const active = filterCategory === String(cat.id);
            const cnt = categoryCounts.get(cat.id) || 0;
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => setFilterCategory(String(cat.id))}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                  active
                    ? 'border-emerald-700 bg-emerald-700 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span>{cat.nameAr}</span>
                <span className="font-mono-num opacity-75">({cnt})</span>
              </button>
            );
          })}
          {uncategorizedCount > 0 && (
            <button
              type="button"
              onClick={() => setFilterCategory('uncategorized')}
              className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                filterCategory === 'uncategorized'
                  ? 'border-amber-700 bg-amber-700 text-white'
                  : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
              }`}
            >
              <AlertTriangle className="h-3 w-3" />
              <span>غير مصنف</span>
              <span className="font-mono-num">({uncategorizedCount})</span>
            </button>
          )}
        </div>
      </SurfacePanel>

      {/* Master-Detail Split Workspace */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12 items-start">
        {/* Product List (5 cols) */}
        <SurfacePanel className="xl:col-span-5 overflow-hidden flex flex-col">
          <div className="p-3.5 border-b border-slate-100 space-y-2.5 bg-slate-50/50">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-slate-900">
                المنتجات <span className="font-mono-num text-slate-400">({filteredProducts.length})</span>
              </span>
              <div className="inline-flex items-center gap-0.5 rounded-lg bg-slate-200/70 p-0.5">
                {(
                  [
                    ['all', 'الكل'],
                    ['visible', 'ظاهر'],
                    ['hidden', 'مخفي'],
                  ] as const
                ).map(([k, lbl]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setFilterVis(k)}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                      filterVis === k ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="بحث بالاسم أو SKU..."
                className="w-full rounded-lg border border-slate-200 bg-white pr-8 pl-3 py-1.5 text-xs focus:border-slate-900 focus:outline-none"
              />
            </div>
          </div>

          <div className="divide-y divide-slate-100 max-h-[660px] overflow-y-auto">
            {filteredProducts.map((p) => {
              const isSelected = selectedProduct?.id === p.id;
              const isPublished = p.isVisible && !p.isPaused;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setSelectedProductId(p.id);
                    setMatcherSearch('');
                  }}
                  className={`w-full text-right px-4 py-3 transition-colors flex flex-col gap-1.5 ${
                    isSelected
                      ? 'bg-slate-900/[0.04] ring-1 ring-inset ring-slate-900/15'
                      : 'bg-white hover:bg-slate-50/80'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-bold text-slate-900 truncate">{p.titleAr}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-slate-500">
                        <span className={p.categoryId ? 'text-slate-600' : 'text-amber-700 font-semibold'}>
                          {p.categoryNameAr}
                        </span>
                        <span>·</span>
                        <span className="font-mono-num font-bold text-slate-900">عميل ${p.retailPrice}</span>
                        <span>·</span>
                        <span className="font-mono-num font-bold text-emerald-700">
                          وكيل ${p.agentPrice ?? p.retailPrice}
                        </span>
                        <span>·</span>
                        <span className={`font-mono-num ${p.totalStock > 0 ? 'text-slate-600' : 'text-rose-600 font-semibold'}`}>
                          مخزون {p.totalStock}
                        </span>
                      </div>
                    </div>
                    <span
                      className={`shrink-0 text-[11px] font-semibold ${
                        isPublished ? 'text-emerald-700' : 'text-slate-400'
                      }`}
                    >
                      {isPublished ? 'ظاهر' : 'مخفي'}
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    {p.activeRoutingProviderName ? (
                      <span className="text-emerald-700 font-medium truncate">
                        النشط: #{p.activeRoutingRank} {p.activeRoutingProviderName}
                      </span>
                    ) : p.providerOffers.length > 0 ? (
                      <span className="text-rose-600 font-medium truncate">
                        {p.totalStock === 0 ? 'نفد المخزون' : 'لا يوجد مزود جاهز'}
                      </span>
                    ) : (
                      <span className="text-slate-400">غير مربوط بمزود</span>
                    )}
                    <span className="font-mono-num text-slate-400 shrink-0">
                      {p.providerOffers.length} مزود
                    </span>
                  </div>
                </button>
              );
            })}

            {filteredProducts.length === 0 && (
              <div className="p-8 text-center space-y-3">
                <div className="text-sm font-semibold text-slate-700">لا توجد منتجات مطابقة</div>
                <button
                  type="button"
                  onClick={() => setShowCreateModal(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                >
                  <Plus className="h-3.5 w-3.5" />
                  إنشاء منتج
                </button>
              </div>
            )}
          </div>
        </SurfacePanel>

        {/* Product Pricing & Provider Priority Studio (7 cols) */}
        <div className="xl:col-span-7 space-y-4">
          {selectedProduct ? (
            <>
              {/* Part A: Controls & Price */}
              <SurfacePanel padded className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-bold text-slate-900">{selectedProduct.titleAr}</h2>
                      <span className="font-mono-num text-[11px] text-slate-400">{selectedProduct.sku}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-slate-500">القسم: <strong className="text-slate-800">{selectedProduct.categoryNameAr}</strong></span>
                      <span className="text-slate-300">·</span>
                      {selectedProduct.activeRoutingProviderName ? (
                        <SemanticStatus
                          tone="positive"
                          label={`التوجيه: #${selectedProduct.activeRoutingRank} ${selectedProduct.activeRoutingProviderName}`}
                        />
                      ) : (
                        <SemanticStatus tone="negative" label="لا يوجد مزود نشط" />
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void quickToggleVisibility(selectedProduct)}
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                        selectedProduct.isVisible && !selectedProduct.isPaused
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                          : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      {selectedProduct.isVisible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                      {selectedProduct.isVisible ? 'ظاهر' : 'مخفي'}
                    </button>
                    <button
                      type="button"
                      onClick={() => openFullEditor(selectedProduct)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      التفاصيل والتسعير
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setDeleteTarget(selectedProduct)}
                      aria-label={`حذف المنتج ${selectedProduct.titleAr}`}
                      className="rounded-lg border border-rose-200 bg-white p-1.5 text-rose-600 hover:bg-rose-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Inline Category, Dual Customer/Agent Prices & Live Margin */}
                <div className="space-y-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-12 items-end">
                    <div className="sm:col-span-4">
                      <label className="block text-[11px] font-semibold text-slate-500 mb-1">القسم</label>
                      <select
                        aria-label="قسم المنتج المحدد"
                        disabled={busy}
                        value={selectedProduct.categoryId ? String(selectedProduct.categoryId) : ''}
                        onChange={(e) => void quickChangeCategory(selectedProduct, e.target.value)}
                        className={`w-full rounded-lg border px-2.5 py-2 text-xs font-semibold focus:outline-none ${
                          !selectedProduct.categoryId
                            ? 'border-amber-300 bg-amber-50 text-amber-900'
                            : 'border-slate-200 bg-white text-slate-800 focus:border-slate-900'
                        }`}
                      >
                        <option value="">غير مصنف</option>
                        {categories.map((c) => (
                          <option key={c.id} value={String(c.id)}>
                            {c.nameAr}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="sm:col-span-3">
                      <div className="flex items-center justify-between gap-1 mb-1">
                        <label htmlFor="quick-customer-price" className="text-[11px] font-semibold text-slate-500">
                          سعر العميل ($)
                        </label>
                        {selectedProduct.pricingRule?.pricingMode === 'percent_margin' && (
                          <span className="font-mono-num text-[10px] font-semibold text-emerald-700">
                            +{Number(selectedProduct.pricingRule.percentMargin).toFixed(0)}%
                          </span>
                        )}
                        {selectedProduct.pricingRule?.pricingMode === 'fixed_margin' && (
                          <span className="font-mono-num text-[10px] font-semibold text-emerald-700">
                            +${Number(selectedProduct.pricingRule.fixedMargin).toFixed(2)}
                          </span>
                        )}
                      </div>
                      <input
                        id="quick-customer-price"
                        type="number"
                        step="0.01"
                        min="0.01"
                        value={quickPrice}
                        onChange={(e) => setQuickPrice(e.target.value)}
                        className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-mono-num font-bold text-slate-900 focus:border-slate-900 focus:outline-none"
                      />
                    </div>

                    <div className="sm:col-span-3">
                      <label htmlFor="quick-agent-price" className="block text-[11px] font-semibold text-emerald-700 mb-1">
                        سعر الوكيل ($)
                      </label>
                      <input
                        id="quick-agent-price"
                        type="number"
                        step="0.01"
                        min="0.01"
                        value={quickAgentPrice}
                        onChange={(e) => setQuickAgentPrice(e.target.value)}
                        className="w-full rounded-lg border border-emerald-300 bg-emerald-50/30 px-2.5 py-2 text-xs font-mono-num font-bold text-emerald-900 focus:border-emerald-700 focus:bg-white focus:outline-none"
                      />
                    </div>

                    <div className="sm:col-span-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void quickSavePrice(selectedProduct)}
                        className="w-full rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap disabled:opacity-50"
                      >
                        حفظ الأسعار
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-2 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2 text-center">
                    <div>
                      <div className="text-[10px] text-slate-400">الجملة</div>
                      <div className="font-mono-num text-xs font-bold text-slate-800">${selectedProduct.wholesalePrice}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-400">ربح العميل</div>
                      <div
                        className={`font-mono-num text-xs font-bold ${
                          Number(selectedProduct.expectedNetProfit) > 0 ? 'text-emerald-700' : 'text-rose-600'
                        }`}
                      >
                        {Number(selectedProduct.expectedNetProfit) > 0 ? '+' : ''}${selectedProduct.expectedNetProfit}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-400">ربح الوكيل</div>
                      <div
                        className={`font-mono-num text-xs font-bold ${
                          Number(selectedProduct.agentExpectedNetProfit ?? selectedProduct.expectedNetProfit) > 0
                            ? 'text-emerald-700'
                            : 'text-rose-600'
                        }`}
                      >
                        {Number(selectedProduct.agentExpectedNetProfit ?? selectedProduct.expectedNetProfit) > 0 ? '+' : ''}$
                        {selectedProduct.agentExpectedNetProfit ?? selectedProduct.expectedNetProfit}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-400">المخزون</div>
                      <div
                        className={`font-mono-num text-xs font-bold ${
                          selectedProduct.totalStock > 0 ? 'text-slate-900' : 'text-rose-600'
                        }`}
                      >
                        {selectedProduct.totalStock}
                      </div>
                    </div>
                  </div>
                </div>
              </SurfacePanel>

              {/* Part B: Ordered Provider Priority Queue (1 -> 2 -> 3) */}
              <SurfacePanel>
                <SectionHeader
                  title={`ترتيب أولوية المزودين (${selectedProduct.providerOffers.length})`}
                  icon={Layers}
                  action={<span className="font-mono-num text-[11px] text-slate-400">1 ← 2 ← 3</span>}
                />

                {selectedProduct.providerOffers.length === 0 ? (
                  <div className="p-6 text-center text-xs text-slate-400">
                    لا يوجد مزودون مرتبطون بعد — أضف مزودًا من القائمة بالأسفل.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {selectedProduct.providerOffers.map((offer, idx) => {
                      const status = getRoutingStatus(offer.routingState);
                      const isFirst = idx === 0;
                      const isLast = idx === selectedProduct.providerOffers.length - 1;
                      return (
                        <div
                          key={offer.mappingId}
                          className={`px-5 py-3.5 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between ${
                            offer.isActiveRoutingTarget ? 'bg-emerald-50/35' : ''
                          }`}
                        >
                          <div className="flex items-start gap-3 min-w-0">
                            <div
                              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg font-mono-num text-xs font-bold ${
                                isFirst
                                  ? 'bg-slate-900 text-white'
                                  : 'bg-slate-100 text-slate-600'
                              }`}
                            >
                              #{idx + 1}
                            </div>

                            <div className="min-w-0 flex-1 space-y-0.5">
                              <div className="flex flex-wrap items-center gap-2.5">
                                <span className="text-sm font-bold text-slate-900">{offer.providerName}</span>
                                <SemanticStatus tone={status.tone} label={status.label} />
                              </div>
                              <div className="text-xs text-slate-500 truncate" title={offer.rawName}>
                                {offer.rawName}
                              </div>
                              <div className="flex flex-wrap items-center gap-2.5 text-[11px] font-mono-num text-slate-500">
                                <span>جملة <strong className="text-slate-900">${offer.wholesalePrice}</strong></span>
                                <span>·</span>
                                <span>
                                  مخزون{' '}
                                  <strong className={offer.stockCount > 0 ? 'text-emerald-700' : 'text-rose-600'}>
                                    {offer.stockCount}
                                  </strong>
                                </span>
                                {offer.providerBalance !== undefined && (
                                  <>
                                    <span>·</span>
                                    <span>رصيد ${offer.providerBalance}</span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1 shrink-0 self-end sm:self-center">
                            <button
                              type="button"
                              disabled={busy || isFirst}
                              onClick={() => moveProviderIndex(idx, -1)}
                              aria-label={`رفع أولوية ${offer.providerName}`}
                              className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-30"
                            >
                              <ArrowUp className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={busy || isLast}
                              onClick={() => moveProviderIndex(idx, 1)}
                              aria-label={`خفض أولوية ${offer.providerName}`}
                              className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-30"
                            >
                              <ArrowDown className="h-3.5 w-3.5" />
                            </button>
                            {!isFirst && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => promoteProviderToFirst(idx)}
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] font-semibold text-slate-700 hover:border-emerald-400 hover:text-emerald-700"
                              >
                                <Crown className="h-3 w-3" />
                                الأول
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void toggleProviderActive(offer)}
                              title={offer.isActive ? 'إيقاف مؤقت' : 'تفعيل'}
                              className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 hover:text-amber-700"
                            >
                              {offer.isActive ? <PauseCircle className="h-3.5 w-3.5" /> : <PlayCircle className="h-3.5 w-3.5" />}
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleUnlinkProvider(offer.mappingId, offer.providerName)}
                              title="فك الارتباط"
                              className="rounded-lg border border-rose-200 bg-white p-1.5 text-rose-600 hover:bg-rose-50"
                            >
                              <Unlink className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </SurfacePanel>

              {/* Part C: All-Servers Offer Matcher */}
              <SurfacePanel>
                <SectionHeader
                  title="ربط مزودين إضافيين"
                  icon={Sparkles}
                  action={
                    <div className="inline-flex items-center gap-0.5 rounded-lg bg-slate-100 p-0.5">
                      <button
                        type="button"
                        onClick={() => setMatcherOnlyRelevant(true)}
                        className={`rounded-md px-2.5 py-1 text-[11px] font-semibold ${
                          matcherOnlyRelevant ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'
                        }`}
                      >
                        المطابقة
                      </button>
                      <button
                        type="button"
                        onClick={() => setMatcherOnlyRelevant(false)}
                        className={`rounded-md px-2.5 py-1 text-[11px] font-semibold ${
                          !matcherOnlyRelevant ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'
                        }`}
                      >
                        الكل ({availableProviderProducts.length})
                      </button>
                    </div>
                  }
                />

                <div className="p-4 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative flex-1 min-w-[180px]">
                      <Search className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                      <input
                        type="text"
                        value={matcherSearch}
                        onChange={(e) => setMatcherSearch(e.target.value)}
                        placeholder="ابحث باسم العرض أو الخادم..."
                        className="w-full rounded-lg border border-slate-200 bg-slate-50 pr-8 pl-3 py-1.5 text-xs focus:border-slate-900 focus:bg-white focus:outline-none"
                      />
                    </div>
                    <select
                      aria-label="تصفية العروض حسب الخادم"
                      value={matcherServerId}
                      onChange={(e) => setMatcherServerId(e.target.value)}
                      className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-slate-900 focus:outline-none"
                    >
                      <option value="all">كل الخوادم ({providers.length})</option>
                      {providers.map((pr) => (
                        <option key={pr.id} value={String(pr.id)}>
                          {pr.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="max-h-60 overflow-y-auto divide-y divide-slate-100 rounded-lg border border-slate-200/80">
                    {smartCandidateOffers.slice(0, 30).map(({ ap }) => (
                      <div
                        key={ap.id}
                        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 hover:bg-slate-50/70 text-xs"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-slate-900">{ap.providerName}</span>
                            <span className="text-slate-300">·</span>
                            <span className="text-slate-600 truncate">{ap.rawName}</span>
                          </div>
                          <div className="mt-0.5 flex items-center gap-2.5 font-mono-num text-[11px] text-slate-500">
                            <span>${ap.wholesalePrice}</span>
                            <span>·</span>
                            <span className={ap.stockCount > 0 ? 'text-emerald-700 font-semibold' : 'text-rose-600'}>
                              مخزون {ap.stockCount}
                            </span>
                            {ap.durationLabel && (
                              <>
                                <span>·</span>
                                <span>{ap.durationLabel}</span>
                              </>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleAttachOffer(ap)}
                          className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-40 transition-colors whitespace-nowrap"
                        >
                          <Link2 className="h-3 w-3" />
                          ربط #{selectedProduct.providerOffers.length + 1}
                        </button>
                      </div>
                    ))}
                    {smartCandidateOffers.length === 0 && (
                      <div className="p-5 text-center text-xs text-slate-400 space-y-1.5">
                        <div>لا توجد عروض مطابقة.</div>
                        {matcherOnlyRelevant && (
                          <button
                            type="button"
                            onClick={() => setMatcherOnlyRelevant(false)}
                            className="text-emerald-700 font-semibold hover:underline"
                          >
                            عرض جميع العروض
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </SurfacePanel>
            </>
          ) : (
            <SurfacePanel className="p-10 text-center space-y-2">
              <Server className="h-7 w-7 text-slate-300 mx-auto" />
              <div className="text-sm font-semibold text-slate-700">اختر منتجًا من القائمة</div>
            </SurfacePanel>
          )}
        </div>
      </div>

      {/* CREATE NEW PRODUCT MODAL */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 overflow-y-auto">
          <div className="w-full max-w-2xl rounded-2xl bg-white border border-slate-200 p-6 my-8 space-y-4 max-h-[90vh] overflow-y-auto shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">إنشاء منتج جديد</h3>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="text-xs font-semibold text-slate-500 hover:text-slate-900"
              >
                إغلاق
              </button>
            </div>

            <form onSubmit={handleCreateProduct} className="space-y-4">
              {modalTranslateNotice && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
                  {modalTranslateNotice}
                </div>
              )}
              {/* Single-input Auto-Translated Title */}
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="create-product-title" className="text-xs font-semibold text-slate-800">
                    اسم المنتج (بالعربية أو الإنجليزية — يُترجم تلقائيًا) *
                  </label>
                  <button
                    type="button"
                    disabled={!createForm.title.trim() || translatingKey === 'create_title'}
                    onClick={() => previewTranslation('create_title', createForm.title, 'product_title')}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-40 transition-colors"
                  >
                    <Languages className="h-3 w-3 text-emerald-700" />
                    {translatingKey === 'create_title' ? 'جارٍ الترجمة...' : 'معاينة الترجمة'}
                  </button>
                </div>
                <input
                  id="create-product-title"
                  type="text"
                  required
                  value={createForm.title}
                  onChange={(e) => {
                    setCreateForm({ ...createForm, title: e.target.value });
                    setCreateTitlePreview(null);
                  }}
                  placeholder="مثال: اشتراك Gemini Plus لمدة 6 أشهر  أو  Gemini Plus 6 Months"
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:border-slate-900 focus:outline-none"
                />
                {createTitlePreview && (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 rounded-xl bg-emerald-50/70 border border-emerald-200/80 p-2.5 text-xs">
                    <div>
                      <span className="text-[10px] font-bold text-emerald-800">العربية (AR)</span>
                      <div className="mt-0.5 font-semibold text-slate-900">{createTitlePreview.textAr}</div>
                    </div>
                    <div dir="ltr" className="text-left">
                      <span className="text-[10px] font-bold text-emerald-800">English (EN)</span>
                      <div className="mt-0.5 font-semibold text-slate-900">{createTitlePreview.textEn}</div>
                    </div>
                  </div>
                )}
              </div>

              {/* Single-input Auto-Translated Description */}
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="create-product-desc" className="text-xs font-semibold text-slate-800">
                    وصف المنتج للعميل (مرة واحدة بالعربية أو الإنجليزية — يُترجم تلقائيًا)
                  </label>
                  <button
                    type="button"
                    disabled={!createForm.description.trim() || translatingKey === 'create_desc'}
                    onClick={() => previewTranslation('create_desc', createForm.description, 'product_description')}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-40 transition-colors"
                  >
                    <Languages className="h-3 w-3 text-emerald-700" />
                    {translatingKey === 'create_desc' ? 'جارٍ الترجمة...' : 'معاينة ترجمة الوصف'}
                  </button>
                </div>
                <textarea
                  id="create-product-desc"
                  rows={3}
                  value={createForm.description}
                  onChange={(e) => {
                    setCreateForm({ ...createForm, description: e.target.value });
                    setCreateDescPreview(null);
                  }}
                  placeholder="اكتب مميزات المنتج وتفاصيل التفعيل بالعربية أو الإنجليزية مرة واحدة فقط (سيتم ترجمتها تلقائيًا للغة الأخرى مع الحفاظ على التنسيق)..."
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm leading-relaxed focus:border-slate-900 focus:outline-none"
                />
                {createDescPreview && (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 rounded-xl bg-emerald-50/70 border border-emerald-200/80 p-2.5 text-xs">
                    <div>
                      <span className="text-[10px] font-bold text-emerald-800">العربية (AR)</span>
                      <div className="mt-0.5 whitespace-pre-line text-slate-800">{createDescPreview.textAr}</div>
                    </div>
                    <div dir="ltr" className="text-left">
                      <span className="text-[10px] font-bold text-emerald-800">English (EN)</span>
                      <div className="mt-0.5 whitespace-pre-line text-slate-800">{createDescPreview.textEn}</div>
                    </div>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">القسم *</label>
                  <select
                    value={createForm.categoryId}
                    onChange={(e) => setCreateForm({ ...createForm, categoryId: e.target.value })}
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
                  >
                    <option value="">اختر القسم...</option>
                    {categories.map((c) => (
                      <option key={c.id} value={String(c.id)}>
                        {c.nameAr}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="create-customer-price" className="block text-xs font-semibold text-slate-700 mb-1">
                    سعر العميل (USDT) *
                  </label>
                  <input
                    id="create-customer-price"
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    value={createForm.retailPrice}
                    onChange={(e) => setCreateForm({ ...createForm, retailPrice: e.target.value })}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono-num focus:border-slate-900 focus:outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="create-agent-price" className="block text-xs font-semibold text-emerald-800 mb-1">
                    سعر الوكيل (USDT) *
                  </label>
                  <input
                    id="create-agent-price"
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    value={createForm.agentPrice}
                    onChange={(e) => setCreateForm({ ...createForm, agentPrice: e.target.value })}
                    className="w-full rounded-xl border border-emerald-300 bg-emerald-50/30 px-3 py-2 text-sm font-mono-num font-semibold text-emerald-950 focus:border-emerald-700 focus:bg-white focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">المدة</label>
                  <input
                    type="text"
                    value={createForm.durationLabel}
                    onChange={(e) => setCreateForm({ ...createForm, durationLabel: e.target.value })}
                    placeholder="6 أشهر"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">الضمان (يُترجم تلقائيًا)</label>
                  <input
                    type="text"
                    value={createForm.warrantyLabel}
                    onChange={(e) => setCreateForm({ ...createForm, warrantyLabel: e.target.value })}
                    placeholder="ضمان التشغيل طوال المدة"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
                  />
                </div>
              </div>

              <div className="border-t border-slate-100 pt-3.5 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-bold text-slate-900">
                    اختر المزودين حسب الأولوية ({createSelectedOfferIds.length})
                  </div>
                  <input
                    type="text"
                    value={createOfferSearch}
                    onChange={(e) => setCreateOfferSearch(e.target.value)}
                    placeholder="تصفية العروض..."
                    className="w-44 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs focus:border-slate-900 focus:outline-none"
                  />
                </div>

                <div className="max-h-48 overflow-y-auto divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {createMatchingOffers.map((ap) => {
                    const rankIdx = createSelectedOfferIds.indexOf(ap.id);
                    const picked = rankIdx !== -1;
                    return (
                      <button
                        key={ap.id}
                        type="button"
                        onClick={() => {
                          setCreateSelectedOfferIds((prev) =>
                            prev.includes(ap.id) ? prev.filter((id) => id !== ap.id) : [...prev, ap.id]
                          );
                        }}
                        className={`w-full text-right flex items-center justify-between gap-2 px-3 py-2 text-xs transition-colors ${
                          picked ? 'bg-emerald-50 text-emerald-950' : 'bg-white hover:bg-slate-50 text-slate-700'
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono-num text-[11px] font-bold ${
                              picked ? 'bg-emerald-700 text-white' : 'border border-slate-300 bg-white text-slate-400'
                            }`}
                          >
                            {picked ? `#${rankIdx + 1}` : '+'}
                          </span>
                          <span className="font-bold text-slate-900 shrink-0">{ap.providerName}</span>
                          <span className="truncate">{ap.rawName}</span>
                        </div>
                        <div className="flex items-center gap-2.5 shrink-0 font-mono-num">
                          <span className="font-bold">${ap.wholesalePrice}</span>
                          <span className={ap.stockCount > 0 ? 'text-emerald-700' : 'text-rose-600'}>
                            {ap.stockCount}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={createForm.isVisible}
                  onChange={(e) => setCreateForm({ ...createForm, isVisible: e.target.checked })}
                  className="accent-emerald-700"
                />
                نشر للمشتري فور الإنشاء
              </label>

              <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-5 py-2 text-xs font-bold text-white hover:bg-emerald-800 disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" />
                  {busy ? 'جارٍ الإنشاء...' : 'إنشاء المنتج'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* FULL EDIT & PRICING MODAL */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 overflow-y-auto">
          <div className="w-full max-w-2xl rounded-2xl bg-white border border-slate-200 p-6 my-8 space-y-5 max-h-[90vh] overflow-y-auto shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900">تعديل المنتج والتسعير</h3>
                <p className="text-xs text-slate-500">
                  سعر الجملة النشط: <span className="font-mono-num font-bold text-slate-800">${editing.wholesalePrice}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="text-xs font-semibold text-slate-500 hover:text-slate-900"
              >
                إغلاق
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-4">
              {modalTranslateNotice && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
                  {modalTranslateNotice}
                </div>
              )}
              {!editManualBilingual ? (
                <div className="space-y-4">
                  {/* Single-input Auto-Translated Title */}
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label htmlFor="edit-product-title" className="text-xs font-semibold text-slate-800">
                        اسم المنتج (بالعربية أو الإنجليزية — يُترجم تلقائيًا) *
                      </label>
                      <button
                        type="button"
                        disabled={!editForm.title.trim() || translatingKey === 'edit_title'}
                        onClick={() => previewTranslation('edit_title', editForm.title, 'product_title')}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-40 transition-colors"
                      >
                        <Languages className="h-3 w-3 text-emerald-700" />
                        {translatingKey === 'edit_title' ? 'جارٍ الترجمة...' : 'معاينة الترجمة'}
                      </button>
                    </div>
                    <input
                      id="edit-product-title"
                      type="text"
                      required
                      value={editForm.title}
                      onChange={(e) => {
                        setEditForm({ ...editForm, title: e.target.value });
                        setEditTitlePreview(null);
                      }}
                      className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:border-slate-900 focus:outline-none"
                    />
                    {editTitlePreview && (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 rounded-xl bg-slate-50 border border-slate-200/80 p-2.5 text-xs">
                        <div>
                          <span className="text-[10px] font-bold text-slate-500">العربية (AR)</span>
                          <div className="mt-0.5 font-semibold text-slate-900">{editTitlePreview.textAr}</div>
                        </div>
                        <div dir="ltr" className="text-left">
                          <span className="text-[10px] font-bold text-slate-500">English (EN)</span>
                          <div className="mt-0.5 font-semibold text-slate-900">{editTitlePreview.textEn}</div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Single-input Auto-Translated Description */}
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label htmlFor="edit-product-desc" className="text-xs font-semibold text-slate-800">
                        وصف المنتج للعميل (مرة واحدة بالعربية أو الإنجليزية — يُترجم تلقائيًا)
                      </label>
                      <button
                        type="button"
                        disabled={!editForm.description.trim() || translatingKey === 'edit_desc'}
                        onClick={() => previewTranslation('edit_desc', editForm.description, 'product_description')}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-40 transition-colors"
                      >
                        <Languages className="h-3 w-3 text-emerald-700" />
                        {translatingKey === 'edit_desc' ? 'جارٍ الترجمة...' : 'معاينة ترجمة الوصف'}
                      </button>
                    </div>
                    <textarea
                      id="edit-product-desc"
                      rows={3}
                      value={editForm.description}
                      onChange={(e) => {
                        setEditForm({ ...editForm, description: e.target.value });
                        setEditDescPreview(null);
                      }}
                      placeholder="اكتب وصف المنتج الذي يظهر للمشتري فقط (بالعربية أو الإنجليزية)..."
                      className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm leading-relaxed focus:border-slate-900 focus:outline-none"
                    />
                    {editDescPreview && (editDescPreview.textAr || editDescPreview.textEn) && (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 rounded-xl bg-slate-50 border border-slate-200/80 p-2.5 text-xs">
                        <div>
                          <span className="text-[10px] font-bold text-slate-500">العربية (AR)</span>
                          <div className="mt-0.5 whitespace-pre-line text-slate-700 line-clamp-3">
                            {editDescPreview.textAr || '—'}
                          </div>
                        </div>
                        <div dir="ltr" className="text-left">
                          <span className="text-[10px] font-bold text-slate-500">English (EN)</span>
                          <div className="mt-0.5 whitespace-pre-line text-slate-700 line-clamp-3">
                            {editDescPreview.textEn || '—'}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 rounded-xl bg-slate-50/70 border border-slate-200/80 p-3.5">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">الاسم (عربي)</label>
                    <input
                      type="text"
                      required
                      value={editForm.titleAr}
                      onChange={(e) => setEditForm({ ...editForm, titleAr: e.target.value })}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">الاسم (EN)</label>
                    <input
                      type="text"
                      dir="ltr"
                      value={editForm.titleEn}
                      onChange={(e) => setEditForm({ ...editForm, titleEn: e.target.value })}
                      placeholder="Gemini Plus 6 Months"
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">الوصف (عربي)</label>
                    <textarea
                      rows={2}
                      value={editForm.descriptionAr}
                      onChange={(e) => setEditForm({ ...editForm, descriptionAr: e.target.value })}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">الوصف (EN)</label>
                    <textarea
                      rows={2}
                      dir="ltr"
                      value={editForm.descriptionEn}
                      onChange={(e) => setEditForm({ ...editForm, descriptionEn: e.target.value })}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={() => setEditManualBilingual((prev) => !prev)}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500 hover:text-slate-900"
                >
                  {editManualBilingual ? (
                    <>
                      <ChevronUp className="h-3.5 w-3.5" />
                      العودة للإدخال الموحد (ترجمة تلقائية)
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3.5 w-3.5" />
                      تعديل النسختين يدويًا (خيار متقدم)
                    </>
                  )}
                </button>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">القسم</label>
                  <select
                    value={editForm.categoryId}
                    onChange={(e) => setEditForm({ ...editForm, categoryId: e.target.value })}
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
                  >
                    <option value="">بدون قسم</option>
                    {categories.map((c) => (
                      <option key={c.id} value={String(c.id)}>
                        {c.nameAr}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">المدة</label>
                  <input
                    type="text"
                    value={editForm.durationLabel}
                    onChange={(e) => setEditForm({ ...editForm, durationLabel: e.target.value })}
                    placeholder="6 أشهر"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">نص الضمان (يُترجم تلقائيًا)</label>
                  <input
                    type="text"
                    value={editManualBilingual ? editForm.warrantyLabelAr : editForm.warrantyLabel}
                    onChange={(e) =>
                      editManualBilingual
                        ? setEditForm({ ...editForm, warrantyLabelAr: e.target.value })
                        : setEditForm({ ...editForm, warrantyLabel: e.target.value })
                    }
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
                  />
                </div>
              </div>

              <div className="border-t border-slate-100 pt-4 space-y-3">
                <h4 className="text-xs font-bold text-slate-900">محرك التسعير المزدوج (سعر العميل + سعر الوكيل)</h4>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">نمط تسعير العميل</label>
                    <select
                      value={editForm.pricingMode}
                      onChange={(e) => setEditForm({ ...editForm, pricingMode: e.target.value as any })}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
                    >
                      <option value="manual">سعر يدوي ثابت</option>
                      <option value="fixed_margin">الجملة + ربح ثابت ($)</option>
                      <option value="percent_margin">الجملة + نسبة ربح (%)</option>
                    </select>
                  </div>
                  {editForm.pricingMode === 'manual' && (
                    <div>
                      <label htmlFor="edit-customer-price" className="block text-xs font-semibold text-slate-700 mb-1">
                        سعر العميل ($) *
                      </label>
                      <input
                        id="edit-customer-price"
                        type="number"
                        step="0.01"
                        min="0.01"
                        required
                        value={editForm.retailPrice}
                        onChange={(e) => setEditForm({ ...editForm, retailPrice: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono-num focus:border-slate-900 focus:outline-none"
                      />
                    </div>
                  )}
                  {editForm.pricingMode === 'fixed_margin' && (
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">ربح العميل الثابت ($)</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={editForm.fixedMargin}
                        onChange={(e) => setEditForm({ ...editForm, fixedMargin: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono-num focus:border-slate-900 focus:outline-none"
                      />
                    </div>
                  )}
                  {editForm.pricingMode === 'percent_margin' && (
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">نسبة ربح العميل (%)</label>
                      <input
                        type="number"
                        step="1"
                        min="0"
                        value={editForm.percentMargin}
                        onChange={(e) => setEditForm({ ...editForm, percentMargin: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono-num focus:border-slate-900 focus:outline-none"
                      />
                    </div>
                  )}
                  <div>
                    <label htmlFor="edit-agent-price" className="block text-xs font-semibold text-emerald-800 mb-1">
                      سعر الوكيل ($) *
                    </label>
                    <input
                      id="edit-agent-price"
                      type="number"
                      step="0.01"
                      min="0.01"
                      required
                      value={editForm.agentPrice}
                      onChange={(e) => setEditForm({ ...editForm, agentPrice: e.target.value })}
                      className="w-full rounded-lg border border-emerald-300 bg-emerald-50/30 px-3 py-2 text-sm font-mono-num font-semibold text-emerald-950 focus:border-emerald-700 focus:bg-white focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">عرض للعميل ($)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={editForm.promoPrice}
                      onChange={(e) => setEditForm({ ...editForm, promoPrice: e.target.value })}
                      placeholder="اختياري"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono-num focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                </div>

                {liveProfitPreview && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-xl bg-slate-50 border border-slate-200/80 p-3 text-center">
                    <div>
                      <div className="text-[11px] text-slate-500">سعر العميل النهائي</div>
                      <div className="font-mono-num text-sm font-bold text-slate-900">${liveProfitPreview.retail}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500">صافي ربح العميل</div>
                      <div
                        className={`font-mono-num text-sm font-bold ${
                          liveProfitPreview.negative ? 'text-rose-600' : 'text-emerald-700'
                        }`}
                      >
                        ${liveProfitPreview.net}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-emerald-700 font-semibold">سعر الوكيل النهائي</div>
                      <div className="font-mono-num text-sm font-bold text-emerald-900">${liveProfitPreview.agentPrice}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-emerald-700 font-semibold">صافي ربح الوكيل</div>
                      <div
                        className={`font-mono-num text-sm font-bold ${
                          liveProfitPreview.agentNegative ? 'text-rose-600' : 'text-emerald-700'
                        }`}
                      >
                        ${liveProfitPreview.agentNet}
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-5 pt-1 text-xs text-slate-700">
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editForm.isVisible}
                      onChange={(e) => setEditForm({ ...editForm, isVisible: e.target.checked })}
                      className="accent-emerald-700"
                    />
                    إظهار للمشتري
                  </label>
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editForm.lockManualPrice}
                      onChange={(e) => setEditForm({ ...editForm, lockManualPrice: e.target.checked })}
                      className="accent-emerald-700"
                    />
                    حماية السعر عند المزامنة
                  </label>
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editForm.autoHideOutOfStock}
                      onChange={(e) => setEditForm({ ...editForm, autoHideOutOfStock: e.target.checked })}
                      className="accent-emerald-700"
                    />
                    إخفاء تلقائي عند النفاد
                  </label>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-lg bg-emerald-700 px-5 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
                >
                  حفظ التعديلات
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DELETE PRODUCT MODAL */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-rose-200 p-6 space-y-4 shadow-xl">
            <div className="flex items-center gap-2 text-rose-700">
              <AlertTriangle className="h-5 w-5 shrink-0" />
              <h3 className="text-base font-bold">تأكيد حذف المنتج</h3>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              هل تريد حذف <strong className="text-slate-900">{deleteTarget.titleAr}</strong> من كتالوج المتجر؟
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleConfirmDeleteProduct()}
                className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {busy ? 'جارٍ الحذف...' : 'حذف المنتج'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SMART AUTO-CATEGORIZATION MODAL */}
      {showAutoCatModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 p-6 space-y-4 shadow-xl">
            <div className="flex items-center gap-2 text-emerald-700">
              <Wand2 className="h-5 w-5 shrink-0" />
              <h3 className="text-base font-bold text-slate-900">التصنيف الذكي</h3>
            </div>
            <div className="space-y-2">
              <label className="flex items-start gap-2.5 rounded-lg border border-slate-200 p-3 cursor-pointer hover:bg-slate-50">
                <input
                  type="radio"
                  name="autoCatScope"
                  checked={autoCatScope === 'uncategorized'}
                  onChange={() => setAutoCatScope('uncategorized')}
                  className="mt-0.5 accent-emerald-700"
                />
                <div className="text-xs">
                  <div className="font-semibold text-slate-900">غير المصنفة فقط ({uncategorizedCount})</div>
                </div>
              </label>
              <label className="flex items-start gap-2.5 rounded-lg border border-slate-200 p-3 cursor-pointer hover:bg-slate-50">
                <input
                  type="radio"
                  name="autoCatScope"
                  checked={autoCatScope === 'all'}
                  onChange={() => setAutoCatScope('all')}
                  className="mt-0.5 accent-emerald-700"
                />
                <div className="text-xs">
                  <div className="font-semibold text-slate-900">جميع المنتجات ({products.length})</div>
                </div>
              </label>
              <label className="flex items-center gap-2 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2.5 text-xs text-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoCatCreateMissing}
                  onChange={(e) => setAutoCatCreateMissing(e.target.checked)}
                  className="accent-emerald-700"
                />
                <span>إنشاء الأقسام الناقصة تلقائيًا</span>
              </label>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                disabled={busy}
                onClick={() => setShowAutoCatModal(false)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void runSmartAutoCategorize(autoCatScope, autoCatCreateMissing)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
              >
                <Wand2 className="h-3.5 w-3.5" />
                {busy ? 'جارٍ التنفيذ...' : 'تنفيذ'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
