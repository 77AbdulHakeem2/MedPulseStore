import React, { useMemo } from 'react';
import {
  ArrowUpLeft,
  ArrowUpRight,
  BarChart3,
  Bell,
  CheckCircle2,
  Package,
  ReceiptText,
  Server,
  ShieldAlert,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { classifyOperationStatusVisual } from '../lib/operationsUtils';
import {
  computeDailyOrderSeries,
  computeDashboardPeriodMetrics,
} from '../lib/kpiSemantics';
import type { WebLang } from '../lib/webLocale';
import {
  KpiCard,
  PageHeader,
  SectionHeader,
  SemanticStatus,
  SurfacePanel,
} from './ui/AdminPrimitives';

interface OverviewDashboardViewProps {
  storeProfile: Record<string, any>;
  overview: any;
  orders: any[];
  deposits: any[];
  providers: any[];
  products: any[];
  customers: any[];
  loadingData: boolean;
  webLang?: WebLang;
  onNavigate: (
    section:
      | 'overview'
      | 'buttons'
      | 'telegram'
      | 'providers'
      | 'products'
      | 'operations'
      | 'referrals'
      | 'settings'
  ) => void;
}

export default function OverviewDashboardView({
  storeProfile,
  overview,
  orders,
  deposits,
  providers,
  products,
  customers,
  loadingData,
  webLang = 'ar',
  onNavigate,
}: OverviewDashboardViewProps) {
  const isEn = webLang === 'en';
  const DirArrow = isEn ? ArrowUpRight : ArrowUpLeft;

  const m = useMemo(
    () =>
      computeDashboardPeriodMetrics({
        overview,
        orders,
        deposits,
        providers,
        products,
        customers,
      }),
    [overview, orders, deposits, providers, products, customers]
  );

  const dailySeries = useMemo(() => computeDailyOrderSeries(orders, 7), [orders]);
  const maxDailyRevenue = useMemo(
    () => Math.max(...dailySeries.map((d) => d.revenue), 0),
    [dailySeries]
  );
  const maxDailyOrders = useMemo(
    () => Math.max(...dailySeries.map((d) => d.totalCount), 0),
    [dailySeries]
  );
  const total7dRevenue = useMemo(
    () => Number(dailySeries.reduce((sum, d) => sum + d.revenue, 0).toFixed(2)),
    [dailySeries]
  );
  const total7dOrders = useMemo(
    () => dailySeries.reduce((sum, d) => sum + d.totalCount, 0),
    [dailySeries]
  );

  const isStoreOpen = storeProfile.isStoreOpen !== false;
  const storeTitle = isEn
    ? storeProfile.storeNameEn || storeProfile.storeName || 'Raqm Store'
    : storeProfile.storeName || 'متجر رَقْم';

  return (
    <div className="space-y-6">
      <PageHeader
        title={isEn ? `${storeTitle} Overview` : `ملخص ${storeTitle}`}
        subtitle={
          isEn
            ? 'Live financial performance, supplier health, and order fulfillment status'
            : 'مؤشرات الأداء المالي، صحة الخوادم، وحالة الطلبات المباشرة'
        }
        actions={
          <div className="flex items-center gap-4">
            <SemanticStatus
              tone={isStoreOpen ? 'positive' : 'negative'}
              label={
                isStoreOpen
                  ? isEn
                    ? 'Store Open'
                    : 'المتجر مفتوح'
                  : isEn
                    ? 'Maintenance'
                    : 'متوقف للصيانة'
              }
            />
            <button
              type="button"
              onClick={() => onNavigate('products')}
              className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              <span>{isEn ? 'Manage Products' : 'إدارة المنتجات'}</span>
              <DirArrow className="h-3.5 w-3.5" />
            </button>
          </div>
        }
      />

      {/* Primary Meaning-Aware 4-Column Executive KPI Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          icon={TrendingUp}
          label={isEn ? 'Net Profit' : 'صافي الأرباح'}
          value={`$${m.netProfit.toFixed(2)}`}
          valueTone={m.netProfit > 0 ? 'positive' : m.netProfit < 0 ? 'negative' : 'default'}
          tone={m.profitPolarity.tone}
          direction={m.profitPolarity.direction}
          indicatorText={
            m.profitPolarity.deltaFormatted
              ? `${m.profitPolarity.deltaFormatted} (${isEn ? '7d' : '7 أيام'})`
              : `${isEn ? 'Margin' : 'هامش'} ${m.profitMarginPercent}%`
          }
          meta={
            <>
              <span>{isEn ? 'Revenue' : 'المبيعات'}</span>
              <strong className="font-mono-num text-slate-700">${m.revenue.toFixed(2)}</strong>
              <span aria-hidden="true">·</span>
              <span>{isEn ? 'Cost' : 'الجملة'}</span>
              <strong className="font-mono-num text-slate-700">${m.wholesale.toFixed(2)}</strong>
            </>
          }
        />

        <KpiCard
          icon={CheckCircle2}
          label={isEn ? 'Order Success Rate' : 'نجاح الطلبات'}
          value={`${m.successRatePercent}%`}
          valueTone={m.failedOrders > 0 && m.successRatePercent < 90 ? 'negative' : 'positive'}
          tone={m.failedOrders > 0 ? 'negative' : 'positive'}
          direction={m.failedOrders > 0 ? 'down' : 'up'}
          indicatorText={
            m.failedOrders > 0
              ? isEn
                ? `${m.failedOrders} failed`
                : `${m.failedOrders} فاشل`
              : isEn
                ? 'Zero failures'
                : 'دون إخفاقات'
          }
          meta={
            <>
              <span className="text-emerald-700 font-semibold">
                <span className="font-mono-num">{m.completedOrders}</span> {isEn ? 'ok' : 'ناجح'}
              </span>
              <span aria-hidden="true">·</span>
              <span
                className={
                  m.failedOrders > 0 ? 'text-rose-600 font-semibold' : 'text-slate-500'
                }
              >
                <span className="font-mono-num">{m.failedOrders}</span> {isEn ? 'failed' : 'فاشل'}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                <span className="font-mono-num">{m.totalOrders}</span> {isEn ? 'total' : 'إجمالي'}
              </span>
            </>
          }
        />

        <KpiCard
          icon={Server}
          label={isEn ? 'Supplier Balance & Health' : 'رصيد وصحة الخوادم'}
          value={`$${m.providerBalance.toFixed(2)}`}
          valueTone="default"
          tone={m.providerHealthPolarity.tone}
          direction={m.providerHealthPolarity.direction}
          indicatorText={
            m.errorProviders > 0
              ? isEn
                ? `${m.errorProviders} error`
                : `${m.errorProviders} خطأ اتصال`
              : `${m.connectedProviders}/${m.totalProviders} ${isEn ? 'online' : 'متصل'}`
          }
          meta={
            <>
              <span>{isEn ? 'Published' : 'المنتجات المنشورة'}</span>
              <strong className="font-mono-num text-emerald-700">{m.publishedProducts}</strong>
              <span aria-hidden="true">·</span>
              <span>{isEn ? 'Hidden' : 'مخفي'}</span>
              <strong className="font-mono-num text-slate-700">{m.hiddenProducts}</strong>
              {m.outOfStockPublished > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <strong className="font-mono-num text-rose-600">
                    {m.outOfStockPublished} {isEn ? 'out' : 'نافذ'}
                  </strong>
                </>
              )}
            </>
          }
        />

        <KpiCard
          icon={Wallet}
          label={isEn ? 'Pending Deposits' : 'إيداعات قيد المراجعة'}
          value={m.pendingDepositsCount}
          valueTone={m.pendingDepositsCount > 0 ? 'warning' : 'positive'}
          tone={m.pendingDepositsPolarity.tone}
          direction={m.pendingDepositsPolarity.direction}
          indicatorText={
            m.pendingDepositsCount > 0
              ? `$${m.pendingDepositsAmount.toFixed(2)} ${isEn ? 'pending' : 'معلق'}`
              : isEn
                ? 'All clear'
                : 'لا توجد معلقات'
          }
          meta={
            <>
              <span>{isEn ? 'Customers' : 'العملاء'}</span>
              <strong className="font-mono-num text-slate-700">{m.totalCustomers}</strong>
              {m.blockedCustomers > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <strong className="font-mono-num text-rose-600">
                    {m.blockedCustomers} {isEn ? 'blocked' : 'محظور'}
                  </strong>
                </>
              )}
            </>
          }
        />
      </div>

      {/* Main Executive Split: Performance + Orders (7 cols) | Health & Alerts (5 cols) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        <div className="lg:col-span-7 space-y-6">
          {/* 7-Day Real Revenue & Orders Breakdown (Strictly Real DB Data) */}
          <SurfacePanel>
            <SectionHeader
              title={isEn ? '7-Day Order & Revenue Activity' : 'نشاط الطلبات والمبيعات (آخر 7 أيام)'}
              subtitle={
                isEn
                  ? `${total7dOrders} orders · $${total7dRevenue.toFixed(2)} revenue`
                  : `${total7dOrders} طلب · مبيعات بقيمة $${total7dRevenue.toFixed(2)}`
              }
              icon={BarChart3}
              action={
                <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 whitespace-nowrap">
                  <span>{isEn ? 'Net' : 'صافي'}</span>
                  <span className="font-mono-num">+${m.profit7d.toFixed(2)}</span>
                </span>
              }
            />
            <div className="p-5">
              {total7dOrders > 0 ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-7 gap-2.5 items-end h-36 pt-4">
                    {dailySeries.map((day) => {
                      const heightRatio =
                        maxDailyRevenue > 0
                          ? day.revenue / maxDailyRevenue
                          : maxDailyOrders > 0
                            ? day.totalCount / maxDailyOrders
                            : 0;
                      const barPct = day.totalCount > 0 ? Math.max(16, Math.round(heightRatio * 100)) : 4;
                      const hasOnlyFailed = day.completedCount === 0 && day.failedCount > 0;
                      return (
                        <div
                          key={day.dateKey}
                          className="flex flex-col items-center justify-end gap-1.5 h-full group"
                        >
                          <div className="text-[10px] font-mono-num font-semibold text-slate-500 group-hover:text-slate-900 transition-colors">
                            {day.revenue > 0
                              ? `$${day.revenue.toFixed(0)}`
                              : day.totalCount > 0
                                ? `${day.totalCount}`
                                : '—'}
                          </div>
                          <div className="w-full flex-1 flex items-end justify-center">
                            <div
                              title={`${day.dateKey}: ${day.completedCount} ok, ${day.failedCount} failed, $${day.revenue.toFixed(2)}`}
                              className={`w-full max-w-[34px] rounded-t-lg transition-all duration-200 ${
                                day.totalCount === 0
                                  ? 'bg-slate-100'
                                  : hasOnlyFailed
                                    ? 'bg-rose-500/80 group-hover:bg-rose-600'
                                    : 'bg-emerald-600/85 group-hover:bg-emerald-700'
                              }`}
                              style={{ height: `${barPct}%` }}
                            />
                          </div>
                          <span className="text-[10px] font-mono-num text-slate-400">
                            {isEn ? day.labelEn : day.labelAr}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 text-[11px] text-slate-500">
                    <span>
                      {isEn
                        ? 'Computed directly from confirmed store orders.'
                        : 'محسوب مباشرة من سجل الطلبات الفعلي دون أي تقديرات.'}
                    </span>
                    <span className="text-slate-700 font-semibold">
                      {isEn ? 'Profit Margin' : 'هامش الربح'}:{' '}
                      <span className="font-mono-num">{m.profitMarginPercent}%</span>
                    </span>
                  </div>
                </div>
              ) : (
                <div className="py-8 text-center text-xs text-slate-400">
                  {isEn
                    ? 'No orders recorded in the last 7 days.'
                    : 'لا توجد طلبات مسجلة خلال الأيام السبعة الماضية.'}
                </div>
              )}
            </div>
          </SurfacePanel>

          {/* Recent Orders Executive Table */}
          <SurfacePanel className="overflow-hidden">
            <SectionHeader
              title={isEn ? 'Recent Orders' : 'أحدث الطلبات'}
              icon={ReceiptText}
              action={
                <button
                  type="button"
                  onClick={() => onNavigate('operations')}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:text-emerald-800 whitespace-nowrap"
                >
                  <span>{isEn ? 'All Operations' : 'كل العمليات'}</span>
                  <DirArrow className="h-3.5 w-3.5" />
                </button>
              }
            />
            <div className="overflow-x-auto">
              <table className={`w-full border-collapse ${isEn ? 'text-left' : 'text-right'}`}>
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                    <th className="py-2.5 px-4">{isEn ? 'Order' : 'الطلب'}</th>
                    <th className="py-2.5 px-4">{isEn ? 'Customer' : 'العميل'}</th>
                    <th className="py-2.5 px-4">{isEn ? 'Total' : 'البيع'}</th>
                    <th className="py-2.5 px-4">{isEn ? 'Net Profit' : 'صافي الربح'}</th>
                    <th className="py-2.5 px-4">{isEn ? 'Status' : 'الحالة'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {(overview?.recentOrders || []).map((o: any) => {
                    const visual = classifyOperationStatusVisual(o.status);
                    const tone =
                      visual.category === 'success'
                        ? 'positive'
                        : visual.category === 'failed'
                          ? 'negative'
                          : 'warning';
                    const statusLabel = isEn
                      ? visual.category === 'success'
                        ? 'Completed'
                        : visual.category === 'failed'
                          ? 'Failed'
                          : 'Pending'
                      : visual.labelAr;
                    return (
                      <tr key={o.id} className="hover:bg-slate-50/70 transition-colors">
                        <td className="py-3 px-4 font-mono-num font-semibold text-slate-900">
                          {o.orderNumber}
                        </td>
                        <td className="py-3 px-4 text-slate-700 truncate max-w-[140px]">
                          {o.customerName}
                        </td>
                        <td className="py-3 px-4 font-mono-num font-medium text-slate-900">
                          ${o.totalRetail}
                        </td>
                        <td
                          className={`py-3 px-4 font-mono-num font-bold ${
                            visual.category === 'failed'
                              ? 'text-rose-600 line-through'
                              : 'text-emerald-700'
                          }`}
                        >
                          {visual.category === 'failed' ? `$${o.netProfit}` : `+$${o.netProfit}`}
                        </td>
                        <td className="py-3 px-4">
                          <SemanticStatus tone={tone} label={statusLabel} />
                        </td>
                      </tr>
                    );
                  })}
                  {(!overview?.recentOrders || overview.recentOrders.length === 0) && (
                    <tr>
                      <td colSpan={5} className="py-10 text-center text-xs text-slate-400">
                        {loadingData
                          ? isEn
                            ? 'Loading data...'
                            : 'جارٍ تحميل البيانات...'
                          : isEn
                            ? 'No orders recorded yet.'
                            : 'لا توجد طلبات مسجلة بعد.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </SurfacePanel>
        </div>

        {/* Right/End Column: Operational Health & Urgent Notifications */}
        <div className="lg:col-span-5 space-y-6">
          <SurfacePanel>
            <SectionHeader
              title={isEn ? 'Operational Snapshot' : 'حالة التشغيل الفورية'}
              icon={Server}
              action={
                <button
                  type="button"
                  onClick={() => onNavigate('providers')}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-slate-600 hover:text-slate-900 whitespace-nowrap"
                >
                  <span>{isEn ? 'Providers' : 'الخوادم'}</span>
                  <DirArrow className="h-3.5 w-3.5" />
                </button>
              }
            />
            <div className="divide-y divide-slate-100 px-5 text-xs">
              <div className="py-3.5 flex items-center justify-between gap-2">
                <span className="text-slate-600 flex items-center gap-2">
                  <Server className="h-3.5 w-3.5 text-slate-400" />
                  {isEn ? 'Connected Suppliers' : 'الخوادم المتصلة'}
                </span>
                <span
                  className={`font-mono-num font-bold ${
                    m.connectedProviders > 0 ? 'text-emerald-700' : 'text-rose-600'
                  }`}
                >
                  {m.connectedProviders} / {m.totalProviders}
                </span>
              </div>
              <div className="py-3.5 flex items-center justify-between gap-2">
                <span className="text-slate-600 flex items-center gap-2">
                  <Package className="h-3.5 w-3.5 text-slate-400" />
                  {isEn ? 'Published Out-of-Stock' : 'منتجات منشورة نافذة المخزون'}
                </span>
                <span
                  className={`font-mono-num font-bold ${
                    m.outOfStockPublished > 0 ? 'text-rose-600' : 'text-emerald-700'
                  }`}
                >
                  {m.outOfStockPublished}
                </span>
              </div>
              <div className="py-3.5 flex items-center justify-between gap-2">
                <span className="text-slate-600 flex items-center gap-2">
                  <ShieldAlert className="h-3.5 w-3.5 text-slate-400" />
                  {isEn ? 'Blocked Accounts' : 'حسابات محظورة'}
                </span>
                <span
                  className={`font-mono-num font-bold ${
                    m.blockedCustomers > 0 ? 'text-rose-600' : 'text-slate-700'
                  }`}
                >
                  {m.blockedCustomers}
                </span>
              </div>
            </div>
          </SurfacePanel>

          <SurfacePanel>
            <SectionHeader
              title={isEn ? 'Unread Notifications' : 'التنبيهات غير المقروءة'}
              icon={Bell}
              action={
                <button
                  type="button"
                  onClick={() => onNavigate('settings')}
                  className="text-xs font-semibold text-emerald-700 hover:text-emerald-800 whitespace-nowrap"
                >
                  {isEn ? 'Full Log' : 'السجل الكامل'}
                </button>
              }
            />
            <div className="divide-y divide-slate-100 px-5">
              {(overview?.unreadNotifications || []).slice(0, 5).map((n: any) => (
                <div key={n.id} className="py-3.5 text-xs">
                  <div className="font-semibold text-slate-900">{n.titleAr}</div>
                  <div className="mt-1 text-slate-500 line-clamp-2 leading-relaxed">{n.bodyAr}</div>
                </div>
              ))}
              {(!overview?.unreadNotifications || overview.unreadNotifications.length === 0) && (
                <div className="py-9 flex flex-col items-center gap-2 text-center text-xs text-slate-400">
                  <CheckCircle2 className="h-5 w-5 text-emerald-600/75" />
                  <span>
                    {isEn
                      ? 'System healthy — no unread alerts.'
                      : 'النظام مستقر — لا توجد تنبيهات معلقة'}
                  </span>
                </div>
              )}
            </div>
          </SurfacePanel>
        </div>
      </div>
    </div>
  );
}
