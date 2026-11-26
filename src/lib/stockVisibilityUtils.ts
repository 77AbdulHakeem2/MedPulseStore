export type StockVisibilityFilter = 'in_stock' | 'all' | 'out_of_stock';

export interface StockOfferLike {
  stockCount: number;
  isActiveAtProvider?: boolean | null;
}

export interface StoreProductListLike {
  id: number;
  categoryId: number | null;
  sortOrder: number;
  isVisible: boolean;
  isPaused?: boolean;
  totalStock: number;
  titleAr: string;
  titleEn?: string | null;
  sku: string;
  categoryNameAr?: string;
}

/**
 * Returns true strictly when a provider offer is active at the upstream provider AND has positive stock (> 0).
 */
export function isProviderOfferInStock(offer: StockOfferLike): boolean {
  return Number(offer.stockCount || 0) > 0 && offer.isActiveAtProvider !== false;
}

/**
 * Filters provider offers according to stock visibility mode (default `'in_stock'`).
 * When an offer hits 0 stock it is excluded in `'in_stock'` mode, and when restocked (> 0) it reappears automatically.
 */
export function filterProviderOffersByStock<T extends StockOfferLike>(
  offers: T[],
  mode: StockVisibilityFilter = 'in_stock'
): T[] {
  if (mode === 'all') return offers;
  if (mode === 'out_of_stock') {
    return offers.filter((offer) => !isProviderOfferInStock(offer));
  }
  return offers.filter((offer) => isProviderOfferInStock(offer));
}

/**
 * Returns true when a store product has combined stock > 0 across its active linked providers.
 */
export function isStoreProductInStock(product: { totalStock: number }): boolean {
  return Number(product.totalStock || 0) > 0;
}

/**
 * Filters and deterministically sorts store products while preserving exact `sortOrder` & `id` positioning.
 * Critical invariant: out-of-stock products are hidden in `'in_stock'` mode without modifying their `categoryId`,
 * `sortOrder`, or `isVisible`, so once stock refills they return to the exact same slot & category.
 */
export function filterAndSortAdminStoreProducts<T extends StoreProductListLike>(
  products: T[],
  opts: {
    stockFilter?: StockVisibilityFilter;
    visFilter?: 'all' | 'visible' | 'hidden';
    categoryFilter?: string;
    search?: string;
  } = {}
): T[] {
  const stockFilter = opts.stockFilter ?? 'in_stock';
  const visFilter = opts.visFilter ?? 'all';
  const categoryFilter = opts.categoryFilter ?? 'all';
  const q = (opts.search || '').trim().toLowerCase();

  const filtered = products.filter((p) => {
    const hasStock = isStoreProductInStock(p);
    if (stockFilter === 'in_stock' && !hasStock) return false;
    if (stockFilter === 'out_of_stock' && hasStock) return false;

    if (visFilter === 'visible' && (!p.isVisible || p.isPaused)) return false;
    if (visFilter === 'hidden' && p.isVisible) return false;

    if (categoryFilter === 'uncategorized') {
      if (p.categoryId !== null) return false;
    } else if (categoryFilter !== 'all' && String(p.categoryId) !== categoryFilter) {
      return false;
    }

    if (q) {
      const hay = `${p.titleAr} ${p.titleEn || ''} ${p.sku} ${p.categoryNameAr || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }

    return true;
  });

  // Always preserve exact catalog sortOrder -> id (matching customer storefront & Telegram bot ordering)
  return [...filtered].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
}

/**
 * Computes normalized sequential sortOrder updates (10, 20, 30...) when moving a product up or down
 * within the currently viewed ordered list (e.g. a category).
 */
export function computeSwappedProductSortOrders<T extends { id: number; sortOrder: number }>(
  orderedItems: T[],
  index: number,
  delta: -1 | 1
): Array<{ id: number; sortOrder: number }> | null {
  const target = index + delta;
  if (index < 0 || index >= orderedItems.length || target < 0 || target >= orderedItems.length) {
    return null;
  }
  const copy = [...orderedItems];
  const [moved] = copy.splice(index, 1);
  copy.splice(target, 0, moved);
  return copy.map((item, idx) => ({
    id: item.id,
    sortOrder: (idx + 1) * 10,
  }));
}
