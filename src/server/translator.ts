import { GoogleGenAI } from '@google/genai';

export type SupportedTranslationLang = 'ar' | 'en';

export type TranslationContext =
  | 'button_label'
  | 'button_content'
  | 'category_name'
  | 'product_title'
  | 'product_description'
  | 'warranty_label';

export interface BilingualTranslationResult {
  sourceLang: SupportedTranslationLang;
  textAr: string;
  textEn: string;
  engine: 'gemini' | 'translate_api' | 'passthrough';
}

export interface ProductBilingualPlan {
  mode: 'single_auto' | 'manual_both' | 'empty';
  singleSourceText?: string;
  detectedLang?: SupportedTranslationLang;
  manualAr?: string;
  manualEn?: string;
}

const ARABIC_CHAR_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g;
const LATIN_CHAR_RE = /[A-Za-z]/g;

/**
 * Pure deterministic language detector for Arabic vs English inputs.
 */
export function detectTextLanguage(text: string): SupportedTranslationLang {
  const value = (text || '').trim();
  if (!value) return 'ar';
  const arMatches = value.match(ARABIC_CHAR_RE)?.length || 0;
  const enMatches = value.match(LATIN_CHAR_RE)?.length || 0;
  if (arMatches === 0 && enMatches > 0) return 'en';
  if (enMatches === 0 && arMatches > 0) return 'ar';
  return arMatches >= enMatches ? 'ar' : 'en';
}

/**
 * Pure deterministic planner for single-input vs explicit manual bilingual payloads.
 * - If `single` is provided (or only one of `ar`/`en` is provided, or both are identical),
 *   returns `single_auto` so the backend translates it automatically into the counterpart language.
 * - Only when distinct non-empty `ar` and `en` overrides are both supplied does it keep `manual_both`.
 */
export function planBilingualTextResolution(input: {
  single?: string | null;
  ar?: string | null;
  en?: string | null;
}): ProductBilingualPlan {
  const single = typeof input.single === 'string' ? input.single.trim() : '';
  const ar = typeof input.ar === 'string' ? input.ar.trim() : '';
  const en = typeof input.en === 'string' ? input.en.trim() : '';

  if (single) {
    return {
      mode: 'single_auto',
      singleSourceText: single,
      detectedLang: detectTextLanguage(single),
    };
  }
  if (ar && en && ar !== en) {
    return {
      mode: 'manual_both',
      manualAr: ar,
      manualEn: en,
    };
  }
  const sole = ar || en;
  if (sole) {
    return {
      mode: 'single_auto',
      singleSourceText: sole,
      detectedLang: detectTextLanguage(sole),
    };
  }
  return { mode: 'empty' };
}

/**
 * Splits a leading emoji cluster from a button label so emojis are preserved cleanly across translation.
 */
export function splitLeadingEmoji(input: string): { emoji: string; cleanText: string } {
  const trimmed = (input || '').trim();
  if (!trimmed) return { emoji: '', cleanText: '' };
  const match = trimmed.match(/^((?:\p{Extended_Pictographic}|\uFE0F|\u200D)+)\s+(.+)$/su);
  if (match) {
    return { emoji: match[1].trim(), cleanText: match[2].trim() };
  }
  return { emoji: '', cleanText: trimmed };
}

/**
 * Re-attaches a preserved leading emoji if the translated string dropped it.
 */
export function ensurePreservedEmoji(emoji: string, translated: string): string {
  const clean = (translated || '').trim();
  if (!emoji) return clean;
  if (!clean) return emoji;
  if (clean.startsWith(emoji)) return clean;
  return `${emoji} ${clean}`;
}

function getGeminiClient(): GoogleGenAI | null {
  const key = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();
  if (!key) return null;
  return new GoogleGenAI({
    apiKey: key,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function buildContextPromptHint(context: TranslationContext): string {
  switch (context) {
    case 'button_label':
      return 'This is a short Telegram bot inline button label. Keep it concise, natural, and preserve any leading/inline emojis and brand names (e.g. Gemini, ChatGPT, Canva, Adobe, USDT, Binance, VIP).';
    case 'category_name':
      return 'This is a digital store category/app name. Keep brand names intact and concise.';
    case 'product_title':
      return 'This is a digital subscription/product title in an e-commerce store. Keep brand names (e.g. Gemini, ChatGPT, Canva Pro, Adobe, Claude, Cursor, Duolingo, Netflix, Spotify, CapCut, YouTube) intact, preserve emojis and plan durations accurately (e.g. "6 أشهر" <-> "6 Months", "سنة" <-> "1 Year"), and keep the title crisp and commercial.';
    case 'product_description':
      return 'This is a customer-facing digital product description for a storefront and Telegram bot. Preserve the exact meaning, persuasive/clean commercial tone, line breaks, bullet markers ([+], •, -), emojis, numbers, warranty terms, official service URLs, and product brand names faithfully. CRITICAL: If the text contains Telegram HTML tags (such as <blockquote>, <blockquote expandable>, <b>, <strong>, <i>, <em>, <u>, <s>, <code>, <pre>, <tg-spoiler>, <a href="...">, <tg-emoji emoji-id="...">), preserve ALL HTML tags, attributes, href URLs, and emoji-id values verbatim in their exact structure while translating ONLY the human-readable text inside them.';
    case 'warranty_label':
      return 'This is a short digital product warranty phrase (e.g. "ضمان التشغيل طوال المدة" <-> "Full-period activation warranty"). Keep it concise and natural.';
    default:
      return 'This is a Telegram bot message/guide body. Preserve line breaks, emojis, bullet points, URLs, @handles, prices, and brand names exactly while translating naturally.';
  }
}

async function callGeminiModelTranslate(
  ai: GoogleGenAI,
  model: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite',
  text: string,
  sourceLang: SupportedTranslationLang,
  context: TranslationContext
): Promise<BilingualTranslationResult> {
  const targetLang: SupportedTranslationLang = sourceLang === 'ar' ? 'en' : 'ar';
  const contextHint = buildContextPromptHint(context);

  const response = await ai.models.generateContent({
    model,
    contents: text,
    config: {
      systemInstruction:
        `You are a professional e-commerce translator for a digital subscriptions store. ` +
        `Translate the user's ${sourceLang === 'ar' ? 'Arabic' : 'English'} text into natural, accurate ${
          targetLang === 'ar' ? 'Arabic' : 'English'
        }. ` +
        `${contextHint} ` +
        `Output ONLY the translated text with zero explanations, no markdown code blocks, and no surrounding quotes.`,
    },
  });

  const translated = (response.text || '')
    .trim()
    .replace(/^```(?:\w+)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (!translated) {
    throw new Error('Empty translation response from Gemini');
  }

  return {
    sourceLang,
    textAr: sourceLang === 'ar' ? text : translated,
    textEn: sourceLang === 'en' ? text : translated,
    engine: 'gemini',
  };
}

async function translateViaGemini(
  text: string,
  sourceLang: SupportedTranslationLang,
  context: TranslationContext
): Promise<BilingualTranslationResult> {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('GEMINI_API_KEY_NOT_CONFIGURED');
  }

  try {
    return await callGeminiModelTranslate(ai, 'gemini-4-hydrogen', text, sourceLang, context);
  } catch (primaryErr: any) {
    console.warn('Primary Gemini translate error:', primaryErr?.status || primaryErr?.message || primaryErr);
    return await callGeminiModelTranslate(ai, 'gemini-3.1-flash-lite', text, sourceLang, context);
  }
}

async function translateViaTranslateApi(
  text: string,
  sourceLang: SupportedTranslationLang,
  isShortLabel: boolean
): Promise<BilingualTranslationResult> {
  const targetLang: SupportedTranslationLang = sourceLang === 'ar' ? 'en' : 'ar';
  const { emoji, cleanText } = isShortLabel ? splitLeadingEmoji(text) : { emoji: '', cleanText: text };
  const textToSend = cleanText || text;

  // Skip external network call if text has neither Arabic nor Latin letters (e.g. pure numbers/emojis/URL)
  if (!/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(textToSend) && !/[A-Za-z]/.test(textToSend)) {
    return {
      sourceLang,
      textAr: text,
      textEn: text,
      engine: 'passthrough',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const url =
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=` +
      encodeURIComponent(textToSend);
    const resp = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      throw new Error(`Translation service HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as any;
    const segments = Array.isArray(data?.[0]) ? data[0] : [];
    const combined = segments
      .map((seg: any) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : ''))
      .join('')
      .trim();

    if (!combined) {
      throw new Error('Empty response from translation service');
    }

    const finalTranslated = isShortLabel ? ensurePreservedEmoji(emoji, combined) : combined;
    return {
      sourceLang,
      textAr: sourceLang === 'ar' ? text : finalTranslated,
      textEn: sourceLang === 'en' ? text : finalTranslated,
      engine: 'translate_api',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Automatically detects the input language (AR or EN) and translates into the counterpart language.
 * - Uses server-side Gemini (`gemini-4-hydrogen` with `gemini-3.1-flash-lite` failover) when `GEMINI_API_KEY`
 *   is configured, with failover to Google Translate HTTPS API if Gemini is unavailable.
 * - Preserves original text verbatim in its source language and saves both AR & EN cleanly.
 */
export async function autoTranslateBilingual(
  inputText: string,
  context: TranslationContext = 'button_label'
): Promise<BilingualTranslationResult> {
  const trimmed = (inputText || '').trim();
  if (!trimmed) {
    return { sourceLang: 'ar', textAr: '', textEn: '', engine: 'passthrough' };
  }

  // URLs, handles, or pure symbols do not need translation
  if (/^(https?:\/\/|@[\w]+$)/i.test(trimmed)) {
    return { sourceLang: 'en', textAr: trimmed, textEn: trimmed, engine: 'passthrough' };
  }

  const sourceLang = detectTextLanguage(trimmed);
  const isShortLabel =
    context === 'button_label' ||
    context === 'category_name' ||
    context === 'product_title' ||
    context === 'warranty_label';

  const hasGeminiKey = Boolean((process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim());
  if (hasGeminiKey) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('GEMINI_TRANSLATE_TIMEOUT')), 10000);
      });
      return await Promise.race([translateViaGemini(trimmed, sourceLang, context), timeoutPromise]);
    } catch (geminiErr: any) {
      console.warn('Gemini translation fallback triggered:', geminiErr?.message || geminiErr);
      try {
        return await translateViaTranslateApi(trimmed, sourceLang, isShortLabel);
      } catch {
        throw new Error(
          'تعذر إتمام الترجمة التلقائية حاليًا. يرجى التحقق من مفتاح GEMINI_API_KEY في الإعدادات (Settings > Secrets) أو المحاولة لاحقًا.'
        );
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  try {
    return await translateViaTranslateApi(trimmed, sourceLang, isShortLabel);
  } catch {
    throw new Error(
      'خدمة الترجمة التلقائية تتطلب تفعيل مفتاح GEMINI_API_KEY في الإعدادات (Settings > Secrets)، أو يمكنك حفظ المنتج وسيتم حفظ النص مباشرة.'
    );
  }
}

/**
 * Resolves single-input or explicit bilingual fields into guaranteed `{ textAr, textEn }`.
 * Falls back gracefully to the source text if external translation services are momentarily unreachable.
 */
export async function resolveBilingualFields(
  input: { single?: string | null; ar?: string | null; en?: string | null },
  context: TranslationContext
): Promise<{ textAr: string; textEn: string; autoTranslated: boolean; sourceLang?: SupportedTranslationLang }> {
  const plan = planBilingualTextResolution(input);
  if (plan.mode === 'empty') {
    return { textAr: '', textEn: '', autoTranslated: false };
  }
  if (plan.mode === 'manual_both') {
    return {
      textAr: plan.manualAr || '',
      textEn: plan.manualEn || '',
      autoTranslated: false,
    };
  }
  const source = plan.singleSourceText || '';
  try {
    const tr = await autoTranslateBilingual(source, context);
    return {
      textAr: tr.textAr || source,
      textEn: tr.textEn || source,
      autoTranslated: true,
      sourceLang: tr.sourceLang,
    };
  } catch {
    return {
      textAr: source,
      textEn: source,
      autoTranslated: false,
      sourceLang: plan.detectedLang,
    };
  }
}
