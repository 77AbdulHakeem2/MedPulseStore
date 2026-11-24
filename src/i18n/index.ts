import arDict from './ar.json' with { type: 'json' };
import enDict from './en.json' with { type: 'json' };

export type SupportedLang = 'ar' | 'en';
export type I18nKey = keyof typeof arDict;

const DICTIONARIES: Record<SupportedLang, Record<string, string>> = {
  ar: arDict,
  en: enDict,
};

/**
 * Translate a key with {placeholder} interpolation.
 * Strictly pulls from ar.json / en.json (zero hardcoded strings in handlers).
 */
export function t(
  lang: SupportedLang,
  key: I18nKey,
  vars?: Record<string, string | number>
): string {
  const dict = DICTIONARIES[lang] || DICTIONARIES.en;
  let template = dict[key] ?? DICTIONARIES.en[key] ?? DICTIONARIES.ar[key] ?? String(key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      template = template.replaceAll(`{${k}}`, String(v));
    }
  }
  return template;
}

/**
 * Resolves initial language for a first-time Telegram user:
 * - If Telegram User.language_code starts with 'ar' (and Arabic is enabled) -> 'ar'
 * - If 'en' or any unsupported language (and English is enabled) -> 'en'
 * - Respects store's enabled languages & fallback default.
 * NOTE: Once user explicitly selects a language (`languageManuallySelected = true`),
 * callers MUST use stored `users.language_code` and NEVER override with device language.
 */
export function resolveInitialLanguage(params: {
  telegramLanguageCode?: string | null;
  arEnabled?: boolean;
  enEnabled?: boolean;
  defaultLanguage?: SupportedLang;
}): SupportedLang {
  const arEnabled = params.arEnabled !== false;
  const enEnabled = params.enEnabled !== false;
  const raw = (params.telegramLanguageCode || '').trim().toLowerCase();

  if (raw.startsWith('ar') && arEnabled) {
    return 'ar';
  }
  if (enEnabled) {
    return 'en';
  }
  if (arEnabled) {
    return 'ar';
  }
  return params.defaultLanguage || 'ar';
}

/**
 * Resolves localized product fields with clear fallback when English translation
 * hasn't been entered by the admin yet (NEVER mutates product ID or provider mapping!).
 */
export function getLocalizedProductFields(
  product: {
    titleAr: string;
    titleEn?: string | null;
    descriptionAr?: string | null;
    descriptionEn?: string | null;
    warrantyLabelAr?: string | null;
    warrantyLabelEn?: string | null;
    deliveryInstructionsAr?: string | null;
    deliveryInstructionsEn?: string | null;
    categoryNameAr?: string | null;
    categoryNameEn?: string | null;
  },
  lang: SupportedLang
) {
  if (lang === 'en') {
    const title = (product.titleEn || '').trim() || product.titleAr;
    const description =
      (product.descriptionEn || '').trim() ||
      (product.descriptionAr?.trim()
        ? `${product.descriptionAr.trim()}`
        : 'Original digital product with instant automated delivery.');
    const warrantyLabel =
      (product.warrantyLabelEn || '').trim() || 'Instant Activation Warranty';
    const instructions =
      (product.deliveryInstructionsEn || '').trim() ||
      (product.deliveryInstructionsAr || '').trim() ||
      '';
    const categoryName =
      (product.categoryNameEn || '').trim() ||
      (product.categoryNameAr || '').trim() ||
      'Digital Products';

    return { title, description, warrantyLabel, instructions, categoryName };
  }

  return {
    title: product.titleAr,
    description: product.descriptionAr || 'منتج رقمي أصلي بتسليم فوري عبر المتجر.',
    warrantyLabel: product.warrantyLabelAr || 'ضمان التشغيل الفوري',
    instructions: product.deliveryInstructionsAr || '',
    categoryName: product.categoryNameAr || 'منتجات رقمية',
  };
}

export function getAllDictionaryKeys(): { arKeys: string[]; enKeys: string[]; missingInEn: string[]; missingInAr: string[] } {
  const arKeys = Object.keys(arDict);
  const enKeys = Object.keys(enDict);
  const enSet = new Set(enKeys);
  const arSet = new Set(arKeys);
  return {
    arKeys,
    enKeys,
    missingInEn: arKeys.filter((k) => !enSet.has(k)),
    missingInAr: enKeys.filter((k) => !arSet.has(k)),
  };
}
