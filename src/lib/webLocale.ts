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
    adminPortalBadge: 'لوحة التحكم المحمية',
    authTitle: 'إدارة متجرك الرقمي بأمان وصلاحيات دقيقة',
    authDesc:
      'تحكم كامل بالمنتجات والأسعار، ربط مزودي API، المحافظ المالية، نظام الإحالات، والمشرفين مع عمل متواصل 24/7 على الخادم.',
    authFeature1Title: 'صلاحيات مالك ومشرفين معزولة (RBAC)',
    authFeature1Desc: 'يحدد المالك صلاحيات كل مشرف بدقة دون كشف الإعدادات الحساسة أو السماح برفع الصلاحيات.',
    authFeature2Title: 'تشغيل دائم 24/7 وحماية الجلسات',
    authFeature2Desc: 'بوت تيليجرام، المزامنة، والمحافظ تعمل من الخادم وقاعدة البيانات بشكل مستقل عن المتصفح.',
    authFeature3Title: 'محافظ، إيداعات، وعمولات إحالة',
    authFeature3Desc: 'دفتر مالي متكامل، تحقق Binance Pay، وتتبع تلقائي لعمولات التسويق بالعمولة.',
    authCardHeading: 'تسجيل الدخول المصرح به',
    authCardSubheading: 'أدخل بيانات المالك أو المشرف المعيّن للمتابعة',
    authCardHeadingSetup: 'تأمين لوحة الإدارة (التهيئة الأولى)',
    authCardSubheadingSetup: 'أنشئ كلمة مرور قوية لحساب المالك لحماية اللوحة قبل بدء العمل',
    ownerEmailLabel: 'بريد المالك الإلكتروني',
    ownerNameLabel: 'الاسم المعروض للمالك',
    loginIdentifierLabel: 'البريد الإلكتروني أو معرّف المالك',
    passwordLabel: 'كلمة المرور',
    confirmPasswordLabel: 'تأكيد كلمة المرور',
    loginSubmit: 'تسجيل الدخول الآمن',
    setupOwnerSubmit: 'حفظ كلمة المرور وتأمين اللوحة',
    orContinueWith: 'أو عبر حساب Google المصرح به',
    loginGoogle: 'تسجيل الدخول بحساب Google',
    publicStoreNotice: 'الوصول الإداري محصور على المالك والمشرفين المعيّنين من قِبل المالك فقط.',
    switchToLogin: 'لدي كلمة مرور أو رمز ADMIN_PASSCODE بالفعل',
    switchToSetup: 'العودة إلى إعداد كلمة مرور المالك الأولى',
    signingIn: 'جارٍ التحقق والدخول...',
    storeAdminLabel: 'إدارة المتجر',
    ownerRole: 'مالك المتجر',
    roleLabels: {
      owner: 'مالك المتجر',
      admin: 'مشرف عام',
      support: 'دعم ومراجعة',
      customer: 'عميل',
    },
    logout: 'تسجيل الخروج',
    changePasswordBtn: 'تغيير كلمة المرور',
    adminBreadcrumbRoot: 'لوحة الإدارة',
    telegramBotBtn: 'بوت تيليجرام',
    navGroups: {
      overview: 'نظرة عامة',
      catalog: 'الكتالوج والقنوات',
      finance: 'المالية والنمو',
      system: 'النظام والأمان',
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
      moderators: 'المشرفون والصلاحيات',
      settings: 'الإعدادات والأمان',
    },
  },
  en: {
    brandSubtitle: 'Digital Commerce & Telegram Bot Operations Platform',
    adminPortalBadge: 'Protected Control Plane',
    authTitle: 'Operate your digital store with strict access control',
    authDesc:
      'Unified control over catalog pricing, multi-provider routing, customer wallets, referrals, and moderator RBAC running 24/7 on the server.',
    authFeature1Title: 'Owner & Granular Moderator RBAC',
    authFeature1Desc: 'Assign exact permissions per moderator without exposing sensitive settings or privilege escalation.',
    authFeature2Title: '24/7 Server Operation & Session Protection',
    authFeature2Desc: 'Telegram bot, provider sync, and ledgers run continuously on server & PostgreSQL independently.',
    authFeature3Title: 'Wallets, Deposits & Commissions',
    authFeature3Desc: 'Double-entry ledger, Binance Pay verification, and automated referral commission payouts.',
    authCardHeading: 'Authorized Sign In',
    authCardSubheading: 'Enter Owner or assigned Moderator credentials',
    authCardHeadingSetup: 'Secure Admin Console (First-Time Setup)',
    authCardSubheadingSetup: 'Create a strong Owner password to lock your dashboard immediately',
    ownerEmailLabel: 'Owner Email',
    ownerNameLabel: 'Owner Display Name',
    loginIdentifierLabel: 'Email or Owner ID',
    passwordLabel: 'Password',
    confirmPasswordLabel: 'Confirm Password',
    loginSubmit: 'Sign In Securely',
    setupOwnerSubmit: 'Set Password & Secure Console',
    orContinueWith: 'Or sign in with authorized Google account',
    loginGoogle: 'Continue with Google',
    publicStoreNotice: 'Admin access is strictly restricted to the Store Owner and Owner-assigned Moderators.',
    switchToLogin: 'I already have a password or ADMIN_PASSCODE',
    switchToSetup: 'Back to initial Owner password setup',
    signingIn: 'Verifying credentials...',
    storeAdminLabel: 'Store Console',
    ownerRole: 'Store Owner',
    roleLabels: {
      owner: 'Owner',
      admin: 'Admin',
      support: 'Support',
      customer: 'Customer',
    },
    logout: 'Sign out',
    changePasswordBtn: 'Change Password',
    adminBreadcrumbRoot: 'Admin',
    telegramBotBtn: 'Telegram Bot',
    navGroups: {
      overview: 'Overview',
      catalog: 'Catalog & Channels',
      finance: 'Finance & Growth',
      system: 'System & Access',
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
      moderators: 'Moderators & Access',
      settings: 'Settings & Security',
    },
  },
} as const;
