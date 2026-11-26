import React, { useEffect, useRef, useState } from 'react';
import {
  Send,
  ShieldCheck,
  User,
  Lock,
  RefreshCw,
  Globe,
  Radio,
  Power,
  KeyRound,
  ExternalLink,
  SlidersHorizontal,
  Terminal,
  Sparkles,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import TelegramHtmlRenderer from './TelegramHtmlRenderer';
import {
  FeedbackBanner,
  PageHeader,
  SectionHeader,
  SegmentedTabs,
  SemanticStatus,
  SurfacePanel,
} from './ui/AdminPrimitives';

interface LiveTelegramStatus {
  configured: boolean;
  tokenSource: 'env' | 'none';
  tokenFingerprint: string | null;
  ownerTelegramIds: string;
  state: 'running' | 'starting' | 'stopped' | 'error' | 'not_configured';
  mode: 'polling' | 'webhook';
  botUsername: string | null;
  botFirstName: string | null;
  botId: number | null;
  lastError: string | null;
  startedAt: string | null;
  updatesReceived: number;
  lastUpdateAt: string | null;
  customEmojiCapability?: {
    state: 'unknown' | 'supported' | 'unsupported_by_telegram';
    lastCheckedAt: string | null;
    diagnosticAr: string;
  };
}

interface BotInlineButton {
  text: string;
  callbackData?: string;
  url?: string;
  copyText?: string;
  iconCustomEmojiId?: string | null;
  style?: 'primary' | 'success' | 'danger' | null;
}

interface BotReplyPayload {
  text: string;
  parseMode?: 'HTML';
  entities?: any[];
  inlineKeyboard: BotInlineButton[][];
  mode: 'customer' | 'admin';
  lang?: 'ar' | 'en';
  editInPlace?: boolean;
  accessDenied?: boolean;
}

interface ChatMessage {
  id: string;
  sender: 'user' | 'bot';
  text: string;
  parseMode?: 'HTML';
  entities?: any[];
  inlineKeyboard?: BotInlineButton[][];
  lang?: 'ar' | 'en';
  timestamp: string;
  accessDenied?: boolean;
}

function renderFormattedTelegramText(
  text: string,
  entities?: any[],
  parseMode?: 'HTML'
): React.ReactNode {
  if (parseMode === 'HTML') {
    return <TelegramHtmlRenderer html={text} />;
  }
  if (!Array.isArray(entities) || entities.length === 0) {
    return text;
  }
  const sorted = [...entities]
    .filter((e) => typeof e?.offset === 'number' && typeof e?.length === 'number' && e.length > 0)
    .sort((a, b) => a.offset - b.offset);

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < sorted.length; i++) {
    const ent = sorted[i];
    if (ent.offset < cursor) continue;
    if (ent.offset > cursor) {
      nodes.push(text.slice(cursor, ent.offset));
    }
    const seg = text.slice(ent.offset, ent.offset + ent.length);
    const key = `ent-${i}-${ent.offset}`;
    switch (ent.type) {
      case 'bold':
        nodes.push(<strong key={key}>{seg}</strong>);
        break;
      case 'italic':
        nodes.push(<em key={key}>{seg}</em>);
        break;
      case 'underline':
        nodes.push(<span key={key} className="underline">{seg}</span>);
        break;
      case 'strikethrough':
        nodes.push(<span key={key} className="line-through">{seg}</span>);
        break;
      case 'code':
        nodes.push(
          <code key={key} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs text-slate-900">
            {seg}
          </code>
        );
        break;
      case 'pre':
        nodes.push(
          <pre key={key} className="my-1 overflow-x-auto rounded bg-slate-900 p-2 font-mono text-xs text-slate-100">
            {seg}
          </pre>
        );
        break;
      case 'blockquote':
      case 'expandable_blockquote':
        nodes.push(
          <blockquote key={key} className="my-1 border-r-2 border-sky-500 bg-slate-50 px-2.5 py-1 text-slate-700">
            {seg}
          </blockquote>
        );
        break;
      case 'text_link':
        nodes.push(
          <a key={key} href={ent.url} target="_blank" rel="noreferrer" className="text-sky-600 underline">
            {seg}
          </a>
        );
        break;
      default:
        nodes.push(<span key={key}>{seg}</span>);
    }
    cursor = ent.offset + ent.length;
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes;
}

interface TelegramBotConsoleProps {
  onDataMutated?: () => void;
  storeName: string;
  initialMode?: 'admin' | 'customer';
  initialCustomerLang?: 'ar' | 'en';
}

export default function TelegramBotConsole({
  onDataMutated,
  storeName,
  initialMode = 'admin',
  initialCustomerLang,
}: TelegramBotConsoleProps) {
  const [botMode, setBotMode] = useState<'admin' | 'customer'>(initialMode);
  const [customerLang, setCustomerLang] = useState<'ar' | 'en'>(initialCustomerLang || 'ar');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [rbacAuditMessage, setRbacAuditMessage] = useState<string | null>(null);
  const [copiedBtnKey, setCopiedBtnKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Real Telegram Bot Live Connection State (Token & Owner ID read-only from runtime env secrets)
  const [liveStatus, setLiveStatus] = useState<LiveTelegramStatus | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveFeedback, setLiveFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [showTokenConfig, setShowTokenConfig] = useState(false);

  const loadLiveStatus = async () => {
    try {
      const res = await apiFetch<{ status: LiveTelegramStatus }>('/api/admin/telegram/status');
      setLiveStatus(res.status);
    } catch {
      // Ignore if non-admin or initial load
    }
  };

  useEffect(() => {
    void loadLiveStatus();
    const timer = window.setInterval(() => void loadLiveStatus(), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const handleEnableLiveBot = async () => {
    setLiveBusy(true);
    setLiveFeedback(null);
    try {
      const res = await apiFetch<{ ok: boolean; messageAr: string; status: LiveTelegramStatus }>(
        '/api/admin/telegram/config',
        {
          method: 'POST',
          body: JSON.stringify({ enabled: true }),
        }
      );
      setLiveStatus(res.status);
      setLiveFeedback({ type: res.ok ? 'ok' : 'err', text: res.messageAr });
    } catch (err: any) {
      setLiveFeedback({ type: 'err', text: err?.message || 'تعذر تشغيل بوت تيليجرام.' });
    } finally {
      setLiveBusy(false);
    }
  };

  const handleRestartLiveBot = async () => {
    setLiveBusy(true);
    setLiveFeedback(null);
    try {
      const res = await apiFetch<{ ok: boolean; messageAr: string; status: LiveTelegramStatus }>(
        '/api/admin/telegram/restart',
        { method: 'POST' }
      );
      setLiveStatus(res.status);
      setLiveFeedback({ type: res.ok ? 'ok' : 'err', text: res.messageAr });
    } catch (err: any) {
      setLiveFeedback({ type: 'err', text: err?.message || 'تعذر إعادة الاتصال بالبوت.' });
    } finally {
      setLiveBusy(false);
    }
  };

  const handleStopLiveBot = async () => {
    setLiveBusy(true);
    setLiveFeedback(null);
    try {
      const res = await apiFetch<{ ok: boolean; messageAr: string; status: LiveTelegramStatus }>(
        '/api/admin/telegram/stop',
        { method: 'POST' }
      );
      setLiveStatus(res.status);
      setLiveFeedback({ type: 'ok', text: res.messageAr });
    } catch (err: any) {
      setLiveFeedback({ type: 'err', text: err?.message || 'تعذر إيقاف البوت.' });
    } finally {
      setLiveBusy(false);
    }
  };

  const nowTime = () =>
    new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });

  const sendCommand = async (payload: {
    text?: string;
    callbackData?: string;
    label?: string;
    modeOverride?: 'admin' | 'customer';
    editTargetMessageId?: string;
    telegramLanguageCode?: string;
  }) => {
    const mode = payload.modeOverride || botMode;
    const isCallback = Boolean(payload.callbackData);

    if (!isCallback && (payload.label || payload.text)) {
      setMessages((prev) => [
        ...prev,
        {
          id: `u-${Date.now()}-${Math.random()}`,
          sender: 'user',
          text: payload.label || payload.text || '',
          timestamp: nowTime(),
        },
      ]);
    }

    setLoading(true);
    try {
      const res = await apiFetch<{ reply: BotReplyPayload }>('/api/telegram/simulate', {
        method: 'POST',
        body: JSON.stringify({
          mode,
          text: payload.text,
          callbackData: payload.callbackData,
          telegramLanguageCode: payload.telegramLanguageCode,
        }),
      });

      if (res.reply.lang) {
        setCustomerLang(res.reply.lang);
      }

      if (isCallback && res.reply.editInPlace && payload.editTargetMessageId) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === payload.editTargetMessageId
              ? {
                  ...m,
                  text: res.reply.text,
                  parseMode: res.reply.parseMode,
                  entities: res.reply.entities,
                  inlineKeyboard: res.reply.inlineKeyboard,
                  lang: res.reply.lang,
                  timestamp: nowTime(),
                  accessDenied: res.reply.accessDenied,
                }
              : m
          )
        );
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: `b-${Date.now()}-${Math.random()}`,
            sender: 'bot',
            text: res.reply.text,
            parseMode: res.reply.parseMode,
            entities: res.reply.entities,
            inlineKeyboard: res.reply.inlineKeyboard,
            lang: res.reply.lang,
            timestamp: nowTime(),
            accessDenied: res.reply.accessDenied,
          },
        ]);
      }

      if (onDataMutated) onDataMutated();
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: `e-${Date.now()}`,
          sender: 'bot',
          text: `⚠️ ${err?.message || 'تعذر الاتصال بالبوت حاليًا.'}`,
          timestamp: nowTime(),
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (nextMode: 'admin' | 'customer', previewLang?: 'ar' | 'en') => {
    setBotMode(nextMode);
    setMessages([]);
    setRbacAuditMessage(null);
    if (nextMode === 'customer' && previewLang) {
      void sendCommand({
        callbackData: `c:setlang:${previewLang}`,
        modeOverride: 'customer',
      });
    } else {
      void sendCommand({
        text: nextMode === 'admin' ? '/admin' : '/start',
        label: nextMode === 'admin' ? '/admin' : '/start',
        modeOverride: nextMode,
      });
    }
  };

  useEffect(() => {
    switchMode(initialMode, initialMode === 'customer' ? initialCustomerLang : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMode, initialCustomerLang]);

  useEffect(() => {
    if (!scrollRef.current) return;
    if (messages.length <= 2) {
      scrollRef.current.scrollTop = 0;
    } else {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputText.trim();
    if (!trimmed || loading) return;
    setInputText('');
    void sendCommand({ text: trimmed, label: trimmed });
  };

  const testCustomerIntrusion = async () => {
    setBotMode('customer');
    setMessages([]);
    setRbacAuditMessage(null);
    await sendCommand({
      text: '/admin',
      label: '/admin (اختبار صلاحيات العميل)',
      modeOverride: 'customer',
    });
    setRbacAuditMessage('تم حظر أمر /admin عن العميل وإظهار قائمة المتجر المعزولة فقط.');
  };

  const isRunning = liveStatus?.state === 'running';
  const showConfigPanel = showTokenConfig || !isRunning;

  return (
    <div className="space-y-5">
      <PageHeader
        title="بوت الإدارة والعملاء"
        subtitle="اتصال تيليجرام المباشر ومحاكاة فورية لبوت المدير والمشتري"
        actions={
          <SegmentedTabs
            value={botMode}
            onChange={(m) => switchMode(m)}
            items={[
              { id: 'admin', label: 'بوت الإدارة (/admin)', icon: ShieldCheck },
              { id: 'customer', label: 'بوت المشتري (/start)', icon: User },
            ]}
          />
        }
      />

      {/* Compact Live Bot Connection Strip */}
      <SurfacePanel className="overflow-hidden">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between px-5 py-3.5">
          <div className="flex flex-wrap items-center gap-3 min-w-0">
            <Radio className={`h-4 w-4 shrink-0 ${isRunning ? 'text-emerald-600' : 'text-amber-600'}`} />
            <span className="text-sm font-bold text-slate-900">اتصال تيليجرام المباشر</span>
            <span className="text-slate-300" aria-hidden="true">·</span>
            {isRunning && liveStatus?.botUsername ? (
              <a
                href={`https://t.me/${liveStatus.botUsername}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:underline font-mono-num"
              >
                @{liveStatus.botUsername}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              <SemanticStatus
                tone={liveStatus?.state === 'error' ? 'negative' : 'warning'}
                label={
                  liveStatus?.state === 'error'
                    ? 'خطأ اتصال'
                    : liveStatus?.state === 'stopped'
                      ? 'متوقف'
                      : 'غير مربوط'
                }
              />
            )}
            {isRunning && (
              <div className="hidden sm:flex items-center gap-2 text-[11px] text-slate-500">
                <span className="text-slate-300">·</span>
                <span>الرسائل: <strong className="font-mono-num text-slate-700">{liveStatus.updatesReceived}</strong></span>
                {liveStatus.lastUpdateAt && (
                  <>
                    <span className="text-slate-300">·</span>
                    <span>آخر تفاعل: <strong className="font-mono-num text-slate-700">{new Date(liveStatus.lastUpdateAt).toLocaleTimeString('ar-SA')}</strong></span>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowTokenConfig((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {showConfigPanel ? 'إخفاء حالة البيئة' : 'بيانات البيئة'}
            </button>
            {liveStatus?.configured && (
              <button
                type="button"
                disabled={liveBusy}
                onClick={() => void handleRestartLiveBot()}
                aria-label="إعادة الاتصال ببوت تيليجرام"
                title="إعادة الاتصال"
                className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${liveBusy ? 'animate-spin' : ''}`} />
              </button>
            )}
            {isRunning && (
              <button
                type="button"
                disabled={liveBusy}
                onClick={() => void handleStopLiveBot()}
                aria-label="إيقاف البوت مؤقتًا"
                title="إيقاف البوت"
                className="rounded-lg border border-rose-200 bg-white p-1.5 text-rose-600 hover:bg-rose-50 disabled:opacity-50"
              >
                <Power className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {(liveFeedback || liveStatus?.lastError) && (
          <div className="px-5 pb-3.5">
            <FeedbackBanner
              type={liveFeedback?.type === 'ok' ? 'ok' : 'err'}
              text={liveFeedback?.text || liveStatus?.lastError || ''}
              onDismiss={() => setLiveFeedback(null)}
            />
          </div>
        )}

        {showConfigPanel && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-12 items-center border-t border-slate-100 bg-slate-50/60 px-5 py-4">
            <div className="md:col-span-5 rounded-lg border border-slate-200/80 bg-white px-3.5 py-2.5">
              <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-slate-600">
                <span className="inline-flex items-center gap-1">
                  <KeyRound className="h-3 w-3 text-slate-400" />
                  توكن البوت (TELEGRAM_BOT_TOKEN)
                </span>
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500">
                  <Lock className="h-2.5 w-2.5" />
                  أسرار بيئة التشغيل
                </span>
              </div>
              <div className="mt-1 font-mono-num text-xs font-semibold text-slate-900">
                {liveStatus?.tokenFingerprint || 'غير مضبوط في أسرار بيئة التشغيل'}
              </div>
            </div>

            <div className="md:col-span-4 rounded-lg border border-slate-200/80 bg-white px-3.5 py-2.5">
              <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-slate-600">
                <span>معرّف المالك (TELEGRAM_OWNER_IDS)</span>
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500">
                  <Lock className="h-2.5 w-2.5" />
                  أسرار بيئة التشغيل
                </span>
              </div>
              <div className="mt-1 font-mono-num text-xs font-semibold text-slate-900">
                {liveStatus?.ownerTelegramIds || 'غير مضبوط في أسرار بيئة التشغيل'}
              </div>
            </div>

            <div className="md:col-span-3 flex flex-col gap-1.5">
              <button
                type="button"
                disabled={liveBusy || !liveStatus?.configured}
                onClick={() => void handleEnableLiveBot()}
                className="w-full rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50 whitespace-nowrap"
              >
                {liveBusy ? 'جارٍ التشغيل...' : 'تشغيل البوت من البيئة'}
              </button>
              <span className="text-[10px] text-slate-500 text-center">
                لتغيير التوكن أو ID المالك عدّلهما في أسرار البيئة
              </span>
            </div>
          </div>
        )}

        {liveStatus?.customEmojiCapability && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/40 px-5 py-2.5 text-[11px] text-slate-600">
            <div className="flex items-center gap-2 min-w-0">
              <Sparkles className="h-3.5 w-3.5 shrink-0 text-sky-600" />
              <span className="font-semibold text-slate-800">دعم Telegram Custom Emoji:</span>
              <span className="truncate sm:whitespace-normal">{liveStatus.customEmojiCapability.diagnosticAr}</span>
            </div>
            <SemanticStatus
              tone={
                liveStatus.customEmojiCapability.state === 'supported'
                  ? 'positive'
                  : liveStatus.customEmojiCapability.state === 'unsupported_by_telegram'
                    ? 'warning'
                    : 'neutral'
              }
              label={
                liveStatus.customEmojiCapability.state === 'supported'
                  ? 'مفعّل على البوت'
                  : liveStatus.customEmojiCapability.state === 'unsupported_by_telegram'
                    ? 'البديل التلقائي نشط'
                    : 'حفظ المعرّفات نشط'
              }
            />
          </div>
        )}
      </SurfacePanel>

      {/* Main Split: Interactive Simulator (8 cols) + Compact Utilities (4 cols) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        <SurfacePanel className="lg:col-span-8 overflow-hidden">
          <div className="flex items-center justify-between bg-slate-900 px-4 py-3 text-white">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-600 font-display font-bold text-sm">
                {botMode === 'admin' ? 'إ' : 'ر'}
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-bold">
                  {botMode === 'admin'
                    ? `${storeName} — لوحة المدير`
                    : customerLang === 'en'
                      ? 'Raqm Digital Store'
                      : storeName}
                </div>
                <div className="text-[11px] text-slate-400">
                  {botMode === 'admin'
                    ? 'صلاحيات المالك الكاملة'
                    : customerLang === 'en'
                      ? 'Customer Inline Bot · EN'
                      : 'بوت المشتري · عربي'}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              {botMode === 'customer' && (
                <div className="flex items-center gap-0.5 rounded-md bg-slate-800 p-0.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() => switchMode('customer', 'ar')}
                    className={`rounded px-2 py-1 font-semibold transition-colors ${
                      customerLang === 'ar' ? 'bg-emerald-600 text-white' : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    AR
                  </button>
                  <button
                    type="button"
                    onClick={() => switchMode('customer', 'en')}
                    className={`rounded px-2 py-1 font-semibold transition-colors ${
                      customerLang === 'en' ? 'bg-emerald-600 text-white' : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    EN
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => switchMode(botMode)}
                aria-label="تحديث المحادثة"
                className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div
            ref={scrollRef}
            className="h-[560px] overflow-y-auto bg-[#f1f5f9] p-4 space-y-3"
          >
            {messages.map((m) => {
              const isEn = m.sender === 'bot' && m.lang === 'en';
              return (
                <div
                  key={m.id}
                  className={`flex flex-col ${m.sender === 'user' ? 'items-start' : 'items-end'}`}
                >
                  <div
                    dir={isEn ? 'ltr' : 'rtl'}
                    className={`max-w-[90%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                      m.sender === 'user'
                        ? 'bg-slate-900 text-white'
                        : 'bg-white border border-slate-200/85 text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.04)]'
                    }`}
                  >
                    <div>{renderFormattedTelegramText(m.text, m.entities, m.parseMode)}</div>
                    <div
                      className={`mt-1 text-[10px] font-mono-num ${
                        m.sender === 'user' ? 'text-slate-400' : 'text-slate-400'
                      }`}
                    >
                      {m.timestamp}
                    </div>
                  </div>

                  {m.sender === 'bot' && m.inlineKeyboard && m.inlineKeyboard.length > 0 && (
                    <div dir={isEn ? 'ltr' : 'rtl'} className="mt-1.5 flex w-[90%] flex-col gap-1.5">
                      {m.inlineKeyboard.map((row, rIdx) => (
                        <div
                          key={rIdx}
                          className="grid gap-1.5"
                          style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}
                        >
                          {row.map((btn, bIdx) => {
                            const styleClasses =
                              btn.style === 'success'
                                ? 'border-emerald-700 bg-emerald-600 text-white hover:bg-emerald-700'
                                : btn.style === 'danger'
                                  ? 'border-rose-700 bg-rose-600 text-white hover:bg-rose-700'
                                  : btn.style === 'primary' && botMode === 'customer'
                                    ? 'border-sky-700 bg-sky-600 text-white hover:bg-sky-700'
                                    : 'border-slate-200 bg-white text-slate-800 hover:bg-slate-50 hover:border-slate-400';

                            if (btn.copyText) {
                              const btnKey = `${m.id}-${rIdx}-${bIdx}`;
                              const isCopied = copiedBtnKey === btnKey;
                              return (
                                <button
                                  key={`copy-${rIdx}-${bIdx}-${btn.text}`}
                                  type="button"
                                  onClick={() => {
                                    void navigator.clipboard?.writeText(btn.copyText!).catch(() => {});
                                    setCopiedBtnKey(btnKey);
                                    window.setTimeout(() => {
                                      setCopiedBtnKey((prev) => (prev === btnKey ? null : prev));
                                    }, 2000);
                                  }}
                                  className={`rounded-lg border px-2.5 py-2 text-xs font-semibold transition-colors text-center truncate ${styleClasses}`}
                                >
                                  {isCopied ? (isEn ? '✅ Copied' : '✅ تم النسخ') : btn.text}
                                </button>
                              );
                            }

                            if (btn.url) {
                              return (
                                <a
                                  key={`url-${rIdx}-${bIdx}-${btn.text}`}
                                  href={btn.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className={`relative flex items-center justify-center gap-1 rounded-lg border px-2.5 py-2 text-xs font-semibold transition-colors text-center truncate ${styleClasses}`}
                                >
                                  <span className="truncate">{btn.text}</span>
                                  <ExternalLink className="h-3 w-3 shrink-0 opacity-85" />
                                </a>
                              );
                            }

                            return (
                              <button
                                key={`${btn.callbackData || bIdx}-${btn.text}`}
                                type="button"
                                disabled={loading}
                                onClick={() =>
                                  void sendCommand({
                                    callbackData: btn.callbackData,
                                    label: btn.text,
                                    editTargetMessageId: m.id,
                                  })
                                }
                                className={`rounded-lg border px-2.5 py-2 text-xs font-semibold transition-colors text-center truncate ${styleClasses}`}
                              >
                                {btn.text}
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {loading && (
              <div className="text-xs text-slate-400 text-left">جارٍ التنفيذ...</div>
            )}
          </div>

          <form onSubmit={handleFormSubmit} className="flex items-center gap-2 border-t border-slate-200 bg-white p-3">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={
                botMode === 'admin'
                  ? 'أمر سريع (مثال: /admin أو سعر 1 3.50)...'
                  : customerLang === 'en'
                    ? 'Enter quantity, USDT amount, or Binance TxID...'
                    : 'أدخل الكمية أو المبلغ أو الرقم المرجعي...'
              }
              className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:bg-white focus:outline-none"
            />
            <button
              type="submit"
              disabled={loading || !inputText.trim()}
              aria-label="إرسال الأمر للبوت"
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-45 transition-colors whitespace-nowrap shrink-0"
            >
              <Send className="h-3.5 w-3.5" />
              إرسال
            </button>
          </form>
        </SurfacePanel>

        {/* Focused Controls Sidebar (4 cols) */}
        <div className="lg:col-span-4 space-y-4">
          <SurfacePanel>
            <SectionHeader title="معاينة سريعة للغات" icon={Globe} />
            <div className="p-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => switchMode('customer', 'ar')}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors"
              >
                🇸🇦 العربية
              </button>
              <button
                type="button"
                onClick={() => switchMode('customer', 'en')}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors"
              >
                🇬🇧 English
              </button>
            </div>
          </SurfacePanel>

          <SurfacePanel>
            <SectionHeader title="أوامر مختصرة" icon={Terminal} />
            <div className="divide-y divide-slate-100 px-4 text-xs">
              {[
                { label: 'لوحة الإدارة', cmd: '/admin', mode: 'admin' as const },
                { label: 'القائمة الرئيسية', cmd: '/start', mode: 'customer' as const },
              ].map((item) => (
                <div key={item.cmd} className="py-2.5 flex items-center justify-between gap-2">
                  <span className="text-slate-600">{item.label}</span>
                  <button
                    type="button"
                    onClick={() => switchMode(item.mode)}
                    className="font-mono-num font-semibold text-emerald-700 hover:underline"
                  >
                    {item.cmd}
                  </button>
                </div>
              ))}
              <div className="py-2.5 flex items-center justify-between gap-2">
                <span className="text-slate-600">تحديث سعر فوري</span>
                <span className="font-mono-num text-slate-700">سعر 1 3.50</span>
              </div>
            </div>
          </SurfacePanel>

          <SurfacePanel>
            <SectionHeader title="اختبار عزل الصلاحيات" icon={Lock} />
            <div className="p-4 space-y-3">
              <button
                type="button"
                onClick={() => void testCustomerIntrusion()}
                className="w-full rounded-lg border border-slate-200 bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors"
              >
                اختبار إرسال /admin كعميل
              </button>
              {rbacAuditMessage && (
                <FeedbackBanner
                  type="ok"
                  text={rbacAuditMessage}
                  onDismiss={() => setRbacAuditMessage(null)}
                />
              )}
            </div>
          </SurfacePanel>
        </div>
      </div>
    </div>
  );
}
