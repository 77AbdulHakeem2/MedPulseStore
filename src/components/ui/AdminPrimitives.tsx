import React from 'react';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  X,
} from 'lucide-react';
import type { KpiDirection, KpiTone } from '../../lib/kpiSemantics';

/* ============================================================================
 * 1. PageHeader — Concise executive title, optional 1-line subtitle, action slot
 * ========================================================================== */
interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-3.5 md:flex-row md:items-end md:justify-between border-b border-slate-200/80 pb-5">
      <div className="min-w-0">
        <h1 className="text-xl sm:text-[26px] font-bold text-slate-900 tracking-tight leading-tight truncate">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1.5 text-xs sm:text-[13px] text-slate-500 truncate">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2.5 shrink-0 self-start md:self-auto">
          {actions}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * 2. SegmentedTabs — Unified executive tab rail across all workspace views
 * ========================================================================== */
export interface SegmentedTabItem<T extends string> {
  id: T;
  label: string;
  count?: number;
  icon?: React.ComponentType<{ className?: string }>;
}

interface SegmentedTabsProps<T extends string> {
  items: ReadonlyArray<SegmentedTabItem<T>>;
  value: T;
  onChange: (next: T) => void;
}

export function SegmentedTabs<T extends string>({
  items,
  value,
  onChange,
}: SegmentedTabsProps<T>) {
  return (
    <div
      role="tablist"
      className="inline-flex flex-wrap sm:flex-nowrap items-center gap-1 rounded-xl bg-slate-200/65 p-1 border border-slate-200/70"
    >
      {items.map((item) => {
        const active = item.id === value;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.id)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-all duration-150 whitespace-nowrap shrink-0 ${
              active
                ? 'bg-white text-slate-900 shadow-[0_1px_3px_rgba(15,23,42,0.08)]'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {Icon && (
              <Icon
                className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-emerald-700' : 'text-slate-500'}`}
              />
            )}
            <span>{item.label}</span>
            {item.count !== undefined && (
              <span
                className={`font-mono-num text-[11px] ${
                  active ? 'text-slate-500' : 'text-slate-400'
                }`}
              >
                ({item.count})
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ============================================================================
 * 3. KpiCard — Meaning-aware executive metric card (Green=Healthy, Red=Adverse)
 *    Always pairs semantic color with explicit icon/text — never hue-only.
 * ========================================================================== */
interface KpiCardProps {
  label: string;
  value: React.ReactNode;
  tone?: KpiTone;
  direction?: KpiDirection;
  indicatorText?: string;
  meta?: React.ReactNode;
  valueTone?: 'default' | 'positive' | 'negative' | 'warning';
  icon?: React.ComponentType<{ className?: string }>;
}

const INDICATOR_TONE_CLASSES: Record<KpiTone, string> = {
  positive: 'text-emerald-700',
  negative: 'text-rose-600',
  warning: 'text-amber-700',
  neutral: 'text-slate-500',
};

const ICON_SURFACE_CLASSES: Record<KpiTone, string> = {
  positive: 'bg-emerald-50 text-emerald-700',
  negative: 'bg-rose-50 text-rose-600',
  warning: 'bg-amber-50 text-amber-700',
  neutral: 'bg-slate-100 text-slate-600',
};

const VALUE_TONE_CLASSES: Record<NonNullable<KpiCardProps['valueTone']>, string> = {
  default: 'text-slate-900',
  positive: 'text-emerald-700',
  negative: 'text-rose-600',
  warning: 'text-amber-700',
};

export function KpiCard({
  label,
  value,
  tone = 'neutral',
  direction = 'flat',
  indicatorText,
  meta,
  valueTone = 'default',
  icon: CardIcon,
}: KpiCardProps) {
  const renderDirectionIcon = () => {
    if (direction === 'up') return <TrendingUp className="h-3.5 w-3.5 shrink-0" />;
    if (direction === 'down') return <TrendingDown className="h-3.5 w-3.5 shrink-0" />;
    if (tone === 'positive') return <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />;
    if (tone === 'negative') return <XCircle className="h-3.5 w-3.5 shrink-0" />;
    if (tone === 'warning') return <AlertTriangle className="h-3.5 w-3.5 shrink-0" />;
    return <Minus className="h-3.5 w-3.5 shrink-0" />;
  };

  return (
    <div className="bg-white border border-slate-200/85 hover:border-slate-300/90 rounded-2xl p-4 sm:p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition-colors duration-150 flex flex-col justify-between gap-3 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        {CardIcon && (
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${ICON_SURFACE_CLASSES[tone]}`}
          >
            <CardIcon className="h-3.5 w-3.5" />
          </span>
        )}
        <span className="text-xs font-semibold text-slate-600 truncate">{label}</span>
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <div
          className={`font-mono-num text-[26px] leading-none font-bold tracking-tight ${VALUE_TONE_CLASSES[valueTone]}`}
        >
          {value}
        </div>
        {indicatorText && (
          <span
            className={`inline-flex items-center gap-1 text-[11px] font-semibold whitespace-nowrap shrink-0 ${INDICATOR_TONE_CLASSES[tone]}`}
          >
            {renderDirectionIcon()}
            <span>{indicatorText}</span>
          </span>
        )}
      </div>

      {meta && (
        <div className="text-[11px] text-slate-500 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 border-t border-slate-100 pt-2.5">
          {meta}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * 4. SurfacePanel & SectionHeader — Single-elevation hairline container
 * ========================================================================== */
interface SurfacePanelProps {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}

export function SurfacePanel({ children, className = '', padded = false }: SurfacePanelProps) {
  return (
    <div
      className={`bg-white border border-slate-200/85 rounded-2xl shadow-[0_1px_2px_rgba(15,23,42,0.03)] ${
        padded ? 'p-5' : ''
      } ${className}`}
    >
      {children}
    </div>
  );
}

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  icon?: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
}

export function SectionHeader({ title, subtitle, icon: Icon, action }: SectionHeaderProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-slate-100 px-5 py-4">
      <div className="flex items-center gap-2.5 min-w-0">
        {Icon && (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
            <Icon className="h-3.5 w-3.5" />
          </span>
        )}
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-slate-900 truncate">{title}</h2>
          {subtitle && <p className="text-[11px] text-slate-500 truncate mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/* ============================================================================
 * 5. SemanticStatus — Clean unboxed status indicator (Zero pill capsule clutter)
 * ========================================================================== */
interface SemanticStatusProps {
  tone: KpiTone;
  label: string;
}

export function SemanticStatus({ tone, label }: SemanticStatusProps) {
  if (tone === 'positive') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 whitespace-nowrap">
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
        <span>{label}</span>
      </span>
    );
  }
  if (tone === 'negative') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-700 whitespace-nowrap">
        <XCircle className="h-3.5 w-3.5 text-rose-600 shrink-0" />
        <span>{label}</span>
      </span>
    );
  }
  if (tone === 'warning') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 whitespace-nowrap">
        <Clock className="h-3.5 w-3.5 text-amber-600 shrink-0" />
        <span>{label}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 whitespace-nowrap">
      <Minus className="h-3.5 w-3.5 text-slate-400 shrink-0" />
      <span>{label}</span>
    </span>
  );
}

/* ============================================================================
 * 6. FeedbackBanner — Crisp dismissible inline toast banner
 * ========================================================================== */
interface FeedbackBannerProps {
  type: 'ok' | 'err' | 'warn';
  text: string;
  onDismiss?: () => void;
}

export function FeedbackBanner({ type, text, onDismiss }: FeedbackBannerProps) {
  const cls =
    type === 'ok'
      ? 'border-emerald-200/90 bg-emerald-50/85 text-emerald-900'
      : type === 'warn'
        ? 'border-amber-200/90 bg-amber-50/85 text-amber-900'
        : 'border-rose-200/90 bg-rose-50/85 text-rose-900';

  const Icon = type === 'ok' ? CheckCircle2 : type === 'warn' ? AlertTriangle : XCircle;
  const iconCls =
    type === 'ok' ? 'text-emerald-600' : type === 'warn' ? 'text-amber-600' : 'text-rose-600';

  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-xs sm:text-[13px] font-medium ${cls}`}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <Icon className={`h-4 w-4 shrink-0 ${iconCls}`} />
        <span className="leading-relaxed">{text}</span>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="إغلاق التنبيه"
          className="rounded-lg p-1 opacity-60 hover:opacity-100 hover:bg-black/5 transition-all shrink-0"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/* ============================================================================
 * 7. ModalShell — Executive dialog shell with crisp backdrop and clear header
 * ========================================================================== */
interface ModalShellProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  maxWidthClass?: string;
}

export function ModalShell({
  title,
  subtitle,
  onClose,
  children,
  maxWidthClass = 'max-w-lg',
}: ModalShellProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 backdrop-blur-[2px] p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className={`w-full ${maxWidthClass} rounded-2xl border border-slate-200/90 bg-white shadow-[0_24px_48px_-12px_rgba(15,23,42,0.22)] max-h-[90vh] flex flex-col overflow-hidden`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-6 py-4">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-slate-900 truncate">{title}</h3>
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق النافذة"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

/* ============================================================================
 * 8. EmptyState — Clean executive zero-data placeholder
 * ========================================================================== */
interface EmptyStateProps {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
}

export function EmptyState({ icon: Icon, title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-8 px-4">
      {Icon && (
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100 text-slate-500 mb-3">
          <Icon className="h-5 w-5" />
        </span>
      )}
      <h3 className="text-sm font-bold text-slate-900">{title}</h3>
      {description && (
        <p className="mt-1 text-xs text-slate-500 max-w-md leading-relaxed">{description}</p>
      )}
    </div>
  );
}

