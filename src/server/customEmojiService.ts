import { extractCustomEmojiIds, replaceDisallowedCustomEmojis } from './productDescriptionEngine.ts';

export type CustomEmojiCapabilityState = 'unknown' | 'supported' | 'unsupported_by_telegram';

export interface CustomEmojiCapabilityStatus {
  state: CustomEmojiCapabilityState;
  lastCheckedAt: string | null;
  diagnosticAr: string;
}

export interface ResolvedCustomEmojiSticker {
  customEmojiId: string;
  valid: boolean;
  emoji?: string;
  fileId?: string;
  thumbnailFileId?: string;
  isAnimated?: boolean;
  isVideo?: boolean;
  setName?: string;
}

interface CachedStickerEntry {
  data: ResolvedCustomEmojiSticker;
  expiresAt: number;
}

interface CachedMediaEntry {
  buffer: Buffer;
  contentType: string;
  expiresAt: number;
}

const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
const CUSTOM_EMOJI_ID_RE = /^\d{5,25}$/;
const MAX_STICKER_CACHE = 500;
const MAX_MEDIA_CACHE = 200;
const VALID_TTL_MS = 60 * 60 * 1000; // 1 hour
const INVALID_TTL_MS = 5 * 60 * 1000; // 5 minutes

const stickerCache = new Map<string, CachedStickerEntry>();
const mediaCache = new Map<string, CachedMediaEntry>();

let capabilityState: CustomEmojiCapabilityStatus = {
  state: 'unknown',
  lastCheckedAt: null,
  diagnosticAr:
    'يدعم النظام وسوم <tg-emoji> كاملة. ملاحظة: اشتراك Telegram Premium في حسابك الشخصي لا يمنح البوت تلقائيًا صلاحية إرسال إيموجي مخصص لغير المقتنيات إلا إذا كان البوت نفسه مخولًا من تيليجرام.',
};

export function isValidCustomEmojiId(id: string | null | undefined): boolean {
  if (!id) return false;
  return CUSTOM_EMOJI_ID_RE.test(id.trim());
}

export function getBotCustomEmojiCapability(): CustomEmojiCapabilityStatus {
  return { ...capabilityState };
}

export function resetBotCustomEmojiCapability(): void {
  capabilityState = {
    state: 'unknown',
    lastCheckedAt: null,
    diagnosticAr:
      'تم تصفير حالة اختبار الإيموجي المخصص — سيتم التحقق تلقائيًا عند أول رسالة تحتوي على <tg-emoji> عبر البوت الحي.',
  };
}

export function recordBotCustomEmojiOutcome(ok: boolean, detailAr?: string): void {
  capabilityState = {
    state: ok ? 'supported' : 'unsupported_by_telegram',
    lastCheckedAt: new Date().toISOString(),
    diagnosticAr: ok
      ? 'بوت تيليجرام أرسل وسوم <tg-emoji> بنجاح مع الحفاظ على التصاميم الأصلية.'
      : detailAr ||
        'رفضت واجهة Telegram Bot API إرسال <tg-emoji> لهذا البوت (صلاحية البوت وليس حساب المالك الشخصي)، لذا يرسل البوت الإيموجي البديل مع كامل تنسيق HTML دون تعطيل الرسالة.',
  };
}

function setBoundedCache<T>(map: Map<string, T>, key: string, val: T, maxSize: number): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= maxSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  map.set(key, val);
}

/**
 * Resolves and caches Telegram custom emoji metadata using `getCustomEmojiStickers`
 * (batches up to 200 IDs per request). Never poisons cache on transient network failures.
 */
export async function resolveCustomEmojiStickers(
  botToken: string | null | undefined,
  rawIds: string[]
): Promise<Map<string, ResolvedCustomEmojiSticker>> {
  const result = new Map<string, ResolvedCustomEmojiSticker>();
  const cleanIds = Array.from(new Set(rawIds.map((id) => id.trim()).filter(isValidCustomEmojiId)));
  if (cleanIds.length === 0) return result;

  const now = Date.now();
  const missing: string[] = [];

  for (const id of cleanIds) {
    const cached = stickerCache.get(id);
    if (cached && cached.expiresAt > now) {
      result.set(id, cached.data);
    } else {
      missing.push(id);
    }
  }

  const token = (botToken || '').trim();
  if (!token || missing.length === 0) {
    return result;
  }

  for (let i = 0; i < missing.length; i += 200) {
    const chunk = missing.slice(i, i + 200);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const url = `${TELEGRAM_API_ORIGIN}/bot${encodeURIComponent(token)}/getCustomEmojiStickers`;
      const resp = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ custom_emoji_ids: chunk }),
      });

      if (!resp.ok) {
        continue;
      }

      const payload = (await resp.json()) as {
        ok?: boolean;
        result?: Array<{
          custom_emoji_id?: string;
          emoji?: string;
          file_id?: string;
          thumbnail?: { file_id?: string };
          is_animated?: boolean;
          is_video?: boolean;
          set_name?: string;
        }>;
      };

      if (!payload?.ok || !Array.isArray(payload.result)) {
        continue;
      }

      const returnedById = new Map<string, ResolvedCustomEmojiSticker>();
      for (const st of payload.result) {
        const cid = (st.custom_emoji_id || '').trim();
        if (!cid) continue;
        returnedById.set(cid, {
          customEmojiId: cid,
          valid: true,
          emoji: st.emoji,
          fileId: st.file_id,
          thumbnailFileId: st.thumbnail?.file_id,
          isAnimated: Boolean(st.is_animated),
          isVideo: Boolean(st.is_video),
          setName: st.set_name,
        });
      }

      for (const id of chunk) {
        const found = returnedById.get(id) || { customEmojiId: id, valid: false };
        setBoundedCache(
          stickerCache,
          id,
          {
            data: found,
            expiresAt: Date.now() + (found.valid ? VALID_TTL_MS : INVALID_TTL_MS),
          },
          MAX_STICKER_CACHE
        );
        result.set(id, found);
      }
    } catch {
      // Transient failure — leave missing IDs unresolved so valid tags are not wrongly stripped
    } finally {
      clearTimeout(timer);
    }
  }

  return result;
}

/**
 * Per-emoji resilient pre-send filter:
 * Checks each custom emoji ID individually via `getCustomEmojiStickers`. If certain IDs are
 * deleted or unrecognized, unwraps ONLY those broken IDs to their Unicode fallback while keeping
 * every valid `<tg-emoji>` tag intact!
 */
export async function filterValidCustomEmojisInHtml(
  html: string,
  botToken: string | null | undefined
): Promise<{
  html: string;
  replacedIds: string[];
  keptIds: string[];
}> {
  const ids = extractCustomEmojiIds(html);
  if (ids.length === 0 || !botToken) {
    return { html, replacedIds: [], keptIds: ids };
  }

  const resolved = await resolveCustomEmojiStickers(botToken, ids);
  const validSet = new Set<string>();
  const replacedIds: string[] = [];
  const keptIds: string[] = [];

  for (const id of ids) {
    const entry = resolved.get(id);
    if (!entry || entry.valid) {
      // Keep confirmed valid OR unresolved (network timeout) IDs intact
      validSet.add(id);
      keptIds.push(id);
    } else {
      replacedIds.push(id);
    }
  }

  if (replacedIds.length === 0) {
    return { html, replacedIds, keptIds };
  }

  return {
    html: replaceDisallowedCustomEmojis(html, validSet),
    replacedIds,
    keptIds,
  };
}

/**
 * Safely proxies Telegram custom emoji raster artwork (`.webp`/`.png` thumbnail or static sticker)
 * for storefront & bot simulator previews without exposing the bot token.
 */
export async function fetchCustomEmojiMediaProxy(
  botToken: string | null | undefined,
  emojiId: string
): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!isValidCustomEmojiId(emojiId) || !botToken) return null;
  const cleanId = emojiId.trim();

  const cachedMedia = mediaCache.get(cleanId);
  if (cachedMedia && cachedMedia.expiresAt > Date.now()) {
    return { buffer: cachedMedia.buffer, contentType: cachedMedia.contentType };
  }

  const resolvedMap = await resolveCustomEmojiStickers(botToken, [cleanId]);
  const sticker = resolvedMap.get(cleanId);
  if (!sticker || !sticker.valid) return null;

  // Prefer raster static image (`fileId` for static webp; `thumbnailFileId` for animated/video stickers)
  const targetFileId =
    sticker.isAnimated || sticker.isVideo
      ? sticker.thumbnailFileId
      : sticker.fileId || sticker.thumbnailFileId;

  if (!targetFileId) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const getFileUrl = `${TELEGRAM_API_ORIGIN}/bot${encodeURIComponent(botToken)}/getFile?file_id=${encodeURIComponent(
      targetFileId
    )}`;
    const fileMetaRes = await fetch(getFileUrl, { signal: controller.signal });
    if (!fileMetaRes.ok) return null;

    const fileMeta = (await fileMetaRes.json()) as {
      ok?: boolean;
      result?: { file_path?: string };
    };
    const filePath = (fileMeta?.result?.file_path || '').trim();
    // Strict SSRF / path-traversal guard on file_path returned by Telegram
    if (!filePath || filePath.includes('..') || filePath.includes('://') || filePath.startsWith('/')) {
      return null;
    }

    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const downloadUrl = `${TELEGRAM_API_ORIGIN}/file/bot${encodeURIComponent(botToken)}/${encodedPath}`;
    const binRes = await fetch(downloadUrl, { signal: controller.signal });
    if (!binRes.ok) return null;

    const arrBuf = await binRes.arrayBuffer();
    const buffer = Buffer.from(arrBuf);
    if (buffer.length === 0 || buffer.length > 2 * 1024 * 1024) {
      return null;
    }

    const lower = filePath.toLowerCase();
    const contentType = lower.endsWith('.png')
      ? 'image/png'
      : lower.endsWith('.jpg') || lower.endsWith('.jpeg')
        ? 'image/jpeg'
        : 'image/webp';

    setBoundedCache(
      mediaCache,
      cleanId,
      {
        buffer,
        contentType,
        expiresAt: Date.now() + VALID_TTL_MS,
      },
      MAX_MEDIA_CACHE
    );

    return { buffer, contentType };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
