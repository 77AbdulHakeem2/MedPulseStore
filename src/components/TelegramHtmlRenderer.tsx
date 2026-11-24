import React, { useState } from 'react';

function decodeHtmlEntitiesClient(str: string): string {
  return str
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function isSafeHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

interface CustomEmojiBadgeProps {
  emojiId?: string;
  fallback: React.ReactNode;
}

function CustomEmojiNode({ emojiId, fallback }: CustomEmojiBadgeProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const validNumericId = emojiId && /^\d{5,25}$/.test(emojiId);

  if (!validNumericId || imgFailed) {
    return (
      <span
        data-tg-emoji-id={validNumericId ? emojiId : undefined}
        data-tg-emoji-fallback="true"
        title={validNumericId ? `Telegram Custom Emoji #${emojiId}` : undefined}
        className="inline-flex items-center align-baseline"
      >
        {fallback || '✨'}
      </span>
    );
  }

  const altText = typeof fallback === 'string' && fallback.trim() ? fallback.trim() : '✨';

  return (
    <span
      data-tg-emoji-id={emojiId}
      title={`Telegram Custom Emoji #${emojiId}`}
      className="inline-flex items-center justify-center align-[-0.2em] mx-[1px]"
    >
      <img
        src={`/api/telegram/custom-emoji/${emojiId}`}
        alt={altText}
        loading="lazy"
        onError={() => setImgFailed(true)}
        className="inline-block h-[1.25em] w-[1.25em] object-contain"
      />
    </span>
  );
}

interface ExpandableBlockquoteProps {
  children: React.ReactNode;
  compact?: boolean;
}

function ExpandableBlockquoteNode({ children, compact }: ExpandableBlockquoteProps) {
  const [expanded, setExpanded] = useState(false);

  if (compact) {
    return (
      <blockquote dir="auto" className="my-1 border-r-2 border-sky-500 bg-slate-50 px-2 py-1 text-slate-700 rounded-sm">
        {children}
      </blockquote>
    );
  }

  return (
    <blockquote dir="auto" className="my-1.5 rounded-md border-r-2 border-sky-500 bg-slate-50 px-2.5 py-1.5 text-[13px] text-slate-700">
      <div className={expanded ? '' : 'line-clamp-4'}>{children}</div>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="mt-1 text-[11px] font-semibold text-sky-700 hover:underline"
      >
        {expanded ? 'طي الاقتباس' : 'عرض الاقتباس كاملًا'}
      </button>
    </blockquote>
  );
}

interface AstNode {
  type: 'text' | 'el';
  text?: string;
  tag?: string;
  href?: string;
  emojiId?: string;
  expandable?: boolean;
  children?: AstNode[];
}

export interface TelegramHtmlRendererProps {
  html: string | null | undefined;
  compact?: boolean;
  className?: string;
}

/**
 * Shared pure-React Telegram HTML AST Renderer (ZERO dangerouslySetInnerHTML).
 * Safely renders <blockquote>, <blockquote expandable>, <b>/<strong>, <i>/<em>,
 * <u>/<ins>, <s>/<strike>/<del>, <code>, <pre>, <tg-spoiler>, <tg-emoji emoji-id="...">,
 * and safe https:// <a href="..."> links across Bot Console, Web Storefront, and Admin Previews.
 */
export default function TelegramHtmlRenderer({
  html,
  compact = false,
  className = '',
}: TelegramHtmlRendererProps) {
  const source = html || '';
  if (!source) return null;

  const root: AstNode = { type: 'el', tag: 'root', children: [] };
  const stack: AstNode[] = [root];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(\s+(?:[^"'<>]|"[^"]*"|'[^']*')*)?\s*(\/?)>/g;
  let cursor = 0;
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(source)) !== null) {
    if (m.index > cursor) {
      stack[stack.length - 1].children!.push({
        type: 'text',
        text: decodeHtmlEntitiesClient(source.slice(cursor, m.index)),
      });
    }
    cursor = m.index + m[0].length;
    const isClosing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const rawAttrStr = m[3] || '';
    const isSelfClosing = m[4] === '/' || (!isClosing && /\/\s*$/.test(rawAttrStr));
    const attrStr = isSelfClosing ? rawAttrStr.replace(/\s*\/\s*$/, '') : rawAttrStr;

    if (tag === 'br') {
      stack[stack.length - 1].children!.push({ type: 'text', text: '\n' });
      continue;
    }

    if (isClosing) {
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tag === tag) {
          stack.splice(i);
          break;
        }
      }
      continue;
    }

    const hrefMatch = attrStr.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const emojiMatch = attrStr.match(/(?:emoji-id|custom_emoji_id)\s*=\s*(?:"(\d{5,25})"|'(\d{5,25})')/i);
    const node: AstNode = {
      type: 'el',
      tag,
      href: hrefMatch ? decodeHtmlEntitiesClient(hrefMatch[1] || hrefMatch[2] || '') : undefined,
      emojiId: emojiMatch ? emojiMatch[1] || emojiMatch[2] : undefined,
      expandable: tag === 'blockquote' && /\bexpandable\b/i.test(attrStr),
      children: [],
    };
    stack[stack.length - 1].children!.push(node);
    if (!isSelfClosing) {
      stack.push(node);
    }
  }

  if (cursor < source.length) {
    stack[stack.length - 1].children!.push({
      type: 'text',
      text: decodeHtmlEntitiesClient(source.slice(cursor)),
    });
  }

  const renderNode = (node: AstNode, key: string): React.ReactNode => {
    if (node.type === 'text') return node.text || '';
    const kids = (node.children || []).map((c, idx) => renderNode(c, `${key}-${idx}`));
    switch (node.tag) {
      case 'b':
      case 'strong':
        return <strong key={key}>{kids}</strong>;
      case 'i':
      case 'em':
        return <em key={key}>{kids}</em>;
      case 'u':
      case 'ins':
        return (
          <span key={key} className="underline">
            {kids}
          </span>
        );
      case 's':
      case 'strike':
      case 'del':
        return (
          <span key={key} className="line-through">
            {kids}
          </span>
        );
      case 'code':
        return (
          <code key={key} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs text-slate-900">
            {kids}
          </code>
        );
      case 'pre':
        return (
          <pre key={key} className="my-1 overflow-x-auto rounded bg-slate-900 p-2 font-mono text-xs text-slate-100">
            {kids}
          </pre>
        );
      case 'blockquote':
        if (node.expandable) {
          return (
            <ExpandableBlockquoteNode key={key} compact={compact}>
              {kids}
            </ExpandableBlockquoteNode>
          );
        }
        return (
          <blockquote
            key={key}
            dir="auto"
            className={
              compact
                ? 'my-1 border-r-2 border-sky-500 bg-slate-50 px-2 py-0.5 text-slate-700'
                : 'my-1.5 rounded-md border-r-2 border-sky-500 bg-slate-50 px-2.5 py-1.5 text-[13px] text-slate-700'
            }
          >
            {kids}
          </blockquote>
        );
      case 'tg-spoiler':
        return (
          <span key={key} className="rounded bg-slate-200 px-1 text-slate-700" title="Spoiler">
            {kids}
          </span>
        );
      case 'tg-emoji':
        return <CustomEmojiNode key={key} emojiId={node.emojiId} fallback={kids.length > 0 ? kids : '✨'} />;
      case 'a':
        if (node.href && isSafeHttpUrl(node.href)) {
          return (
            <a
              key={key}
              href={node.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-600 underline hover:text-sky-700"
            >
              {kids}
            </a>
          );
        }
        return <React.Fragment key={key}>{kids}</React.Fragment>;
      default:
        return <React.Fragment key={key}>{kids}</React.Fragment>;
    }
  };

  return (
    <div dir="auto" className={`whitespace-pre-line break-words ${className}`}>
      {(root.children || []).map((c, idx) => renderNode(c, `tg-${idx}`))}
    </div>
  );
}
