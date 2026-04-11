import { useState, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { cn } from '@/lib/utils';
import { format, subDays, startOfWeek, startOfMonth, isWithinInterval, parseISO } from 'date-fns';
import {
  TrendingUp, Package, Truck, XCircle, CheckCircle,
  ArrowUpRight, ArrowDownRight, Clock, PackageCheck, Loader2,
  ShoppingBag, RefreshCw, BarChart2, Download, TrendingDown,
  BarChart3 as BarChartIcon, PieChart as PieChartIcon,
  Sparkles,
} from 'lucide-react';

type ViewMode = 'daily' | 'weekly' | 'monthly';

const STATUS_META: Record<string, { label: string; color: string; bg: string; border: string; icon: any; chartColor: string; dot: string }> = {
  pending:    { label: 'Pending',    color: 'text-amber-600',   bg: 'bg-amber-50 dark:bg-amber-950/30',   border: 'border-amber-200/60 dark:border-amber-800/40',   icon: Clock,        chartColor: 'hsl(38,92%,50%)',  dot: '#f59e0b' },
  confirmed:  { label: 'Confirmed',  color: 'text-blue-600',    bg: 'bg-blue-50 dark:bg-blue-950/30',     border: 'border-blue-200/60 dark:border-blue-800/40',     icon: CheckCircle,  chartColor: 'hsl(217,91%,60%)', dot: '#3b82f6' },
  processing: { label: 'Processing', color: 'text-violet-600',  bg: 'bg-violet-50 dark:bg-violet-950/30', border: 'border-violet-200/60 dark:border-violet-800/40', icon: Package,      chartColor: 'hsl(270,70%,60%)', dot: '#8b5cf6' },
  shipped:    { label: 'Shipped',    color: 'text-cyan-600',    bg: 'bg-cyan-50 dark:bg-cyan-950/30',     border: 'border-cyan-200/60 dark:border-cyan-800/40',     icon: Truck,        chartColor: 'hsl(185,85%,45%)', dot: '#06b6d4' },
  delivered:  { label: 'Delivered',  color: 'text-emerald-600', bg: 'bg-emerald-50 dark:bg-emerald-950/30', border: 'border-emerald-200/60 dark:border-emerald-800/40', icon: PackageCheck, chartColor: 'hsl(142,71%,45%)', dot: '#10b981' },
  cancelled:  { label: 'Cancelled',  color: 'text-red-500',     bg: 'bg-red-50 dark:bg-red-950/30',       border: 'border-red-200/60 dark:border-red-800/40',       icon: XCircle,      chartColor: 'hsl(0,84%,60%)',   dot: '#ef4444' },
};

type SummaryType = {
  total: number; revenue: number; totalChange: number; revenueChange: number;
  statuses: Record<string, { count: number; change: number }>;
};
type ChartRow = { label: string; total: number; delivered: number; cancelled: number; pending: number; revenue: number };

async function exportPageAsPDF(
  pageEl: HTMLElement | null,
  viewMode: ViewMode,
  setDownloading: (v: boolean) => void,
) {
  if (!pageEl) return;
  setDownloading(true);
  try {
    const html2canvas = (await import('html2canvas')).default;
    const { jsPDF } = await import('jspdf');

    const canvas = await html2canvas(pageEl, {
      scale: 2,
      useCORS: true,
      logging: false,
      backgroundColor: '#ffffff',
      windowWidth: pageEl.scrollWidth,
      height: pageEl.scrollHeight,
      scrollY: 0,
    });

    const imgData = canvas.toDataURL('image/png');
    const imgW = canvas.width;
    const imgH = canvas.height;

    const PDF_W = 210; // A4 mm width
    const PDF_H = (imgH / imgW) * PDF_W;

    const pdf = new jsPDF({
      orientation: PDF_H > PDF_W ? 'p' : 'l',
      unit: 'mm',
      format: [PDF_W, PDF_H],
    });

    pdf.addImage(imgData, 'PNG', 0, 0, PDF_W, PDF_H);

    // Footer
    const C = { muted: [100,116,139] as [number,number,number], light: [241,245,249] as [number,number,number], slate: [226,232,240] as [number,number,number] };
    const pH = pdf.internal.pageSize.getHeight();
    pdf.setFillColor(...C.light); pdf.rect(0, pH - 10, PDF_W, 10, 'F');
    pdf.setDrawColor(...C.slate); pdf.setLineWidth(0.3); pdf.line(0, pH - 10, PDF_W, pH - 10);
    pdf.setTextColor(...C.muted); pdf.setFontSize(7); pdf.setFont('helvetica', 'normal');
    pdf.text('Chat Monitor — Analytics Report', 14, pH - 3.5);
    pdf.text(`${viewMode.charAt(0).toUpperCase() + viewMode.slice(1)} · ${format(new Date(), 'dd MMM yyyy HH:mm')}`, PDF_W - 14, pH - 3.5, { align: 'right' });

    pdf.save(`analytics-report-${format(new Date(), 'dd-MMM-yyyy')}.pdf`);
  } catch (e) {
    console.error(e);
  } finally {
    setDownloading(false);
  }
}

const OrderAnalytics = () => {
  const [viewMode, setViewMode] = useState<ViewMode>('daily');
  const [days] = useState(90);
  const [isDownloading, setIsDownloading] = useState(false);
  const [orderChartType, setOrderChartType] = useState<'area' | 'bar'>('area');
  const pageRef = useRef<HTMLDivElement>(null);

  const { data: orders = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['orders-analytics'],
    queryFn: async () => {
      const { data, error } = await supabase.from('orders').select('*').order('created_at', { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 30000,
  });

  const dateRange = useMemo(() => ({ end: new Date(), start: subDays(new Date(), days) }), [days]);

  const filteredOrders = useMemo(() =>
    orders.filter(o => isWithinInterval(parseISO(o.created_at), dateRange)), [orders, dateRange]);

  const previousOrders = useMemo(() => {
    const end = subDays(dateRange.start, 1);
    const start = subDays(end, days);
    return orders.filter(o => isWithinInterval(parseISO(o.created_at), { start, end }));
  }, [orders, dateRange, days]);

  const calcChange = (curr: number, prev: number) =>
    prev === 0 ? (curr > 0 ? 100 : 0) : Math.round(((curr - prev) / prev) * 100);

  const summary = useMemo(() => {
    const count = (s: string) => filteredOrders.filter(o => o.status === s).length;
    const prevCount = (s: string) => previousOrders.filter(o => o.status === s).length;
    const total = filteredOrders.length;
    const revenue = filteredOrders.reduce((s, o) => s + (Number(o.total_price) || 0), 0);
    const prevTotal = previousOrders.length;
    const prevRevenue = previousOrders.reduce((s, o) => s + (Number(o.total_price) || 0), 0);
    return {
      total, revenue,
      totalChange: calcChange(total, prevTotal),
      revenueChange: calcChange(revenue, prevRevenue),
      statuses: {
        pending:    { count: count('pending'),    change: calcChange(count('pending'),    prevCount('pending')) },
        confirmed:  { count: count('confirmed'),  change: calcChange(count('confirmed'),  prevCount('confirmed')) },
        processing: { count: count('processing'), change: calcChange(count('processing'), prevCount('processing')) },
        shipped:    { count: count('shipped'),    change: calcChange(count('shipped'),    prevCount('shipped')) },
        delivered:  { count: count('delivered'),  change: calcChange(count('delivered'),  prevCount('delivered')) },
        cancelled:  { count: count('cancelled'),  change: calcChange(count('cancelled'),  prevCount('cancelled')) },
      },
    };
  }, [filteredOrders, previousOrders]);

  const chartData = useMemo(() => {
    const buckets: Record<string, ChartRow> = {};
    filteredOrders.forEach(order => {
      const d = parseISO(order.created_at);
      let key: string, label: string;
      if (viewMode === 'daily') { key = format(d, 'yyyy-MM-dd'); label = format(d, 'dd MMM'); }
      else if (viewMode === 'weekly') { const ws = startOfWeek(d, { weekStartsOn: 6 }); key = format(ws, 'yyyy-MM-dd'); label = `W${format(ws, 'dd MMM')}`; }
      else { const ms = startOfMonth(d); key = format(ms, 'yyyy-MM'); label = format(ms, 'MMM yy'); }
      if (!buckets[key]) buckets[key] = { label, total: 0, delivered: 0, cancelled: 0, pending: 0, revenue: 0 };
      buckets[key].total++;
      if (order.status === 'delivered') buckets[key].delivered++;
      if (order.status === 'cancelled') buckets[key].cancelled++;
      if (order.status === 'pending') buckets[key].pending++;
      buckets[key].revenue += Number(order.total_price) || 0;
    });
    return Object.values(buckets);
  }, [filteredOrders, viewMode]);

  const statusPieData = useMemo(() =>
    Object.entries(summary.statuses)
      .filter(([, v]) => v.count > 0)
      .map(([key, v]) => ({ name: STATUS_META[key].label, value: v.count, color: STATUS_META[key].chartColor, dot: STATUS_META[key].dot })),
    [summary]);

  if (isLoading) {
    return (
      <div className="space-y-3 p-1">
        <div className="h-10 w-64 rounded bg-muted/40 animate-pulse" />
        <div className="grid grid-cols-2 gap-3">
          {[...Array(4)].map((_, i) => <div key={i} className="h-[90px] rounded-xl bg-muted/40 animate-pulse" />)}
        </div>
        <div className="h-64 rounded-xl bg-muted/40 animate-pulse" />
        <div className="h-48 rounded-xl bg-muted/40 animate-pulse" />
      </div>
    );
  }

  const viewLabel = viewMode === 'daily' ? 'Day' : viewMode === 'weekly' ? 'Week' : 'Month';
  const avgOrder = summary.total > 0 ? Math.round(summary.revenue / summary.total) : 0;

  return (
    <div ref={pageRef} className="space-y-3">

      {/* ── Amazon-style top toolbar ───────────────────────── */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center rounded-md border border-[#D5D9D9] dark:border-border overflow-hidden text-[12px] font-medium">
          {(['daily', 'weekly', 'monthly'] as ViewMode[]).map((m, idx) => (
            <button key={m} onClick={() => setViewMode(m)}
              className={cn(
                'px-3.5 py-1.5 transition-colors',
                idx !== 0 && 'border-l border-[#D5D9D9] dark:border-border',
                viewMode === m
                  ? 'bg-[#FFE9C0] dark:bg-amber-900/30 text-[#C45500] dark:text-amber-400 font-semibold'
                  : 'bg-white dark:bg-card text-[#0F1111] dark:text-foreground hover:bg-[#F7F8F8] dark:hover:bg-muted/40'
              )}
            >{m.charAt(0).toUpperCase() + m.slice(1)}</button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => refetch()} disabled={isFetching}
            className="flex items-center gap-1.5 text-[11.5px] font-medium text-[#007185] dark:text-blue-400 hover:text-[#C45500] dark:hover:text-amber-400 px-3 py-1.5 rounded border border-[#D5D9D9] dark:border-border bg-white dark:bg-card transition-colors"
          >
            <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} /> Refresh
          </button>
          <button
            onClick={() => exportPageAsPDF(pageRef.current, viewMode, setIsDownloading)}
            disabled={isDownloading}
            className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[#0F1111] dark:text-foreground px-4 py-1.5 rounded border border-[#FFA41C] bg-gradient-to-b from-[#FFD78C] to-[#F5A623] dark:from-amber-500 dark:to-amber-600 hover:from-[#F5C26B] hover:to-[#E8951E] transition-all disabled:opacity-60 shadow-sm"
          >
            {isDownloading ? <><Loader2 size={12} className="animate-spin" /> Generating…</> : <><Download size={12} /> Export PDF</>}
          </button>
        </div>
      </div>

      {/* ── 4-metric KPI row ───────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2.5">
        {/* Revenue */}
        <div className="bg-white dark:bg-card border border-[#D5D9D9] dark:border-border rounded-xl p-4">
          <p className="text-[10.5px] font-semibold text-[#565959] dark:text-muted-foreground uppercase tracking-wide mb-2">Revenue</p>
          <div className="flex items-end justify-between gap-2">
            <p className="text-[28px] font-black leading-none text-[#C45500] dark:text-amber-500 tracking-tight">
              ৳{summary.revenue.toLocaleString()}
            </p>
            {summary.revenueChange !== 0 && (
              <span className={cn(
                'flex items-center gap-0.5 text-[11px] font-bold mb-0.5',
                summary.revenueChange >= 0 ? 'text-[#007600] dark:text-emerald-400' : 'text-[#CC0C39] dark:text-red-400'
              )}>
                {summary.revenueChange >= 0 ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
                {Math.abs(summary.revenueChange)}%
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-2.5 pt-2.5 border-t border-[#EAEDED] dark:border-border/40">
            <TrendingUp size={11} className="text-[#565959] dark:text-muted-foreground" />
            <span className="text-[10px] text-[#565959] dark:text-muted-foreground">Total in period</span>
          </div>
        </div>

        {/* Orders */}
        <div className="bg-white dark:bg-card border border-[#D5D9D9] dark:border-border rounded-xl p-4">
          <p className="text-[10.5px] font-semibold text-[#565959] dark:text-muted-foreground uppercase tracking-wide mb-2">Orders</p>
          <div className="flex items-end justify-between gap-2">
            <p className="text-[28px] font-black leading-none text-[#0F1111] dark:text-foreground tracking-tight">
              {summary.total.toLocaleString()}
            </p>
            {summary.totalChange !== 0 && (
              <span className={cn(
                'flex items-center gap-0.5 text-[11px] font-bold mb-0.5',
                summary.totalChange >= 0 ? 'text-[#007600] dark:text-emerald-400' : 'text-[#CC0C39] dark:text-red-400'
              )}>
                {summary.totalChange >= 0 ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
                {Math.abs(summary.totalChange)}%
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-2.5 pt-2.5 border-t border-[#EAEDED] dark:border-border/40">
            <ShoppingBag size={11} className="text-[#565959] dark:text-muted-foreground" />
            <span className="text-[10px] text-[#565959] dark:text-muted-foreground">Total in period</span>
          </div>
        </div>

        {/* Avg Order Value */}
        <div className="bg-white dark:bg-card border border-[#D5D9D9] dark:border-border rounded-xl p-4">
          <p className="text-[10.5px] font-semibold text-[#565959] dark:text-muted-foreground uppercase tracking-wide mb-2">Avg. Order</p>
          <p className="text-[28px] font-black leading-none text-[#0F1111] dark:text-foreground tracking-tight">৳{avgOrder.toLocaleString()}</p>
          <div className="flex items-center gap-1.5 mt-2.5 pt-2.5 border-t border-[#EAEDED] dark:border-border/40">
            <Sparkles size={11} className="text-[#565959] dark:text-muted-foreground" />
            <span className="text-[10px] text-[#565959] dark:text-muted-foreground">Per order avg</span>
          </div>
        </div>

        {/* Delivered */}
        <div className="bg-white dark:bg-card border border-[#D5D9D9] dark:border-border rounded-xl p-4">
          <p className="text-[10.5px] font-semibold text-[#565959] dark:text-muted-foreground uppercase tracking-wide mb-2">Delivered</p>
          <div className="flex items-end justify-between gap-2">
            <p className="text-[28px] font-black leading-none text-[#007600] dark:text-emerald-500 tracking-tight">
              {summary.statuses.delivered.count.toLocaleString()}
            </p>
            <span className="text-[11px] font-bold text-[#565959] dark:text-muted-foreground mb-0.5">
              {summary.total > 0 ? Math.round((summary.statuses.delivered.count / summary.total) * 100) : 0}%
            </span>
          </div>
          <div className="flex items-center gap-1.5 mt-2.5 pt-2.5 border-t border-[#EAEDED] dark:border-border/40">
            <PackageCheck size={11} className="text-[#565959] dark:text-muted-foreground" />
            <span className="text-[10px] text-[#565959] dark:text-muted-foreground">Success rate</span>
          </div>
        </div>
      </div>

      {/* ── Revenue chart ──────────────────────────────────── */}
      {chartData.length > 0 && (
        <div className="bg-white dark:bg-card border border-[#D5D9D9] dark:border-border rounded-xl overflow-hidden">
          <div className="px-4 pt-4 pb-3 border-b border-[#EAEDED] dark:border-border/40 flex items-center justify-between">
            <div>
              <h3 className="text-[13px] font-bold text-[#0F1111] dark:text-foreground">Sales Revenue</h3>
              <p className="text-[10.5px] text-[#565959] dark:text-muted-foreground mt-0.5">
                ৳{summary.revenue.toLocaleString()} · {viewMode} view
              </p>
            </div>
            <ChangePill value={summary.revenueChange} />
          </div>
          <div className="px-2 py-4">
            <ResponsiveContainer width="100%" height={195}>
              <AreaChart data={chartData} margin={{ top: 4, right: 12, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="amzRevGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#FF9900" stopOpacity={0.22} />
                    <stop offset="85%" stopColor="#FF9900" stopOpacity={0.03} />
                    <stop offset="100%" stopColor="#FF9900" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="4 4" stroke="hsl(var(--border))" strokeOpacity={0.25} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#767676' }} axisLine={false} tickLine={false} dy={7} />
                <YAxis tick={{ fontSize: 10, fill: '#767676' }} axisLine={false} tickLine={false}
                  tickFormatter={(v: number) => v >= 1000 ? `${(v/1000).toFixed(0)}k` : `${v}`} />
                <Tooltip content={<RevenueTooltip />} cursor={{ stroke: '#FF9900', strokeWidth: 1, strokeDasharray: '4 2' }} />
                <Area type="monotone" dataKey="revenue" name="Revenue (৳)"
                  stroke="#FF9900" strokeWidth={2.5} fill="url(#amzRevGrad)" dot={false}
                  activeDot={{ r: 5, strokeWidth: 2, stroke: '#FF9900', fill: '#fff' }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ── Orders chart ──────────────────────────────────── */}
      {chartData.length > 0 && (
        <div className="bg-white dark:bg-card border border-[#D5D9D9] dark:border-border rounded-2xl overflow-hidden">
          {/* Header */}
          <div className="px-5 pt-4 pb-3 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-[14px] font-bold text-[#0F1111] dark:text-foreground">Orders by {viewLabel}</h3>
              <p className="text-[10.5px] text-[#565959] dark:text-muted-foreground mt-0.5">{summary.total} total orders in this period</p>
            </div>
            {/* Chart type toggle */}
            <div className="flex items-center border border-[#D5D9D9] dark:border-border rounded-lg overflow-hidden">
              <button
                onClick={() => setOrderChartType('area')}
                className={cn(
                  'p-1.5 transition-colors',
                  orderChartType === 'area'
                    ? 'bg-[#F0F7FF] dark:bg-primary/20 text-primary'
                    : 'bg-white dark:bg-card text-[#565959] dark:text-muted-foreground hover:bg-[#F7F8F8] dark:hover:bg-muted/30'
                )}
                title="Area chart"
              >
                <TrendingUp size={14} />
              </button>
              <button
                onClick={() => setOrderChartType('bar')}
                className={cn(
                  'p-1.5 border-l border-[#D5D9D9] dark:border-border transition-colors',
                  orderChartType === 'bar'
                    ? 'bg-[#F0F7FF] dark:bg-primary/20 text-primary'
                    : 'bg-white dark:bg-card text-[#565959] dark:text-muted-foreground hover:bg-[#F7F8F8] dark:hover:bg-muted/30'
                )}
                title="Bar chart"
              >
                <BarChartIcon size={14} />
              </button>
            </div>
          </div>

          {/* Chart */}
          <div className="px-3 pb-2">
            {orderChartType === 'area' ? (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={chartData} margin={{ top: 4, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="ocTotalFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3B82F6" stopOpacity={0.18} />
                      <stop offset="85%" stopColor="#3B82F6" stopOpacity={0.03} />
                      <stop offset="100%" stopColor="#3B82F6" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="ocDelivFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#22C55E" stopOpacity={0.18} />
                      <stop offset="85%" stopColor="#22C55E" stopOpacity={0.03} />
                      <stop offset="100%" stopColor="#22C55E" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="ocCancFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#EF4444" stopOpacity={0.15} />
                      <stop offset="85%" stopColor="#EF4444" stopOpacity={0.02} />
                      <stop offset="100%" stopColor="#EF4444" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="4 4" stroke="#E5E7EB" strokeOpacity={0.7} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#9CA3AF' }} axisLine={false} tickLine={false} dy={6} />
                  <YAxis tick={{ fontSize: 10, fill: '#9CA3AF' }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip content={<BarTooltip />} cursor={{ stroke: '#E5E7EB', strokeWidth: 1 }} />
                  <Area type="monotone" dataKey="total" name="Total"
                    stroke="#3B82F6" strokeWidth={2} fill="url(#ocTotalFill)" dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: '#3B82F6', fill: '#fff' }} />
                  <Area type="monotone" dataKey="delivered" name="Delivered"
                    stroke="#22C55E" strokeWidth={2} fill="url(#ocDelivFill)" dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: '#22C55E', fill: '#fff' }} />
                  <Area type="monotone" dataKey="cancelled" name="Cancelled"
                    stroke="#EF4444" strokeWidth={2} fill="url(#ocCancFill)" dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: '#EF4444', fill: '#fff' }} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartData} barGap={3} barCategoryGap="38%" margin={{ top: 4, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="ocTotalBar" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#60A5FA" />
                      <stop offset="100%" stopColor="#2563EB" stopOpacity={0.9} />
                    </linearGradient>
                    <linearGradient id="ocDelivBar" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#4ADE80" />
                      <stop offset="100%" stopColor="#16A34A" stopOpacity={0.9} />
                    </linearGradient>
                    <linearGradient id="ocCancBar" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#F87171" />
                      <stop offset="100%" stopColor="#DC2626" stopOpacity={0.9} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="4 4" stroke="#E5E7EB" strokeOpacity={0.7} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#9CA3AF' }} axisLine={false} tickLine={false} dy={6} />
                  <YAxis tick={{ fontSize: 10, fill: '#9CA3AF' }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip content={<BarTooltip />} cursor={{ fill: '#F1F5F9', fillOpacity: 0.7, radius: 4 }} />
                  <Bar dataKey="total" name="Total" fill="url(#ocTotalBar)" radius={[5,5,0,0]} maxBarSize={30} />
                  <Bar dataKey="delivered" name="Delivered" fill="url(#ocDelivBar)" radius={[5,5,0,0]} maxBarSize={30} />
                  <Bar dataKey="cancelled" name="Cancelled" fill="url(#ocCancBar)" radius={[5,5,0,0]} maxBarSize={30} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Legend */}
          <div className="flex items-center justify-center gap-5 pb-4 pt-1">
            {[
              { color: '#3B82F6', label: 'Total' },
              { color: '#22C55E', label: 'Delivered' },
              { color: '#EF4444', label: 'Cancelled' },
            ].map(l => (
              <div key={l.label} className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: l.color }} />
                <span className="text-[11px] font-medium text-[#565959] dark:text-muted-foreground">{l.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Order status breakdown table ──────────────────── */}
      <div className="bg-white dark:bg-card border border-[#D5D9D9] dark:border-border rounded-xl overflow-hidden">
        <div className="px-4 pt-4 pb-3 border-b border-[#EAEDED] dark:border-border/40">
          <h3 className="text-[13px] font-bold text-[#0F1111] dark:text-foreground">Order Status Breakdown</h3>
          <p className="text-[10.5px] text-[#565959] dark:text-muted-foreground mt-0.5">{summary.total} total orders across all statuses</p>
        </div>
        <div className="divide-y divide-[#EAEDED] dark:divide-border/30">
          {(Object.entries(STATUS_META) as [string, typeof STATUS_META[string]][]).map(([key, meta]) => {
            const { count, change } = summary.statuses[key as keyof typeof summary.statuses];
            const pct = summary.total > 0 ? Math.round((count / summary.total) * 100) : 0;
            const Icon = meta.icon;
            return (
              <div key={key} className="flex items-center gap-3 px-4 py-3 hover:bg-[#F7F8F8] dark:hover:bg-muted/20 transition-colors">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ backgroundColor: meta.dot + '18' }}>
                  <Icon size={13} className={meta.color} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[12px] font-semibold text-[#0F1111] dark:text-foreground">{meta.label}</span>
                    <div className="flex items-center gap-2">
                      {change !== 0 && (
                        <span className={cn('text-[10px] font-bold',
                          change >= 0 ? 'text-[#007600] dark:text-emerald-400' : 'text-[#CC0C39] dark:text-red-400')}>
                          {change >= 0 ? '↑' : '↓'}{Math.abs(change)}%
                        </span>
                      )}
                      <span className="text-[12px] font-bold text-[#0F1111] dark:text-foreground w-7 text-right">{count}</span>
                      <span className="text-[10px] text-[#565959] dark:text-muted-foreground w-7 text-right">{pct}%</span>
                    </div>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-[#EAEDED] dark:bg-muted/40 overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-700"
                      style={{ width: pct > 0 ? `${pct}%` : '3px', backgroundColor: meta.dot }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Empty state */}
      {filteredOrders.length === 0 && !isLoading && (
        <div className="flex flex-col items-center justify-center py-16 text-center rounded-xl border border-dashed border-[#D5D9D9] dark:border-border bg-white dark:bg-card">
          <div className="w-14 h-14 rounded-xl bg-[#F7F8F8] dark:bg-muted/30 flex items-center justify-center mb-4">
            <Package size={24} className="text-[#C8CDD1] dark:text-muted-foreground/40" />
          </div>
          <p className="text-[13px] font-semibold text-[#0F1111] dark:text-foreground">No orders yet</p>
          <p className="text-[11px] text-[#565959] dark:text-muted-foreground mt-1">Orders will appear here once n8n starts sending data</p>
        </div>
      )}
    </div>
  );
};

export default OrderAnalytics;

// ── Micro components ──────────────────────────────────────────────────────────

const ChangePill = ({ value, tiny }: { value: number; tiny?: boolean }) => {
  const isUp = value >= 0;
  if (value === 0) return null;
  return (
    <span className={cn(
      'inline-flex items-center gap-0.5 font-bold rounded-full',
      tiny ? 'text-[9px] px-1.5 py-0.5' : 'text-[10px] px-2 py-0.5',
      isUp ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400' : 'bg-red-500/12 text-red-500'
    )}>
      {isUp ? <ArrowUpRight size={tiny ? 8 : 10} /> : <ArrowDownRight size={tiny ? 8 : 10} />}
      {Math.abs(value)}%
    </span>
  );
};

const StatChip = ({ color, label, value }: { color: string; label: string; value: number }) => (
  <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted/40 border border-border/40">
    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
    <span className="text-[10px] font-semibold text-muted-foreground">{label}</span>
    <span className="text-[10px] font-bold text-foreground">{value}</span>
  </div>
);

const BarTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card/95 backdrop-blur-sm border border-border/60 rounded-xl shadow-xl p-3 min-w-[140px]">
      <p className="text-[11px] font-bold text-foreground mb-2 pb-2 border-b border-border/40">{label}</p>
      {payload.map((p: any) => (
        <div key={p.name} className="flex items-center justify-between gap-4 py-0.5">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: p.fill?.includes('url') ? p.color : p.fill }} />
            <span className="text-[10px] text-muted-foreground">{p.name}</span>
          </div>
          <span className="text-[11px] font-bold text-foreground">{p.value}</span>
        </div>
      ))}
    </div>
  );
};

const RevenueTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card/95 backdrop-blur-sm border border-border/60 rounded-xl shadow-xl p-3 min-w-[140px]">
      <p className="text-[11px] font-bold text-foreground mb-2 pb-2 border-b border-border/40">{label}</p>
      {payload.map((p: any) => (
        <div key={p.name} className="flex items-center justify-between gap-4 py-0.5">
          <span className="text-[10px] text-muted-foreground">Revenue</span>
          <span className="text-[11px] font-bold text-primary">৳{Number(p.value).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
};

const CustomTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card/95 backdrop-blur-sm border border-border/60 rounded-xl shadow-xl p-3 min-w-[120px]">
      {payload.map((p: any) => (
        <div key={p.name} className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: p.payload?.dot || p.color }} />
            <span className="text-[10px] text-muted-foreground">{p.name}</span>
          </div>
          <span className="text-[11px] font-bold text-foreground">{p.value}</span>
        </div>
      ))}
    </div>
  );
};
