import React, { useEffect, useState } from 'react';
import {
  KeyRound,
  Lock,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Eye,
  EyeOff,
  Server,
  Webhook,
  Coins,
} from 'lucide-react';
import { apiFetch, setAuthToken } from '../lib/api';
import {
  FeedbackBanner,
  KpiCard,
  SectionHeader,
  SemanticStatus,
  SurfacePanel,
} from './ui/AdminPrimitives';

interface EnvOnlySecretItem {
  envVar: string;
  labelAr: string;
  descriptionAr: string;
  configured: boolean;
  fingerprint: string | null;
  maskedSummary: string | null;
}

interface VaultEntryItem {
  key: string;
  envVar: string;
  labelAr: string;
  descriptionAr: string;
  group: 'security' | 'webhooks' | 'blockchain';
  isSensitive: boolean;
  canGenerate: boolean;
  hasValue: boolean;
  source: 'preview_vault' | 'env' | 'none';
  fingerprint: string | null;
  value: string | null;
  updatedAt: string | null;
}

interface SecretsVaultSummary {
  envOnlySecrets: EnvOnlySecretItem[];
  entries: VaultEntryItem[];
  linkedIntegrations: {
    providerKeysCount: number;
    binanceHistoryConfigured: boolean;
    binanceReceiverId: string | null;
  };
}

interface SecretsVaultPanelProps {
  onRefreshWorkspace?: () => Promise<void>;
}

const GROUP_META: Record<
  'security' | 'webhooks' | 'blockchain',
  { title: string; subtitle: string; icon: React.ComponentType<{ className?: string }> }
> = {
  security: {
    title: 'أسرار الأمان والجلسات والمالك',
    subtitle: 'تُحفظ مشفرة بـ AES-256-GCM في قاعدة البيانات وتعمل فورًا دون تعديل ملفات البيئة',
    icon: ShieldCheck,
  },
  webhooks: {
    title: 'أسرار Webhooks وبوابات الدفع',
    subtitle: 'أسرار التحقق من إشعارات تيليجرام وبوابة Binance Pay Merchant',
    icon: Webhook,
  },
  blockchain: {
    title: 'مفاتيح الشبكات وعناوين USDT',
    subtitle: 'مفاتيح مستكشفات TronGrid وBscScan ومحافظ وعقود الاستقبال',
    icon: Coins,
  },
};

export default function SecretsVaultPanel({ onRefreshWorkspace }: SecretsVaultPanelProps) {
  const [vault, setVault] = useState<SecretsVaultSummary | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const loadVault = async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ vault: SecretsVaultSummary }>('/api/admin/secrets-vault');
      setVault(res.vault);
      const nextDrafts: Record<string, string> = {};
      for (const entry of res.vault.entries) {
        if (!entry.isSensitive && entry.value) {
          nextDrafts[entry.key] = entry.value;
        }
      }
      setDrafts(nextDrafts);
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تحميل خزينة الأسرار.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadVault();
  }, []);

  const syncDraftsFromVault = (nextVault: SecretsVaultSummary) => {
    setVault(nextVault);
    const nextDrafts: Record<string, string> = {};
    for (const entry of nextVault.entries) {
      if (!entry.isSensitive && entry.value) {
        nextDrafts[entry.key] = entry.value;
      }
    }
    setDrafts(nextDrafts);
    setRevealed({});
  };

  const handleSaveVault = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!vault) return;

    const updates: Record<string, string> = {};
    for (const entry of vault.entries) {
      const raw = (drafts[entry.key] || '').trim();
      if (!raw) continue;
      if (!entry.isSensitive && raw === (entry.value || '')) continue;
      updates[entry.key] = raw;
    }

    if (Object.keys(updates).length === 0) {
      setFeedback({ type: 'err', text: 'أدخل أو عدّل قيمة واحدة على الأقل قبل الحفظ.' });
      return;
    }

    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{
        ok: boolean;
        vault: SecretsVaultSummary;
        updatedKeys: string[];
        refreshedToken?: string;
      }>('/api/admin/secrets-vault', {
        method: 'PATCH',
        body: JSON.stringify({ updates }),
      });

      if (res.refreshedToken) {
        setAuthToken(res.refreshedToken);
      }
      syncDraftsFromVault(res.vault);
      setFeedback({
        type: 'ok',
        text: `تم تشفير وحفظ ${res.updatedKeys.length} إعداد/مفتاح بنجاح وتفعيله مباشرة على الخادم.`,
      });
      if (onRefreshWorkspace) await onRefreshWorkspace();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر حفظ مفاتيح خزينة الأسرار.' });
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateKey = async (key: 'sessionSigningSecret' | 'telegramWebhookSecret') => {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{
        ok: boolean;
        vault: SecretsVaultSummary;
        fingerprint: string;
        refreshedToken?: string;
      }>('/api/admin/secrets-vault/generate', {
        method: 'POST',
        body: JSON.stringify({ key }),
      });

      if (res.refreshedToken) {
        setAuthToken(res.refreshedToken);
      }
      syncDraftsFromVault(res.vault);
      setFeedback({
        type: 'ok',
        text: `تم توليد وحفظ مفتاح آمن عشوائيًا (${res.fingerprint}) بنجاح.`,
      });
      if (onRefreshWorkspace) await onRefreshWorkspace();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر توليد المفتاح العشوائي.' });
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteEntry = async (key: string, labelAr: string) => {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{
        ok: boolean;
        vault: SecretsVaultSummary;
        refreshedToken?: string;
      }>(`/api/admin/secrets-vault/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      });
      if (res.refreshedToken) {
        setAuthToken(res.refreshedToken);
      }
      syncDraftsFromVault(res.vault);
      setFeedback({ type: 'ok', text: `تم مسح «${labelAr}» من خزينة المعاينة.` });
      if (onRefreshWorkspace) await onRefreshWorkspace();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر حذف المفتاح.' });
    } finally {
      setBusy(false);
    }
  };

  if (loading && !vault) {
    return (
      <SurfacePanel className="p-8 text-center text-xs text-slate-500">
        جارٍ تحميل خزينة الأسرار والمفاتيح المشفرة...
      </SurfacePanel>
    );
  }

  const configuredVaultCount = vault ? vault.entries.filter((e) => e.hasValue).length : 0;
  const totalVaultEntries = vault ? vault.entries.length : 0;

  return (
    <div className="space-y-6">
      {feedback && (
        <FeedbackBanner
          type={feedback.type}
          text={feedback.text}
          onDismiss={() => setFeedback(null)}
        />
      )}

      {/* Summary KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          label="أسرار خزينة المعاينة"
          value={`${configuredVaultCount}/${totalVaultEntries}`}
          tone={configuredVaultCount > 0 ? 'positive' : 'neutral'}
          indicatorText="مشفّرة بـ AES-256-GCM"
          meta={<span>تُدار وتُحفظ مباشرة من داخل صفحة المعاينة</span>}
        />
        <KpiCard
          label="أسرار بيئة التشغيل المقفولة"
          value={`${vault?.envOnlySecrets.filter((s) => s.configured).length || 0}/2`}
          tone={vault?.envOnlySecrets.every((s) => s.configured) ? 'positive' : 'warning'}
          indicatorText="TELEGRAM_BOT_TOKEN & OWNER_ID"
          meta={<span>مقصورة على أسرار بيئة التشغيل فقط</span>}
        />
        <KpiCard
          label="مفاتيح الخوادم والدفع المرتبطة"
          value={vault?.linkedIntegrations.providerKeysCount ?? 0}
          tone="neutral"
          indicatorText={
            vault?.linkedIntegrations.binanceHistoryConfigured
              ? 'Binance History مفعّل'
              : 'Binance History غير مضبوط'
          }
          meta={<span>تُدار من تبويبي الخوادم وBinance ID</span>}
        />
      </div>

      {/* Locked Runtime-Environment-Only Secrets */}
      <SurfacePanel className="overflow-hidden border-amber-200/80">
        <SectionHeader
          title="أسرار مقصورة على بيئة التشغيل فقط (مقفولة عن المعاينة)"
          subtitle="وفق إعداداتك الأمنية، يُضبط توكن البوت ومعرّف المالك فقط من أسرار بيئة التشغيل ولا يمكن إدخالهما من الواجهة"
          icon={Lock}
          action={
            <button
              type="button"
              onClick={() => void loadVault()}
              disabled={loading || busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              تحديث الحالة
            </button>
          }
        />
        <div className="p-5 grid grid-cols-1 gap-4 md:grid-cols-2">
          {(vault?.envOnlySecrets || []).map((item) => (
            <div
              key={item.envVar}
              data-testid={`env-only-secret-${item.envVar}`}
              className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-900 inline-flex items-center gap-1.5">
                  <Server className="h-3.5 w-3.5 text-slate-500" />
                  {item.labelAr}
                </span>
                <SemanticStatus
                  tone={item.configured ? 'positive' : 'warning'}
                  label={item.configured ? 'مضبوط في البيئة' : 'غير مضبوط'}
                />
              </div>
              <div className="text-[11px] text-slate-500">{item.descriptionAr}</div>
              <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs">
                <code className="font-mono-num text-[11px] font-semibold text-slate-700">
                  {item.envVar}
                </code>
                <span className="font-mono-num text-xs font-semibold text-slate-900" dir="ltr">
                  {item.maskedSummary || '—'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </SurfacePanel>

      {/* Editable Preview Secrets Vault Form */}
      <form onSubmit={handleSaveVault} className="space-y-6">
        {(['security', 'webhooks', 'blockchain'] as const).map((groupKey) => {
          const meta = GROUP_META[groupKey];
          const IconComp = meta.icon;
          const groupEntries = (vault?.entries || []).filter((e) => e.group === groupKey);

          return (
            <SurfacePanel key={groupKey} className="overflow-hidden">
              <SectionHeader title={meta.title} subtitle={meta.subtitle} icon={IconComp} />
              <div className="p-5 grid grid-cols-1 gap-4 md:grid-cols-2">
                {groupEntries.map((entry) => {
                  const isRevealed = Boolean(revealed[entry.key]);
                  const draftVal = drafts[entry.key] || '';
                  const sourceBadge =
                    entry.source === 'preview_vault'
                      ? { tone: 'positive' as const, label: 'محفوظ بالمعاينة' }
                      : entry.source === 'env'
                        ? { tone: 'neutral' as const, label: 'من البيئة' }
                        : { tone: 'warning' as const, label: 'غير مضبوط' };

                  return (
                    <div
                      key={entry.key}
                      data-testid={`vault-entry-${entry.key}`}
                      className="rounded-xl border border-slate-200/90 bg-slate-50/40 p-4 space-y-2.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label
                          htmlFor={`vault-input-${entry.key}`}
                          className="text-xs font-bold text-slate-900"
                        >
                          {entry.labelAr}
                        </label>
                        <SemanticStatus tone={sourceBadge.tone} label={sourceBadge.label} />
                      </div>

                      <div className="text-[11px] text-slate-500 leading-relaxed">
                        {entry.descriptionAr}
                      </div>

                      <div className="flex items-center gap-1.5">
                        <div className="relative flex-1">
                          <input
                            id={`vault-input-${entry.key}`}
                            data-testid={`vault-input-${entry.key}`}
                            type={entry.isSensitive && !isRevealed ? 'password' : 'text'}
                            dir="ltr"
                            autoComplete="new-password"
                            value={draftVal}
                            onChange={(e) =>
                              setDrafts((prev) => ({ ...prev, [entry.key]: e.target.value }))
                            }
                            placeholder={
                              entry.isSensitive
                                ? entry.fingerprint
                                  ? `محفوظ (${entry.fingerprint}) — أدخل قيمة جديدة للتحديث`
                                  : `أدخل ${entry.envVar}`
                                : `أدخل ${entry.envVar}`
                            }
                            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-mono-num placeholder:font-sans focus:border-emerald-600 focus:outline-none"
                          />
                        </div>

                        {entry.isSensitive && (
                          <button
                            type="button"
                            onClick={() =>
                              setRevealed((prev) => ({ ...prev, [entry.key]: !prev[entry.key] }))
                            }
                            title={isRevealed ? 'إخفاء' : 'إظهار أثناء الكتابة'}
                            className="rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                          >
                            {isRevealed ? (
                              <EyeOff className="h-3.5 w-3.5" />
                            ) : (
                              <Eye className="h-3.5 w-3.5" />
                            )}
                          </button>
                        )}

                        {entry.canGenerate && (
                          <button
                            type="button"
                            disabled={busy}
                            data-testid={`vault-generate-${entry.key}`}
                            onClick={() =>
                              void handleGenerateKey(
                                entry.key as 'sessionSigningSecret' | 'telegramWebhookSecret'
                              )
                            }
                            title="توليد مفتاح عشوائي قوي وحفظه فورًا"
                            className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 whitespace-nowrap"
                          >
                            <Sparkles className="h-3 w-3" />
                            توليد
                          </button>
                        )}

                        {entry.source === 'preview_vault' && (
                          <button
                            type="button"
                            disabled={busy}
                            data-testid={`vault-delete-${entry.key}`}
                            onClick={() => void handleDeleteEntry(entry.key, entry.labelAr)}
                            title="مسح القيمة المحفوظة"
                            className="rounded-lg border border-rose-200 bg-white p-2 text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>

                      <div className="flex items-center justify-between text-[10px] text-slate-400">
                        <code className="font-mono-num">{entry.envVar}</code>
                        {entry.fingerprint && (
                          <span className="font-mono-num" dir="ltr">
                            {entry.fingerprint}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </SurfacePanel>
          );
        })}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4">
          <div className="flex items-center gap-2 text-xs text-slate-600">
            <KeyRound className="h-4 w-4 text-emerald-700" />
            <span>تُشفَّر جميع القيم الحساسة قبل التخزين وتُطبَّق فوريًا دون الحاجة لإعادة النشر.</span>
          </div>
          <button
            type="submit"
            disabled={busy}
            data-testid="vault-save-btn"
            className="rounded-lg bg-emerald-700 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50 transition-colors"
          >
            {busy ? 'جارٍ التشفير والحفظ...' : 'حفظ مفاتيح خزينة الأسرار'}
          </button>
        </div>
      </form>
    </div>
  );
}
