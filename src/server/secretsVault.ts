import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { auditLogs, binancePaySettings, providerCredentials, settings } from '../db/schema.ts';
import { decryptSecret, encryptSecret, maskApiKey } from './crypto.ts';
import {
  clearAllRuntimeVaultValues,
  clearRuntimeVaultValue,
  getVaultKeyDefinition,
  isEnvOnlySecretName,
  resolveVaultOrEnv,
  setRuntimeVaultValue,
  VAULT_KEY_DEFINITIONS,
  type ConfigVaultKey,
  type SensitiveVaultSecretKey,
  type VaultKey,
} from './runtimeSecretStore.ts';

const VAULT_SETTINGS_KEY = 'app_secrets_vault';

interface StoredEncryptedSecretEntry {
  encryptedValue: string;
  fingerprint: string;
  updatedAt: string;
  updatedByUserId?: number | null;
}

interface StoredVaultPayload {
  secrets?: Partial<Record<SensitiveVaultSecretKey, StoredEncryptedSecretEntry>>;
  config?: Partial<Record<ConfigVaultKey, string>>;
  updatedAt?: string;
}

export interface VaultEntryView {
  key: VaultKey;
  envVar: string;
  labelAr: string;
  descriptionAr: string;
  group: 'security' | 'webhooks' | 'blockchain';
  isSensitive: boolean;
  canGenerate: boolean;
  hasValue: boolean;
  source: 'preview_vault' | 'env' | 'none';
  fingerprint: string | null;
  value: string | null; // Strictly null for sensitive keys; plaintext only for non-sensitive config fields
  updatedAt: string | null;
}

export interface SecretsVaultSummary {
  envOnlySecrets: Array<{
    envVar: string;
    labelAr: string;
    descriptionAr: string;
    configured: boolean;
    fingerprint: string | null;
    maskedSummary: string | null;
  }>;
  entries: VaultEntryView[];
  linkedIntegrations: {
    providerKeysCount: number;
    binanceHistoryConfigured: boolean;
    binanceReceiverId: string | null;
  };
}

let vaultHydrated = false;

async function readVaultDoc(): Promise<StoredVaultPayload> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, VAULT_SETTINGS_KEY))
    .limit(1);
  const raw = (row?.valueJson as StoredVaultPayload) || {};
  return {
    secrets: raw.secrets && typeof raw.secrets === 'object' ? raw.secrets : {},
    config: raw.config && typeof raw.config === 'object' ? raw.config : {},
    updatedAt: raw.updatedAt,
  };
}

async function writeVaultDoc(doc: StoredVaultPayload): Promise<void> {
  await db
    .insert(settings)
    .values({ key: VAULT_SETTINGS_KEY, valueJson: doc })
    .onConflictDoUpdate({
      target: settings.key,
      set: { valueJson: doc, updatedAt: new Date() },
    });
}

function applyVaultDocToRuntimeCache(doc: StoredVaultPayload): void {
  clearAllRuntimeVaultValues();

  if (doc.secrets) {
    for (const def of VAULT_KEY_DEFINITIONS) {
      if (!def.isSensitive) continue;
      const entry = doc.secrets[def.key as SensitiveVaultSecretKey];
      if (!entry?.encryptedValue) continue;
      try {
        const plain = decryptSecret(entry.encryptedValue).trim();
        if (plain) {
          setRuntimeVaultValue(def.key, plain);
        }
      } catch {
        // Ignore undecryptable legacy entry safely
      }
    }
  }

  if (doc.config) {
    for (const def of VAULT_KEY_DEFINITIONS) {
      if (def.isSensitive) continue;
      const val = String(doc.config[def.key as ConfigVaultKey] || '').trim();
      if (val) {
        setRuntimeVaultValue(def.key, val);
      }
    }
  }
}

export async function hydrateSecretsVault(force = false): Promise<void> {
  if (vaultHydrated && !force) return;
  const doc = await readVaultDoc();
  applyVaultDocToRuntimeCache(doc);
  vaultHydrated = true;
}

export async function getSecretsVaultSummary(): Promise<SecretsVaultSummary> {
  await hydrateSecretsVault();
  const [doc, providerCredRows, binanceRows] = await Promise.all([
    readVaultDoc(),
    db.select({ id: providerCredentials.id }).from(providerCredentials),
    db
      .select({
        binanceReceiverId: binancePaySettings.binanceReceiverId,
        encryptedApiKey: binancePaySettings.encryptedApiKey,
        encryptedApiSecret: binancePaySettings.encryptedApiSecret,
      })
      .from(binancePaySettings)
      .limit(1),
  ]);

  const botToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const ownerIds = [process.env.TELEGRAM_OWNER_IDS || '', process.env.ADMIN_TELEGRAM_IDS || '']
    .join(',')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const envOnlySecrets = [
    {
      envVar: 'TELEGRAM_BOT_TOKEN',
      labelAr: 'توكن بوت تيليجرام (Bot Token)',
      descriptionAr: 'يُقرأ حصريًا من أسرار بيئة التشغيل (TELEGRAM_BOT_TOKEN) ولا يُدخل من صفحة المعاينة.',
      configured: Boolean(botToken),
      fingerprint: botToken ? maskApiKey(botToken) : null,
      maskedSummary: botToken ? maskApiKey(botToken) : null,
    },
    {
      envVar: 'TELEGRAM_OWNER_IDS',
      labelAr: 'معرّف المالك في تيليجرام (Owner ID)',
      descriptionAr: 'يُقرأ حصريًا من أسرار بيئة التشغيل (TELEGRAM_OWNER_IDS) لتعيين المالك بأمان.',
      configured: ownerIds.length > 0,
      fingerprint: ownerIds.length > 0 ? ownerIds.join(', ') : null,
      maskedSummary: ownerIds.length > 0 ? ownerIds.join(', ') : null,
    },
  ];

  const entries: VaultEntryView[] = VAULT_KEY_DEFINITIONS.map((def) => {
    const resolved = resolveVaultOrEnv(def.key, def.envVar);
    const storedSecret = def.isSensitive ? doc.secrets?.[def.key as SensitiveVaultSecretKey] : undefined;
    const fingerprint = def.isSensitive
      ? resolved.source === 'preview_vault'
        ? storedSecret?.fingerprint || (resolved.value ? maskApiKey(resolved.value) : null)
        : resolved.value
          ? maskApiKey(resolved.value)
          : null
      : null;

    return {
      key: def.key,
      envVar: def.envVar,
      labelAr: def.labelAr,
      descriptionAr: def.descriptionAr,
      group: def.group,
      isSensitive: def.isSensitive,
      canGenerate: Boolean(def.canGenerate),
      hasValue: Boolean(resolved.value),
      source: resolved.source,
      fingerprint,
      // Never return decrypted secrets to client; only expose non-sensitive config strings
      value: def.isSensitive ? null : resolved.value || null,
      updatedAt: storedSecret?.updatedAt || doc.updatedAt || null,
    };
  });

  const bn = binanceRows[0];

  return {
    envOnlySecrets,
    entries,
    linkedIntegrations: {
      providerKeysCount: providerCredRows.length,
      binanceHistoryConfigured: Boolean(
        (bn?.encryptedApiKey && bn?.encryptedApiSecret) ||
          (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET)
      ),
      binanceReceiverId: bn?.binanceReceiverId || (process.env.BINANCE_RECEIVER_ID || '').trim() || null,
    },
  };
}

function validateVaultEntryValue(key: VaultKey, rawValue: string): { ok: true; clean: string } | { ok: false; errorAr: string } {
  const def = getVaultKeyDefinition(key);
  if (!def) {
    return { ok: false, errorAr: `المفتاح "${key}" غير مدعوم في خزينة الأسرار.` };
  }
  const clean = rawValue.trim();
  if (!clean) {
    return { ok: false, errorAr: `القيمة المدخلة لحقل "${def.labelAr}" فارغة.` };
  }

  if (def.minLength && clean.length < def.minLength) {
    return {
      ok: false,
      errorAr: `يجب أن لا يقل طول "${def.labelAr}" عن ${def.minLength} أحرف/رموز.`,
    };
  }

  if (key === 'ownerEmail' && (!clean.includes('@') || clean.length > 160)) {
    return { ok: false, errorAr: 'يرجى إدخال بريد إلكتروني صحيح للمالك.' };
  }

  if (key === 'appUrl') {
    try {
      const parsed = new URL(clean);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, errorAr: 'يجب أن يبدأ رابط التطبيق بـ https:// أو http://.' };
      }
      return { ok: true, clean: clean.replace(/\/+$/, '') };
    } catch {
      return { ok: false, errorAr: 'صيغة رابط التطبيق (APP_URL) غير صالحة.' };
    }
  }

  return { ok: true, clean };
}

export async function updateSecretsVault(params: {
  updates: Record<string, unknown>;
  actorUserId: number;
  actorRole: string;
}): Promise<{ summary: SecretsVaultSummary; updatedKeys: VaultKey[]; sessionSecretChanged: boolean }> {
  const entries = Object.entries(params.updates || {});
  if (entries.length === 0) {
    throw new Error('لم يتم إرسال أي مفاتيح أو إعدادات للتحديث.');
  }

  for (const [k] of entries) {
    if (isEnvOnlySecretName(k)) {
      throw new Error(
        'توكن البوت (TELEGRAM_BOT_TOKEN) ومعرّف المالك (TELEGRAM_OWNER_IDS) مضبوطان حصريًا عبر أسرار بيئة التشغيل ولا يمكن تعديلهما من المعاينة.'
      );
    }
    if (!getVaultKeyDefinition(k)) {
      throw new Error(`المفتاح "${k}" غير مصرح بتخزينه في خزينة الأسرار.`);
    }
  }

  const doc = await readVaultDoc();
  const nextSecrets: Partial<Record<SensitiveVaultSecretKey, StoredEncryptedSecretEntry>> = {
    ...(doc.secrets || {}),
  };
  const nextConfig: Partial<Record<ConfigVaultKey, string>> = {
    ...(doc.config || {}),
  };

  const updatedKeys: VaultKey[] = [];
  let sessionSecretChanged = false;
  const nowIso = new Date().toISOString();

  for (const [rawKey, rawVal] of entries) {
    if (typeof rawVal !== 'string') continue;
    const def = getVaultKeyDefinition(rawKey)!;
    const trimmed = rawVal.trim();
    if (!trimmed) continue;

    const validated = validateVaultEntryValue(def.key, trimmed);
    if (!validated.ok) {
      throw new Error(validated.errorAr);
    }

    if (def.isSensitive) {
      nextSecrets[def.key as SensitiveVaultSecretKey] = {
        encryptedValue: encryptSecret(validated.clean),
        fingerprint: maskApiKey(validated.clean),
        updatedAt: nowIso,
        updatedByUserId: params.actorUserId,
      };
    } else {
      nextConfig[def.key as ConfigVaultKey] = validated.clean;
    }

    setRuntimeVaultValue(def.key, validated.clean);
    updatedKeys.push(def.key);
    if (def.key === 'sessionSigningSecret') {
      sessionSecretChanged = true;
    }
  }

  if (updatedKeys.length === 0) {
    throw new Error('أدخل قيمة جديدة واحدة على الأقل لحفظها في الخزينة.');
  }

  const nextDoc: StoredVaultPayload = {
    secrets: nextSecrets,
    config: nextConfig,
    updatedAt: nowIso,
  };
  await writeVaultDoc(nextDoc);
  vaultHydrated = true;

  await db.insert(auditLogs).values({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    action: 'SECRETS_VAULT_UPDATED',
    entityType: 'settings',
    entityId: VAULT_SETTINGS_KEY,
    detailsJson: { updatedKeys },
  });

  const summary = await getSecretsVaultSummary();
  return { summary, updatedKeys, sessionSecretChanged };
}

export async function generateVaultSecret(params: {
  key: 'sessionSigningSecret' | 'telegramWebhookSecret';
  actorUserId: number;
  actorRole: string;
}): Promise<{ summary: SecretsVaultSummary; fingerprint: string; sessionSecretChanged: boolean }> {
  if (params.key !== 'sessionSigningSecret' && params.key !== 'telegramWebhookSecret') {
    throw new Error('التوليد التلقائي متاح لمفتاح توقيع الجلسات وسر Webhook تيليجرام فقط.');
  }
  const generated = crypto.randomBytes(32).toString('hex');
  const res = await updateSecretsVault({
    updates: { [params.key]: generated },
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
  });
  return {
    summary: res.summary,
    fingerprint: maskApiKey(generated),
    sessionSecretChanged: res.sessionSecretChanged,
  };
}

export async function deleteVaultSecret(params: {
  key: string;
  actorUserId: number;
  actorRole: string;
}): Promise<{ summary: SecretsVaultSummary; sessionSecretChanged: boolean }> {
  if (isEnvOnlySecretName(params.key)) {
    throw new Error('لا يمكن حذف أسرار بيئة التشغيل من المعاينة.');
  }
  const def = getVaultKeyDefinition(params.key);
  if (!def) {
    throw new Error(`المفتاح "${params.key}" غير موجود.`);
  }

  const doc = await readVaultDoc();
  const nextSecrets = { ...(doc.secrets || {}) };
  const nextConfig = { ...(doc.config || {}) };

  if (def.isSensitive) {
    delete nextSecrets[def.key as SensitiveVaultSecretKey];
  } else {
    delete nextConfig[def.key as ConfigVaultKey];
  }
  clearRuntimeVaultValue(def.key);

  const nowIso = new Date().toISOString();
  await writeVaultDoc({
    secrets: nextSecrets,
    config: nextConfig,
    updatedAt: nowIso,
  });
  vaultHydrated = true;

  await db.insert(auditLogs).values({
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    action: 'SECRETS_VAULT_DELETED',
    entityType: 'settings',
    entityId: def.key,
    detailsJson: { deletedKey: def.key },
  });

  const summary = await getSecretsVaultSummary();
  return {
    summary,
    sessionSecretChanged: def.key === 'sessionSigningSecret',
  };
}
