import Decimal from 'decimal.js';
import {
  extractSupplierRawDescription,
  normalizeOriginalTelegramHtmlForPreview,
  processSupplierProductDescription,
  stripTelegramHtmlToPlainText,
} from './productDescriptionEngine.ts';

export interface SupplierPricingTier {
  minQty: number;
  maxQty: number | null;
  price: string;
}

export interface SupplierVariantSummary {
  id: string;
  name: string;
  price?: string;
  stock?: number;
  durationLabel?: string;
}

export interface RichNormalizedCatalogItem {
  externalProductId: string;
  externalVariantId: string;
  rawName: string;
  rawDescription: string;
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
  variantsSummary: SupplierVariantSummary[];
  pricingTiers?: SupplierPricingTier[];
  extraMetadata: Record<string, string | number | boolean>;
}

export interface ExistingStoreLinkInfo {
  providerProductId: number;
  storeProductId: number | null;
  storeProductTitle: string | null;
  storeCategoryId: number | null;
  storeIsVisible: boolean | null;
  storeDescriptionEmpty: boolean;
}

export interface SupplierBrowserItem extends RichNormalizedCatalogItem {
  itemKey: string;
  previewSafeHtml: string;
  cleanedImportHtml: string;
  plainDescriptionPreview: string;
  hasHtmlFormatting: boolean;
  hasCustomEmoji: boolean;
  importStatus: 'not_imported' | 'imported';
  existingProviderProductId: number | null;
  existingStoreProductId: number | null;
  existingStoreProductTitle: string | null;
  existingCategoryId: number | null;
  existingStoreVisible: boolean | null;
  existingDescriptionEmpty: boolean;
}

export type PaginationDirective =
  | { kind: 'none' }
  | { kind: 'url'; nextUrl: string }
  | { kind: 'cursor'; cursor: string }
  | { kind: 'page'; nextPage: number; limit?: number }
  | { kind: 'offset'; nextOffset: number; limit: number };

function safeDecStr(val: unknown, fallback = '0.0000'): string {
  if (val === null || val === undefined || val === '') return fallback;
  try {
    const cleaned = String(val).replace(/[^0-9.\-]/g, '');
    if (!cleaned || cleaned === '-' || cleaned === '.') return fallback;
    const dec = new Decimal(cleaned);
    if (!dec.isFinite()) return fallback;
    return dec.toFixed(4);
  } catch {
    return fallback;
  }
}

function optionalPositivePriceStr(val: unknown): string | null {
  if (val === null || val === undefined || val === '') return null;
  try {
    const cleaned = String(val).replace(/[^0-9.\-]/g, '');
    if (!cleaned || cleaned === '-' || cleaned === '.') return null;
    const dec = new Decimal(cleaned);
    if (!dec.isFinite() || dec.lte(0)) return null;
    return dec.toFixed(4);
  } catch {
    return null;
  }
}

function isPrivateOrBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^0\./.test(h)) {
    return true;
  }
  const m172 = h.match(/^172\.(\d+)\./);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

export function sanitizeSupplierImageUrl(raw: unknown): string {
  if (!raw) return '';
  let candidate = '';
  if (typeof raw === 'string') {
    candidate = raw.trim();
  } else if (Array.isArray(raw) && raw.length > 0) {
    return sanitizeSupplierImageUrl(raw[0]);
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    return sanitizeSupplierImageUrl(obj.url ?? obj.src ?? obj.href ?? obj.image ?? obj.secure_url);
  }
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    if (isPrivateOrBlockedHost(parsed.hostname)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

export function inferDeliveryTypeFromHints(hint: string): 'code' | 'link' | 'account' | 'manual' {
  const h = (hint || '').toLowerCase();
  if (h.includes('link') || h.includes('invite') || h.includes('redeem') || h.includes('activation_link')) return 'link';
  if (h.includes('account') || h.includes('acc') || h.includes('email') || h.includes('slot') || h.includes('profile')) return 'account';
  if (h.includes('manual') || h.includes('upgrade') || h.includes('pre-order') || h.includes('preorder')) return 'manual';
  return 'code';
}

function firstNonEmptyString(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const nested = o.name ?? o.title ?? o.label ?? o.en ?? o.ar ?? o.value;
      if (typeof nested === 'string' && nested.trim()) return nested.trim();
    }
  }
  return '';
}

function extractFeaturesList(p: Record<string, any>): string[] {
  const rawList = p.features ?? p.highlights ?? p.benefits ?? p.tags ?? p.included ?? p.perks;
  if (!Array.isArray(rawList)) return [];
  const out: string[] = [];
  for (const entry of rawList) {
    if (typeof entry === 'string' && entry.trim()) {
      out.push(entry.trim());
    } else if (entry && typeof entry === 'object') {
      const s = firstNonEmptyString(entry.label, entry.name, entry.title, entry.text, entry.value);
      if (s) out.push(s);
    }
    if (out.length >= 25) break;
  }
  return out;
}

const KNOWN_MAPPED_KEYS = new Set([
  'id', '_id', 'service_id', 'product_id', 'productId', 'service_key', 'variant_id', 'code', 'slug',
  'name', 'title', 'product_name', 'service_name', 'name_ar', 'name_en', 'label', 'variant_name',
  'description', 'description_html', 'html_description', 'telegram_description', 'descriptionHtml',
  'description_ar', 'description_en', 'desc_ar', 'desc_en', 'short_description_ar', 'short_description_en',
  'full_description', 'long_description', 'product_description', 'service_description', 'details', 'detail',
  'details_html', 'desc', 'content', 'body', 'overview', 'info', 'information', 'short_description',
  'summary', 'note', 'notes', 'custom_pricing_note', 'readme', 'instructions', 'guide',
  'activation_instructions', 'activation_guide', 'how_to_use', 'usage',
  'price', 'price_usdt', 'usdt_price', 'your_price_usdt', 'base_price_usdt', 'shop_price_usdt',
  'price_usd', 'usd_price', 'your_cost', 'unit_price', 'unit_price_cents', 'reseller_price', 'your_price', 'normal_price',
  'cost', 'price_vnd', 'wholesale_price', 'retail_price', 'suggested_price', 'msrp', 'original_price',
  'market_price', 'regular_price', 'list_price', 'pricing_tiers', 'tiers', 'variants',
  'stock', 'stock_count', 'stock_quantity', 'stockQuantity', 'available', 'available_stock', 'availableStock',
  'quantity', 'remaining', 'inventory', 'inStock', 'in_stock', 'is_available', 'available_flag',
  'unlimited', 'is_unlimited', 'stock_unlimited',
  'min_qty', 'min_quantity', 'minimum_quantity', 'minQuantity', 'max_qty', 'max_quantity', 'maximum_quantity', 'maxQuantity', 'max_per_order',
  'image', 'image_url', 'imageUrl', 'thumbnail', 'thumbnail_url', 'icon', 'icon_url', 'logo', 'photo', 'cover', 'images',
  'category', 'category_name', 'categoryName', 'group', 'group_name', 'type', 'product_type', 'productType', 'product_type_label', 'service_type',
  'duration', 'duration_label', 'durationLabel', 'period', 'validity',
  'warranty', 'warranty_days', 'warrantyDays', 'warranty_label', 'warranty_en',
  'delivery_type', 'deliveryType', 'delivery_method', 'fulfillment_mode',
  'currency', 'features', 'highlights', 'benefits',
]);

const SENSITIVE_META_KEY_RE = /(?:api[-_]?key|secret|token|password|signature|auth|credential)/i;

function extractExtraMetadata(
  p: Record<string, any>,
  parent?: Record<string, any>
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const sources = parent ? [parent, p] : [p];
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const [key, val] of Object.entries(src)) {
      if (KNOWN_MAPPED_KEYS.has(key) || SENSITIVE_META_KEY_RE.test(key)) continue;
      if (val === null || val === undefined || val === '') continue;
      if (typeof val === 'string') {
        const t = val.trim();
        if (t && t.length <= 280) out[key] = t;
      } else if (typeof val === 'number' && Number.isFinite(val)) {
        out[key] = val;
      } else if (typeof val === 'boolean') {
        out[key] = val;
      } else if (Array.isArray(val) && val.length > 0 && val.length <= 8 && val.every((x) => typeof x === 'string' || typeof x === 'number')) {
        out[key] = val.join(', ');
      }
      if (Object.keys(out).length >= 24) break;
    }
  }
  return out;
}

export function extractRawCatalogItemsList(rawData: any): any[] {
  if (Array.isArray(rawData)) return rawData;
  if (!rawData || typeof rawData !== 'object') return [];
  const candidates = [
    rawData.services,
    rawData.products,
    rawData.items,
    rawData.catalog,
    rawData.results,
    rawData.records,
    rawData.offers,
    rawData.list,
    rawData.stock,
    rawData.data?.services,
    rawData.data?.products,
    rawData.data?.items,
    rawData.data?.catalog,
    rawData.data?.results,
    rawData.data?.records,
    Array.isArray(rawData.data) ? rawData.data : null,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

/**
 * Extracts safe pagination continuation instructions across diverse reseller APIs.
 * Enforces strict same-origin matching for next_page_url to prevent SSRF redirects.
 */
export function extractPaginationDirective(
  rawData: any,
  currentPage: number,
  currentOffset: number,
  currentLimit: number,
  itemsReceived: number,
  allowedBaseOrigin: string
): PaginationDirective {
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData) || itemsReceived === 0) {
    return { kind: 'none' };
  }

  const meta = rawData.meta || rawData.pagination || rawData.page_info || rawData.data?.meta || rawData.data?.pagination || {};
  const links = rawData.links || rawData.data?.links || {};

  // 1. Explicit next URL (verify same origin strictly!)
  const nextUrlCandidate =
    rawData.next_page_url ??
    rawData.nextUrl ??
    links.next ??
    meta.next_page_url ??
    meta.nextUrl;
  if (typeof nextUrlCandidate === 'string' && nextUrlCandidate.trim()) {
    try {
      const resolved = new URL(nextUrlCandidate.trim(), allowedBaseOrigin);
      const allowedOrigin = new URL(allowedBaseOrigin).origin;
      if (resolved.origin === allowedOrigin && (resolved.protocol === 'https:' || resolved.protocol === 'http:')) {
        return { kind: 'url', nextUrl: resolved.toString() };
      }
    } catch {
      // Ignore malformed next URL
    }
  }

  // 2. Cursor pagination
  const nextCursor =
    rawData.next_cursor ??
    rawData.nextCursor ??
    meta.next_cursor ??
    meta.nextCursor ??
    (rawData.has_more === true || meta.has_more === true ? rawData.cursor ?? meta.cursor : null);
  if (typeof nextCursor === 'string' && nextCursor.trim()) {
    return { kind: 'cursor', cursor: nextCursor.trim() };
  }

  // 3. Explicit page-based pagination
  const curPage = Number(rawData.current_page ?? rawData.page ?? meta.current_page ?? meta.page ?? currentPage) || currentPage;
  const lastPage = Number(
    rawData.last_page ??
      rawData.total_pages ??
      rawData.totalPages ??
      meta.last_page ??
      meta.total_pages ??
      meta.totalPages ??
      0
  );
  const perPage = Number(rawData.per_page ?? rawData.limit ?? meta.per_page ?? meta.limit ?? currentLimit) || currentLimit;
  const explicitHasMore =
    rawData.has_next ?? rawData.hasNext ?? rawData.has_more ?? meta.has_next ?? meta.has_more;

  if (lastPage > 0) {
    if (curPage < lastPage) {
      return { kind: 'page', nextPage: curPage + 1, limit: perPage };
    }
    return { kind: 'none' };
  }

  // 4. Total-count based pagination (offset or page)
  const totalCount = Number(rawData.total ?? rawData.total_count ?? rawData.totalCount ?? meta.total ?? meta.total_count ?? 0);
  if (totalCount > 0) {
    if (currentOffset + itemsReceived < totalCount) {
      if (rawData.offset !== undefined || meta.offset !== undefined) {
        return { kind: 'offset', nextOffset: currentOffset + itemsReceived, limit: perPage };
      }
      return { kind: 'page', nextPage: curPage + 1, limit: perPage };
    }
    return { kind: 'none' };
  }

  if (explicitHasMore === true) {
    return { kind: 'page', nextPage: curPage + 1, limit: perPage };
  }

  return { kind: 'none' };
}

/**
 * Normalizes a single upstream raw supplier product (expanding variants when present)
 * while capturing ALL rich catalog attributes for the Supplier Product Browser.
 */
export function normalizeRichSupplierItem(
  p: Record<string, any>,
  currencyFallback = 'USD'
): RichNormalizedCatalogItem[] {
  if (!p || typeof p !== 'object') return [];
  const baseId = firstNonEmptyString(
    p.service_id,
    p.product_id,
    p.productId,
    p.service_key,
    p.id,
    p._id,
    p.code,
    p.slug
  );
  const rawName = firstNonEmptyString(
    p.name,
    p.title,
    p.product_name,
    p.service_name,
    p.name_en,
    p.name_ar,
    p.label,
    baseId
  ) || 'Product';
  if (!baseId && !rawName) return [];

  const parentImage = sanitizeSupplierImageUrl(
    p.image_url ?? p.imageUrl ?? p.image ?? p.thumbnail_url ?? p.thumbnail ?? p.icon_url ?? p.icon ?? p.logo ?? p.photo ?? p.cover ?? p.images
  );
  const parentCat = firstNonEmptyString(
    p.category_name,
    p.categoryName,
    p.category,
    p.group_name,
    p.group,
    p.platform,
    p.brand
  );
  const parentType = firstNonEmptyString(
    p.product_type_label,
    p.product_type,
    p.productType,
    p.service_type,
    p.type,
    p.fulfillment_mode,
    p.delivery_method,
    p.delivery_type
  );
  const parentInstructions = firstNonEmptyString(
    p.activation_instructions,
    p.activation_guide,
    p.instructions,
    p.how_to_use,
    p.guide,
    p.customer_prompt,
    p.customer_prompt_en
  );
  const parentFeatures = extractFeaturesList(p);

  const rawVariants = Array.isArray(p.variants) && p.variants.length > 0 ? p.variants : null;
  if (rawVariants) {
    const variantsSummary: SupplierVariantSummary[] = rawVariants.map((v: any) => ({
      id: firstNonEmptyString(v.id, v.variant_id, v.code, v.name),
      name: firstNonEmptyString(v.name, v.title, v.name_en, v.name_ar, v.label, v.variant_name, v.id),
      price: safeDecStr(
        v.your_price_usdt ?? v.price_usdt ?? v.usdt_price ?? v.price_usd ?? v.your_cost ?? v.unit_price ?? v.reseller_price ?? v.price ?? v.cost ?? p.price_usd ?? p.price
      ),
      stock: Math.max(0, Number(v.stock ?? v.stock_count ?? v.stock_quantity ?? v.available ?? v.available_stock ?? v.availableStock ?? p.stock ?? 0) || 0),
      durationLabel: firstNonEmptyString(v.duration, v.duration_label, v.period, p.duration, p.period),
    }));

    return rawVariants.map((v: any) => {
      const varId = firstNonEmptyString(v.id, v.variant_id, v.code, v.name);
      const vName = firstNonEmptyString(v.variant_name, v.name, v.title, v.name_en, v.name_ar, v.label);
      const usdPriceVal =
        v.your_price_usdt ??
        v.price_usdt ??
        v.usdt_price ??
        v.price_usd ??
        v.usd_price ??
        v.base_price_usdt ??
        v.your_cost ??
        p.your_price_usdt ??
        p.price_usdt ??
        p.price_usd;
      const priceVal =
        usdPriceVal ??
        v.unit_price ??
        v.reseller_price ??
        v.your_price ??
        v.price ??
        v.cost ??
        (v.unit_price_cents != null ? Number(v.unit_price_cents) / 100 : undefined) ??
        p.unit_price ??
        p.price ??
        0;
      const suggestedVal =
        v.shop_price_usdt ??
        v.retail_price ??
        v.suggested_price ??
        v.msrp ??
        v.original_price ??
        v.market_price ??
        v.regular_price ??
        p.shop_price_usdt ??
        p.retail_price ??
        p.suggested_price ??
        p.msrp ??
        p.original_price;
      const stockVal =
        v.stock ??
        v.stock_count ??
        v.stock_quantity ??
        v.stockQuantity ??
        v.available_stock ??
        v.availableStock ??
        v.available ??
        v.quantity ??
        (v.in_stock === true || v.inStock === true ? 99 : p.stock ?? p.stock_quantity ?? p.available_stock ?? p.availableStock ?? 0);
      const isUnlimited = v.unlimited === true || v.is_unlimited === true || v.stock_unlimited === true || p.unlimited === true || p.is_unlimited === true || p.stock_unlimited === true;
      const rawNumStock = Math.max(0, Number(stockVal) || 0);
      const numStock = rawNumStock > 0 ? rawNumStock : isUnlimited ? 999 : 0;
      const explicitAvail =
        isUnlimited ||
        (typeof v.is_available === 'boolean'
          ? v.is_available
          : typeof v.in_stock === 'boolean'
            ? v.in_stock
            : numStock > 0);
      const warrantyDays = Math.max(0, Number(v.warranty_days ?? v.warrantyDays ?? p.warranty_days ?? p.warrantyDays ?? 30) || 0);
      const warrantyLabel =
        firstNonEmptyString(v.warranty_label, v.warranty_en, p.warranty_label, p.warranty_en) ||
        (typeof p.warranty === 'string' ? p.warranty.trim() : '') ||
        (warrantyDays > 0 ? `${warrantyDays} يوم` : '');

      return {
        externalProductId: baseId || rawName,
        externalVariantId: varId,
        rawName: vName ? `${rawName} — ${vName}` : rawName,
        rawDescription: extractSupplierRawDescription(v, p),
        imageUrl: sanitizeSupplierImageUrl(v.image_url ?? v.image ?? v.thumbnail) || parentImage,
        wholesalePrice: safeDecStr(priceVal),
        suggestedRetailPrice: optionalPositivePriceStr(suggestedVal),
        currency: usdPriceVal != null ? 'USD' : String(v.currency ?? p.currency ?? currencyFallback),
        stockCount: numStock,
        isAvailable: explicitAvail,
        minQty: Math.max(1, Number(v.min_qty ?? v.minQuantity ?? v.minimum_quantity ?? p.min_qty ?? p.minQuantity ?? p.minimum_quantity ?? 1) || 1),
        maxQty: Math.max(1, Number(v.max_qty ?? v.maxQuantity ?? v.max_per_order ?? v.maximum_quantity ?? p.max_qty ?? p.maxQuantity ?? p.max_per_order ?? p.maximum_quantity ?? 1000) || 1000),
        deliveryType: inferDeliveryTypeFromHints(String(v.delivery_type ?? p.delivery_type ?? parentType ?? rawName)),
        deliveryInstructions: firstNonEmptyString(v.activation_instructions, v.instructions) || parentInstructions,
        durationLabel: firstNonEmptyString(v.duration, v.duration_label, v.period, v.validity, p.duration, p.duration_label, p.period),
        warrantyDays,
        warrantyLabel,
        productType: firstNonEmptyString(v.product_type_label, v.product_type, v.type) || parentType,
        categoryName: firstNonEmptyString(v.category_name, v.category) || parentCat,
        features: extractFeaturesList(v).length > 0 ? extractFeaturesList(v) : parentFeatures,
        variantsSummary,
        pricingTiers: Array.isArray(v.pricing_tiers ?? p.pricing_tiers)
          ? (v.pricing_tiers ?? p.pricing_tiers).map((t: any) => ({
              minQty: Number(t.min ?? t.min_qty ?? t.minQty ?? 1),
              maxQty: t.max || t.max_qty || t.maxQty ? Number(t.max ?? t.max_qty ?? t.maxQty) : null,
              price: safeDecStr(t.price ?? 0),
            }))
          : undefined,
        extraMetadata: extractExtraMetadata(v, p),
      };
    });
  }

  const rawTiers = Array.isArray(p.pricing_tiers) ? p.pricing_tiers : Array.isArray(p.tiers) ? p.tiers : null;
  const firstTierPrice = rawTiers && rawTiers.length > 0 ? rawTiers[0]?.price : undefined;
  const usdPriceVal =
    p.your_price_usdt ??
    p.price_usdt ??
    p.usdt_price ??
    p.price_usd ??
    p.usd_price ??
    p.base_price_usdt ??
    p.your_cost;
  const priceVal =
    usdPriceVal ??
    p.unit_price ??
    p.wholesale_price ??
    p.reseller_price ??
    p.your_price ??
    p.normal_price ??
    firstTierPrice ??
    (p.unit_price_cents != null ? Number(p.unit_price_cents) / 100 : undefined) ??
    p.price ??
    p.cost ??
    p.price_vnd ??
    0;
  const suggestedVal =
    p.shop_price_usdt ??
    p.retail_price ??
    p.suggested_price ??
    p.msrp ??
    p.original_price ??
    p.market_price ??
    p.regular_price ??
    p.list_price;
  const stockVal =
    p.stock ??
    p.stock_count ??
    p.stock_quantity ??
    p.stockQuantity ??
    p.available_stock ??
    p.availableStock ??
    p.available ??
    p.quantity ??
    p.remaining ??
    p.inventory ??
    (p.inStock === true || p.in_stock === true ? 99 : 0);
  const isUnlimited = p.unlimited === true || p.is_unlimited === true || p.stock_unlimited === true;
  const rawNumStock = Math.max(0, Number(stockVal) || 0);
  const numStock = rawNumStock > 0 ? rawNumStock : isUnlimited ? 999 : 0;
  const explicitAvail =
    isUnlimited ||
    (typeof p.is_available === 'boolean'
      ? p.is_available
      : typeof p.in_stock === 'boolean'
        ? p.in_stock
        : typeof p.inStock === 'boolean'
          ? p.inStock
          : numStock > 0);
  const warrantyDays = Math.max(0, Number(p.warranty_days ?? p.warrantyDays ?? (typeof p.warranty === 'number' ? p.warranty : 30)) || 0);
  const warrantyLabel =
    firstNonEmptyString(p.warranty_label, p.warranty_en) ||
    (typeof p.warranty === 'string' ? p.warranty.trim() : '') ||
    (warrantyDays > 0 ? `${warrantyDays} يوم` : '');

  const varId = p.variant_id ? String(p.variant_id).trim() : '';
  const finalName = p.variant_name ? `${rawName} — ${String(p.variant_name).trim()}` : rawName;

  return [
    {
      externalProductId: baseId || finalName,
      externalVariantId: varId,
      rawName: finalName,
      rawDescription: extractSupplierRawDescription(p),
      imageUrl: parentImage,
      wholesalePrice: safeDecStr(priceVal),
      suggestedRetailPrice: optionalPositivePriceStr(suggestedVal),
      currency: usdPriceVal != null ? 'USD' : String(p.currency ?? (p.price_usdt !== undefined ? 'USDT' : currencyFallback)),
      stockCount: numStock,
      isAvailable: explicitAvail,
      minQty: Math.max(1, Number(p.min_qty ?? p.min_quantity ?? p.minimum_quantity ?? p.minQuantity ?? 1) || 1),
      maxQty: Math.max(1, Number(p.max_qty ?? p.max_quantity ?? p.maximum_quantity ?? p.maxQuantity ?? p.max_per_order ?? 1000) || 1000),
      deliveryType: inferDeliveryTypeFromHints(String(p.delivery_type ?? p.delivery_method ?? p.type ?? p.delivery ?? finalName)),
      deliveryInstructions: parentInstructions,
      durationLabel: firstNonEmptyString(p.duration, p.duration_label, p.durationLabel, p.period, p.validity),
      warrantyDays,
      warrantyLabel,
      productType: parentType,
      categoryName: parentCat,
      features: parentFeatures,
      variantsSummary: [],
      pricingTiers: rawTiers
        ? rawTiers.map((t: any) => ({
            minQty: Number(t.min ?? t.min_qty ?? t.minQty ?? 1),
            maxQty: t.max || t.max_qty || t.maxQty ? Number(t.max ?? t.max_qty ?? t.maxQty) : null,
            price: safeDecStr(t.price ?? 0),
          }))
        : undefined,
      extraMetadata: extractExtraMetadata(p),
    },
  ];
}

export function normalizeRichSupplierCatalog(rawData: any, currencyFallback = 'USD'): RichNormalizedCatalogItem[] {
  const list = extractRawCatalogItemsList(rawData);
  const out: RichNormalizedCatalogItem[] = [];
  for (const row of list) {
    out.push(...normalizeRichSupplierItem(row, currencyFallback));
  }
  return out;
}

export function makeSupplierOfferKey(externalProductId: string, externalVariantId = ''): string {
  return `${String(externalProductId || '').trim()}::${String(externalVariantId || '').trim()}`;
}

export function buildSupplierBrowserItem(
  item: RichNormalizedCatalogItem,
  opts: {
    extraSupplierDomains?: string[];
    extraSupplierNames?: string[];
    existingLink?: ExistingStoreLinkInfo | null;
  }
): SupplierBrowserItem {
  const rawDesc = (item.rawDescription || '').trim();
  const previewSafeHtml = normalizeOriginalTelegramHtmlForPreview(rawDesc);
  const processed = processSupplierProductDescription(rawDesc, {
    extraSupplierDomains: opts.extraSupplierDomains || [],
    extraSupplierNames: opts.extraSupplierNames || [],
  });
  // Never lose a non-empty supplier description if selective scrubbing stripped all lines
  const cleanedImportHtml = processed.telegramHtml || previewSafeHtml;
  const plainDescriptionPreview = stripTelegramHtmlToPlainText(previewSafeHtml || rawDesc);
  const link = opts.existingLink;
  const isImported = Boolean(link && link.storeProductId);

  return {
    ...item,
    itemKey: makeSupplierOfferKey(item.externalProductId, item.externalVariantId),
    previewSafeHtml,
    cleanedImportHtml,
    plainDescriptionPreview,
    hasHtmlFormatting: processed.hasHtmlFormatting || /<(?:b|strong|i|em|u|s|code|pre|blockquote|a|tg-emoji)\b/i.test(previewSafeHtml),
    hasCustomEmoji: /<tg-emoji\b/i.test(previewSafeHtml),
    importStatus: isImported ? 'imported' : 'not_imported',
    existingProviderProductId: link?.providerProductId ?? null,
    existingStoreProductId: link?.storeProductId ?? null,
    existingStoreProductTitle: link?.storeProductTitle ?? null,
    existingCategoryId: link?.storeCategoryId ?? null,
    existingStoreVisible: link?.storeIsVisible ?? null,
    existingDescriptionEmpty: link?.storeDescriptionEmpty ?? false,
  };
}

export interface BrowserFilterOptions {
  search?: string;
  category?: string;
  status?: 'all' | 'not_imported' | 'imported';
  page?: number;
  pageSize?: number;
}

export function filterAndPaginateSupplierBrowserItems(
  items: SupplierBrowserItem[],
  opts: BrowserFilterOptions
): {
  items: SupplierBrowserItem[];
  totalMatched: number;
  page: number;
  pageSize: number;
  totalPages: number;
  distinctCategories: string[];
} {
  const catSet = new Set<string>();
  for (const it of items) {
    const label = (it.categoryName || it.productType || '').trim();
    if (label) catSet.add(label);
  }
  const distinctCategories = Array.from(catSet).sort((a, b) => a.localeCompare(b));

  const q = (opts.search || '').trim().toLowerCase();
  const catFilter = (opts.category || '').trim().toLowerCase();
  const statusFilter = opts.status || 'all';

  const matched = items.filter((it) => {
    if (statusFilter === 'imported' && it.importStatus !== 'imported') return false;
    if (statusFilter === 'not_imported' && it.importStatus !== 'not_imported') return false;
    if (catFilter && catFilter !== 'all') {
      const catHay = `${it.categoryName || ''} ${it.productType || ''}`.trim().toLowerCase();
      if (catHay !== catFilter && (it.categoryName || '').trim().toLowerCase() !== catFilter && (it.productType || '').trim().toLowerCase() !== catFilter) {
        return false;
      }
    }
    if (q) {
      const hay = `${it.rawName} ${it.externalProductId} ${it.externalVariantId} ${it.categoryName} ${it.productType} ${it.plainDescriptionPreview}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const pageSize = Math.min(100, Math.max(1, Number(opts.pageSize || 24)));
  const totalMatched = matched.length;
  const totalPages = Math.max(1, Math.ceil(totalMatched / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(opts.page || 1)));
  const start = (page - 1) * pageSize;

  return {
    items: matched.slice(start, start + pageSize),
    totalMatched,
    page,
    pageSize,
    totalPages,
    distinctCategories,
  };
}

export interface PlannedImportValidationResult {
  ok: boolean;
  reason?: string;
  targetCategoryId?: number;
  action: 'create' | 'update' | 'skip';
  finalDescriptionHtml: string;
}

/**
 * Validates per-item import prerequisites BEFORE writing to database:
 * - Strictly requires an existing MedPulse Store category ID (never auto-creates categories).
 * - Prevents accidental duplicates unless explicit `action === 'update'`.
 * - Ensures non-empty supplier descriptions are NEVER dropped to blank on import.
 */
export function validateAndPlanSupplierImport(params: {
  sourceItem: SupplierBrowserItem;
  requestedCategoryId: number | null | undefined;
  validCategoryIds: Set<number>;
  requestedAction?: 'create' | 'update' | 'skip';
}): PlannedImportValidationResult {
  const { sourceItem, requestedCategoryId, validCategoryIds, requestedAction } = params;

  if (!requestedCategoryId || !Number.isInteger(requestedCategoryId) || !validCategoryIds.has(requestedCategoryId)) {
    return {
      ok: false,
      reason: 'يجب اختيار قسم متجر صالح وموجود مسبقًا قبل استيراد المنتج.',
      action: 'skip',
      finalDescriptionHtml: '',
    };
  }

  const hasRaw = (sourceItem.rawDescription || '').trim().length > 0;
  const finalDescriptionHtml = (sourceItem.cleanedImportHtml || sourceItem.previewSafeHtml || '').trim();
  if (hasRaw && !finalDescriptionHtml) {
    return {
      ok: false,
      reason: 'تعذر تجهيز وصف المنتج دون فقدان البيانات الأصلية.',
      action: 'skip',
      finalDescriptionHtml: '',
    };
  }

  if (sourceItem.importStatus === 'imported') {
    if (requestedAction === 'update') {
      return {
        ok: true,
        targetCategoryId: requestedCategoryId,
        action: 'update',
        finalDescriptionHtml,
      };
    }
    return {
      ok: false,
      reason: `المنتج مستورد مسبقًا ومربوط بمنتج المتجر #${sourceItem.existingStoreProductId}.`,
      targetCategoryId: requestedCategoryId,
      action: 'skip',
      finalDescriptionHtml,
    };
  }

  return {
    ok: true,
    targetCategoryId: requestedCategoryId,
    action: 'create',
    finalDescriptionHtml,
  };
}
