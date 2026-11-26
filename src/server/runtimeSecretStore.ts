export type SensitiveVaultSecretKey =
  | 'sessionSigningSecret'
  | 'adminPasscode'
  | 'telegramWebhookSecret'
  | 'binancePayApiKey'
  | 'binancePaySecretKey'
  | 'trongridApiKey'
  | 'bscscanApiKey';

export type ConfigVaultKey =
  | 'ownerEmail'
  | 'appUrl'
  | 'usdtReceiverWalletTrc20'
  | 'usdtReceiverWalletBep20'
  | 'usdtTrc20Contract'
  | 'usdtBep20Contract';

export type VaultKey = SensitiveVaultSecretKey | ConfigVaultKey;

export interface VaultKeyDefinition {
  key: VaultKey;
  envVar: string;
  labelAr: string;
  descriptionAr: string;
  group: 'security' | 'webhooks' | 'blockchain';
  isSensitive: boolean;
  canGenerate?: boolean;
  minLength?: number;
}

export const ENV_ONLY_RUNTIME_SECRETS = [
  {
    envVar: 'TELEGRAM_BOT_TOKEN',
    labelAr: 'توكن بوت تيليجرام (Bot Token)',
    descriptionAr: 'مقفل عبر أسرار بيئة التشغيل فقط — لا يُدخل أو يُحفظ من داخل المعاينة.',
  },
  {
    envVar: 'TELEGRAM_OWNER_IDS',
    labelAr: 'معرّف المالك في تيليجرام (Owner ID)',
    descriptionAr: 'مقفل عبر أسرار بيئة التشغيل فقط (TELEGRAM_OWNER_IDS / ADMIN_TELEGRAM_IDS).',
  },
] as const;

export const VAULT_KEY_DEFINITIONS: readonly VaultKeyDefinition[] = [
  {
    key: 'sessionSigningSecret',
    envVar: 'SESSION_SIGNING_SECRET',
    labelAr: 'مفتاح توقيع الجلسات (Session Signing Secret)',
    descriptionAr: 'يُحافظ على بقاء جلسات المالك والمشرفين نشطة بعد إعادة تشغيل الخادم.',
    group: 'security',
    isSensitive: true,
    canGenerate: true,
    minLength: 16,
  },
  {
    key: 'adminPasscode',
    envVar: 'ADMIN_PASSCODE',
    labelAr: 'رمز الدخول السريع للمالك (Admin Passcode)',
    descriptionAr: 'رمز دخول احتياطي للمالك في لوحة التحكم (8 أحرف على الأقل).',
    group: 'security',
    isSensitive: true,
    minLength: 8,
  },
  {
    key: 'ownerEmail',
    envVar: 'OWNER_EMAIL',
    labelAr: 'بريد المالك لحساب Google (Owner Email)',
    descriptionAr: 'البريد الذي يُمنح صلاحية المالك تلقائيًا عند تسجيل الدخول بـ Google.',
    group: 'security',
    isSensitive: false,
  },
  {
    key: 'appUrl',
    envVar: 'APP_URL',
    labelAr: 'رابط المتجر العام (App URL)',
    descriptionAr: 'الرابط الأساسي للتطبيق المستضاف لروابط Webhooks والربط الخارجي.',
    group: 'security',
    isSensitive: false,
  },
  {
    key: 'telegramWebhookSecret',
    envVar: 'TELEGRAM_WEBHOOK_SECRET',
    labelAr: 'سر التحقق من Webhook تيليجرام',
    descriptionAr: 'يُستخدم للتحقق من ترويسة X-Telegram-Bot-Api-Secret-Token الواردة.',
    group: 'webhooks',
    isSensitive: true,
    canGenerate: true,
    minLength: 8,
  },
  {
    key: 'binancePayApiKey',
    envVar: 'BINANCE_PAY_API_KEY',
    labelAr: 'مفتاح Binance Pay Merchant API',
    descriptionAr: 'مفتاح بوابة التجار لـ Binance Pay إن كانت مفعلة على حسابك.',
    group: 'webhooks',
    isSensitive: true,
    minLength: 8,
  },
  {
    key: 'binancePaySecretKey',
    envVar: 'BINANCE_PAY_SECRET_KEY',
    labelAr: 'السر التوقيعي لـ Binance Pay Webhook',
    descriptionAr: 'يُستخدم للتحقق من توقيع إشعارات الدفع الواردة عبر /api/webhooks/binance-pay.',
    group: 'webhooks',
    isSensitive: true,
    minLength: 8,
  },
  {
    key: 'trongridApiKey',
    envVar: 'TRONGRID_API_KEY',
    labelAr: 'مفتاح TronGrid API (شبكة TRC20)',
    descriptionAr: 'يرفع حدود الاستعلام ويُحسّن موثوقية التحقق الآلي من إيداعات USDT TRC20.',
    group: 'blockchain',
    isSensitive: true,
    minLength: 8,
  },
  {
    key: 'bscscanApiKey',
    envVar: 'BSCSCAN_API_KEY',
    labelAr: 'مفتاح BscScan API (شبكة BEP20)',
    descriptionAr: 'مفتاح مستكشف BNB Smart Chain للتحقق من معاملات USDT BEP20.',
    group: 'blockchain',
    isSensitive: true,
    minLength: 8,
  },
  {
    key: 'usdtReceiverWalletTrc20',
    envVar: 'USDT_RECEIVER_WALLET_TRC20',
    labelAr: 'عنوان محفظة استقبال USDT (TRC20)',
    descriptionAr: 'العنوان المعتمد لاستقبال إيداعات TRC20 والتحقق من مطابقة المستلم.',
    group: 'blockchain',
    isSensitive: false,
  },
  {
    key: 'usdtReceiverWalletBep20',
    envVar: 'USDT_RECEIVER_WALLET_BEP20',
    labelAr: 'عنوان محفظة استقبال USDT (BEP20)',
    descriptionAr: 'العنوان المعتمد لاستقبال إيداعات BEP20 والتحقق من مطابقة المستلم.',
    group: 'blockchain',
    isSensitive: false,
  },
  {
    key: 'usdtTrc20Contract',
    envVar: 'USDT_TRC20_CONTRACT',
    labelAr: 'عنوان عقد USDT TRC20 الرسمي',
    descriptionAr: 'الافتراضي المعتمد: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    group: 'blockchain',
    isSensitive: false,
  },
  {
    key: 'usdtBep20Contract',
    envVar: 'USDT_BEP20_CONTRACT',
    labelAr: 'عنوان عقد USDT BEP20 الرسمي',
    descriptionAr: 'الافتراضي المعتمد: 0x55d398326f99059fF775485246999027B3197955',
    group: 'blockchain',
    isSensitive: false,
  },
] as const;

const VAULT_DEF_BY_KEY = new Map<string, VaultKeyDefinition>(
  VAULT_KEY_DEFINITIONS.map((d) => [d.key, d])
);

const ENV_ONLY_NAMES = new Set<string>([
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_OWNER_IDS',
  'ADMIN_TELEGRAM_IDS',
  'botToken',
  'ownerTelegramIds',
  'telegramBotToken',
  'telegramOwnerIds',
]);

const runtimeVaultValues = new Map<VaultKey, string>();

export function isEnvOnlySecretName(name: string): boolean {
  const trimmed = (name || '').trim();
  return ENV_ONLY_NAMES.has(trimmed) || ENV_ONLY_NAMES.has(trimmed.toUpperCase());
}

export function getVaultKeyDefinition(key: string): VaultKeyDefinition | undefined {
  return VAULT_DEF_BY_KEY.get(key);
}

export function getRuntimeVaultValue(key: VaultKey): string {
  return (runtimeVaultValues.get(key) || '').trim();
}

export function setRuntimeVaultValue(key: VaultKey, value: string): void {
  const trimmed = (value || '').trim();
  if (!trimmed) {
    runtimeVaultValues.delete(key);
    return;
  }
  runtimeVaultValues.set(key, trimmed);
}

export function clearRuntimeVaultValue(key: VaultKey): void {
  runtimeVaultValues.delete(key);
}

export function clearAllRuntimeVaultValues(): void {
  runtimeVaultValues.clear();
}

export function resolveVaultOrEnv(key: VaultKey, envVarName: string): {
  value: string;
  source: 'preview_vault' | 'env' | 'none';
} {
  const vaultVal = getRuntimeVaultValue(key);
  if (vaultVal) {
    return { value: vaultVal, source: 'preview_vault' };
  }
  const envVal = (process.env[envVarName] || '').trim();
  if (envVal) {
    return { value: envVal, source: 'env' };
  }
  return { value: '', source: 'none' };
}
