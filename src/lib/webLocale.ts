export type WebLang = 'ar' | 'en';

const STORAGE_KEY = 'raqm_web_lang';

export function getStoredWebLang(): WebLang {
  if (typeof window === 'undefined') return 'ar';
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === 'en' ? 'en' : 'ar';
  } catch {
    return 'ar';
  }
}

export function saveWebLang(lang: WebLang): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ignore storage quota / privacy errors
  }
}

export function applyDocumentLang(lang: WebLang): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
}

export const WEB_COPY = {
  ar: {
    brandSubtitle: 'منصة إدارة المتاجر الرقمية وبوتات تيليجرام',
    adminPortalBadge: 'لوحة التحكم المركزية',
    authTitle: 'إدارة متجرك الرقمي بدقة تجارية',
    authDesc:
      'تحكم كامل بالمنتجات والأسعار، ربط مزودي API، المحافظ المالية، نظام الإحالات، وبوت تيليجرام من واجهة واحدة منظمة.',
    authFeature1Title: 'تسعير ومخزون متزامن',
    authFeature1Desc: 'حساب دقيق لهامش الربح ومزامنة فورية للأسعار والمخزون عبر الويب وتيليجرام.',
    authFeature2Title: 'إدارة الخوادم والتبديل التلقائي',
    authFeature2Desc: 'توجيه ذكي للطلبات عبر عدة مزودين مع حماية فورية عند نفاذ الرصيد أو التوقف.',
    authFeature3Title: 'محافظ، إيداعات، وعمولات إحالة',
    authFeature3Desc: 'دفتر مالي متكامل، تحقق Binance Pay، وتتبع تلقائي لعمولات التسويق بالعمولة.',
    authCardHeading: 'تسجيل الدخول إلى المنصة',
    authCardSubheading: 'اختر بوابة الدخول المناسبة لمتابعة العمل',
    loginOwner: 'الدخول إلى لوحة الإدارة (Owner)',
    loginGoogle: 'تسجيل الدخول بحساب Google',
    isolatedPreviewDivider: 'معاينة واجهة المشتري المعزولة',
    loginCustomer: 'الدخول بحساب عميل (واجهة المتجر)',
    signingIn: 'جارٍ تسجيل الدخول...',
    storeAdminLabel: 'إدارة المتجر',
    ownerRole: 'مالك المتجر',
    logout: 'تسجيل الخروج',
    adminBreadcrumbRoot: 'لوحة الإدارة',
    telegramBotBtn: 'بوت تيليجرام',
    navGroups: {
      overview: 'نظرة عامة',
      catalog: 'الكتالوج والقنوات',
      finance: 'المالية والنمو',
      system: 'النظام',
    },
    navItems: {
      overview: 'الرئيسية والإحصائيات',
      products: 'المنتجات والأسعار',
      providers: 'الخوادم',
      telegram: 'بوت الإدارة والعملاء',
      buttons: 'إدارة الأزرار والقوائم',
      operations: 'الطلبات والإيداعات والمحافظ',
      localFinance: 'المحافظ المحلية والريال',
      referrals: 'الإحالات والعمولات',
      settings: 'الإعدادات والأمان',
    },
  },
  en: {
    brandSubtitle: 'Digital Commerce & Telegram Bot Operations Platform',
    adminPortalBadge: 'Executive Control Plane',
    authTitle: 'Operate your digital store with precision',
    authDesc:
      'Unified control over catalog pricing, multi-provider API routing, customer wallets, referral commissions, and Telegram storefronts.',
    authFeature1Title: 'Synchronized Pricing & Stock',
    authFeature1Desc: 'Exact margin calculations synced live across your Web storefront and Telegram bot.',
    authFeature2Title: 'Multi-Provider Failover Routing',
    authFeature2Desc: 'Automatic priority routing across connected suppliers with instant fallback protection.',
    authFeature3Title: 'Wallets, Deposits & Commissions',
    authFeature3Desc: 'Double-entry ledger, Binance Pay verification, and automated referral commission payouts.',
    authCardHeading: 'Sign in to workspace',
    authCardSubheading: 'Select an access mode to continue',
    loginOwner: 'Enter Admin Console (Owner)',
    loginGoogle: 'Continue with Google',
    isolatedPreviewDivider: 'Isolated Customer Preview',
    loginCustomer: 'Sign in as Customer (Storefront)',
    signingIn: 'Signing in...',
    storeAdminLabel: 'Store Console',
    ownerRole: 'Store Owner',
    logout: 'Sign out',
    adminBreadcrumbRoot: 'Admin',
    telegramBotBtn: 'Telegram Bot',
    navGroups: {
      overview: 'Overview',
      catalog: 'Catalog & Channels',
      finance: 'Finance & Growth',
      system: 'System',
    },
    navItems: {
      overview: 'Overview & Analytics',
      products: 'Products & Pricing',
      providers: 'Providers',
      telegram: 'Admin & Buyer Bot',
      buttons: 'Buttons & Menus',
      operations: 'Orders, Deposits & Wallets',
      localFinance: 'Local Wallets & YER',
      referrals: 'Referrals & Commissions',
      settings: 'Settings & Security',
    },
  },
} as const;
