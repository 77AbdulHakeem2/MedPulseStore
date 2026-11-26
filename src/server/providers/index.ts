import Decimal from 'decimal.js';
import { verifyHmacSha256 } from '../crypto.ts';
import { extractSupplierRawDescription } from '../productDescriptionEngine.ts';
import {
  extractPaginationDirective,
  extractRawCatalogItemsList,
  normalizeRichSupplierCatalog,
  normalizeRichSupplierItem,
  type SupplierVariantSummary,
} from '../supplierCatalogBrowser.ts';

export interface NormalizedProviderProduct {
  externalProductId: string;
  externalVariantId: string;
  rawName: string;
  rawDescription: string;
  wholesalePrice: string;
  currency: string;
  stockCount: number;
  minQty: number;
  maxQty: number;
  deliveryType: 'code' | 'link' | 'account' | 'manual';
  durationLabel: string;
  warrantyDays: number;
  pricingTiers?: Array<{ minQty: number; maxQty: number | null; price: string }>;
  imageUrl?: string;
  suggestedRetailPrice?: string | null;
  categoryName?: string;
  productType?: string;
  warrantyLabel?: string;
  deliveryInstructions?: string;
  features?: string[];
  variantsSummary?: SupplierVariantSummary[];
  isAvailable?: boolean;
  extraMetadata?: Record<string, string | number | boolean>;
}

export interface NormalizedBalanceResult {
  connected: boolean;
  balance: string;
  currency: string;
  reservedBalance?: string;
  rateLimitPerMin?: number;
  rawError?: string;
}

export interface NormalizedQuoteResult {
  unitPrice: string;
  totalPrice: string;
  currency: string;
  priceVersion?: string;
  sufficientBalance?: boolean;
}

export interface ProviderOrderRequest {
  externalProductId: string;
  externalVariantId?: string;
  quantity: number;
  idempotencyRef: string;
  expectedUnitPrice?: string;
  priceVersion?: string;
  customerLabel?: string;
  acceptNormalPrice?: boolean;
}

export interface ProviderOrderResponse {
  status: 'completed' | 'pending' | 'failed' | 'uncertain';
  uncertainState: boolean;
  providerOrderId?: string;
  deliveredItems?: string[];
  viewUrl?: string;
  chargedTotal?: string;
  deterministicFailureCode?: string;
  rawError?: string;
  idempotentReplay?: boolean;
}

export interface ProviderAdapter {
  code: string;
  name: string;
  baseUrl: string;
  docsUrl?: string;
  authHeader?: string;
  supportsIdempotency: boolean;
  supportsWebhooks: boolean;
  supportsQuote: boolean;
  testConnection(apiKey: string): Promise<NormalizedBalanceResult>;
  fetchProducts(apiKey: string): Promise<NormalizedProviderProduct[]>;
  getQuote(
    apiKey: string,
    params: { externalProductId: string; externalVariantId?: string; quantity: number }
  ): Promise<NormalizedQuoteResult | null>;
  placeOrder(apiKey: string, req: ProviderOrderRequest): Promise<ProviderOrderResponse>;
  getOrderStatus(apiKey: string, providerOrderId: string): Promise<ProviderOrderResponse>;
  verifyWebhookSignature?(rawBody: string | Buffer, signature: string, secret: string): boolean;
}

// Per-provider rate limit tracking (respects 60 req/min documented on AIVault Hub & Pixora)
const rateLimitBuckets = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(providerCode: string, limitPerMin = 60): boolean {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(providerCode);
  if (!bucket || now - bucket.windowStart >= 60_000) {
    rateLimitBuckets.set(providerCode, { count: 1, windowStart: now });
    return true;
  }
  if (bucket.count >= limitPerMin) {
    return false;
  }
  bucket.count += 1;
  return true;
}

async function safeFetchJson(
  providerCode: string,
  url: string,
  init: RequestInit,
  timeoutMs = 12_000,
  limitPerMin = 60
): Promise<{ ok: boolean; status: number; data: any; networkUncertain: boolean; errorText?: string }> {
  if (!checkRateLimit(providerCode, limitPerMin)) {
    return {
      ok: false,
      status: 429,
      data: null,
      networkUncertain: false,
      errorText: 'RATE_LIMITED_LOCAL',
    };
  }
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 300) };
    }
    return { ok: res.ok, status: res.status, data, networkUncertain: false };
  } catch (err: any) {
    // Network drop / timeout AFTER sending request -> mark uncertainState so caller NEVER blindly double-buys!
    return {
      ok: false,
      status: 0,
      data: null,
      networkUncertain: true,
      errorText: err?.message || 'NETWORK_TIMEOUT',
    };
  }
}

// ============================================================================
// 1. Pixora API (https://daddyclub.bar/pixora-api/v1)
// Docs verified: GET /user/me, GET /stock, POST /order, GET /order/{order_code}
// ============================================================================
export const pixoraAdapter: ProviderAdapter = {
  code: 'pixora',
  name: 'Pixora API',
  baseUrl: 'https://daddyclub.bar/pixora-api/v1',
  supportsIdempotency: false, // custom_ref is optional metadata, not guaranteed idempotent replay
  supportsWebhooks: false,
  supportsQuote: false,

  async testConnection(apiKey: string): Promise<NormalizedBalanceResult> {
    const res = await safeFetchJson('pixora', `${this.baseUrl}/user/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok || !res.data?.success) {
      return {
        connected: false,
        balance: '0.0000',
        currency: 'USD',
        rawError: res.errorText || `HTTP_${res.status}`,
      };
    }
    return {
      connected: true,
      balance: new Decimal(res.data.balance ?? 0).toFixed(4),
      currency: 'USD',
      rateLimitPerMin: Number(res.data.rate_limit_per_min ?? 60),
    };
  },

  async fetchProducts(apiKey: string): Promise<NormalizedProviderProduct[]> {
    const res = await safeFetchJson('pixora', `${this.baseUrl}/stock`, {
      method: 'GET',
      headers: { 'X-API-Key': apiKey, Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok || !res.data) {
      throw new Error(`Pixora catalog error: HTTP ${res.status}`);
    }
    const items = Array.isArray(res.data) ? res.data : extractRawCatalogItemsList(res.data);
    const list = items.length > 0 ? items : [res.data];
    return list
      .filter((p: any) => p && (p.service_key || p.id || p.product_id))
      .map((p: any) => {
        const rich = normalizeRichSupplierItem(p, String(p.currency || 'USD'))[0];
        return {
          ...(rich || {}),
          externalProductId: String(p.service_key || p.id || rich?.externalProductId || ''),
          externalVariantId: rich?.externalVariantId || '',
          rawName: String(p.name || p.service_key || rich?.rawName || 'Product'),
          rawDescription: extractSupplierRawDescription(p) || rich?.rawDescription || 'Instant activation link delivery',
          wholesalePrice: new Decimal(p.price ?? rich?.wholesalePrice ?? 0).toFixed(4),
          currency: String(p.currency || 'USD'),
          stockCount: Number(p.stock ?? rich?.stockCount ?? 0),
          minQty: rich?.minQty || 1,
          maxQty: rich?.maxQty || 20,
          deliveryType: 'link',
          durationLabel: rich?.durationLabel || (/24m/i.test(String(p.name || p.service_key)) ? '24 شهر' : '18 شهر'),
          warrantyDays: rich?.warrantyDays ?? 540,
        };
      });
  },

  async getQuote() {
    return null;
  },

  async placeOrder(apiKey: string, req: ProviderOrderRequest): Promise<ProviderOrderResponse> {
    const res = await safeFetchJson('pixora', `${this.baseUrl}/order`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        service_key: req.externalProductId,
        quantity: Math.min(Math.max(1, req.quantity), 20),
        custom_ref: req.idempotencyRef,
      }),
    });

    if (res.networkUncertain) {
      return { status: 'uncertain', uncertainState: true, rawError: res.errorText };
    }
    if (!res.ok || !res.data?.success) {
      const code =
        res.status === 402 || /balance/i.test(JSON.stringify(res.data))
          ? 'INSUFFICIENT_BALANCE'
          : /stock/i.test(JSON.stringify(res.data))
            ? 'OUT_OF_STOCK'
            : undefined;
      return {
        status: 'failed',
        uncertainState: false,
        deterministicFailureCode: code,
        rawError: JSON.stringify(res.data || res.errorText).slice(0, 240),
      };
    }

    const items = Array.isArray(res.data.items)
      ? res.data.items.map((it: any) => String(it.activation_link || it.code || it.order_code))
      : [];
    const firstCode = res.data.items?.[0]?.order_code;
    return {
      status: 'completed',
      uncertainState: false,
      providerOrderId: firstCode ? String(firstCode) : String(res.data.order_id || req.idempotencyRef),
      deliveredItems: items,
      chargedTotal: new Decimal(res.data.total_paid ?? 0).toFixed(4),
    };
  },

  async getOrderStatus(apiKey: string, providerOrderId: string): Promise<ProviderOrderResponse> {
    const res = await safeFetchJson('pixora', `${this.baseUrl}/order/${encodeURIComponent(providerOrderId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.networkUncertain) return { status: 'uncertain', uncertainState: true, rawError: res.errorText };
    if (!res.ok) return { status: 'failed', uncertainState: false, rawError: `HTTP_${res.status}` };
    const link = res.data?.activation_link || res.data?.items?.[0]?.activation_link;
    return {
      status: link ? 'completed' : 'pending',
      uncertainState: false,
      providerOrderId,
      deliveredItems: link ? [String(link)] : [],
    };
  },
};

// ============================================================================
// 2. Pandora Digital (https://api.pandoradigital.shop/api/v1)
// OpenAPI verified: GET /balance, GET /products, POST /quotes, POST /orders (Idempotency-Key header)
// ============================================================================
export const pandoraAdapter: ProviderAdapter = {
  code: 'pandora',
  name: 'Pandora Digital',
  baseUrl: 'https://api.pandoradigital.shop/api/v1',
  supportsIdempotency: true,
  supportsWebhooks: true,
  supportsQuote: true,

  async testConnection(apiKey: string): Promise<NormalizedBalanceResult> {
    const res = await safeFetchJson('pandora', `${this.baseUrl}/balance`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok || !res.data) {
      return { connected: false, balance: '0.0000', currency: 'USD', rawError: res.errorText || `HTTP_${res.status}` };
    }
    return {
      connected: true,
      balance: new Decimal(res.data.available_balance ?? 0).toFixed(4),
      reservedBalance: new Decimal(res.data.reserved_balance ?? 0).toFixed(4),
      currency: String(res.data.currency || 'USD'),
    };
  },

  async fetchProducts(apiKey: string): Promise<NormalizedProviderProduct[]> {
    const headers = { Authorization: `Bearer ${apiKey}` };
    const allItems: NormalizedProviderProduct[] = [];
    const seenKeys = new Set<string>();
    const origin = new URL(this.baseUrl).origin;
    let page = 1;
    let nextDirectUrl: string | null = `${this.baseUrl}/products?limit=100&page=1`;

    for (let hop = 0; hop < 15 && nextDirectUrl; hop++) {
      const res = await safeFetchJson('pandora', nextDirectUrl, { method: 'GET', headers }, 15_000, 60);
      if (!res.ok || !res.data) {
        if (hop === 0) throw new Error(`Pandora catalog error: HTTP ${res.status}`);
        Object.defineProperty(allItems, '__partial', { value: true, enumerable: false });
        break;
      }
      const rawList = Array.isArray(res.data) ? res.data : res.data.items || res.data.products || res.data.data || [];
      if (!Array.isArray(rawList) || rawList.length === 0) break;

      let addedThisPage = 0;
      for (const p of rawList) {
        const richList = normalizeRichSupplierItem(p, String(p.currency || 'USD'));
        for (const rich of richList) {
          const extId = String(p.id ?? rich.externalProductId);
          const varId = p.variant_id ? String(p.variant_id) : rich.externalVariantId || '';
          const dedupKey = `${extId}::${varId}`;
          if (seenKeys.has(dedupKey)) continue;
          seenKeys.add(dedupKey);
          addedThisPage += 1;
          allItems.push({
            ...rich,
            externalProductId: extId,
            externalVariantId: varId,
            rawName: p.variant_name ? `${p.name} — ${p.variant_name}` : String(p.name || rich.rawName),
            rawDescription: extractSupplierRawDescription(p) || rich.rawDescription,
            wholesalePrice: new Decimal(p.unit_price ?? rich.wholesalePrice ?? 0).toFixed(4),
            currency: String(p.currency || rich.currency || 'USD'),
            stockCount: Number(p.available_stock ?? rich.stockCount ?? 0),
            minQty: Number(p.minimum_quantity ?? rich.minQty ?? 1),
            maxQty: Number(p.maximum_quantity ?? rich.maxQty ?? 100),
            deliveryType: String(p.delivery_type || rich.deliveryType || 'code').includes('account')
              ? 'account'
              : String(p.delivery_type || rich.deliveryType || 'code').includes('link')
                ? 'link'
                : 'code',
          });
        }
      }

      if (addedThisPage === 0) break;
      const directive = extractPaginationDirective(res.data, page, (page - 1) * 100, 100, rawList.length, origin);
      if (directive.kind === 'url') {
        nextDirectUrl = directive.nextUrl;
        page += 1;
      } else if (directive.kind === 'cursor') {
        nextDirectUrl = `${this.baseUrl}/products?limit=100&cursor=${encodeURIComponent(directive.cursor)}`;
        page += 1;
      } else if (directive.kind === 'page') {
        page = directive.nextPage;
        nextDirectUrl = `${this.baseUrl}/products?limit=100&page=${page}`;
      } else if (directive.kind === 'offset') {
        nextDirectUrl = `${this.baseUrl}/products?limit=${directive.limit}&offset=${directive.nextOffset}`;
        page += 1;
      } else if (rawList.length >= 100 && Array.isArray(res.data?.items || res.data?.products)) {
        // Fallback page probe when total count omitted on a full 100-item page
        page += 1;
        nextDirectUrl = `${this.baseUrl}/products?limit=100&page=${page}`;
      } else {
        nextDirectUrl = null;
      }
    }

    return allItems;
  },

  async getQuote(apiKey: string, params): Promise<NormalizedQuoteResult | null> {
    const res = await safeFetchJson('pandora', `${this.baseUrl}/quotes`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        product_id: params.externalProductId,
        variant_id: params.externalVariantId || null,
        quantity: params.quantity,
      }),
    });
    if (!res.ok || !res.data) return null;
    return {
      unitPrice: new Decimal(res.data.unit_price ?? 0).toFixed(4),
      totalPrice: new Decimal(res.data.total_amount ?? new Decimal(res.data.unit_price ?? 0).times(params.quantity)).toFixed(4),
      currency: String(res.data.currency || 'USD'),
      priceVersion: res.data.price_version ? String(res.data.price_version) : undefined,
    };
  },

  async placeOrder(apiKey: string, req: ProviderOrderRequest): Promise<ProviderOrderResponse> {
    const quote = await this.getQuote(apiKey, {
      externalProductId: req.externalProductId,
      externalVariantId: req.externalVariantId,
      quantity: req.quantity,
    });
    const res = await safeFetchJson('pandora', `${this.baseUrl}/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': req.idempotencyRef,
      },
      body: JSON.stringify({
        product_id: req.externalProductId,
        variant_id: req.externalVariantId || null,
        quantity: req.quantity,
        expected_unit_price: quote?.unitPrice || req.expectedUnitPrice || '0.01',
        price_version: quote?.priceVersion || req.priceVersion || null,
        client_order_reference: req.idempotencyRef,
      }),
    });
    if (res.networkUncertain) return { status: 'uncertain', uncertainState: true, rawError: res.errorText };
    if (!res.ok) {
      const errCode = res.data?.error?.code;
      return {
        status: 'failed',
        uncertainState: false,
        deterministicFailureCode: errCode || undefined,
        rawError: JSON.stringify(res.data || res.errorText).slice(0, 240),
      };
    }
    const statusRaw = String(res.data?.status || 'processing').toLowerCase();
    const deliveryItems = extractDeliveryItems(res.data?.delivery);
    return {
      status: statusRaw === 'delivered' || statusRaw === 'completed' ? 'completed' : 'pending',
      uncertainState: false,
      providerOrderId: String(res.data.id),
      deliveredItems: deliveryItems,
      chargedTotal: new Decimal(res.data.total_amount ?? 0).toFixed(4),
    };
  },

  async getOrderStatus(apiKey: string, providerOrderId: string): Promise<ProviderOrderResponse> {
    const res = await safeFetchJson('pandora', `${this.baseUrl}/orders/${encodeURIComponent(providerOrderId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.networkUncertain) return { status: 'uncertain', uncertainState: true, rawError: res.errorText };
    if (!res.ok) return { status: 'failed', uncertainState: false, rawError: `HTTP_${res.status}` };
    const statusRaw = String(res.data?.status || '').toLowerCase();
    return {
      status:
        statusRaw === 'delivered' || statusRaw === 'completed'
          ? 'completed'
          : statusRaw === 'failed' || statusRaw === 'refunded'
            ? 'failed'
            : 'pending',
      uncertainState: false,
      providerOrderId,
      deliveredItems: extractDeliveryItems(res.data?.delivery),
    };
  },
};

// ============================================================================
// 3. QORIX (https://qorixlab.com/api/public/reseller/v1)
// Docs verified: GET /me, GET /products?channel=bot, POST /orders, GET /orders/:id
// ============================================================================
export const qorixAdapter: ProviderAdapter = {
  code: 'qorix',
  name: 'QORIX',
  baseUrl: 'https://qorixlab.com/api/public/reseller/v1',
  supportsIdempotency: true, // external_ref prevents duplicate buys
  supportsWebhooks: false,
  supportsQuote: false,

  async testConnection(apiKey: string): Promise<NormalizedBalanceResult> {
    const res = await safeFetchJson('qorix', `${this.baseUrl}/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      redirect: 'manual',
    });
    if (!res.ok || !res.data) {
      return { connected: false, balance: '0.0000', currency: 'USD', rawError: res.errorText || `HTTP_${res.status}` };
    }
    const bal = res.data.balance ?? res.data.wallet_balance ?? res.data.account?.balance ?? 0;
    return {
      connected: true,
      balance: new Decimal(bal).toFixed(4),
      currency: String(res.data.currency || 'USD'),
    };
  },

  async fetchProducts(apiKey: string): Promise<NormalizedProviderProduct[]> {
    const res = await safeFetchJson('qorix', `${this.baseUrl}/products?channel=bot`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      redirect: 'manual',
    });
    if (!res.ok || !res.data) {
      throw new Error(`QORIX catalog error: HTTP ${res.status}`);
    }
    const list = Array.isArray(res.data) ? res.data : res.data.products || res.data.data || [];
    return list.flatMap((p: any) => {
      const richList = normalizeRichSupplierItem(p, String(p.currency || 'USD'));
      return richList.map((rich) => ({
        ...rich,
        externalProductId: String(p.id || p.product_id || rich.externalProductId),
        rawName: String(p.name || p.title || rich.rawName),
        rawDescription: extractSupplierRawDescription(p) || rich.rawDescription,
        wholesalePrice: new Decimal(p.reseller_price ?? p.price ?? rich.wholesalePrice ?? 0).toFixed(4),
        currency: String(p.currency || rich.currency || 'USD'),
        stockCount: Number(p.stock ?? (p.in_stock ? 25 : rich.stockCount ?? 0)),
        deliveryType: rich.deliveryType || 'account',
      }));
    });
  },

  async getQuote() {
    return null;
  },

  async placeOrder(apiKey: string, req: ProviderOrderRequest): Promise<ProviderOrderResponse> {
    const res = await safeFetchJson('qorix', `${this.baseUrl}/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      redirect: 'manual',
      body: JSON.stringify({
        product_id: req.externalProductId,
        quantity: req.quantity,
        channel: 'bot',
        external_ref: req.idempotencyRef,
        customer_name: req.customerLabel || 'Store Customer',
      }),
    });
    if (res.networkUncertain) return { status: 'uncertain', uncertainState: true, rawError: res.errorText };
    if (!res.ok) {
      const code =
        res.status === 402
          ? 'INSUFFICIENT_BALANCE'
          : res.status === 404
            ? 'PRODUCT_NOT_FOUND'
            : res.status === 409
              ? 'DELIVERY_FAILED_REFUNDED'
              : undefined;
      return {
        status: 'failed',
        uncertainState: false,
        deterministicFailureCode: code,
        rawError: JSON.stringify(res.data || res.errorText).slice(0, 240),
      };
    }
    const items = Array.isArray(res.data?.items) ? res.data.items.map(formatDeliveredItem) : [];
    const completed = res.data?.status === 'completed' && items.length > 0;
    return {
      status: completed ? 'completed' : 'pending',
      uncertainState: false,
      providerOrderId: String(res.data?.id || res.data?.order_id || req.idempotencyRef),
      deliveredItems: items,
      chargedTotal: new Decimal(res.data?.total_price ?? res.data?.total ?? 0).toFixed(4),
    };
  },

  async getOrderStatus(apiKey: string, providerOrderId: string): Promise<ProviderOrderResponse> {
    const res = await safeFetchJson('qorix', `${this.baseUrl}/orders/${encodeURIComponent(providerOrderId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      redirect: 'manual',
    });
    if (res.networkUncertain) return { status: 'uncertain', uncertainState: true, rawError: res.errorText };
    if (!res.ok) return { status: 'failed', uncertainState: false, rawError: `HTTP_${res.status}` };
    const items = Array.isArray(res.data?.items) ? res.data.items.map(formatDeliveredItem) : [];
    return {
      status: res.data?.status === 'completed' && items.length > 0 ? 'completed' : res.data?.status === 'failed' ? 'failed' : 'pending',
      uncertainState: false,
      providerOrderId,
      deliveredItems: items,
    };
  },
};

// ============================================================================
// 4. DigitalCore (https://digitalcore.top)
// Docs verified: GET /api/user/me, GET /api/user/products, POST /api/user/buy, GET /api/user/order?id=...
// WARNING: No documented Idempotency key -> NEVER auto-retry on uncertain network failure!
// ============================================================================
export const digitalCoreAdapter: ProviderAdapter = {
  code: 'digitalcore',
  name: 'DigitalCore',
  baseUrl: 'https://digitalcore.top',
  supportsIdempotency: false,
  supportsWebhooks: false,
  supportsQuote: false,

  async testConnection(apiKey: string): Promise<NormalizedBalanceResult> {
    const res = await safeFetchJson('digitalcore', `${this.baseUrl}/api/user/me`, {
      method: 'GET',
      headers: { 'Api-Key': apiKey },
    });
    if (!res.ok || !res.data || res.data.success === false) {
      return { connected: false, balance: '0.0000', currency: 'USD', rawError: res.data?.msg || `HTTP_${res.status}` };
    }
    return {
      connected: true,
      balance: new Decimal(res.data.balance ?? 0).toFixed(4),
      currency: 'USD',
    };
  },

  async fetchProducts(apiKey: string): Promise<NormalizedProviderProduct[]> {
    const res = await safeFetchJson('digitalcore', `${this.baseUrl}/api/user/products`, {
      method: 'GET',
      headers: { 'Api-Key': apiKey },
    });
    if (!res.ok || !Array.isArray(res.data)) {
      throw new Error(`DigitalCore catalog error: HTTP ${res.status}`);
    }
    return res.data.flatMap((p: any) => {
      const richList = normalizeRichSupplierItem(p, 'USD');
      return richList.map((rich) => ({
        ...rich,
        externalProductId: String(p.id ?? rich.externalProductId),
        rawName: String(p.name || rich.rawName),
        rawDescription: extractSupplierRawDescription(p) || rich.rawDescription,
        wholesalePrice: new Decimal(p.price ?? rich.wholesalePrice ?? 0).toFixed(4),
        currency: 'USD',
        stockCount: Number(p.stock ?? rich.stockCount ?? 0),
        deliveryType: 'link',
      }));
    });
  },

  async getQuote() {
    return null;
  },

  async placeOrder(apiKey: string, req: ProviderOrderRequest): Promise<ProviderOrderResponse> {
    const res = await safeFetchJson('digitalcore', `${this.baseUrl}/api/user/buy`, {
      method: 'POST',
      headers: {
        'Api-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: req.externalProductId,
        count: Math.min(Math.max(1, req.quantity), 1000),
      }),
    });
    // CRITICAL: DigitalCore has no idempotency key; on timeout/drop mark uncertainState=true and halt!
    if (res.networkUncertain) {
      return {
        status: 'uncertain',
        uncertainState: true,
        rawError: 'DIGITALCORE_NETWORK_UNCERTAIN_DO_NOT_RETRY',
      };
    }
    if (!res.ok || !res.data?.success) {
      const msg = String(res.data?.msg || '');
      const code =
        msg === 'OUT_OF_STOCK' || msg === 'INSUFFICIENT_BALANCE' || msg === 'PRODUCT_NOT_FOUND'
          ? msg
          : undefined;
      return {
        status: 'failed',
        uncertainState: false,
        deterministicFailureCode: code,
        rawError: msg || `HTTP_${res.status}`,
      };
    }
    return {
      status: 'completed',
      uncertainState: false,
      providerOrderId: String(res.data.order_id),
      viewUrl: res.data.view_url ? String(res.data.view_url) : undefined,
      deliveredItems: Array.isArray(res.data.items) ? res.data.items.map(String) : [],
      chargedTotal: new Decimal(res.data.total_amount ?? 0).toFixed(4),
    };
  },

  async getOrderStatus(apiKey: string, providerOrderId: string): Promise<ProviderOrderResponse> {
    const res = await safeFetchJson(
      'digitalcore',
      `${this.baseUrl}/api/user/order?id=${encodeURIComponent(providerOrderId)}`,
      {
        method: 'GET',
        headers: { 'Api-Key': apiKey },
      }
    );
    if (res.networkUncertain) return { status: 'uncertain', uncertainState: true, rawError: res.errorText };
    if (!res.ok || !res.data) return { status: 'failed', uncertainState: false, rawError: `HTTP_${res.status}` };
    return {
      status: Array.isArray(res.data.items) && res.data.items.length > 0 ? 'completed' : 'pending',
      uncertainState: false,
      providerOrderId,
      deliveredItems: Array.isArray(res.data.items) ? res.data.items.map(String) : [],
      viewUrl: res.data.view_url ? String(res.data.view_url) : undefined,
    };
  },
};

// ============================================================================
// 5. AIVault Hub (https://reseller.aivaulthub.store/api/v1)
// Docs verified: X-API-Key, GET /me, /products, /quote, POST /order (external_order_id),
// GET /order/{id}, HMAC-SHA256 X-Webhook-Signature, 60 req/min rate limit
// ============================================================================
export const aiVaultHubAdapter: ProviderAdapter = {
  code: 'aivaulthub',
  name: 'AIVault Hub',
  baseUrl: 'https://reseller.aivaulthub.store/api/v1',
  supportsIdempotency: true,
  supportsWebhooks: true,
  supportsQuote: true,

  async testConnection(apiKey: string): Promise<NormalizedBalanceResult> {
    const res = await safeFetchJson('aivaulthub', `${this.baseUrl}/me`, {
      method: 'GET',
      headers: { 'X-API-Key': apiKey },
    }, 12_000, 60);
    if (!res.ok || !res.data) {
      return { connected: false, balance: '0.0000', currency: 'USD', rawError: res.errorText || `HTTP_${res.status}` };
    }
    return {
      connected: true,
      balance: new Decimal(res.data.balance ?? res.data.balance_usd ?? 0).toFixed(4),
      currency: String(res.data.currency || 'USD'),
      rateLimitPerMin: 60,
    };
  },

  async fetchProducts(apiKey: string): Promise<NormalizedProviderProduct[]> {
    const res = await safeFetchJson('aivaulthub', `${this.baseUrl}/products`, {
      method: 'GET',
      headers: { 'X-API-Key': apiKey },
    }, 12_000, 60);
    if (!res.ok || !res.data) {
      throw new Error(`AIVault Hub catalog error: HTTP ${res.status}`);
    }
    const list = Array.isArray(res.data.products) ? res.data.products : extractRawCatalogItemsList(res.data);
    return list.flatMap((p: any) => {
      const richList = normalizeRichSupplierItem(p, 'USD');
      const firstTierPrice = Array.isArray(p.pricing_tiers) && p.pricing_tiers[0]?.price
        ? p.pricing_tiers[0].price
        : p.price ?? richList[0]?.wholesalePrice ?? 0;
      return richList.map((rich) => ({
        ...rich,
        externalProductId: String(p.service_id ?? rich.externalProductId),
        rawName: String(p.name ?? rich.rawName),
        rawDescription: extractSupplierRawDescription(p) || rich.rawDescription,
        wholesalePrice: new Decimal(firstTierPrice).toFixed(4),
        currency: 'USD',
        stockCount: Number(p.stock ?? rich.stockCount ?? 0),
      }));
    });
  },

  async getQuote(apiKey: string, params): Promise<NormalizedQuoteResult | null> {
    const qs = new URLSearchParams({
      service_id: params.externalProductId,
      quantity: String(params.quantity),
    });
    const res = await safeFetchJson('aivaulthub', `${this.baseUrl}/quote?${qs.toString()}`, {
      method: 'GET',
      headers: { 'X-API-Key': apiKey },
    }, 12_000, 60);
    if (!res.ok || !res.data) return null;
    const pb = res.data.price_breakdown || res.data;
    return {
      unitPrice: new Decimal(pb.unit_price ?? 0).toFixed(4),
      totalPrice: new Decimal(pb.final_total ?? pb.base_total ?? 0).toFixed(4),
      currency: String(res.data.currency || 'USD'),
      sufficientBalance: Boolean(res.data.sufficient_balance ?? true),
    };
  },

  async placeOrder(apiKey: string, req: ProviderOrderRequest): Promise<ProviderOrderResponse> {
    const payload: Record<string, any> = {
      service_id: req.externalProductId,
      quantity: req.quantity,
      external_order_id: req.idempotencyRef,
    };
    if (req.acceptNormalPrice) {
      payload.accept_normal_price = true;
    }
    const res = await safeFetchJson('aivaulthub', `${this.baseUrl}/order`, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }, 12_000, 60);

    if (res.networkUncertain) return { status: 'uncertain', uncertainState: true, rawError: res.errorText };
    if (!res.ok || !res.data?.success) {
      const text = JSON.stringify(res.data || res.errorText);
      const code =
        /balance/i.test(text)
          ? 'INSUFFICIENT_BALANCE'
          : /stock/i.test(text)
            ? 'OUT_OF_STOCK'
            : res.status === 404
              ? 'PRODUCT_NOT_FOUND'
              : undefined;
      return {
        status: 'failed',
        uncertainState: false,
        deterministicFailureCode: code,
        rawError: text.slice(0, 240),
      };
    }

    return {
      status: 'completed',
      uncertainState: false,
      providerOrderId: String(res.data.order_id),
      deliveredItems: Array.isArray(res.data.products) ? res.data.products.map(String) : [],
      chargedTotal: new Decimal(res.data.total_cost ?? 0).toFixed(4),
      idempotentReplay: Boolean(res.data.idempotent_replay),
    };
  },

  async getOrderStatus(apiKey: string, providerOrderId: string): Promise<ProviderOrderResponse> {
    const res = await safeFetchJson(
      'aivaulthub',
      `${this.baseUrl}/order/${encodeURIComponent(providerOrderId)}`,
      {
        method: 'GET',
        headers: { 'X-API-Key': apiKey },
      },
      12_000,
      60
    );
    if (res.networkUncertain) return { status: 'uncertain', uncertainState: true, rawError: res.errorText };
    if (!res.ok || !res.data) return { status: 'failed', uncertainState: false, rawError: `HTTP_${res.status}` };
    return {
      status: res.data.status === 'delivered' ? 'completed' : res.data.status === 'failed' ? 'failed' : 'pending',
      uncertainState: false,
      providerOrderId,
      deliveredItems: Array.isArray(res.data.products) ? res.data.products.map(String) : [],
    };
  },

  verifyWebhookSignature(rawBody: string | Buffer, signature: string, secret: string): boolean {
    return verifyHmacSha256(rawBody, signature, secret, 'sha256=');
  },
};

function extractDeliveryItems(delivery: any): string[] {
  if (!delivery) return [];
  if (typeof delivery === 'string') return [delivery];
  if (Array.isArray(delivery)) return delivery.map(formatDeliveredItem);
  if (Array.isArray(delivery.accounts)) return delivery.accounts.map(formatDeliveredItem);
  if (Array.isArray(delivery.products)) return delivery.products.map(formatDeliveredItem);
  if (Array.isArray(delivery.cards)) return delivery.cards.map(formatDeliveredItem);
  if (Array.isArray(delivery.keys)) return delivery.keys.map(formatDeliveredItem);
  if (Array.isArray(delivery.items)) return delivery.items.map(formatDeliveredItem);
  if (Array.isArray(delivery.codes)) return delivery.codes.map(String);
  if (typeof delivery.value === 'string' && delivery.value) return [delivery.value];
  if (typeof delivery.content === 'string' && delivery.content) return [delivery.content];
  if (typeof delivery.text === 'string' && delivery.text) return [delivery.text];
  if (delivery.order) return extractDeliveryItems(delivery.order);
  if (delivery.data) return extractDeliveryItems(delivery.data);
  return [JSON.stringify(delivery)];
}

function formatDeliveredItem(item: any): string {
  if (typeof item === 'string') return item;
  if (item?.code) return String(item.code);
  if (item?.card) return String(item.card);
  if (item?.key) return String(item.key);
  if (item?.value) return String(item.value);
  if (item?.activation_link) return String(item.activation_link);
  if (item?.email && item?.password) return `Email: ${item.email} | Pass: ${item.password}`;
  return JSON.stringify(item);
}

function safeDecimalString(val: unknown, fallback = '0.0000'): string {
  if (val === null || val === undefined || val === '') return fallback;
  try {
    const cleaned = String(val).replace(/[^0-9.\-]/g, '');
    if (!cleaned) return fallback;
    return new Decimal(cleaned).toFixed(4);
  } catch {
    return fallback;
  }
}

function buildAuthHeaders(
  apiKey: string,
  authHeader: string,
  authType: string,
  extraHeaders?: Record<string, string>
): Record<string, string> {
  const key = String(apiKey || '').trim();
  const headers: Record<string, string> = { ...(extraHeaders || {}) };

  // Support LukuAI dual-header format: "X-User-Id: 123\nX-Api-Key: pk_..." or "123:pk_..." or "123|pk_..."
  if (authType === 'partner_pair' || /x-user-id/i.test(key)) {
    const userIdMatch = key.match(/x-user-id\s*:\s*([^\s\r\n]+)/i);
    const apiKeyMatch = key.match(/x-api-key\s*:\s*([^\s\r\n]+)/i);
    if (userIdMatch && apiKeyMatch) {
      headers['X-User-Id'] = userIdMatch[1].trim();
      headers['X-Api-Key'] = apiKeyMatch[1].trim();
      return headers;
    }
    const pairSep = key.includes(':') ? ':' : key.includes('|') ? '|' : null;
    if (pairSep) {
      const idx = key.indexOf(pairSep);
      const uid = key.slice(0, idx).trim();
      const secret = key.slice(idx + 1).trim();
      if (uid && secret) {
        headers['X-User-Id'] = uid;
        headers['X-Api-Key'] = secret;
        return headers;
      }
    }
    headers['X-Api-Key'] = key;
    return headers;
  }

  const hdr = String(authHeader || '').trim();
  if (authType === 'bearer' || hdr.toLowerCase() === 'authorization') {
    headers['Authorization'] = /^bearer\s+/i.test(key) ? key : `Bearer ${key}`;
    return headers;
  }

  headers[hdr || 'X-API-Key'] = key;
  return headers;
}

function extractBalancePayload(data: any): { balance: string; currency: string; found: boolean } {
  if (!data || typeof data !== 'object') {
    return { balance: '0.0000', currency: 'USD', found: false };
  }
  const candidates = [
    data.balance_usdt,
    data.usdt_balance,
    data.wallet_balance,
    data.balance,
    data.credits,
    data.available_balance,
    data.data?.balance_usdt,
    data.data?.wallet_balance,
    data.data?.balance,
    data.data?.credits,
    data.user?.balance,
    data.user?.wallet_balance,
    data.account?.balance,
    data.wallet?.balance,
    data.wallet?.available,
    data.balance_vnd,
  ];
  const foundVal = candidates.find((v) => v !== undefined && v !== null && v !== '');
  const currency = String(
    data.currency ||
      data.data?.currency ||
      data.wallet?.currency ||
      (data.balance_usdt !== undefined ? 'USDT' : data.balance_vnd !== undefined ? 'VND' : 'USD')
  );
  return {
    balance: foundVal !== undefined ? safeDecimalString(foundVal) : '0.0000',
    currency,
    found: foundVal !== undefined,
  };
}

function normalizeGenericCatalogItems(rawData: any): NormalizedProviderProduct[] {
  return normalizeRichSupplierCatalog(rawData, 'USD');
}

function inferDeliveryType(hint: string): 'code' | 'link' | 'account' | 'manual' {
  const h = (hint || '').toLowerCase();
  if (h.includes('link') || h.includes('invite') || h.includes('redeem')) return 'link';
  if (h.includes('account') || h.includes('acc') || h.includes('email') || h.includes('slot')) return 'account';
  if (h.includes('manual') || h.includes('upgrade')) return 'manual';
  return 'code';
}

interface ConfigurableResellerSpec {
  code: string;
  name: string;
  baseUrl: string;
  docsUrl: string;
  authType: 'bearer' | 'x_api_key' | 'api_key' | 'partner_pair';
  authHeader: string;
  rateLimitPerMin?: number;
  balancePaths: string[];
  productsPaths: string[];
  orderPath: string;
  orderFallbackPaths?: string[];
  orderStatusPath?: (orderId: string) => string;
  buildOrderBody?: (req: ProviderOrderRequest) => Record<string, any>;
  idempotencyHeader?: string;
}

function createConfigurableResellerAdapter(spec: ConfigurableResellerSpec): ProviderAdapter {
  const cleanBase = spec.baseUrl.replace(/\/+$/, '');
  const limit = spec.rateLimitPerMin || 60;

  return {
    code: spec.code,
    name: spec.name,
    baseUrl: cleanBase,
    docsUrl: spec.docsUrl,
    authHeader: spec.authHeader,
    supportsIdempotency: Boolean(spec.idempotencyHeader),
    supportsWebhooks: false,
    supportsQuote: false,

    async testConnection(apiKey: string): Promise<NormalizedBalanceResult> {
      const headers = buildAuthHeaders(apiKey, spec.authHeader, spec.authType, {
        Accept: 'application/json',
      });
      let lastError = 'CONNECTION_FAILED';

      for (const path of spec.balancePaths) {
        const url = `${cleanBase}${path.startsWith('/') ? path : `/${path}`}`;
        const res = await safeFetchJson(spec.code, url, { method: 'GET', headers }, 12_000, limit);
        if (res.ok && res.data && typeof res.data === 'object') {
          if (res.data.ok === false || res.data.success === false) {
            lastError = String(res.data.error?.message || res.data.message || res.data.error || `HTTP_${res.status}`);
            continue;
          }
          const bal = extractBalancePayload(res.data);
          return {
            connected: true,
            balance: bal.balance,
            currency: bal.currency,
          };
        }
        if (res.status === 401 || res.status === 403) {
          const msg =
            (res.data && (res.data.message || res.data.error?.message || res.data.error)) ||
            `HTTP_${res.status}_UNAUTHORIZED`;
          return {
            connected: false,
            balance: '0.0000',
            currency: 'USD',
            rawError: String(msg).slice(0, 200),
          };
        }
        lastError =
          (res.data && (res.data.message || res.data.error?.message || res.data.error)) ||
          res.errorText ||
          `HTTP_${res.status}`;
      }

      // Fallback: if balance endpoint wasn't found (404), try products endpoint to verify key validity
      for (const pPath of spec.productsPaths) {
        const url = `${cleanBase}${pPath.startsWith('/') ? pPath : `/${pPath}`}`;
        const res = await safeFetchJson(spec.code, url, { method: 'GET', headers }, 12_000, limit);
        if (res.ok && res.data) {
          return {
            connected: true,
            balance: '0.0000',
            currency: 'USD',
          };
        }
        if (res.status === 401 || res.status === 403) {
          const msg =
            (res.data && (res.data.message || res.data.error?.message || res.data.error)) ||
            `HTTP_${res.status}_UNAUTHORIZED`;
          return {
            connected: false,
            balance: '0.0000',
            currency: 'USD',
            rawError: String(msg).slice(0, 200),
          };
        }
      }

      return {
        connected: false,
        balance: '0.0000',
        currency: 'USD',
        rawError: String(lastError).slice(0, 220),
      };
    },

    async fetchProducts(apiKey: string): Promise<NormalizedProviderProduct[]> {
      const headers = buildAuthHeaders(apiKey, spec.authHeader, spec.authType, {
        Accept: 'application/json',
      });
      let lastErr = 'FETCH_PRODUCTS_FAILED';
      const baseOrigin = (() => {
        try {
          return new URL(cleanBase).origin;
        } catch {
          return cleanBase;
        }
      })();

      for (const path of spec.productsPaths) {
        const firstUrl = `${cleanBase}${path.startsWith('/') ? path : `/${path}`}`;
        const firstRes = await safeFetchJson(spec.code, firstUrl, { method: 'GET', headers }, 15_000, limit);
        if (firstRes.ok && firstRes.data) {
          const firstRawList = extractRawCatalogItemsList(firstRes.data);
          const firstItems = normalizeGenericCatalogItems(firstRes.data);
          const hasExplicitArray =
            firstRawList.length > 0 ||
            Array.isArray(firstRes.data) ||
            Array.isArray(firstRes.data?.products) ||
            Array.isArray(firstRes.data?.services) ||
            Array.isArray(firstRes.data?.items) ||
            Array.isArray(firstRes.data?.data);

          if (hasExplicitArray) {
            const collected: NormalizedProviderProduct[] = [];
            const seen = new Set<string>();
            const pushUnique = (batch: NormalizedProviderProduct[]): number => {
              let added = 0;
              for (const item of batch) {
                const key = `${item.externalProductId}::${item.externalVariantId || ''}`;
                if (seen.has(key)) continue;
                seen.add(key);
                collected.push(item);
                added += 1;
              }
              return added;
            };
            pushUnique(firstItems);

            // Follow pagination cleanly across up to 12 pages without ever leaving baseOrigin
            let currentData = firstRes.data;
            let currentRawLen = firstRawList.length;
            let currentPage = 1;
            let currentOffset = 0;
            const visitedUrls = new Set<string>([firstUrl]);

            for (let hop = 0; hop < 11; hop++) {
              const directive = extractPaginationDirective(
                currentData,
                currentPage,
                currentOffset,
                Math.max(1, currentRawLen),
                currentRawLen,
                baseOrigin
              );
              if (directive.kind === 'none') break;

              let nextUrl = '';
              const baseObj = new URL(firstUrl);
              if (directive.kind === 'url') {
                nextUrl = directive.nextUrl;
              } else if (directive.kind === 'cursor') {
                baseObj.searchParams.set('cursor', directive.cursor);
                nextUrl = baseObj.toString();
              } else if (directive.kind === 'page') {
                currentPage = directive.nextPage;
                baseObj.searchParams.set('page', String(currentPage));
                if (directive.limit) baseObj.searchParams.set('limit', String(directive.limit));
                nextUrl = baseObj.toString();
              } else if (directive.kind === 'offset') {
                currentOffset = directive.nextOffset;
                baseObj.searchParams.set('offset', String(currentOffset));
                baseObj.searchParams.set('limit', String(directive.limit));
                nextUrl = baseObj.toString();
              }

              if (!nextUrl || visitedUrls.has(nextUrl)) break;
              visitedUrls.add(nextUrl);

              const nextRes = await safeFetchJson(spec.code, nextUrl, { method: 'GET', headers }, 15_000, limit);
              if (!nextRes.ok || !nextRes.data) {
                Object.defineProperty(collected, '__partial', { value: true, enumerable: false });
                break;
              }
              const nextRawList = extractRawCatalogItemsList(nextRes.data);
              const nextItems = normalizeGenericCatalogItems(nextRes.data);
              if (nextItems.length === 0) break;
              const added = pushUnique(nextItems);
              if (added === 0) break;
              currentData = nextRes.data;
              currentRawLen = nextRawList.length;
            }

            return collected;
          }
        }
        lastErr =
          (firstRes.data && (firstRes.data.message || firstRes.data.error?.message || firstRes.data.error)) ||
          firstRes.errorText ||
          `HTTP_${firstRes.status}`;
        if (firstRes.status === 401 || firstRes.status === 403) {
          throw new Error(`${spec.name} auth error: ${String(lastErr)}`);
        }
      }

      throw new Error(`${spec.name} fetchProducts failed: ${String(lastErr)}`);
    },

    async placeOrder(apiKey: string, req: ProviderOrderRequest): Promise<ProviderOrderResponse> {
      const extraHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (spec.idempotencyHeader) {
        extraHeaders[spec.idempotencyHeader] = req.idempotencyRef;
      }
      const headers = buildAuthHeaders(apiKey, spec.authHeader, spec.authType, extraHeaders);
      const body = spec.buildOrderBody
        ? spec.buildOrderBody(req)
        : {
            product_id: req.externalProductId,
            service_id: req.externalProductId,
            quantity: req.quantity,
            external_order_id: req.idempotencyRef,
            ...(req.externalVariantId ? { variant_id: req.externalVariantId } : {}),
            ...(req.customerLabel ? { email: req.customerLabel, customer_info: req.customerLabel } : {}),
          };

      const paths = [spec.orderPath, ...(spec.orderFallbackPaths || [])];
      let res: { ok: boolean; status: number; data?: any; errorText?: string; networkUncertain?: boolean } = {
        ok: false,
        status: 0,
      };

      for (const p of paths) {
        const url = `${cleanBase}${p.startsWith('/') ? p : `/${p}`}`;
        res = await safeFetchJson(
          spec.code,
          url,
          { method: 'POST', headers, body: JSON.stringify(body) },
          15_000,
          limit
        );
        if (res.status !== 404) break;
      }

      if (res.networkUncertain) {
        return { status: 'uncertain', uncertainState: true, rawError: res.errorText };
      }

      const d = res.data || {};
      const explicitFail = d.ok === false || d.success === false;
      if (!res.ok || explicitFail) {
        const text = JSON.stringify(d || res.errorText);
        const code = /balance|fund|credit/i.test(text)
          ? 'INSUFFICIENT_BALANCE'
          : /stock|out_of_stock|sold/i.test(text)
            ? 'OUT_OF_STOCK'
            : res.status === 404
              ? 'PRODUCT_NOT_FOUND'
              : res.status === 401 || res.status === 403
                ? 'INVALID_CREDENTIALS'
                : undefined;
        return {
          status: 'failed',
          uncertainState: false,
          deterministicFailureCode: code,
          rawError: text.slice(0, 240),
        };
      }

      const orderObj = d.order || d.data || d;
      const delivered = extractDeliveryItems(orderObj);
      const rawStatus = String(orderObj.status || d.status || 'completed').toLowerCase();
      const isPending = ['pending', 'processing', 'queued', 'manual'].includes(rawStatus) && delivered.length === 0;
      const charged =
        orderObj.total_cost ??
        orderObj.total_price ??
        orderObj.total ??
        d.total_cost ??
        d.total_price ??
        0;

      return {
        status: isPending ? 'pending' : 'completed',
        uncertainState: false,
        providerOrderId: String(
          orderObj.order_id ?? orderObj.orderCode ?? orderObj.order_code ?? orderObj.id ?? d.order_id ?? req.idempotencyRef
        ),
        deliveredItems: delivered,
        chargedTotal: safeDecimalString(charged),
        idempotentReplay: Boolean(d.idempotent_replay || orderObj.idempotent_replay),
      };
    },

    async getOrderStatus(apiKey: string, providerOrderId: string): Promise<ProviderOrderResponse> {
      if (!spec.orderStatusPath) {
        return { status: 'pending', uncertainState: false, providerOrderId };
      }
      const headers = buildAuthHeaders(apiKey, spec.authHeader, spec.authType, {
        Accept: 'application/json',
      });
      const path = spec.orderStatusPath(providerOrderId);
      const url = `${cleanBase}${path.startsWith('/') ? path : `/${path}`}`;
      const res = await safeFetchJson(spec.code, url, { method: 'GET', headers }, 12_000, limit);
      if (res.networkUncertain) return { status: 'uncertain', uncertainState: true, rawError: res.errorText };
      if (!res.ok || !res.data) return { status: 'failed', uncertainState: false, rawError: `HTTP_${res.status}` };
      const orderObj = res.data.order || res.data.data || res.data;
      const st = String(orderObj.status || 'pending').toLowerCase();
      return {
        status: ['completed', 'delivered', 'success', 'done'].includes(st)
          ? 'completed'
          : ['failed', 'cancelled', 'refunded'].includes(st)
            ? 'failed'
            : 'pending',
        uncertainState: false,
        providerOrderId,
        deliveredItems: extractDeliveryItems(orderObj),
      };
    },

    async getQuote(): Promise<NormalizedQuoteResult | null> {
      return null;
    },

    verifyWebhookSignature(rawBody: string | Buffer, signature: string, secret: string): boolean {
      return verifyHmacSha256(rawBody, signature, secret, 'sha256=');
    },
  };
}

// ============================================================================
// 6. WARZONE SHOP — https://api.warzoneshop.in/api/v1 (X-API-Key)
// ============================================================================
export const warzoneAdapter: ProviderAdapter = createConfigurableResellerAdapter({
  code: 'warzone',
  name: 'Warzone Shop',
  baseUrl: 'https://api.warzoneshop.in/api/v1',
  docsUrl: 'https://api.warzoneshop.in/api/v1',
  authType: 'x_api_key',
  authHeader: 'X-API-Key',
  balancePaths: ['/me', '/balance'],
  productsPaths: ['/products', '/services'],
  orderPath: '/order',
  orderFallbackPaths: ['/orders'],
  orderStatusPath: (id) => `/order/${encodeURIComponent(id)}`,
});

// ============================================================================
// 7. LUKUAI PARTNER — https://bot.lukuai.com (X-User-Id + X-Api-Key)
// ============================================================================
export const lukuaiAdapter: ProviderAdapter = createConfigurableResellerAdapter({
  code: 'lukuai',
  name: 'LukuAI Partner',
  baseUrl: 'https://bot.lukuai.com',
  docsUrl: 'https://bot.lukuai.com/partner-api-docs?lang=en',
  authType: 'partner_pair',
  authHeader: 'X-Api-Key',
  balancePaths: ['/api/partner/me'],
  productsPaths: ['/api/partner/products'],
  orderPath: '/api/partner/orders',
  orderStatusPath: (id) => `/api/partner/orders/${encodeURIComponent(id)}`,
  buildOrderBody: (req) => ({
    product_id: req.externalProductId,
    quantity: req.quantity,
  }),
});

// ============================================================================
// 8. SAJID OFFICIAL — https://sajidofficial.com/api/v1 (X-API-Key)
// ============================================================================
export const sajidOfficialAdapter: ProviderAdapter = createConfigurableResellerAdapter({
  code: 'sajidofficial',
  name: 'Sajid Official',
  baseUrl: 'https://sajidofficial.com/api/v1',
  docsUrl: 'https://sajidofficial.com/docs',
  authType: 'x_api_key',
  authHeader: 'X-API-Key',
  balancePaths: ['/me'],
  productsPaths: ['/products'],
  orderPath: '/order',
  orderStatusPath: (id) => `/order/${encodeURIComponent(id)}`,
  buildOrderBody: (req) => ({
    service_id: req.externalProductId,
    product_id: req.externalProductId,
    quantity: req.quantity,
    external_order_id: req.idempotencyRef,
  }),
});

// ============================================================================
// 9. TOOLVERIO — https://api.toolverio.com (Authorization: Bearer)
// ============================================================================
export const toolverioAdapter: ProviderAdapter = createConfigurableResellerAdapter({
  code: 'toolverio',
  name: 'Toolverio',
  baseUrl: 'https://api.toolverio.com',
  docsUrl: 'https://toolverio.com/docs',
  authType: 'bearer',
  authHeader: 'Authorization',
  balancePaths: ['/v1/balance'],
  productsPaths: ['/v1/products'],
  orderPath: '/v1/orders',
  orderStatusPath: (id) => `/v1/orders/${encodeURIComponent(id)}`,
  buildOrderBody: (req) => ({
    product_id: req.externalProductId,
    quantity: req.quantity,
  }),
});

// ============================================================================
// 10. AIVERSE HUB — https://aiversehub.store (X-API-Key, 1 req/10s products)
// ============================================================================
export const aiverseHubAdapter: ProviderAdapter = createConfigurableResellerAdapter({
  code: 'aiversehub',
  name: 'AIVerse Hub',
  baseUrl: 'https://aiversehub.store',
  docsUrl: 'https://aiversehub.store/docs',
  authType: 'x_api_key',
  authHeader: 'X-API-Key',
  balancePaths: ['/api/v1/me'],
  productsPaths: ['/api/v1/products'],
  orderPath: '/api/v1/order',
  orderStatusPath: (id) => `/api/v1/order/${encodeURIComponent(id)}`,
  buildOrderBody: (req) => ({
    service_id: req.externalProductId,
    product_id: req.externalProductId,
    quantity: req.quantity,
  }),
});

// ============================================================================
// 11. HMAI STORE — https://api.hmai.shop (Authorization: Bearer)
// ============================================================================
export const hmaiAdapter: ProviderAdapter = createConfigurableResellerAdapter({
  code: 'hmai',
  name: 'HMAI Store',
  baseUrl: 'https://api.hmai.shop',
  docsUrl: 'https://api.hmai.shop/api/docs',
  authType: 'bearer',
  authHeader: 'Authorization',
  idempotencyHeader: 'Idempotency-Key',
  balancePaths: ['/api/balance'],
  productsPaths: ['/api/products'],
  orderPath: '/api/buy',
  orderStatusPath: (id) => `/api/order-status?order_id=${encodeURIComponent(id)}`,
  buildOrderBody: (req) => ({
    product_id: req.externalProductId,
    quantity: req.quantity,
    ...(req.customerLabel ? { email: req.customerLabel, customer_info: req.customerLabel } : {}),
  }),
});

// ============================================================================
// 12. CANBOSO BUYER API — https://canboso.com (x-buyer-key)
// ============================================================================
export const canbosoAdapter: ProviderAdapter = createConfigurableResellerAdapter({
  code: 'canboso',
  name: 'Canboso',
  baseUrl: 'https://canboso.com',
  docsUrl: 'https://canboso.com/api/swagger',
  authType: 'x_api_key',
  authHeader: 'x-buyer-key',
  rateLimitPerMin: 25,
  balancePaths: ['/api/v2/telegram-buyer/balance'],
  productsPaths: ['/api/v2/telegram-buyer/products'],
  orderPath: '/api/v2/telegram-buyer/purchase',
  orderStatusPath: () => '/api/v2/telegram-buyer/orders',
  buildOrderBody: (req) => ({
    product_id: req.externalProductId,
    quantity: req.quantity,
  }),
});

// ============================================================================
// 13. KANGHNE STORE — https://bot.kangnequantri.cc/api/v1 (X-API-Key)
// ============================================================================
export const kangnequantriAdapter: ProviderAdapter = createConfigurableResellerAdapter({
  code: 'kangnequantri',
  name: 'Kanghne Store',
  baseUrl: 'https://bot.kangnequantri.cc/api/v1',
  docsUrl: 'https://bot.kangnequantri.cc/api-docs',
  authType: 'x_api_key',
  authHeader: 'X-API-Key',
  balancePaths: ['/balance'],
  productsPaths: ['/products'],
  orderPath: '/orders',
  orderStatusPath: (id) => `/orders/${encodeURIComponent(id)}`,
  buildOrderBody: (req) => ({
    product_id: req.externalProductId,
    quantity: req.quantity,
  }),
});

// ============================================================================
// 14. RENQIS RESELLER — https://api.renqis.online/api/reseller/v1 (X-API-Key)
// ============================================================================
export const renqisAdapter: ProviderAdapter = createConfigurableResellerAdapter({
  code: 'renqis',
  name: 'Renqis API',
  baseUrl: 'https://api.renqis.online/api/reseller/v1',
  docsUrl: 'https://api.renqis.online/api/reseller/docs',
  authType: 'x_api_key',
  authHeader: 'X-API-Key',
  idempotencyHeader: 'X-Idempotency-Key',
  balancePaths: ['/account/balance', '/account/info'],
  productsPaths: ['/products'],
  orderPath: '/orders',
  orderStatusPath: () => '/orders',
  buildOrderBody: (req) => ({
    productId: /^\d+$/.test(req.externalProductId) ? Number(req.externalProductId) : req.externalProductId,
    quantity: req.quantity,
  }),
});

export const PROVIDER_ADAPTERS: Record<string, ProviderAdapter> = {
  pixora: pixoraAdapter,
  pandora: pandoraAdapter,
  qorix: qorixAdapter,
  digitalcore: digitalCoreAdapter,
  aivaulthub: aiVaultHubAdapter,
  warzone: warzoneAdapter,
  warzoneshop: warzoneAdapter,
  lukuai: lukuaiAdapter,
  sajidofficial: sajidOfficialAdapter,
  toolverio: toolverioAdapter,
  aiversehub: aiverseHubAdapter,
  hmai: hmaiAdapter,
  canboso: canbosoAdapter,
  kangnequantri: kangnequantriAdapter,
  renqis: renqisAdapter,
};

export interface ResolvableProviderRow {
  code: string;
  name: string;
  baseUrl: string;
  docsUrl?: string;
  authType?: string;
  authHeader?: string;
  rateLimitPerMin?: number;
}

function ensureApiSuffix(baseUrl: string, requiredSuffix: string): string {
  const cleaned = baseUrl.replace(/\/+$/, '');
  if (cleaned.toLowerCase().endsWith(requiredSuffix.toLowerCase())) return cleaned;
  return `${cleaned}${requiredSuffix}`;
}

/**
 * Always resolves a working ProviderAdapter for ANY server row in PostgreSQL:
 * 1. Matches exact built-in adapter code
 * 2. Matches by baseUrl hostname (e.g. reseller.aivaulthub.store, api.aivaulthub.store, api.warzoneshop.in, etc.)
 * 3. Falls back to a smart configurable generic reseller adapter so custom servers NEVER fail with "no adapter".
 */
export function resolveProviderAdapter(prov: ResolvableProviderRow): ProviderAdapter {
  const code = String(prov.code || '').trim().toLowerCase();
  const baseUrl = String(prov.baseUrl || '').trim().replace(/\/+$/, '');
  const host = (() => {
    try {
      return new URL(/^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`).hostname.toLowerCase();
    } catch {
      return baseUrl.toLowerCase();
    }
  })();

  // Exact match for the original 5 specialized adapters (keeping their specialized logic when URL matches)
  if (code === 'pixora' || host.includes('daddyclub.bar')) return pixoraAdapter;
  if (code === 'pandora' || host.includes('pandoradigital.shop')) return pandoraAdapter;
  if (code === 'qorix' || host.includes('qorixlab.com')) return qorixAdapter;
  if (code === 'digitalcore' || host.includes('digitalcore.top')) return digitalCoreAdapter;

  // AIVault Hub works on both reseller.aivaulthub.store AND api.aivaulthub.store (with /api/v1)
  if (code === 'aivaulthub' || code === 'aivault' || host.includes('aivaulthub.store')) {
    const targetBase = ensureApiSuffix(baseUrl || 'https://reseller.aivaulthub.store', '/api/v1');
    return createConfigurableResellerAdapter({
      code: code || 'aivaulthub',
      name: prov.name || 'AIVault Hub',
      baseUrl: targetBase,
      docsUrl: prov.docsUrl || `${targetBase}/docs`,
      authType: 'x_api_key',
      authHeader: 'X-API-Key',
      balancePaths: ['/me'],
      productsPaths: ['/products'],
      orderPath: '/order',
      orderStatusPath: (id) => `/order/${encodeURIComponent(id)}`,
      buildOrderBody: (req) => ({
        service_id: req.externalProductId,
        quantity: req.quantity,
        external_order_id: req.idempotencyRef,
      }),
    });
  }

  // Warzone Shop (always uses /api/v1 + X-API-Key)
  if (code === 'warzone' || code === 'warzoneshop' || host.includes('warzoneshop.in')) {
    const targetBase = ensureApiSuffix(baseUrl || 'https://api.warzoneshop.in', '/api/v1');
    return createConfigurableResellerAdapter({
      code: code || 'warzone',
      name: prov.name || 'Warzone Shop',
      baseUrl: targetBase,
      docsUrl: prov.docsUrl || targetBase,
      authType: 'x_api_key',
      authHeader: 'X-API-Key',
      balancePaths: ['/me', '/balance'],
      productsPaths: ['/products', '/services'],
      orderPath: '/order',
      orderFallbackPaths: ['/orders'],
      orderStatusPath: (id) => `/order/${encodeURIComponent(id)}`,
    });
  }

  if (code === 'lukuai' || host.includes('lukuai.com')) return lukuaiAdapter;
  if (code === 'sajidofficial' || host.includes('sajidofficial.com')) return sajidOfficialAdapter;
  if (code === 'toolverio' || host.includes('toolverio.com')) return toolverioAdapter;
  if (code === 'aiversehub' || host.includes('aiversehub.store')) return aiverseHubAdapter;
  if (code === 'hmai' || host.includes('hmai.shop')) return hmaiAdapter;
  if (code === 'canboso' || host.includes('canboso.com')) return canbosoAdapter;
  if (code === 'kangnequantri' || host.includes('kangnequantri.cc')) return kangnequantriAdapter;
  if (code === 'renqis' || host.includes('renqis.online')) return renqisAdapter;

  // Smart Generic Reseller Adapter for ANY custom server added by the store owner
  const inferredAuthType: ConfigurableResellerSpec['authType'] =
    prov.authType === 'partner_pair'
      ? 'partner_pair'
      : prov.authType === 'x_api_key' || String(prov.authHeader || '').toLowerCase() === 'x-api-key'
        ? 'x_api_key'
        : prov.authType === 'api_key' || String(prov.authHeader || '').toLowerCase() === 'api-key'
          ? 'api_key'
          : 'bearer';

  return createConfigurableResellerAdapter({
    code: code || 'custom',
    name: prov.name || 'Custom Reseller API',
    baseUrl: baseUrl || 'https://example.com',
    docsUrl: prov.docsUrl || baseUrl,
    authType: inferredAuthType,
    authHeader:
      prov.authHeader && /^[A-Za-z0-9-]+$/.test(prov.authHeader.trim())
        ? prov.authHeader.trim()
        : inferredAuthType === 'bearer'
          ? 'Authorization'
          : inferredAuthType === 'api_key'
            ? 'Api-Key'
            : 'X-API-Key',
    rateLimitPerMin: prov.rateLimitPerMin || 60,
    balancePaths: [
      '/me',
      '/balance',
      '/account/balance',
      '/api/v1/me',
      '/api/v1/balance',
      '/v1/balance',
      '/api/balance',
      '/api/partner/me',
    ],
    productsPaths: [
      '/products',
      '/services',
      '/api/v1/products',
      '/v1/products',
      '/api/products',
      '/api/partner/products',
      '/stock',
    ],
    orderPath: '/order',
    orderFallbackPaths: ['/orders', '/api/v1/order', '/api/v1/orders', '/v1/orders', '/api/buy'],
    orderStatusPath: (id) => `/order/${encodeURIComponent(id)}`,
  });
}

export function getProviderAdapter(code: string): ProviderAdapter | null {
  return PROVIDER_ADAPTERS[code.toLowerCase()] || null;
}

