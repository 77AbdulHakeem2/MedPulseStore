/**
 * Centralized Product Description Processing & Telegram HTML Engine for MedPulse Store.
 *
 * Handles the full description pipeline across ALL Supplier APIs (existing & future):
 * 1. Unified extraction across heterogeneous supplier API schemas.
 * 2. Format detection (Telegram HTML, generic HTML, entity-encoded HTML, plain text).
 * 3. Selective supplier identity, branding, promotional text, and non-service URL removal
 *    while strictly preserving official service/activation/redemption links and 100% of
 *    product operational details (duration, warranty, account type, usage instructions).
 * 4. Strict allowlist-based Telegram HTML tokenizer, validator, and stack-based auto-repair
 *    (supporting <blockquote>, <blockquote expandable>, <b>/<strong>, <i>/<em>, <u>/<ins>,
 *    <s>/<strike>/<del>, <code>, <pre>, <tg-spoiler>, <a href="...">, <tg-emoji emoji-id="...">).
 * 5. Guaranteed safe fallbacks (no-custom-emoji HTML + clean plain text) to prevent
 *    Telegram `Bad Request: can't parse entities` errors under all conditions.
 */

export type DetectedDescriptionFormat =
  | 'telegram_html'
  | 'generic_html'
  | 'encoded_html'
  | 'plain_text';

export interface SupplierIdentityInput {
  name?: string | null;
  code?: string | null;
  baseUrl?: string | null;
  docsUrl?: string | null;
}

export interface ProcessProductDescriptionOptions {
  /** Additional supplier names/phrases to scrub beyond built-in + dynamically registered providers */
  extraSupplierNames?: string[];
  /** Additional supplier domains/hosts to block beyond built-in + dynamically registered providers */
  extraSupplierDomains?: string[];
  /** Optional max visible character cap (default 3500 to leave generous room for header/footer under Telegram 4096 limit) */
  maxVisibleChars?: number;
}

export interface ProcessedProductDescription {
  detectedFormat: DetectedDescriptionFormat;
  /** Valid, balanced, sanitized Telegram HTML ready for `parse_mode: 'HTML'` */
  telegramHtml: string;
  /** Valid Telegram HTML with `<tg-emoji>` unwrapped to its fallback Unicode emoji */
  telegramHtmlNoCustomEmoji: string;
  /** Clean, human-readable plain text with zero raw HTML tags or entities */
  plainText: string;
  hasHtmlFormatting: boolean;
  hasCustomEmoji: boolean;
  keptLinks: string[];
  removedLinks: string[];
  removedSupplierLinesCount: number;
}

// ============================================================================
// 1. BUILT-IN + DYNAMIC SUPPLIER REGISTRY (ALL CURRENT & FUTURE PROVIDERS)
// ============================================================================

const BUILTIN_SUPPLIER_DOMAINS: string[] = [
  'pandoradigital.shop',
  'qorixlab.com',
  'digitalcore.top',
  'daddyclub.bar',
  'aivaulthub.store',
  'warzoneshop.in',
  'lukuai.com',
  'sajidofficial.com',
  'toolverio.com',
  'aiversehub.store',
  'hmai.shop',
  'canboso.com',
  'kangnequantri.cc',
  'renqis.online',
  'qcst.tech',
  'digitalaistore.com',
  'resellwithme.com',
  'bulkware.co',
  'cmpdr.dev',
  'qamify.site',
  'technysoft.com',
  'nastele.online',
  'hmkstore.com',
  'aihub.fashion',
  'nam.qzz.io',
  'qwanhailuna.io.vn',
  'bunnytoolsbot.tech',
  'daki.cc',
  'aitoolifystudio.io',
  'silvex-ai.com',
];

/**
 * Exact supplier brand phrases/identifiers that must never appear in MedPulse Store descriptions.
 * Multi-word names (like "gemini shop") are matched as full phrases so legitimate product names
 * (like "Gemini Plus") are NEVER damaged!
 */
const BUILTIN_SUPPLIER_BRAND_PATTERNS: RegExp[] = [
  /\bpixora(?:\s*api)?\b/gi,
  /\bpandora\s*digital\b/gi,
  /\bpandoradigital\b/gi,
  /\bqorix(?:lab)?\b/gi,
  /\bdigitalcore\b/gi,
  /\baivaulthub\b/gi,
  /\baivault(?:\s*hub)?\b/gi,
  /\bdaddyclub\b/gi,
  /\bgemini\s*shop\b/gi,
  /\bgeminishop\b/gi,
  /\bwarzone\s*shop\b/gi,
  /\bwarzoneshop\b/gi,
  /\blukuai(?:\s*partner)?\b/gi,
  /\bsajid\s*official\b/gi,
  /\bsajidofficial\b/gi,
  /\btoolverio\b/gi,
  /\baiverse\s*hub\b/gi,
  /\baiversehub\b/gi,
  /\bhmai(?:\s*store)?\b/gi,
  /\bcanboso\b/gi,
  /\bkangnequantri\b/gi,
  /\bkanghne(?:\s*store)?\b/gi,
  /\brenqis(?:\s*api)?\b/gi,
  /\bqcst(?:\s*api)?\b/gi,
  /\bdigitalai\s*store\b/gi,
  /\bdigitalaistore\b/gi,
  /\bresellwithme\b/gi,
  /\bbulkware\b/gi,
  /\bcmpdr(?:\s*api)?\b/gi,
  /\bqamify\b/gi,
  /\btechnysoft\b/gi,
  /\bnastele(?:\s*partner)?\b/gi,
  /\bhmk\s*store\b/gi,
  /\bhmkstore\b/gi,
  /\baihub\s*fashion\b/gi,
  /\baihubfashion\b/gi,
  /\bqwanhailuna(?:\s*shop)?\b/gi,
  /\bbunnytools(?:\s*bot)?\b/gi,
  /\bdaki\s*partner\b/gi,
  /\baitoolify(?:\s*studio)?\b/gi,
  /\bsilvex[-\s]*ai\b/gi,
];

/** Official consumer service / product / activation / OTP domains that MUST be preserved */
const OFFICIAL_SERVICE_DOMAINS: string[] = [
  'openai.com',
  'chatgpt.com',
  'google.com',
  'one.google.com',
  'gemini.google.com',
  'accounts.google.com',
  'play.google.com',
  'adobe.com',
  'redeem.adobe.com',
  'express.adobe.com',
  'canva.com',
  'duolingo.com',
  'notion.so',
  'notion.site',
  'protonvpn.com',
  'proton.me',
  'nordaccount.com',
  'nordvpn.com',
  'netflix.com',
  'spotify.com',
  'apple.com',
  'apps.apple.com',
  'music.apple.com',
  'capcut.com',
  'ilovepdf.com',
  'udemy.com',
  'coursera.org',
  'figma.com',
  'gamma.app',
  'claude.ai',
  'anthropic.com',
  'cursor.com',
  'cursor.sh',
  'lovable.dev',
  'elevenlabs.io',
  'elevenreader.io',
  'picsart.com',
  'microsoft.com',
  'outlook.com',
  'live.com',
  'xbox.com',
  'autodesk.com',
  'quillbot.com',
  'perplexity.ai',
  'midjourney.com',
  'github.com',
  'jetbrains.com',
  'grammarly.com',
  'envato.com',
  'freepik.com',
  'surfshark.com',
  'expressvpn.com',
  'crunchyroll.com',
  'youtube.com',
  'discord.com',
  'discordapp.com',
  'x.ai',
  'grok.com',
  'deepseek.com',
  'linkedin.com',
  'zoom.us',
  'dropbox.com',
  'icloud.com',
  'disneyplus.com',
  'primevideo.com',
  'amazon.com',
  'playstation.com',
  'steampowered.com',
  // Functional OTP / 2FA / Edu webmail utilities required by delivered accounts
  '2fa.live',
  '2fa-domain.com',
  'hitools.pro',
  'edu-mail.edu.rs',
];

/** Social / messaging / shortener / invite domains typically used by suppliers to advertise */
const DISALLOWED_MARKETING_DOMAINS: string[] = [
  't.me',
  'telegram.me',
  'telegram.dog',
  'discord.gg',
  'chat.whatsapp.com',
  'wa.me',
  'whatsapp.com',
  'linktr.ee',
  'beacons.ai',
  'bio.link',
  'taplink.cc',
  'bit.ly',
  'tinyurl.com',
  't.ly',
  'cutt.ly',
  'rb.gy',
  'shorturl.at',
  'is.gd',
  'instagram.com',
  'facebook.com',
  'fb.com',
  'tiktok.com',
];

/** Product brand names that must NEVER be accidentally turned into dynamic supplier scrub patterns */
const PROTECTED_PRODUCT_BRANDS = new Set([
  'gemini',
  'chatgpt',
  'gpt',
  'openai',
  'claude',
  'anthropic',
  'canva',
  'adobe',
  'duolingo',
  'notion',
  'proton',
  'nordvpn',
  'netflix',
  'spotify',
  'apple',
  'capcut',
  'ilovepdf',
  'udemy',
  'coursera',
  'figma',
  'gamma',
  'cursor',
  'lovable',
  'elevenlabs',
  'elevenreader',
  'picsart',
  'discord',
  'xbox',
  'microsoft',
  'outlook',
  'hotmail',
  'autodesk',
  'quillbot',
  'perplexity',
  'grok',
  'youtube',
  'google',
  'digital',
  'store',
  'shop',
  'hub',
  'api',
  'partner',
  'studio',
  'official',
  'pro',
  'plus',
  'premium',
]);

const dynamicSupplierDomains = new Set<string>();
const dynamicSupplierPatterns: RegExp[] = [];
const dynamicSupplierNameKeys = new Set<string>();

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractRegistrableHost(rawUrl?: string | null): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (!host || host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
    // Strip common API/bot/reseller subdomains so root supplier store domain is also blocked
    const stripped = host.replace(/^(?:api|reseller|bot|shop|store|panel|partner|v1|paid\d*)\./, '');
    return stripped || host;
  } catch {
    return null;
  }
}

/**
 * Registers live providers from the PostgreSQL `providers` table so ANY newly added
 * supplier server in the future is automatically scrubbed from product descriptions.
 */
export function registerDynamicSupplierIdentities(entries: SupplierIdentityInput[]): void {
  for (const entry of entries) {
    const host1 = extractRegistrableHost(entry.baseUrl);
    const host2 = extractRegistrableHost(entry.docsUrl);
    if (host1 && !isOfficialServiceHost(host1)) dynamicSupplierDomains.add(host1);
    if (host2 && !isOfficialServiceHost(host2)) dynamicSupplierDomains.add(host2);

    const candidates = [entry.name, entry.code]
      .map((s) => (s || '').trim())
      .filter((s) => s.length >= 4);

    for (const candidate of candidates) {
      const lower = candidate.toLowerCase();
      if (PROTECTED_PRODUCT_BRANDS.has(lower)) continue;
      if (dynamicSupplierNameKeys.has(lower)) continue;
      dynamicSupplierNameKeys.add(lower);
      // Match whole words/phrase safely (spaces allow optional whitespace/hyphens)
      const patternStr = `\\b${escapeRegExp(candidate).replace(/\\ /g, '[\\s-]+')}\\b`;
      try {
        dynamicSupplierPatterns.push(new RegExp(patternStr, 'gi'));
      } catch {
        // Ignore malformed regex
      }
    }
  }
}

function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  const d = domain.toLowerCase().replace(/^www\./, '');
  return h === d || h.endsWith(`.${d}`);
}

function isOfficialServiceHost(host: string): boolean {
  return OFFICIAL_SERVICE_DOMAINS.some((d) => hostMatchesDomain(host, d));
}

// ============================================================================
// 2. UNIFIED SUPPLIER DESCRIPTION EXTRACTOR (ALL SUPPLIER API SCHEMAS)
// ============================================================================

function coerceDescriptionField(val: unknown): string {
  if (typeof val === 'string') return val.trim();
  if (Array.isArray(val)) {
    const parts = val
      .map((item) => coerceDescriptionField(item))
      .filter(Boolean);
    return parts.join('\n').trim();
  }
  if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const preferred =
      obj.html ??
      obj.telegram_html ??
      obj.en ??
      obj.ar ??
      obj.text ??
      obj.body ??
      obj.content ??
      obj.value;
    if (preferred !== undefined) return coerceDescriptionField(preferred);
  }
  return '';
}

const DESCRIPTION_CANDIDATE_KEYS = [
  'description_html',
  'html_description',
  'telegram_description',
  'descriptionHtml',
  'full_description',
  'long_description',
  'product_description',
  'service_description',
  'description',
  'description_ar',
  'description_en',
  'desc_ar',
  'desc_en',
  'details_html',
  'details',
  'detail',
  'desc',
  'content',
  'body',
  'overview',
  'info',
  'information',
  'activation_instructions',
  'activation_guide',
  'instructions',
  'guide',
  'usage',
  'how_to_use',
  'terms',
  'short_description',
  'short_description_ar',
  'short_description_en',
  'summary',
  'custom_pricing_note',
  'notes',
  'note',
  'readme',
] as const;

function synthesizeSpecsOrFeaturesDescription(src: Record<string, any>): string {
  const sections: string[] = [];
  const featureArrays = [src.features, src.highlights, src.benefits, src.requirements, src.specs, src.specifications];
  for (const cand of featureArrays) {
    if (Array.isArray(cand) && cand.length > 0) {
      const lines = cand
        .map((entry) => {
          if (typeof entry === 'string') return entry.trim();
          if (entry && typeof entry === 'object') {
            const k = entry.label ?? entry.name ?? entry.title ?? entry.key;
            const v = entry.value ?? entry.text ?? entry.description;
            if (k && v) return `${String(k).trim()}: ${String(v).trim()}`;
            return coerceDescriptionField(entry);
          }
          return '';
        })
        .filter(Boolean);
      if (lines.length > 0) {
        sections.push(lines.map((l) => (l.startsWith('•') || l.startsWith('-') ? l : `• ${l}`)).join('\n'));
      }
    } else if (cand && typeof cand === 'object' && !Array.isArray(cand)) {
      const entries = Object.entries(cand as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
        .map(([k, v]) => `• ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v).trim()}`);
      if (entries.length > 0) {
        sections.push(entries.join('\n'));
      }
    }
  }
  return sections.join('\n\n').trim();
}

/**
 * Extracts the richest product description from ANY supplier API item payload
 * (supporting nested variant/meta/attributes objects, HTML fields, arrays, localized objects, and features).
 */
export function extractSupplierRawDescription(
  item: Record<string, any> | null | undefined,
  parentItem?: Record<string, any> | null
): string {
  const directSources = [item, parentItem].filter((s): s is Record<string, any> => Boolean(s && typeof s === 'object'));
  const expandedSources: Record<string, any>[] = [];
  for (const src of directSources) {
    expandedSources.push(src);
    for (const nestedKey of ['attributes', 'meta', 'metadata', 'product', 'service', 'details', 'info']) {
      const nested = src[nestedKey];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        expandedSources.push(nested as Record<string, any>);
      }
    }
  }

  for (const src of expandedSources) {
    for (const key of DESCRIPTION_CANDIDATE_KEYS) {
      const candidate = coerceDescriptionField(src[key]);
      if (candidate) return candidate;
    }
  }

  for (const src of expandedSources) {
    const synthesized = synthesizeSpecsOrFeaturesDescription(src);
    if (synthesized) return synthesized;
  }

  return '';
}

// ============================================================================
// 3. URL CLASSIFIER & PROMOTIONAL/SUPPLIER CONTENT DETECTION
// ============================================================================

const PROMO_LINK_ANCHOR_OR_CONTEXT_RE =
  /(?:visit\s+(?:our\s+)?(?:store|shop|website|site|bot|channel)|join\s+(?:our\s+)?(?:telegram\s+)?(?:channel|group|community)|contact\s+(?:supplier|seller|support|us|admin)|powered\s+by|order\s+(?:from|at|on)\s+(?:our\s+)?(?:website|store|shop|bot)|buy\s+(?:more|now|here|from\s+us)|our\s+(?:official\s+)?(?:store|shop|channel|website|bot)|reseller\s+(?:api|panel|portal)|wholesale|زوروا\s+متجرنا|زيارة\s+متجرنا|انضم\s+(?:إلى\s+|الى\s+)?قناتنا|تواصل\s+مع\s+المورد|اطلب\s+من\s+موقعنا|قناتنا\s+على\s+تيليجرام|متجر\s+المورد|للمزيد\s+من\s+المنتجات)/i;

const STANDALONE_PROMO_LINE_RE =
  /^\s*[\p{Extended_Pictographic}\uFE0F\u200D\s•·\-—–*🔥💎🚀⚡🛒📢📣🌐💬📲👉👇✨©®]*(?:visit\s+(?:our\s+)?(?:store|shop|website|site)|join\s+(?:our\s+)?(?:telegram\s+)?(?:channel|group|community)|follow\s+(?:our\s+)?(?:channel|page)|contact\s+(?:supplier|seller|us\s+on\s+telegram|support\s+at\s+@|@)|powered\s+by\b|provided\s+by\b|supplied\s+by\b|brought\s+to\s+you\s+by\b|sold\s+by\b|order\s+(?:from|at|on)\s+(?:our\s+)?(?:website|store|shop|bot)|buy\s+(?:more|directly)\s+(?:at|from)\b|for\s+(?:bulk|wholesale|reseller)\s+(?:orders?|pricing|api)|reseller\s+api\b|official\s+(?:channel|bot|store)\s*:|updates?\s+channel\s*:|supplier\s+(?:channel|support|store|website)\s*:|©\s*\d{4}?\s*.*(?:store|shop|hub|digital)|زوروا\s+متجرنا|اطلب\s+من\s+موقعنا|انضم\s+(?:إلى\s+|الى\s+)?قناتنا|قناتنا\s+(?:الرسمية|على\s+تيليجرام)|تواصل\s+مع\s+المورد|بواسطة\s+(?:متجر|خادم)|مقدم\s+من\s+(?:متجر|شركة))/iu;

const INTERNAL_ADMIN_NOTICE_LINE_RE =
  /(?:منتج\s*مستورد\s*تلقائي(?:ًا|ا)?\s*من\s*(?:الخادم|المزود|السيرفر)|مخفي\s*افتراضي(?:ًا|ا)?\s*حتى\s*التفعيل(?:\s*والتسعير)?|مستورد\s*تلقائي(?:ًا|ا)?\s*من\s*(?:الخادم|المزود|السيرفر)|مخفي\s*افتراضي(?:ًا|ا)?|حتى\s*التفعيل\s*والتسعير|ملاحظة\s*إدارية\s*داخلية|خاص\s*بالإدارة\s*فقط|للمسؤول\s*فقط|auto[-\s]*imported\s*from\s*(?:the\s*)?(?:server|provider|supplier)|hidden\s*by\s*default\s*(?:until|pending)\s*(?:activation|pricing|review)|pending\s*(?:admin\s*)?activation\s*(?:and|&)\s*pricing|internal\s*(?:admin|system)\s*note|for\s*admin\s*only)/i;

const TRAILING_POWERED_BY_RE =
  /\s*(?:[|•·—–-]+\s*)?(?:powered\s+by|provided\s+by|supplied\s+by|brought\s+to\s+you\s+by|sold\s+by|visit\s+our\s+(?:store|website|shop)|join\s+our\s+(?:channel|group)|contact\s+supplier|order\s+from\s+our\s+(?:website|store)|بواسطة\s+متجر|زوروا\s+متجرنا|انضم\s+لقناتنا|اطلب\s+من\s+موقعنا)\b[^.\n]*$/i;

const REFERRAL_QUERY_PARAMS = new Set([
  'ref',
  'referral',
  'ref_id',
  'aff',
  'aff_id',
  'affiliate',
  'affiliate_id',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'invite_code',
  'partner_ref',
  'via',
]);

const ACTIVATION_OR_UTILITY_PATH_RE =
  /\/(?:redeem|activate|activation|claim|login|signin|sign-in|download|app|apps|setup|install|verify|otp|2fa|inbox|read-|go-to-email|webmail|partner\/|magenta-moments|account|auth|oauth|code|coupon|gift|promo)/i;

const STORE_LIKE_HOST_RE =
  /(?:^|[.-])(?:reseller|smm|cheap|panel|sellers?|shops?|stores?|bot|bots|vcc|accs?|keys?store|digitalstore|aistore|aishop|vault)(?:[.-]|$)/i;

export function classifyDescriptionUrl(
  rawUrl: string,
  contextText = '',
  extraSupplierDomains: string[] = []
): { allowed: boolean; normalizedUrl?: string; reason: string } {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return { allowed: false, reason: 'empty_url' };

  // Decode &amp; in href before parsing URL
  const unescaped = decodeBasicHtmlEntities(trimmed).trim();

  let parsed: URL;
  try {
    parsed = new URL(unescaped);
  } catch {
    return { allowed: false, reason: 'invalid_url' };
  }

  // Strictly permit only http: and https:
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: 'disallowed_scheme' };
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!host || host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return { allowed: false, reason: 'private_or_ip_host' };
  }

  // 1. Always block known & dynamically registered supplier domains
  const allSupplierDomains = [
    ...BUILTIN_SUPPLIER_DOMAINS,
    ...Array.from(dynamicSupplierDomains),
    ...extraSupplierDomains.map((d) => d.toLowerCase().replace(/^www\./, '')),
  ];
  if (allSupplierDomains.some((d) => d && hostMatchesDomain(host, d))) {
    return { allowed: false, reason: 'supplier_domain' };
  }

  // 2. Always block Telegram channels/bots/invites, WhatsApp, Discord invites, link shorteners
  if (DISALLOWED_MARKETING_DOMAINS.some((d) => hostMatchesDomain(host, d))) {
    return { allowed: false, reason: 'marketing_or_social_domain' };
  }
  if (hostMatchesDomain(host, 'discord.com') && /^\/invite\b/i.test(parsed.pathname)) {
    return { allowed: false, reason: 'discord_invite' };
  }

  // 3. Check referral / affiliate query params
  for (const paramKey of parsed.searchParams.keys()) {
    if (REFERRAL_QUERY_PARAMS.has(paramKey.toLowerCase())) {
      return { allowed: false, reason: 'referral_or_marketing_param' };
    }
  }

  // 4. Promotional anchor or surrounding context explicitly advertising a store/channel/supplier
  if (contextText && PROMO_LINK_ANCHOR_OR_CONTEXT_RE.test(contextText)) {
    return { allowed: false, reason: 'promotional_context' };
  }

  // 5. Official consumer service & activation utility domains are explicitly allowed
  if (isOfficialServiceHost(host)) {
    return { allowed: true, normalizedUrl: parsed.toString(), reason: 'official_service_domain' };
  }

  // 6. Block domains that look like third-party reseller stores / shops / bots
  if (STORE_LIKE_HOST_RE.test(host)) {
    return { allowed: false, reason: 'store_like_host' };
  }

  // 7. Allow functional activation / login / redeem / OTP / webmail URLs on neutral domains
  if (
    ACTIVATION_OR_UTILITY_PATH_RE.test(parsed.pathname) ||
    /(?:2fa|otp|mail|inbox|redeem|activate|login|download|support|help|docs)/i.test(host)
  ) {
    return { allowed: true, normalizedUrl: parsed.toString(), reason: 'service_utility_url' };
  }

  // 8. Neutral non-store external link without promo context — block if it's just a bare root homepage
  // (usually a supplier's marketing website), allow if it's a specific service resource path
  if (parsed.pathname === '/' || parsed.pathname === '') {
    return { allowed: false, reason: 'unrecognized_root_homepage' };
  }

  return { allowed: true, normalizedUrl: parsed.toString(), reason: 'neutral_service_link' };
}

function getAllSupplierPatterns(extraSupplierNames: string[] = []): RegExp[] {
  const patterns = [...BUILTIN_SUPPLIER_BRAND_PATTERNS, ...dynamicSupplierPatterns];
  for (const name of extraSupplierNames) {
    const clean = (name || '').trim();
    if (clean.length >= 4 && !PROTECTED_PRODUCT_BRANDS.has(clean.toLowerCase())) {
      try {
        patterns.push(new RegExp(`\\b${escapeRegExp(clean).replace(/\\ /g, '[\\s-]+')}\\b`, 'gi'));
      } catch {
        // Ignore invalid pattern
      }
    }
  }
  return patterns;
}

function containsSupplierBrand(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

function stripSupplierBrandsInline(text: string, patterns: RegExp[]): string {
  let out = text;
  for (const re of patterns) {
    re.lastIndex = 0;
    out = out.replace(re, '');
  }
  return out;
}

// ============================================================================
// 4. HTML ENTITY HELPERS & FORMAT DETECTION
// ============================================================================

const KNOWN_NAMED_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos', 'nbsp']);

export function escapeTelegramHtml(text: string): string {
  if (!text) return '';
  // Escape &, <, > while preserving already-valid HTML entities (avoids double-escaping &amp; -> &amp;amp;)
  return text
    .replace(/&(?!(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);)/g, '&amp;')
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (full, name: string) => {
      const lower = name.toLowerCase();
      if (lower === 'nbsp') return ' ';
      if (KNOWN_NAMED_ENTITIES.has(lower)) return `&${lower};`;
      return `&amp;${name};`;
    })
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function decodeBasicHtmlEntities(text: string): string {
  if (!text) return '';
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    })
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

const TELEGRAM_HTML_TAG_RE =
  /<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote|tg-spoiler|tg-emoji|a)(?:\s[^>]*)?>/i;
const GENERIC_HTML_TAG_RE =
  /<\/?(?:p|div|span|br|ul|ol|li|h[1-6]|table|tr|td|th|section|article|header|footer|font|small|big|hr|img|script|style|iframe)(?:\s[^>]*)?\/?>/i;
const ENCODED_HTML_TAG_RE =
  /&lt;\/?(?:blockquote|b|strong|i|em|u|s|code|pre|tg-emoji|tg-spoiler|a|p|div|br)(?:\s[^&]*)?&gt;/i;

export function detectDescriptionFormat(raw: string): DetectedDescriptionFormat {
  const trimmed = (raw || '').trim();
  if (!trimmed) return 'plain_text';
  if (TELEGRAM_HTML_TAG_RE.test(trimmed)) return 'telegram_html';
  if (GENERIC_HTML_TAG_RE.test(trimmed)) return 'generic_html';
  if (ENCODED_HTML_TAG_RE.test(trimmed)) return 'encoded_html';
  return 'plain_text';
}

// ============================================================================
// 5. STACK-BASED TELEGRAM HTML TOKENIZER, SANITIZER & AUTO-REPAIR ENGINE
// ============================================================================

type TgTagName =
  | 'b'
  | 'strong'
  | 'i'
  | 'em'
  | 'u'
  | 'ins'
  | 's'
  | 'strike'
  | 'del'
  | 'code'
  | 'pre'
  | 'blockquote'
  | 'tg-spoiler'
  | 'a'
  | 'tg-emoji';

interface HtmlNode {
  type: 'text' | 'element';
  text?: string;
  tag?: TgTagName;
  attrs?: Record<string, string>;
  children?: HtmlNode[];
}

const SUPPORTED_TG_TAGS = new Set<string>([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'code',
  'pre',
  'blockquote',
  'tg-spoiler',
  'a',
  'tg-emoji',
]);

const STRIP_CONTENT_TAGS = new Set(['script', 'style', 'iframe', 'noscript', 'object', 'embed', 'svg']);
const BLOCK_NEWLINE_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'tr', 'table', 'ul', 'ol']);
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

function parseTagAttributes(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!attrStr || !attrStr.trim()) return attrs;
  const attrRe = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(attrStr)) !== null) {
    const key = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[key] = val;
  }
  return attrs;
}

function getNodePlainText(node: HtmlNode): string {
  if (node.type === 'text') return decodeBasicHtmlEntities(node.text || '');
  return (node.children || []).map(getNodePlainText).join('');
}

/**
 * Parses arbitrary (possibly malformed, unclosed, misnested, or mixed) HTML into a clean,
 * strictly valid Telegram HTML AST tree while never dropping legitimate product text!
 */
function parseAndRepairToTelegramAst(
  input: string,
  extraSupplierDomains: string[],
  keptLinks: string[],
  removedLinks: string[]
): HtmlNode {
  // Remove HTML comments and dangerous content blocks (<script>, <style>, <iframe>, etc.)
  let cleaned = input.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of STRIP_CONTENT_TAGS) {
    cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
    cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }

  const root: HtmlNode = { type: 'element', tag: undefined, children: [] };
  const stack: HtmlNode[] = [root];

  const currentParent = () => stack[stack.length - 1];

  const pushText = (rawText: string) => {
    if (!rawText) return;
    currentParent().children!.push({ type: 'text', text: rawText });
  };

  const hasOpenTag = (tagName: TgTagName): boolean => {
    for (let i = stack.length - 1; i >= 1; i--) {
      if (stack[i].tag === tagName) return true;
    }
    return false;
  };

  const isInsideCodeOrPre = (): boolean => hasOpenTag('code') || hasOpenTag('pre');

  const openTag = (tag: TgTagName, attrs: Record<string, string> = {}) => {
    // Enforce Telegram nesting rules:
    // 1. No nested <blockquote> inside <blockquote> -> flatten inner blockquote with a newline break
    if (tag === 'blockquote' && hasOpenTag('blockquote')) {
      pushText('\n');
      return;
    }
    // 2. No nested <a> inside <a>
    if (tag === 'a' && hasOpenTag('a')) {
      return;
    }
    // 3. Inside <pre>, only <code class="language-..."> is allowed as child
    if (hasOpenTag('pre') && tag !== 'code') {
      return;
    }
    // 4. Inside <code>, no nested HTML formatting tags allowed
    if (hasOpenTag('code')) {
      return;
    }

    const node: HtmlNode = { type: 'element', tag, attrs, children: [] };
    currentParent().children!.push(node);
    stack.push(node);
  };

  const closeTag = (tag: TgTagName) => {
    // Find matching open tag in stack
    let matchIdx = -1;
    for (let i = stack.length - 1; i >= 1; i--) {
      if (stack[i].tag === tag) {
        matchIdx = i;
        break;
      }
    }
    // Stray unmatched closing tag -> ignore safely
    if (matchIdx === -1) return;

    // If misnested (e.g. <b><i>text</b></i>), cleanly close intermediate tags and reopen them
    const toReopen: Array<{ tag: TgTagName; attrs: Record<string, string> }> = [];
    while (stack.length - 1 > matchIdx) {
      const popped = stack.pop()!;
      if (popped.tag && popped.tag !== 'blockquote' && popped.tag !== 'a' && popped.tag !== 'tg-emoji') {
        toReopen.push({ tag: popped.tag, attrs: { ...(popped.attrs || {}) } });
      }
    }
    // Close the matched tag itself
    stack.pop();

    // Reopen any inline tags that crossed the boundary
    for (let i = toReopen.length - 1; i >= 0; i--) {
      const item = toReopen[i];
      const reopened: HtmlNode = { type: 'element', tag: item.tag, attrs: item.attrs, children: [] };
      currentParent().children!.push(reopened);
      stack.push(reopened);
    }
  };

  // Tokenize tags vs text with a zero-backtracking linear pattern (disjoint char classes, bounded length)
  const tagTokenRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]{0,30})((?:"[^"]*"|'[^']*'|[^"'<>]){0,600})>/g;

  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tagTokenRe.exec(cleaned)) !== null) {
    const fullMatch = match[0];
    const isClosing = match[1] === '/';
    const rawName = match[2].toLowerCase();
    const rawBetween = match[3] || '';

    if (rawBetween && !/^[\s/]/.test(rawBetween)) {
      pushText(cleaned.slice(cursor, match.index + fullMatch.length));
      cursor = match.index + fullMatch.length;
      continue;
    }

    const isSelfClosing = !isClosing && /\/\s*$/.test(rawBetween);
    const attrStr = isSelfClosing ? rawBetween.replace(/\s*\/\s*$/, '') : rawBetween;

    if (match.index > cursor) {
      pushText(cleaned.slice(cursor, match.index));
    }
    cursor = match.index + fullMatch.length;

    // Handle <br> / <hr>
    if (rawName === 'br') {
      pushText('\n');
      continue;
    }
    if (rawName === 'hr') {
      pushText('\n━━━━━━━━━━━━━━\n');
      continue;
    }

    // Handle list items <li>...</li>
    if (rawName === 'li') {
      if (!isClosing) {
        pushText('\n• ');
      } else {
        pushText('\n');
      }
      continue;
    }

    // Handle headings <h1>..<h6> -> convert to <b>...</b> + newline
    if (HEADING_TAGS.has(rawName)) {
      if (!isClosing) {
        pushText('\n');
        openTag('b');
      } else {
        closeTag('b');
        pushText('\n');
      }
      continue;
    }

    // Handle block containers <p>, <div>, etc. -> preserve paragraph breaks
    if (BLOCK_NEWLINE_TAGS.has(rawName)) {
      if (isClosing) {
        pushText('\n');
      }
      continue;
    }

    // Handle <span class="tg-spoiler"> -> map to Telegram <tg-spoiler>
    if (rawName === 'span') {
      if (!isClosing) {
        const attrs = parseTagAttributes(attrStr);
        if ((attrs.class || '').toLowerCase().split(/\s+/).includes('tg-spoiler')) {
          openTag('tg-spoiler');
        }
        // Any other <span> wrapper is transparently unwrapped (inner text preserved)
      } else if (hasOpenTag('tg-spoiler')) {
        closeTag('tg-spoiler');
      }
      continue;
    }

    // Supported Telegram HTML tags
    if (SUPPORTED_TG_TAGS.has(rawName)) {
      const tagName = rawName as TgTagName;

      if (isClosing) {
        closeTag(tagName);
        continue;
      }

      if (isSelfClosing && tagName !== 'tg-emoji') {
        // Telegram does not allow self-closing formatting tags (except empty supplier <tg-emoji /> which we fill with ✨)
        continue;
      }

      const attrs = parseTagAttributes(attrStr);

      if (tagName === 'blockquote') {
        const isExpandable =
          'expandable' in attrs || /\bexpandable\b/i.test(attrStr);
        openTag('blockquote', isExpandable ? { expandable: 'true' } : {});
        continue;
      }

      if (tagName === 'tg-emoji') {
        const emojiId = (attrs['emoji-id'] || attrs['custom_emoji_id'] || '').trim();
        // Telegram custom emoji IDs are numeric 64-bit IDs (typically 15–20 digits, allow 5–25 digits)
        if (/^\d{5,25}$/.test(emojiId)) {
          openTag('tg-emoji', { 'emoji-id': emojiId });
          if (isSelfClosing) {
            pushText('✨');
            closeTag('tg-emoji');
          }
        } else if (isSelfClosing) {
          pushText('✨');
        }
        // If invalid emoji-id, skip opening the tag so fallback inner emoji renders cleanly!
        continue;
      }

      if (tagName === 'a') {
        const href = (attrs.href || '').trim();
        if (href) {
          openTag('a', { href });
        }
        continue;
      }

      if (tagName === 'code') {
        const cls = (attrs.class || '').trim();
        const langMatch = cls.match(/\blanguage-([a-zA-Z0-9_+#.-]{1,30})\b/);
        openTag('code', langMatch && hasOpenTag('pre') ? { class: `language-${langMatch[1]}` } : {});
        continue;
      }

      openTag(tagName);
      continue;
    }

    // Unknown HTML tags:
    // If it looks like a placeholder like <email> or <username> (no attributes, single word inside plain text, not paired),
    // preserve as escaped literal text if it's an obvious placeholder; otherwise unwrap unknown HTML tag cleanly!
    const isLikelyPlaceholder =
      !isClosing &&
      !attrStr.trim() &&
      /^(?:email|password|pass|username|user|code|token|key|link|id|name|your_email|your_code)$/i.test(rawName);
    if (isLikelyPlaceholder && !isInsideCodeOrPre()) {
      pushText(fullMatch);
    }
    // Otherwise discard only the unsupported tag wrapper while preserving all inner content!
  }

  if (cursor < cleaned.length) {
    pushText(cleaned.slice(cursor));
  }

  // Validate all <a> nodes now that their anchor text is known!
  validateLinksInAst(root, extraSupplierDomains, keptLinks, removedLinks);

  return root;
}

function validateLinksInAst(
  node: HtmlNode,
  extraSupplierDomains: string[],
  keptLinks: string[],
  removedLinks: string[]
): void {
  if (!node.children || node.children.length === 0) return;

  const nextChildren: HtmlNode[] = [];
  for (const child of node.children) {
    if (child.type === 'element' && child.tag === 'a') {
      const href = child.attrs?.href || '';
      const anchorText = getNodePlainText(child).trim();
      const verdict = classifyDescriptionUrl(href, anchorText, extraSupplierDomains);

      if (verdict.allowed && verdict.normalizedUrl) {
        child.attrs = { href: verdict.normalizedUrl };
        validateLinksInAst(child, extraSupplierDomains, keptLinks, removedLinks);
        if (getNodePlainText(child).trim()) {
          keptLinks.push(verdict.normalizedUrl);
          nextChildren.push(child);
        }
      } else {
        if (href) removedLinks.push(href);
        // If anchor text is purely the URL itself or a promotional CTA, drop completely;
        // otherwise keep non-promotional text without the disallowed link.
        const looksLikeUrlText = /^https?:\/\//i.test(anchorText) || /^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(anchorText);
        if (
          anchorText &&
          !looksLikeUrlText &&
          !PROMO_LINK_ANCHOR_OR_CONTEXT_RE.test(anchorText) &&
          !STANDALONE_PROMO_LINE_RE.test(anchorText)
        ) {
          nextChildren.push({ type: 'text', text: anchorText });
        }
      }
      continue;
    }

    if (child.type === 'element') {
      validateLinksInAst(child, extraSupplierDomains, keptLinks, removedLinks);
    }
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

// ============================================================================
// 6. AST SERIALIZATION & SELECTIVE SUPPLIER / PROMO SCRUBBING
// ============================================================================

const RAW_URL_RE = /\bhttps?:\/\/[^\s<>"')\]}]+/gi;
const BARE_TELEGRAM_URL_RE = /\b(?:t\.me|telegram\.me|telegram\.dog|discord\.gg|wa\.me|chat\.whatsapp\.com)\/[^\s<>"')\]}]+/gi;
const PROMO_HANDLE_LINE_RE =
  /(?:contact|support|channel|bot|store|shop|admin|owner|supplier|telegram|dm|message|order|buy|تواصل|الدعم|القناة|البوت|المتجر|المورد)\s*[:：\-—–]?\s*@[a-zA-Z][a-zA-Z0-9_]{3,}/gi;
const SUPPLIER_BOT_OR_SHOP_HANDLE_RE =
  /(?<![a-zA-Z0-9._%+-])@[a-zA-Z0-9_]*(?:bot|store|shop|channel|support|reseller|official|deals|market|supplier)\b/gi;

function scrubPlainTextLine(
  line: string,
  supplierPatterns: RegExp[],
  extraSupplierDomains: string[],
  keptLinks: string[],
  removedLinks: string[]
): { text: string; removedLine: boolean } {
  const trimmed = line.trim();
  if (!trimmed) return { text: '', removedLine: false };

  // 1. Always strip internal admin import notices
  if (INTERNAL_ADMIN_NOTICE_LINE_RE.test(trimmed)) {
    return { text: '', removedLine: true };
  }

  // 2. Always strip standalone promotional / supplier call-to-action lines
  if (STANDALONE_PROMO_LINE_RE.test(trimmed)) {
    // Record any URLs on this line as removed
    const urls = trimmed.match(RAW_URL_RE) || [];
    for (const u of urls) removedLinks.push(u);
    return { text: '', removedLine: true };
  }

  let working = line;

  // 3. Strip trailing "— Powered by ..." / "— Visit our store..." suffix while keeping main product info!
  if (TRAILING_POWERED_BY_RE.test(working)) {
    working = working.replace(TRAILING_POWERED_BY_RE, '').trimEnd();
  }

  // 4. Inspect any bare/plain http(s) URLs in the text line
  working = working.replace(RAW_URL_RE, (matchedUrl) => {
    // Trim trailing punctuation like '.', ',', ')'
    const cleanUrl = matchedUrl.replace(/[.,;:!?)}\]]+$/, '');
    const trailingPunct = matchedUrl.slice(cleanUrl.length);
    const verdict = classifyDescriptionUrl(cleanUrl, trimmed, extraSupplierDomains);
    if (verdict.allowed) {
      keptLinks.push(verdict.normalizedUrl || cleanUrl);
      return matchedUrl;
    }
    removedLinks.push(cleanUrl);
    return trailingPunct ? '' : '';
  });

  // 5. Remove bare t.me / discord.gg / wa.me links (without https:// prefix)
  working = working.replace(BARE_TELEGRAM_URL_RE, (m) => {
    removedLinks.push(m);
    return '';
  });

  // 6. Remove promotional Telegram @handles (only in contact/promo/bot/store context, NEVER emails or passwords!)
  working = working.replace(PROMO_HANDLE_LINE_RE, '');
  working = working.replace(SUPPLIER_BOT_OR_SHOP_HANDLE_RE, '');

  // 7. Remove known/registered supplier names while keeping surrounding product info intact
  const hadSupplierBrand = containsSupplierBrand(working, supplierPatterns);
  if (hadSupplierBrand) {
    working = stripSupplierBrandsInline(working, supplierPatterns);
  }

  // Clean up orphaned separators left behind after scrubbing
  const cleaned = working
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s*[-—–•·:|]+\s*$/, '')
    .trimEnd();

  if (!cleaned.trim()) {
    return { text: '', removedLine: true };
  }
  return { text: cleaned, removedLine: false };
}

/**
 * Scrubs supplier branding/promos/disallowed links at the line level while preserving
 * balanced Telegram HTML tags (including multi-line <blockquote> blocks!).
 */
function scrubHtmlAwareLines(
  telegramHtml: string,
  supplierPatterns: RegExp[],
  extraSupplierDomains: string[],
  keptLinks: string[],
  removedLinks: string[]
): { html: string; removedCount: number } {
  const lines = telegramHtml.split('\n');
  const outLines: string[] = [];
  let removedCount = 0;

  for (const line of lines) {
    const plainOfLine = stripTelegramHtmlToPlainText(line).trim();
    if (!plainOfLine) {
      // Keep structural tag-only lines (like closing </blockquote>) or blank separators
      const strippedTagsOnly = line.replace(/<\/?[^>]+>/g, '').trim();
      if (line.includes('<')) {
        outLines.push(line);
      } else if (!strippedTagsOnly) {
        outLines.push('');
      }
      continue;
    }

    // Check if the entire line is a standalone promotional / admin-notice / supplier-only line
    if (
      INTERNAL_ADMIN_NOTICE_LINE_RE.test(plainOfLine) ||
      STANDALONE_PROMO_LINE_RE.test(plainOfLine)
    ) {
      const lineUrls = [
        ...(plainOfLine.match(RAW_URL_RE) || []),
        ...(plainOfLine.match(BARE_TELEGRAM_URL_RE) || []),
      ];
      for (const u of lineUrls) {
        removedLinks.push(u.replace(/[.,;:!?)}\]]+$/, ''));
      }
      // Preserve any structural opening/closing <blockquote> tags on this line so nesting stays 100% balanced!
      const structuralTags = (line.match(/<\/?blockquote(?:\s+expandable)?>/gi) || []).join('');
      if (structuralTags) {
        outLines.push(structuralTags);
      }
      removedCount += 1;
      continue;
    }

    // Check if the line has ONLY supplier brand name(s) + punctuation/emojis
    const withoutSuppliers = stripSupplierBrandsInline(plainOfLine, supplierPatterns)
      .replace(/[\p{Extended_Pictographic}\uFE0F\u200D\s\-—–|•·:.,!()[\]{}©®™]+/gu, '')
      .trim();
    if (containsSupplierBrand(plainOfLine, supplierPatterns) && !withoutSuppliers) {
      const structuralTags = (line.match(/<\/?blockquote(?:\s+expandable)?>/gi) || []).join('');
      if (structuralTags) {
        outLines.push(structuralTags);
      }
      removedCount += 1;
      continue;
    }

    // Process ONLY text segments outside HTML tags on this line so tags & hrefs remain intact
    const parts = line.split(/(<[^>]+>)/g);
    let insideAnchor = false;
    let insideCode = false;
    let modified = false;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      if (part.startsWith('<') && part.endsWith('>')) {
        const lower = part.toLowerCase();
        if (lower.startsWith('<a ')) insideAnchor = true;
        else if (lower === '</a>') insideAnchor = false;
        else if (lower.startsWith('<code') || lower.startsWith('<pre')) insideCode = true;
        else if (lower === '</code>' || lower === '</pre>') insideCode = false;
        continue;
      }

      // Skip scrubbing official URLs inside <a> or <code> (already validated or literal activation code examples)
      if (insideAnchor) {
        // Still strip any supplier brand from anchor text if present
        if (containsSupplierBrand(part, supplierPatterns)) {
          parts[i] = stripSupplierBrandsInline(part, supplierPatterns);
          modified = true;
        }
        continue;
      }

      if (insideCode) {
        // Inside <code>, only scrub explicit supplier domains (preserve e.g. duolingo.com/redeem?code=..., edu-mail.edu.rs)
        let codePart = part;
        const decodedCode = decodeBasicHtmlEntities(codePart);
        const urls = decodedCode.match(RAW_URL_RE) || [];
        for (const u of urls) {
          const cleanU = u.replace(/[.,;:!?)}\]]+$/, '');
          const v = classifyDescriptionUrl(cleanU, plainOfLine, extraSupplierDomains);
          if (!v.allowed) {
            removedLinks.push(cleanU);
            codePart = codePart.replace(escapeTelegramHtml(cleanU), '').replace(cleanU, '');
            modified = true;
          }
        }
        parts[i] = codePart;
        continue;
      }

      const decoded = decodeBasicHtmlEntities(part);
      // Preserve pure whitespace separators between inline tags (e.g., `</tg-emoji> <b>`, `</b> <i>`)
      if (!decoded.trim()) {
        continue;
      }
      const leadingWs = decoded.match(/^\s+/)?.[0] || '';
      const trailingWs = decoded.match(/\s+$/)?.[0] || '';
      const res = scrubPlainTextLine(
        decoded,
        supplierPatterns,
        extraSupplierDomains,
        keptLinks,
        removedLinks
      );
      const nextText = res.text ? `${leadingWs}${res.text.trim()}${trailingWs}` : '';
      if (nextText !== decoded) {
        parts[i] = escapeTelegramHtml(nextText);
        modified = true;
      }
    }

    const rebuilt = parts.join('');
    const rebuiltPlain = stripTelegramHtmlToPlainText(rebuilt).trim();
    if (modified && !rebuiltPlain) {
      const structuralTags = (rebuilt.match(/<\/?blockquote(?:\s+expandable)?>/gi) || []).join('');
      if (structuralTags) outLines.push(structuralTags);
      removedCount += 1;
      continue;
    }

    outLines.push(rebuilt);
  }

  return {
    html: outLines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    removedCount,
  };
}

function serializeAstToTelegramHtml(node: HtmlNode, allowCustomEmoji: boolean): string {
  if (node.type === 'text') {
    return escapeTelegramHtml(node.text || '');
  }

  const childrenHtml = (node.children || [])
    .map((child) => serializeAstToTelegramHtml(child, allowCustomEmoji))
    .join('');

  if (!node.tag) return childrenHtml;

  // Never prune <tg-emoji emoji-id="..."> even if supplier sent empty inner text — supply safe ✨ fallback!
  if (node.tag === 'tg-emoji') {
    const emojiId = node.attrs?.['emoji-id'];
    const safeInner = childrenHtml.replace(/<[^>]+>/g, '').trim() ? childrenHtml : '✨';
    if (!allowCustomEmoji || !emojiId || !/^\d{5,25}$/.test(emojiId)) {
      return safeInner;
    }
    return `<tg-emoji emoji-id="${emojiId}">${safeInner}</tg-emoji>`;
  }

  // Prune empty formatting tags (never send <b></b> or <blockquote> </blockquote> to Telegram!)
  const visibleContent = childrenHtml.replace(/<[^>]+>/g, '').trim();
  if (!visibleContent) {
    // Preserve newlines if they were inside an empty block
    return childrenHtml.includes('\n') ? '\n' : '';
  }

  if (node.tag === 'a') {
    const href = node.attrs?.href;
    if (!href) return childrenHtml;
    return `<a href="${escapeHtmlAttr(href)}">${childrenHtml}</a>`;
  }

  if (node.tag === 'blockquote') {
    const trimmedInner = childrenHtml.replace(/^\n+|\n+$/g, '');
    if (!trimmedInner.replace(/<[^>]+>/g, '').trim()) return '';
    const attr = node.attrs?.expandable ? ' expandable' : '';
    return `<blockquote${attr}>${trimmedInner}</blockquote>`;
  }

  if (node.tag === 'code' && node.attrs?.class) {
    return `<code class="${escapeHtmlAttr(node.attrs.class)}">${childrenHtml}</code>`;
  }

  return `<${node.tag}>${childrenHtml}</${node.tag}>`;
}

/**
 * Extracts unique ordered Telegram custom emoji IDs from sanitized or raw HTML.
 */
export function extractCustomEmojiIds(html: string | null | undefined): string[] {
  if (!html) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /<tg-emoji\b[^>]*(?:emoji-id|custom_emoji_id)\s*=\s*(?:"(\d{5,25})"|'(\d{5,25})')[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const id = (m[1] || m[2] || '').trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Unwraps ONLY `<tg-emoji>` tags whose `emoji-id` is NOT in `validIds` to their Unicode fallback,
 * keeping all other valid `<tg-emoji>` tags and Telegram HTML formatting 100% intact.
 */
export function replaceDisallowedCustomEmojis(html: string, validIds: Set<string>): string {
  if (!html) return '';
  return html.replace(
    /<tg-emoji\b([^>]*)>([\s\S]*?)<\/tg-emoji>/gi,
    (full, attrStr: string, inner: string) => {
      const idMatch = attrStr.match(/(?:emoji-id|custom_emoji_id)\s*=\s*(?:"(\d{5,25})"|'(\d{5,25})')/i);
      const id = (idMatch?.[1] || idMatch?.[2] || '').trim();
      if (id && validIds.has(id)) {
        return full;
      }
      const cleanInner = inner.replace(/<[^>]+>/g, '').trim();
      return cleanInner ? inner : '✨';
    }
  );
}

/**
 * Unwraps `<tg-emoji emoji-id="...">X</tg-emoji>` to its Unicode fallback `X` while
 * keeping ALL other Telegram HTML formatting (`<blockquote>`, `<b>`, `<i>`, `<a>`, `<code>`) intact.
 */
export function stripTgEmojiTagsKeepFallback(html: string): string {
  if (!html) return '';
  return html.replace(/<tg-emoji\b[^>]*>([\s\S]*?)<\/tg-emoji>/gi, (_full, inner: string) =>
    inner.replace(/<[^>]+>/g, '').trim() ? inner : '✨'
  );
}

/**
 * Converts Telegram HTML into clean, readable plain text with zero raw tags or HTML entities.
 */
export function stripTelegramHtmlToPlainText(html: string | null | undefined): string {
  if (!html) return '';
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/blockquote>\s*<blockquote(?:\s+expandable)?>/gi, '\n\n')
    .replace(/<\/(blockquote|p|div|li|pre|h[1-6])>/gi, '\n')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_full, href: string, label: string) => {
      const cleanLabel = label.replace(/<[^>]+>/g, '').trim();
      const cleanHref = decodeBasicHtmlEntities(href).trim();
      if (!cleanLabel) return cleanHref;
      if (cleanLabel.includes(cleanHref) || cleanHref.includes(cleanLabel)) return cleanLabel;
      return `${cleanLabel} (${cleanHref})`;
    })
    .replace(/<[^>]+>/g, '');

  return decodeBasicHtmlEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Truncates Telegram HTML safely by visible character count, automatically closing any
 * open tags so Telegram NEVER receives a broken/unclosed tag even on ultra-long descriptions.
 */
export function truncateTelegramHtmlSafely(html: string, maxVisibleChars: number): string {
  if (!html || maxVisibleChars <= 0) return '';
  const plain = stripTelegramHtmlToPlainText(html);
  if (plain.length <= maxVisibleChars) return html;

  const limit = Math.max(40, maxVisibleChars - 3);
  const tagRe = /(<\/?[a-zA-Z][a-zA-Z0-9-]{0,30}(?:\s[^<>]{0,600})?>)/g;
  const parts = html.split(tagRe);
  const openStack: string[] = [];
  let visibleCount = 0;
  let result = '';

  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('<') && part.endsWith('>')) {
      const closeMatch = part.match(/^<\/([a-zA-Z0-9-]+)>$/);
      if (closeMatch) {
        const idx = openStack.lastIndexOf(closeMatch[1].toLowerCase());
        if (idx !== -1) openStack.splice(idx, 1);
        result += part;
      } else {
        const openMatch = part.match(/^<([a-zA-Z0-9-]+)/);
        if (openMatch) {
          openStack.push(openMatch[1].toLowerCase());
        }
        result += part;
      }
      continue;
    }

    const decoded = decodeBasicHtmlEntities(part);
    if (visibleCount + decoded.length <= limit) {
      result += part;
      visibleCount += decoded.length;
    } else {
      const remaining = Math.max(0, limit - visibleCount);
      if (remaining > 0) {
        // Avoid cutting in the middle of an entity or surrogate pair
        const sliced = Array.from(decoded).slice(0, remaining).join('').trimEnd();
        result += escapeTelegramHtml(sliced);
      }
      result += '…';
      break;
    }
  }

  // Close all still-open tags in LIFO reverse order
  for (let i = openStack.length - 1; i >= 0; i--) {
    result += `</${openStack[i]}>`;
  }

  return result;
}

// ============================================================================
// 7. MAIN CENTRALIZED ENTRY POINT
// ============================================================================

/**
 * Central, unified product description processor for ALL suppliers and ALL product views.
 *
 * Guarantees:
 * - Preserves native Telegram HTML formatting (`<blockquote>`, `<b>`, `<i>`, `<u>`, `<s>`,
 *   `<code>`, `<pre>`, `<tg-spoiler>`, `<a href>`, `<tg-emoji emoji-id="...">`).
 * - Repairs unclosed/misnested tags & unwraps unsupported tags without losing product details.
 * - Scrubs supplier identities, store/channel/referral links, and promotional lines selectively.
 * - Preserves official service/activation/redemption/OTP links & 100% of product info.
 * - Provides both `telegramHtml`, `telegramHtmlNoCustomEmoji`, and `plainText` outputs.
 */
export function processSupplierProductDescription(
  rawInput: string | null | undefined,
  options: ProcessProductDescriptionOptions = {}
): ProcessedProductDescription {
  const original = (rawInput || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!original) {
    return {
      detectedFormat: 'plain_text',
      telegramHtml: '',
      telegramHtmlNoCustomEmoji: '',
      plainText: '',
      hasHtmlFormatting: false,
      hasCustomEmoji: false,
      keptLinks: [],
      removedLinks: [],
      removedSupplierLinesCount: 0,
    };
  }

  const detectedFormat = detectDescriptionFormat(original);
  const extraSupplierDomains = options.extraSupplierDomains || [];
  const supplierPatterns = getAllSupplierPatterns(options.extraSupplierNames || []);
  const keptLinks: string[] = [];
  const removedLinks: string[] = [];

  // If the supplier API double-encoded HTML tags (`&lt;blockquote&gt;...`), decode once before AST parsing
  const workingSource =
    detectedFormat === 'encoded_html' ? decodeBasicHtmlEntities(original) : original;

  // Step 1: Parse into strictly valid Telegram HTML AST (handles plain text, Telegram HTML, and generic HTML uniformly!)
  const ast1 = parseAndRepairToTelegramAst(workingSource, extraSupplierDomains, keptLinks, removedLinks);
  const repairedPass1 = serializeAstToTelegramHtml(ast1, true);

  // Step 2: Selectively scrub supplier branding, promotional text, and disallowed plain-text URLs
  const scrubbed = scrubHtmlAwareLines(
    repairedPass1,
    supplierPatterns,
    extraSupplierDomains,
    keptLinks,
    removedLinks
  );

  // Step 3: Final AST repair & empty-tag pruning pass after line scrubbing (guarantees 100% valid balanced HTML!)
  const finalKept: string[] = [];
  const finalRemoved: string[] = [...removedLinks];
  const astFinal = parseAndRepairToTelegramAst(scrubbed.html, extraSupplierDomains, finalKept, finalRemoved);

  let telegramHtml = serializeAstToTelegramHtml(astFinal, true)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  let telegramHtmlNoCustomEmoji = serializeAstToTelegramHtml(astFinal, false)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Optional safe visible-character cap (default 3500 chars to stay well within Telegram's 4096 char limit)
  const maxVisible = options.maxVisibleChars ?? 3500;
  if (maxVisible > 0) {
    telegramHtml = truncateTelegramHtmlSafely(telegramHtml, maxVisible);
    telegramHtmlNoCustomEmoji = truncateTelegramHtmlSafely(telegramHtmlNoCustomEmoji, maxVisible);
  }

  const plainText = stripTelegramHtmlToPlainText(telegramHtml);
  const hasHtmlFormatting = TELEGRAM_HTML_TAG_RE.test(telegramHtml);
  const hasCustomEmoji = /<tg-emoji\b/i.test(telegramHtml);

  // Deduplicate diagnostics lists
  const dedupKept = Array.from(new Set([...keptLinks, ...finalKept]));
  const dedupRemoved = Array.from(new Set(finalRemoved));

  return {
    detectedFormat,
    telegramHtml,
    telegramHtmlNoCustomEmoji,
    plainText,
    hasHtmlFormatting,
    hasCustomEmoji,
    keptLinks: dedupKept,
    removedLinks: dedupRemoved,
    removedSupplierLinesCount: scrubbed.removedCount,
  };
}

function validateSafePreviewLinksInAst(node: HtmlNode): void {
  if (!node.children || node.children.length === 0) return;
  const nextChildren: HtmlNode[] = [];
  for (const child of node.children) {
    if (child.type === 'element' && child.tag === 'a') {
      const href = decodeBasicHtmlEntities(child.attrs?.href || '').trim();
      let safeHref: string | null = null;
      try {
        const parsed = new URL(href);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          safeHref = parsed.toString();
        }
      } catch {
        safeHref = null;
      }
      if (safeHref) {
        child.attrs = { href: safeHref };
        validateSafePreviewLinksInAst(child);
        nextChildren.push(child);
      } else {
        const txt = getNodePlainText(child).trim();
        if (txt) nextChildren.push({ type: 'text', text: txt });
      }
      continue;
    }
    if (child.type === 'element') {
      validateSafePreviewLinksInAst(child);
    }
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

/**
 * Normalizes an original supplier description for pre-import Admin Preview ONLY:
 * - Strips dangerous XSS tags (<script>, <iframe>, <style>, etc.) and non-http(s) links.
 * - Repairs broken HTML / decodes double-encoded tags into clean Telegram HTML.
 * - Preserves 100% of original supplier content, links, <blockquote>, formatting, and <tg-emoji>
 *   so the admin can inspect the product exactly as it exists at the upstream server before importing.
 */
export function normalizeOriginalTelegramHtmlForPreview(rawInput: string | null | undefined): string {
  const original = (rawInput || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!original) return '';
  const detected = detectDescriptionFormat(original);
  const workingSource = detected === 'encoded_html' ? decodeBasicHtmlEntities(original) : original;
  let cleaned = workingSource.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of STRIP_CONTENT_TAGS) {
    cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
    cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }
  return serializeRawPreviewAst(cleaned);
}

function serializeRawPreviewAst(cleaned: string): string {
  const root: HtmlNode = { type: 'element', tag: undefined, children: [] };
  const stack: HtmlNode[] = [root];
  const currentParent = () => stack[stack.length - 1];
  const pushText = (t: string) => {
    if (t) currentParent().children!.push({ type: 'text', text: t });
  };
  const hasOpenTag = (tagName: TgTagName): boolean => {
    for (let i = stack.length - 1; i >= 1; i--) {
      if (stack[i].tag === tagName) return true;
    }
    return false;
  };
  const openTag = (tag: TgTagName, attrs: Record<string, string> = {}) => {
    if (tag === 'blockquote' && hasOpenTag('blockquote')) {
      pushText('\n');
      return;
    }
    if (tag === 'a' && hasOpenTag('a')) return;
    if (hasOpenTag('pre') && tag !== 'code') return;
    if (hasOpenTag('code')) return;
    const node: HtmlNode = { type: 'element', tag, attrs, children: [] };
    currentParent().children!.push(node);
    stack.push(node);
  };
  const closeTag = (tag: TgTagName) => {
    let matchIdx = -1;
    for (let i = stack.length - 1; i >= 1; i--) {
      if (stack[i].tag === tag) {
        matchIdx = i;
        break;
      }
    }
    if (matchIdx === -1) return;
    while (stack.length - 1 >= matchIdx) stack.pop();
  };

  const tagTokenRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]{0,30})((?:"[^"]*"|'[^']*'|[^"'<>]){0,600})>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tagTokenRe.exec(cleaned)) !== null) {
    const fullMatch = match[0];
    const isClosing = match[1] === '/';
    const rawName = match[2].toLowerCase();
    const rawBetween = match[3] || '';
    if (rawBetween && !/^[\s/]/.test(rawBetween)) {
      pushText(cleaned.slice(cursor, match.index + fullMatch.length));
      cursor = match.index + fullMatch.length;
      continue;
    }
    if (match.index > cursor) pushText(cleaned.slice(cursor, match.index));
    cursor = match.index + fullMatch.length;
    const isSelfClosing = !isClosing && /\/\s*$/.test(rawBetween);
    const attrStr = isSelfClosing ? rawBetween.replace(/\s*\/\s*$/, '') : rawBetween;
    if (rawName === 'br') { pushText('\n'); continue; }
    if (rawName === 'hr') { pushText('\n━━━━━━━━━━━━━━\n'); continue; }
    if (rawName === 'li') { pushText(!isClosing ? '\n• ' : '\n'); continue; }
    if (HEADING_TAGS.has(rawName)) {
      if (!isClosing) { pushText('\n'); openTag('b'); } else { closeTag('b'); pushText('\n'); }
      continue;
    }
    if (BLOCK_NEWLINE_TAGS.has(rawName)) { if (isClosing) pushText('\n'); continue; }
    if (rawName === 'span') {
      if (!isClosing) {
        const attrs = parseTagAttributes(attrStr);
        if ((attrs.class || '').toLowerCase().split(/\s+/).includes('tg-spoiler')) openTag('tg-spoiler');
      } else if (hasOpenTag('tg-spoiler')) closeTag('tg-spoiler');
      continue;
    }
    if (SUPPORTED_TG_TAGS.has(rawName)) {
      const tagName = rawName as TgTagName;
      if (isClosing) { closeTag(tagName); continue; }
      if (isSelfClosing && tagName !== 'tg-emoji') continue;
      const attrs = parseTagAttributes(attrStr);
      if (tagName === 'blockquote') {
        openTag('blockquote', 'expandable' in attrs || /\bexpandable\b/i.test(attrStr) ? { expandable: 'true' } : {});
        continue;
      }
      if (tagName === 'tg-emoji') {
        const emojiId = (attrs['emoji-id'] || attrs['custom_emoji_id'] || '').trim();
        if (/^\d{5,25}$/.test(emojiId)) {
          openTag('tg-emoji', { 'emoji-id': emojiId });
          if (isSelfClosing) { pushText('✨'); closeTag('tg-emoji'); }
        } else if (isSelfClosing) pushText('✨');
        continue;
      }
      if (tagName === 'a') {
        const href = (attrs.href || '').trim();
        if (href) openTag('a', { href });
        continue;
      }
      if (tagName === 'code') {
        const langMatch = (attrs.class || '').trim().match(/\blanguage-([a-zA-Z0-9_+#.-]{1,30})\b/);
        openTag('code', langMatch && hasOpenTag('pre') ? { class: `language-${langMatch[1]}` } : {});
        continue;
      }
      openTag(tagName);
    }
  }
  if (cursor < cleaned.length) pushText(cleaned.slice(cursor));
  validateSafePreviewLinksInAst(root);
  return serializeAstToTelegramHtml(root, true)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
