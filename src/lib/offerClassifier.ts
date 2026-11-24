export interface OfferBrandDefinition {
  key: string;
  labelAr: string;
  labelEn: string;
  emoji: string;
  keywords: string[];
}

export const OFFER_BRANDS: OfferBrandDefinition[] = [
  {
    key: 'gemini',
    labelAr: 'Gemini',
    labelEn: 'Gemini',
    emoji: '✨',
    keywords: ['gemini', 'google ai', 'google one', 'ai pro', 'ai ultra', 'veo', 'antigravity', 'jio offer'],
  },
  {
    key: 'chatgpt',
    labelAr: 'ChatGPT',
    labelEn: 'ChatGPT',
    emoji: '🤖',
    keywords: ['chatgpt', 'openai', 'gpt-4', 'gpt-5', 'gpt plus', 'gpt team', 'gpt pro', 'gpt business', 'codex', 'sora'],
  },
  {
    key: 'claude',
    labelAr: 'Claude',
    labelEn: 'Claude',
    emoji: '🟠',
    keywords: ['claude', 'anthropic'],
  },
  {
    key: 'canva',
    labelAr: 'Canva',
    labelEn: 'Canva',
    emoji: '🎨',
    keywords: ['canva'],
  },
  {
    key: 'adobe',
    labelAr: 'Adobe',
    labelEn: 'Adobe',
    emoji: '🅰️',
    keywords: ['adobe', 'creative cloud', 'photoshop', 'acrobat', 'firefly', 'illustrator', 'premiere'],
  },
  {
    key: 'gamma',
    labelAr: 'Gamma',
    labelEn: 'Gamma',
    emoji: '📊',
    keywords: ['gamma'],
  },
  {
    key: 'cloud',
    labelAr: 'Cloud',
    labelEn: 'Cloud',
    emoji: '☁️',
    keywords: ['google cloud', 'gcp', 'aws', 'azure', 'digitalocean', 'linode', 'vercel', 'supabase', 'hetzner', 'cloud credit', 'icloud'],
  },
  {
    key: 'duolingo',
    labelAr: 'Duolingo',
    labelEn: 'Duolingo',
    emoji: '🦉',
    keywords: ['duolingo'],
  },
  {
    key: 'youtube',
    labelAr: 'YouTube',
    labelEn: 'YouTube',
    emoji: '▶️',
    keywords: ['youtube', 'yt premium', 'yt music'],
  },
  {
    key: 'perplexity',
    labelAr: 'Perplexity',
    labelEn: 'Perplexity',
    emoji: '🔎',
    keywords: ['perplexity'],
  },
  {
    key: 'cursor',
    labelAr: 'Cursor & Dev',
    labelEn: 'Cursor & Dev',
    emoji: '💻',
    keywords: ['cursor', 'jetbrains', 'windsurf', 'copilot', 'github', 'bolt', 'lovable', 'replit', 'v0', 'trae', 'augment'],
  },
  {
    key: 'capcut',
    labelAr: 'CapCut & Media',
    labelEn: 'CapCut & Media',
    emoji: '🎬',
    keywords: ['capcut', 'elevenlabs', 'heygen', 'runway', 'kling', 'midjourney', 'suno', 'hailuo', 'higgsfield', 'picsart', 'muse'],
  },
  {
    key: 'grok',
    labelAr: 'Grok & AI Tools',
    labelEn: 'Grok & AI Tools',
    emoji: '⚡',
    keywords: ['grok', 'supergrok', 'deepseek', 'kimi', 'manus', 'poe', 'notion', 'figma', 'miro', 'linear', 'airtable'],
  },
  {
    key: 'office',
    labelAr: 'Office & Work',
    labelEn: 'Office & Work',
    emoji: '💼',
    keywords: ['office', 'microsoft', '365', 'windows', 'zoom', 'ilovepdf', 'grammarly', 'quillbot', 'linkedin', 'coursera', 'edx', 'autodesk'],
  },
  {
    key: 'vpn',
    labelAr: 'VPN & Emails',
    labelEn: 'VPN & Emails',
    emoji: '🛡️',
    keywords: ['vpn', 'nord', 'surfshark', 'expressvpn', 'proton', '1password', 'gmail', 'outlook', 'edu mail', 'email'],
  },
  {
    key: 'streaming',
    labelAr: 'Streaming & Music',
    labelEn: 'Streaming & Music',
    emoji: '🍿',
    keywords: ['netflix', 'spotify', 'disney', 'prime video', 'crunchyroll', 'apple tv', 'apple music', 'hbo', 'iptv'],
  },
];

export const OTHER_BRAND: OfferBrandDefinition = {
  key: 'other',
  labelAr: 'أخرى',
  labelEn: 'Other',
  emoji: '📦',
  keywords: [],
};

export function classifyOfferBrand(rawName: string, rawDescription = ''): OfferBrandDefinition {
  // Strip trailing server annotations like "(Gemini Shop)" before brand matching
  const cleanedTitle = (rawName || '').replace(/\([^)]*\)\s*$/g, '').trim().toLowerCase();
  const haystack = `${cleanedTitle} ${(rawDescription || '').toLowerCase()}`;
  // First pass: check cleaned title alone for highest precision
  for (const brand of OFFER_BRANDS) {
    if (brand.keywords.some((kw) => cleanedTitle.includes(kw))) {
      return brand;
    }
  }
  // Second pass: check combined cleaned title + description
  for (const brand of OFFER_BRANDS) {
    if (brand.keywords.some((kw) => haystack.includes(kw))) {
      return brand;
    }
  }
  return OTHER_BRAND;
}

export interface BrandBucket<T> {
  brand: OfferBrandDefinition;
  items: T[];
  count: number;
}

export function groupOffersByBrand<T extends { rawName: string; rawDescription?: string }>(
  offers: T[]
): BrandBucket<T>[] {
  const map = new Map<string, BrandBucket<T>>();
  for (const offer of offers) {
    const brand = classifyOfferBrand(offer.rawName, offer.rawDescription || '');
    const existing = map.get(brand.key);
    if (existing) {
      existing.items.push(offer);
      existing.count += 1;
    } else {
      map.set(brand.key, { brand, items: [offer], count: 1 });
    }
  }
  const orderIndex = new Map(OFFER_BRANDS.map((b, idx) => [b.key, idx]));
  return Array.from(map.values()).sort((a, b) => {
    const ia = orderIndex.has(a.brand.key) ? orderIndex.get(a.brand.key)! : 999;
    const ib = orderIndex.has(b.brand.key) ? orderIndex.get(b.brand.key)! : 999;
    if (ia !== ib) return ia - ib;
    return b.count - a.count;
  });
}

export interface StoreCategoryRef {
  id: number;
  slug: string;
  nameAr: string;
  nameEn?: string | null;
}

export interface MatchedStoreCategory {
  categoryId: number;
  categorySlug: string;
  categoryName: string;
  brandKey: string;
  matchedBy: 'brand' | 'custom_name';
}

/**
 * Matches a product's title/description to the best matching real store category in PostgreSQL.
 * 1. Uses classifyOfferBrand() to match standard brand categories (Gemini, ChatGPT, Canva, Adobe, Gamma, Cloud, Duolingo, YouTube, Claude, etc.).
 * 2. Also matches any custom categories created by the store owner (e.g. "Netflix", "Cursor", "VPN", "CapCut").
 * 3. Never blindly dumps unrelated products into a random default category — returns null if genuinely unmatched.
 */
export function matchProductToStoreCategory(
  title: string,
  description: string,
  storeCategories: StoreCategoryRef[]
): MatchedStoreCategory | null {
  if (!storeCategories || storeCategories.length === 0) return null;

  const brand = classifyOfferBrand(title, description);

  // Pass 1: Match identified brand against store categories by slug or normalized name
  if (brand.key !== 'other') {
    for (const cat of storeCategories) {
      const slug = String(cat.slug || '').trim().toLowerCase();
      const nameAr = String(cat.nameAr || '').trim().toLowerCase();
      const nameEn = String(cat.nameEn || '').trim().toLowerCase();
      const brandAr = brand.labelAr.toLowerCase();
      const brandEn = brand.labelEn.toLowerCase();

      if (
        slug === brand.key ||
        slug.startsWith(`${brand.key}-`) ||
        nameEn === brand.key ||
        nameAr === brand.key ||
        nameEn === brandEn ||
        nameAr === brandAr ||
        (brand.key.length >= 4 && (nameEn.includes(brand.key) || nameAr.includes(brand.key)))
      ) {
        return {
          categoryId: cat.id,
          categorySlug: cat.slug,
          categoryName: cat.nameAr || cat.nameEn || cat.slug,
          brandKey: brand.key,
          matchedBy: 'brand',
        };
      }
    }
  }

  // Pass 2: Check direct match against custom user-created store categories (excluding overly generic words)
  const cleanedTitle = (title || '').replace(/\([^)]*\)\s*$/g, '').trim().toLowerCase();
  const fullText = `${cleanedTitle} ${(description || '').toLowerCase()}`;

  for (const cat of storeCategories) {
    const tokens = [cat.slug, cat.nameEn || '', cat.nameAr || '']
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length >= 3 && s !== 'other' && s !== 'أخرى' && s !== 'general');

    if (tokens.some((tok) => cleanedTitle.includes(tok))) {
      return {
        categoryId: cat.id,
        categorySlug: cat.slug,
        categoryName: cat.nameAr || cat.nameEn || cat.slug,
        brandKey: brand.key,
        matchedBy: 'custom_name',
      };
    }
    if (tokens.some((tok) => tok.length >= 4 && fullText.includes(tok))) {
      return {
        categoryId: cat.id,
        categorySlug: cat.slug,
        categoryName: cat.nameAr || cat.nameEn || cat.slug,
        brandKey: brand.key,
        matchedBy: 'custom_name',
      };
    }
  }

  return null;
}

export interface ParsedAuthHeaderResult {
  authHeader: string;
  authType: 'bearer' | 'x_api_key' | 'api_key' | 'partner_pair';
  extractedApiKey: string | null;
}

/**
 * Prevents API keys accidentally pasted into the Auth Header input (e.g. "X-API-Key: WAR_xxx"
 * or raw "rsk_xxx") from corrupting the provider's header name. Splits them cleanly so the
 * header name is saved in `providers.auth_header` and the secret is encrypted in `provider_credentials`.
 */
export function parseAuthHeaderInput(
  rawHeader: string,
  rawAuthType?: string,
  explicitApiKey?: string
): ParsedAuthHeaderResult {
  const trimmed = String(rawHeader || '').trim();
  const explicitKey = String(explicitApiKey || '').trim() || null;

  const inferType = (headerName: string, fallback?: string): ParsedAuthHeaderResult['authType'] => {
    const low = headerName.toLowerCase();
    if (low === 'authorization') return 'bearer';
    if (low === 'api-key') return 'api_key';
    if (low === 'x-api-key' || low === 'x-partner-key') return 'x_api_key';
    if (fallback === 'partner_pair' || fallback === 'x_api_key' || fallback === 'api_key' || fallback === 'bearer') {
      return fallback;
    }
    return 'bearer';
  };

  if (!trimmed) {
    const fallbackType =
      rawAuthType === 'x_api_key' || rawAuthType === 'api_key' || rawAuthType === 'partner_pair'
        ? rawAuthType
        : 'bearer';
    const fallbackHeader =
      fallbackType === 'x_api_key' || fallbackType === 'partner_pair'
        ? 'X-API-Key'
        : fallbackType === 'api_key'
          ? 'Api-Key'
          : 'Authorization';
    return { authHeader: fallbackHeader, authType: fallbackType, extractedApiKey: explicitKey };
  }

  // Case 1: "Header-Name: value" pasted in header field
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx > 0) {
    const left = trimmed.slice(0, colonIdx).trim();
    let right = trimmed.slice(colonIdx + 1).trim();
    if (/^[A-Za-z0-9-]+$/.test(left) && right.length >= 6) {
      if (left.toLowerCase() === 'authorization' && /^bearer\s+/i.test(right)) {
        right = right.replace(/^bearer\s+/i, '').trim();
      }
      return {
        authHeader: left,
        authType: inferType(left, rawAuthType),
        extractedApiKey: explicitKey || right,
      };
    }
  }

  // Case 2: Raw secret pasted directly into authHeader (e.g. "rsk_...", "WAR_...", "pk_...", "sk_...", or long token without spaces)
  const looksLikeRawSecret =
    /^(rsk_|war_|pk_|sk_|ak_|rk_|api_|live_|key_|px_|pd_|qr_|dc_)/i.test(trimmed) ||
    (trimmed.length >= 24 && !/^(authorization|x-api-key|api-key|x-partner-key|x-auth-token)$/i.test(trimmed));

  if (looksLikeRawSecret) {
    const isKnownXApiKeyPrefix = /^(rsk_|war_|pk_|sk_live_|sk_test_)/i.test(trimmed);
    const useBearer = !isKnownXApiKeyPrefix && rawAuthType === 'bearer';
    const fallbackHeader = useBearer ? 'Authorization' : 'X-API-Key';
    const fallbackType = useBearer ? 'bearer' : 'x_api_key';
    return {
      authHeader: fallbackHeader,
      authType: fallbackType,
      extractedApiKey: explicitKey || trimmed,
    };
  }

  // Case 3: Clean HTTP header name
  return {
    authHeader: trimmed,
    authType: inferType(trimmed, rawAuthType),
    extractedApiKey: explicitKey,
  };
}

export function normalizeProviderBaseUrl(rawUrl: string): string {
  let cleaned = String(rawUrl || '').trim();
  if (!cleaned) return '';
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = `https://${cleaned}`;
  }
  cleaned = cleaned.replace(/\/+$/, '');
  // Strip common docs suffixes if user pasted the docs URL into Base URL
  cleaned = cleaned
    .replace(/\/partner-api-docs(\?.*)?$/i, '')
    .replace(/\/api-docs(\?.*)?$/i, '')
    .replace(/\/api\/swagger(\/.*)?$/i, '')
    .replace(/\/api\/docs(\/.*)?$/i, '')
    .replace(/\/swagger(\/.*)?$/i, '')
    .replace(/\/docs(\/.*)?$/i, '');
  return cleaned.replace(/\/+$/, '');
}
