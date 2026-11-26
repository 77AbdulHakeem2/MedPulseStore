import { classifyOfferBrand } from './offerClassifier.ts';

export type MappingIssueType =
  | 'duplicate_offer_across_products'
  | 'disabled_provider'
  | 'inactive_provider_offer'
  | 'service_mismatch';

export interface ProviderOfferPoolItem {
  id: number;
  linkedStoreProductId?: number | null;
  linkedStoreProductTitle?: string | null;
}

export interface MappingRecordForAudit {
  mappingId: number;
  storeProductId: number;
  storeProductTitle: string;
  storeProductCategoryName?: string | null;
  storeProductDescription?: string | null;
  storeProductVisible?: boolean;
  providerProductId: number;
  providerId: number;
  providerName: string;
  providerEnabled: boolean;
  providerStatus: string;
  providerOfferRawName: string;
  providerOfferDescription?: string | null;
  isActiveAtProvider: boolean;
  wholesalePrice: string;
  stockCount: number;
  priority: number;
  isActiveMapping: boolean;
}

export interface MappingAuditIssue {
  mappingId: number;
  storeProductId: number;
  storeProductTitle: string;
  storeProductVisible: boolean;
  providerProductId: number;
  providerId: number;
  providerName: string;
  providerOfferRawName: string;
  wholesalePrice: string;
  stockCount: number;
  priority: number;
  issueTypes: MappingIssueType[];
  primaryIssue: MappingIssueType;
  reasonAr: string;
  severity: 'high' | 'medium';
}

export interface MappingAuditReport {
  summary: {
    totalMappings: number;
    healthyCount: number;
    flaggedCount: number;
    duplicateOfferCount: number;
    disabledProviderCount: number;
    inactiveOfferCount: number;
    mismatchCount: number;
  };
  issues: MappingAuditIssue[];
}

export type OfferBindingCheckResult =
  | { ok: true }
  | {
      ok: false;
      code: 'ALREADY_LINKED_SAME_PRODUCT' | 'ALREADY_LINKED_OTHER_PRODUCT';
      conflictMappingId: number;
      conflictStoreProductId: number;
      conflictStoreProductTitle: string;
    };

const DISTINCT_SERVICE_STOPWORDS = new Set([
  'pro', 'plus', 'premium', 'ultra', 'basic', 'super', 'vip', 'max', 'standard',
  'plan', 'month', 'months', 'year', 'years', 'day', 'days', '1m', '3m', '6m', '12m', '24m', '1y',
  'account', 'link', 'links', 'invite', 'activation', 'activate', 'instant', 'auto', 'official',
  'private', 'shared', 'slot', 'cdk', 'redeem', 'voucher', 'code', 'subscription', 'recharge',
  'اشتراك', 'تفعيل', 'فوري', 'رسمي', 'حساب', 'باقة', 'ضمان', 'شهر', 'أشهر', 'سنة', 'مفتاح', 'كود',
  'edition', 'education', 'business', 'team', 'family', 'individual', 'student', 'teacher',
  'and', 'for', 'with', 'the', 'full', 'warranty', 'new', 'old', 'api', 'server',
]);

function extractServiceTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .split(/[^a-z0-9\u0600-\u06ff]+/)
    .filter((tok) => tok.length >= 3 && !DISTINCT_SERVICE_STOPWORDS.has(tok) && !/^\d+$/.test(tok));
}

/**
 * Strictly excludes any provider offer that is already bound to ANY store product.
 * Once a provider offer is unlinked, `linkedStoreProductId` becomes null and it immediately
 * re-enters the available pool.
 */
export function filterUnlinkedAvailableOffers<T extends ProviderOfferPoolItem>(
  allOffers: T[],
  excludeOfferIds?: Iterable<number>
): T[] {
  const excluded = excludeOfferIds ? new Set(excludeOfferIds) : null;
  return allOffers.filter((offer) => {
    if (offer.linkedStoreProductId !== null && offer.linkedStoreProductId !== undefined) {
      return false;
    }
    if (excluded && excluded.has(offer.id)) {
      return false;
    }
    return true;
  });
}

/**
 * Validates exclusive 1-to-1 binding of a provider offer to a single store product.
 */
export function validateExclusiveOfferBinding(
  existingMappings: Array<{
    id: number;
    storeProductId: number;
    providerProductId: number;
    storeProductTitle?: string;
  }>,
  targetStoreProductId: number,
  providerProductId: number
): OfferBindingCheckResult {
  const existing = existingMappings.find((m) => m.providerProductId === providerProductId);
  if (!existing) {
    return { ok: true };
  }
  if (existing.storeProductId === targetStoreProductId) {
    return {
      ok: false,
      code: 'ALREADY_LINKED_SAME_PRODUCT',
      conflictMappingId: existing.id,
      conflictStoreProductId: existing.storeProductId,
      conflictStoreProductTitle: existing.storeProductTitle || `#${existing.storeProductId}`,
    };
  }
  return {
    ok: false,
    code: 'ALREADY_LINKED_OTHER_PRODUCT',
    conflictMappingId: existing.id,
    conflictStoreProductId: existing.storeProductId,
    conflictStoreProductTitle: existing.storeProductTitle || `#${existing.storeProductId}`,
  };
}

/**
 * Computes sequential compacted priorities (`1, 2, 3...`, `#1 = primary`) after removing a mapping.
 */
export function computeRecompactedPriorities<T extends { id: number; priority: number }>(
  mappingsForProduct: T[],
  removedMappingId: number
): Array<{ id: number; priority: number; roleType: 'primary' | 'backup' }> {
  return [...mappingsForProduct]
    .filter((m) => m.id !== removedMappingId)
    .sort((a, b) => a.priority - b.priority || a.id - b.id)
    .map((m, idx) => ({
      id: m.id,
      priority: idx + 1,
      roleType: idx === 0 ? 'primary' : 'backup',
    }));
}

/**
 * Checks whether a provider offer genuinely serves the store product's service/brand.
 */
export function isOfferCompatibleWithStoreProduct(params: {
  storeProductTitle: string;
  storeProductCategoryName?: string | null;
  storeProductDescription?: string | null;
  providerOfferRawName: string;
  providerOfferDescription?: string | null;
}): { compatible: boolean; reasonAr: string } {
  const titleBrand = classifyOfferBrand(params.storeProductTitle, params.storeProductDescription || '');
  const productSeed = `${params.storeProductTitle} ${params.storeProductCategoryName || ''}`;
  const productBrand =
    titleBrand.key !== 'other'
      ? titleBrand
      : classifyOfferBrand(productSeed, params.storeProductDescription || '');
  const offerBrand = classifyOfferBrand(
    params.providerOfferRawName,
    params.providerOfferDescription || ''
  );

  // 1. Both resolve to explicit brands and they differ (e.g. ChatGPT product vs CapCut offer)
  if (productBrand.key !== 'other' && offerBrand.key !== 'other' && productBrand.key !== offerBrand.key) {
    return {
      compatible: false,
      reasonAr: `عرض المزود يتبع لخدمة (${offerBrand.labelEn}) بينما المنتج مخصص لخدمة (${productBrand.labelEn}).`,
    };
  }

  // 2. Store product has a known brand, offer failed to match that brand AND has zero shared keyword tokens
  if (productBrand.key !== 'other' && offerBrand.key === 'other') {
    const pTokens = new Set(extractServiceTokens(productSeed));
    const oTokens = extractServiceTokens(
      `${params.providerOfferRawName} ${params.providerOfferDescription || ''}`
    );
    const hasOverlap = oTokens.some((tok) => pTokens.has(tok));
    if (!hasOverlap) {
      return {
        compatible: false,
        reasonAr: `عنوان العرض «${params.providerOfferRawName}» لا يحتوي على الخدمة المطلوبة (${productBrand.labelEn}).`,
      };
    }
  }

  // 3. Offer has a known brand (e.g. Netflix) while store product is classified differently with no overlap
  if (productBrand.key === 'other' && offerBrand.key !== 'other') {
    const pTokens = new Set(extractServiceTokens(productSeed));
    const oBrandTokens = extractServiceTokens(offerBrand.labelEn);
    const mentionsOfferBrand = oBrandTokens.some((tok) => pTokens.has(tok));
    if (pTokens.size > 0 && !mentionsOfferBrand) {
      const oAllTokens = extractServiceTokens(params.providerOfferRawName);
      const anyShared = oAllTokens.some((tok) => pTokens.has(tok));
      if (!anyShared) {
        return {
          compatible: false,
          reasonAr: `هذا المزود يقدم خدمة (${offerBrand.labelEn}) ولا يتطابق مع اسم المنتج «${params.storeProductTitle}».`,
        };
      }
    }
  }

  return { compatible: true, reasonAr: 'متوافق مع المنتج' };
}

/**
 * Audits ALL product-provider mappings across the entire catalog for:
 * - Duplicate offers linked to multiple products
 * - Disabled providers
 * - Inactive provider offers
 * - Brand / service mismatches
 */
export function auditAllProductMappings(records: MappingRecordForAudit[]): MappingAuditReport {
  const countsByOfferId = new Map<number, number>();
  for (const r of records) {
    countsByOfferId.set(r.providerProductId, (countsByOfferId.get(r.providerProductId) || 0) + 1);
  }

  const issues: MappingAuditIssue[] = [];
  let duplicateOfferCount = 0;
  let disabledProviderCount = 0;
  let inactiveOfferCount = 0;
  let mismatchCount = 0;

  for (const rec of records) {
    const issueTypes: MappingIssueType[] = [];
    const reasons: string[] = [];

    if ((countsByOfferId.get(rec.providerProductId) || 0) > 1) {
      issueTypes.push('duplicate_offer_across_products');
      reasons.push('هذا العرض مكرر ومربوط بأكثر من منتج.');
      duplicateOfferCount += 1;
    }

    if (!rec.providerEnabled || rec.providerStatus === 'disabled') {
      issueTypes.push('disabled_provider');
      reasons.push(`الخادم «${rec.providerName}» معطل حاليًا.`);
      disabledProviderCount += 1;
    }

    if (!rec.isActiveAtProvider) {
      issueTypes.push('inactive_provider_offer');
      reasons.push('هذا العرض غير نشط أو تم إيقافه لدى المزود.');
      inactiveOfferCount += 1;
    }

    const compat = isOfferCompatibleWithStoreProduct({
      storeProductTitle: rec.storeProductTitle,
      storeProductCategoryName: rec.storeProductCategoryName,
      storeProductDescription: rec.storeProductDescription,
      providerOfferRawName: rec.providerOfferRawName,
      providerOfferDescription: rec.providerOfferDescription,
    });

    if (!compat.compatible) {
      issueTypes.push('service_mismatch');
      reasons.push(compat.reasonAr);
      mismatchCount += 1;
    }

    if (issueTypes.length > 0) {
      const primaryIssue = issueTypes[0];
      const severity: 'high' | 'medium' =
        issueTypes.includes('duplicate_offer_across_products') || issueTypes.includes('service_mismatch')
          ? 'high'
          : 'medium';

      issues.push({
        mappingId: rec.mappingId,
        storeProductId: rec.storeProductId,
        storeProductTitle: rec.storeProductTitle,
        storeProductVisible: Boolean(rec.storeProductVisible),
        providerProductId: rec.providerProductId,
        providerId: rec.providerId,
        providerName: rec.providerName,
        providerOfferRawName: rec.providerOfferRawName,
        wholesalePrice: rec.wholesalePrice,
        stockCount: rec.stockCount,
        priority: rec.priority,
        issueTypes,
        primaryIssue,
        reasonAr: reasons.join(' · '),
        severity,
      });
    }
  }

  // Sort high-severity and visible-product issues first for clean triage
  issues.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
    if (a.storeProductVisible !== b.storeProductVisible) return a.storeProductVisible ? -1 : 1;
    return a.storeProductId - b.storeProductId || a.priority - b.priority;
  });

  const flaggedCount = issues.length;
  return {
    summary: {
      totalMappings: records.length,
      healthyCount: Math.max(0, records.length - flaggedCount),
      flaggedCount,
      duplicateOfferCount,
      disabledProviderCount,
      inactiveOfferCount,
      mismatchCount,
    },
    issues,
  };
}
