import { useState, useMemo, useRef, useEffect } from 'react';
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
  Sparkles, CalendarDays, X,
} from 'lucide-react';

type ViewMode = 'daily' | 'weekly' | 'monthly' | 'custom';

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
type ChartRow = {
  label: string; total: number; revenue: number;
  pending: number; confirmed: number; processing: number;
  shipped: number; delivered: number; cancelled: number;
};

const ALL_STATUSES = ['pending','confirmed','processing','shipped','delivered','cancelled'] as const;
type StatusKey = typeof ALL_STATUSES[number];

const STATUS_CHART: Record<StatusKey, { label: string; color: string; gradId: string }> = {
  pending:    { label: 'Pending',    color: '#f59e0b', gradId: 'ocPendFill' },
  confirmed:  { label: 'Confirmed',  color: '#3b82f6', gradId: 'ocConfFill' },
  processing: { label: 'Processing', color: '#8b5cf6', gradId: 'ocProcFill' },
  shipped:    { label: 'Shipped',    color: '#06b6d4', gradId: 'ocShipFill' },
  delivered:  { label: 'Delivered',  color: '#10b981', gradId: 'ocDelivFill' },
  cancelled:  { label: 'Cancelled',  color: '#ef4444', gradId: 'ocCancFill' },
};

async function generateAnalyticsPDF(
  viewMode: ViewMode,
  summary: SummaryType,
  filteredOrders: { status: string; total_price: unknown }[],
  refs: { kpi: HTMLElement | null; revChart: HTMLElement | null; statusChart: HTMLElement | null },
  setDownloading: (v: boolean) => void,
) {
  setDownloading(true);
  try {
    const [{ jsPDF }, html2canvas] = await Promise.all([
      import('jspdf'),
      import('html2canvas').then(m => m.default),
    ]);

    const W = 210; const PH = 297; const M = 14; const CW = W - M * 2;
    type RGB = [number, number, number];
    const C = {
      blue:    [66, 133, 244] as RGB,
      ink:     [32, 33, 36]   as RGB,
      muted:   [95, 99, 104]  as RGB,
      border:  [218, 220, 224] as RGB,
      bg:      [248, 249, 250] as RGB,
      white:   [255, 255, 255] as RGB,
      green:   [30, 142, 62]  as RGB,
      amber:   [183, 117, 0]  as RGB,
      red:     [197, 34, 31]  as RGB,
      violet:  [109, 40, 180] as RGB,
      cyan:    [6, 100, 140]  as RGB,
      emerald: [4, 120, 87]   as RGB,
      rowAlt:  [248, 250, 252] as RGB,
    };
    const statusColors: Record<string, RGB> = {
      pending: C.amber, confirmed: C.blue, processing: C.violet,
      shipped: C.cyan,  delivered: C.emerald, cancelled: C.red,
    };

    const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
    const fill   = (c: RGB) => pdf.setFillColor(...c);
    const stroke = (c: RGB) => pdf.setDrawColor(...c);
    const color  = (c: RGB) => pdf.setTextColor(...c);
    const bold   = (s: number) => { pdf.setFont('helvetica', 'bold');   pdf.setFontSize(s); };
    const norm   = (s: number) => { pdf.setFont('helvetica', 'normal'); pdf.setFontSize(s); };

    const h2c = (el: HTMLElement) =>
      html2canvas(el, { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false });

    const addSectionImage = (canvas: HTMLCanvasElement, yPos: number, maxH: number) => {
      const imgW  = CW;
      const ratio = canvas.height / canvas.width;
      const imgH  = Math.min(imgW * ratio, maxH);
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', M, yPos, imgW, imgH);
      return imgH;
    };

    const addFooter = (page: number, total: number) => {
      const fy = PH - 11;
      fill(C.bg); pdf.rect(0, fy, W, 11, 'F');
      stroke(C.border); pdf.setLineWidth(0.3); pdf.line(M, fy, W - M, fy);
      color(C.muted); norm(7);
      pdf.text('Chat Monitor  ·  Analytics Report', M, fy + 7);
      pdf.text(`Page ${page} of ${total}  ·  Generated ${format(new Date(), 'dd MMM yyyy, HH:mm')}`, W - M, fy + 7, { align: 'right' });
    };

    // ── PAGE 1 ────────────────────────────────────────────────
    // Top accent bar
    fill(C.blue); pdf.rect(0, 0, W, 4, 'F');

    // Header
    let y = 13;
    color(C.ink); bold(20); pdf.text('Analytics Report', M, y);
    y += 6;
    color(C.muted); norm(8.5);
    pdf.text(`Period: ${viewMode.charAt(0).toUpperCase() + viewMode.slice(1)}  ·  ${summary.total} orders  ·  ৳${summary.revenue.toLocaleString()} revenue`, M, y);
    y += 5;
    stroke(C.border); pdf.setLineWidth(0.4); pdf.line(M, y, W - M, y);
    y += 8;

    // ── KPI cards screenshot ──────────────────────────────────
    if (refs.kpi) {
      const canvas = await h2c(refs.kpi);
      const h = addSectionImage(canvas, y, 75);
      y += h + 8;
    }

    // ── Status breakdown table ────────────────────────────────
    color(C.ink); bold(11); pdf.text('Order Status Breakdown', M, y);
    fill(C.blue); pdf.rect(M, y + 2, 34, 0.7, 'F');
    y += 9;

    const SCOLS = [40, 20, 20, 22, 40, 26];
    const SHEADS = ['STATUS', 'COUNT', '% SHARE', 'CHANGE', 'REVENUE', 'SHARE'];
    fill(C.blue); pdf.rect(M, y, CW, 8, 'F');
    color(C.white); bold(7);
    let cx = M + 3;
    SHEADS.forEach((h, i) => { pdf.text(h, cx, y + 5.5); cx += SCOLS[i]; });
    y += 8;

    Object.entries(STATUS_META).forEach(([key, meta], idx) => {
      const { count, change } = summary.statuses[key] ?? { count: 0, change: 0 };
      const pct = summary.total > 0 ? Math.round((count / summary.total) * 100) : 0;
      const rev = filteredOrders.filter(o => o.status === key).reduce((s, o) => s + (Number(o.total_price) || 0), 0);
      const rowH = 9;
      fill(idx % 2 === 0 ? C.white : C.rowAlt); pdf.rect(M, y, CW, rowH, 'F');
      stroke(C.border); pdf.setLineWidth(0.15); pdf.line(M, y + rowH, M + CW, y + rowH);
      const sc = statusColors[key] ?? C.muted;
      fill(sc); pdf.circle(M + 4, y + 4.5, 2, 'F');
      color(C.ink); norm(8.5); pdf.text(meta.label, M + 9, y + 5.8);
      cx = M + SCOLS[0] + 3;
      bold(8.5); pdf.text(count.toString(), cx, y + 5.8); cx += SCOLS[1];
      norm(8); color(C.muted); pdf.text(`${pct}%`, cx, y + 5.8); cx += SCOLS[2];
      color(change >= 0 ? C.green : C.red); pdf.text(`${change >= 0 ? '+' : ''}${change}%`, cx, y + 5.8); cx += SCOLS[3];
      color(C.ink); norm(8); pdf.text(`৳${rev.toLocaleString()}`, cx, y + 5.8); cx += SCOLS[4];
      const bw = SCOLS[5] - 4;
      fill(C.border); pdf.roundedRect(cx, y + 3.5, bw, 2.5, 1, 1, 'F');
      if (pct > 0) { fill(sc); pdf.roundedRect(cx, y + 3.5, Math.max(1.5, bw * pct / 100), 2.5, 1, 1, 'F'); }
      y += rowH;
    });

    y += 10;

    // ── Revenue chart screenshot ──────────────────────────────
    if (refs.revChart) {
      if (y > 200) { pdf.addPage(); y = 18; }
      color(C.ink); bold(11); pdf.text('Sales Revenue', M, y);
      fill(C.blue); pdf.rect(M, y + 2, 22, 0.7, 'F');
      y += 9;
      const canvas = await h2c(refs.revChart);
      const h = addSectionImage(canvas, y, 72);
      y += h + 10;
    }

    // ── Status breakdown chart screenshot ─────────────────────
    if (refs.statusChart) {
      if (y > 190) { pdf.addPage(); y = 18; }
      color(C.ink); bold(11); pdf.text('Status Breakdown Chart', M, y);
      fill(C.blue); pdf.rect(M, y + 2, 36, 0.7, 'F');
      y += 9;
      const canvas = await h2c(refs.statusChart);
      const h = addSectionImage(canvas, y, 80);
      y += h + 6;
    }

    // ── Footers ───────────────────────────────────────────────
    const pageCount = (pdf as any).getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) { pdf.setPage(i); addFooter(i, pageCount); }

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
  const [visibleStatuses, setVisibleStatuses] = useState<Set<StatusKey>>(new Set(ALL_STATUSES));
  const toggleStatus = (s: StatusKey) =>
    setVisibleStatuses(prev => {
      const next = new Set(prev);
      if (next.has(s)) { if (next.size > 1) next.delete(s); } else next.add(s);
      return next;
    });
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [customApplied, setCustomApplied] = useState(false);
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const pickerRef   = useRef<HTMLDivElement>(null);
  const kpiRef      = useRef<HTMLDivElement>(null);
  const revChartRef = useRef<HTMLDivElement>(null);
  const stChartRef  = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowCustomPicker(false);
      }
    };
    if (showCustomPicker) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showCustomPicker]);

  const { data: orders = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['orders-analytics'],
    queryFn: async () => {
      const { data, error } = await supabase.from('orders').select('*').order('created_at', { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 30000,
  });

  const dateRange = useMemo(() => {
    if (viewMode === 'custom' && customApplied && customFrom && customTo) {
      const start = new Date(customFrom + 'T00:00:00');
      const end = new Date(customTo + 'T23:59:59');
      return { start, end };
    }
    return { end: new Date(), start: subDays(new Date(), days) };
  }, [viewMode, customApplied, customFrom, customTo, days]);

  const filteredOrders = useMemo(() =>
    orders.filter(o => isWithinInterval(parseISO(o.created_at), dateRange)), [orders, dateRange]);

  const customRangeDays = useMemo(() => {
    if (viewMode === 'custom' && customApplied && customFrom && customTo) {
      return Math.ceil((new Date(customTo).getTime() - new Date(customFrom).getTime()) / 86400000) + 1;
    }
    return days;
  }, [viewMode, customApplied, customFrom, customTo, days]);

  const previousOrders = useMemo(() => {
    const end = subDays(dateRange.start, 1);
    const start = subDays(end, customRangeDays);
    return orders.filter(o => isWithinInterval(parseISO(o.created_at), { start, end }));
  }, [orders, dateRange, customRangeDays]);

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

  const customBucketMode: 'daily' | 'weekly' | 'monthly' = useMemo(() => {
    if (viewMode !== 'custom') return 'daily';
    if (customRangeDays <= 31) return 'daily';
    if (customRangeDays <= 120) return 'weekly';
    return 'monthly';
  }, [viewMode, customRangeDays]);

  const chartData = useMemo(() => {
    const buckets: Record<string, ChartRow> = {};
    const bucketing = viewMode === 'custom' ? customBucketMode : viewMode;
    filteredOrders.forEach(order => {
      const d = parseISO(order.created_at);
      let key: string, label: string;
      if (bucketing === 'daily') { key = format(d, 'yyyy-MM-dd'); label = format(d, 'dd MMM'); }
      else if (bucketing === 'weekly') { const ws = startOfWeek(d, { weekStartsOn: 6 }); key = format(ws, 'yyyy-MM-dd'); label = `W${format(ws, 'dd MMM')}`; }
      else { const ms = startOfMonth(d); key = format(ms, 'yyyy-MM'); label = format(ms, 'MMM yy'); }
      if (!buckets[key]) buckets[key] = { label, total: 0, revenue: 0, pending: 0, confirmed: 0, processing: 0, shipped: 0, delivered: 0, cancelled: 0 };
      buckets[key].total++;
      const st = order.status as StatusKey;
      if (st in buckets[key]) (buckets[key] as any)[st]++;
      buckets[key].revenue += Number(order.total_price) || 0;
    });
    return Object.values(buckets);
  }, [filteredOrders, viewMode, customBucketMode]);

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

  const viewLabel = viewMode === 'daily' ? 'Day' : viewMode === 'weekly' ? 'Week' : viewMode === 'monthly' ? 'Month' : 'Custom';
  const avgOrder = summary.total > 0 ? Math.round(summary.revenue / summary.total) : 0;
  const customLabel = customApplied && customFrom && customTo
    ? `${format(new Date(customFrom), 'dd MMM')} – ${format(new Date(customTo), 'dd MMM yyyy')}`
    : 'Custom';

  return (
    <div className="space-y-3">

      {/* ── Amazon-style top toolbar ───────────────────────── */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Period tabs */}
          <div className="flex items-center rounded-md border border-[#D5D9D9] dark:border-border overflow-hidden text-[12px] font-medium">
            {(['daily', 'weekly', 'monthly'] as const).map((m, idx) => (
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

          {/* Custom date range button + popover */}
          <div className="relative" ref={pickerRef}>
            <button
              onClick={() => { setViewMode('custom'); setShowCustomPicker(v => !v); }}
              className={cn(
                'flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded border transition-colors',
                viewMode === 'custom'
                  ? 'bg-[#FFE9C0] dark:bg-amber-900/30 text-[#C45500] dark:text-amber-400 border-[#FFA41C] font-semibold'
                  : 'bg-white dark:bg-card text-[#0F1111] dark:text-foreground border-[#D5D9D9] dark:border-border hover:bg-[#F7F8F8] dark:hover:bg-muted/40'
              )}
            >
              <CalendarDays size={13} />
              <span>{viewMode === 'custom' ? customLabel : 'Custom'}</span>
              {viewMode === 'custom' && customApplied && (
                <span
                  className="ml-1 flex items-center justify-center w-4 h-4 rounded-full bg-[#C45500] text-white hover:bg-red-600 transition-colors"
                  onClick={e => { e.stopPropagation(); setCustomApplied(false); setCustomFrom(''); setCustomTo(''); setViewMode('daily'); setShowCustomPicker(false); }}
                >
                  <X size={9} />
                </span>
              )}
            </button>

            {showCustomPicker && (
              <div className="absolute top-full left-0 mt-1.5 z-50 bg-white dark:bg-card border border-[#D5D9D9] dark:border-border rounded-xl shadow-lg p-4 w-72">
                <p className="text-[11px] font-semibold text-[#565959] dark:text-muted-foreground uppercase tracking-wide mb-3">Custom Date Range</p>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div>
                    <label className="text-[10.5px] text-[#565959] dark:text-muted-foreground font-medium mb-1 block">From</label>
                    <input
                      type="date"
                      value={customFrom}
                      max={customTo || format(new Date(), 'yyyy-MM-dd')}
                      onChange={e => setCustomFrom(e.target.value)}
                      className="w-full text-[11.5px] px-2 py-1.5 rounded border border-[#D5D9D9] dark:border-border bg-white dark:bg-background text-[#0F1111] dark:text-foreground focus:outline-none focus:ring-1 focus:ring-[#FF9900]"
                    />
                  </div>
                  <div>
                    <label className="text-[10.5px] text-[#565959] dark:text-muted-foreground font-medium mb-1 block">To</label>
                    <input
                      type="date"
                      value={customTo}
                      min={customFrom}
                      max={format(new Date(), 'yyyy-MM-dd')}
                      onChange={e => setCustomTo(e.target.value)}
                      className="w-full text-[11.5px] px-2 py-1.5 rounded border border-[#D5D9D9] dark:border-border bg-white dark:bg-background text-[#0F1111] dark:text-foreground focus:outline-none focus:ring-1 focus:ring-[#FF9900]"
                    />
                  </div>
                </div>

                {/* Quick presets */}
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {[
                    { label: 'Last 7d', days: 7 }, { label: 'Last 14d', days: 14 },
                    { label: 'Last 30d', days: 30 }, { label: 'Last 90d', days: 90 },
                  ].map(p => (
                    <button key={p.label}
                      onClick={() => {
                        const to = format(new Date(), 'yyyy-MM-dd');
                        const from = format(subDays(new Date(), p.days - 1), 'yyyy-MM-dd');
                        setCustomFrom(from); setCustomTo(to);
                      }}
                      className="text-[10.5px] px-2 py-1 rounded border border-[#D5D9D9] dark:border-border bg-[#F7F8F8] dark:bg-muted/40 text-[#007185] dark:text-blue-400 hover:bg-[#FFE9C0] hover:text-[#C45500] hover:border-[#FFA41C] transition-colors font-medium"
                    >{p.label}</button>
                  ))}
                </div>

                <div className="flex gap-2">
                  <button
                    disabled={!customFrom || !customTo}
                    onClick={() => { if (customFrom && customTo) { setCustomApplied(true); setShowCustomPicker(false); } }}
                    className="flex-1 text-[11.5px] font-semibold py-1.5 rounded border border-[#FFA41C] bg-gradient-to-b from-[#FFD78C] to-[#F5A623] text-[#0F1111] disabled:opacity-40 hover:from-[#F5C26B] hover:to-[#E8951E] transition-all"
                  >Apply</button>
                  <button
                    onClick={() => { setCustomFrom(''); setCustomTo(''); setCustomApplied(false); setShowCustomPicker(false); setViewMode('daily'); }}
                    className="px-3 text-[11.5px] font-medium py-1.5 rounded border border-[#D5D9D9] dark:border-border bg-white dark:bg-card text-[#565959] dark:text-muted-foreground hover:bg-[#F7F8F8] transition-colors"
                  >Clear</button>
                </div>
              </div>
            )}
          </div>

          {/* Active custom range badge */}
          {viewMode === 'custom' && customApplied && (
            <span className="text-[10.5px] font-medium text-[#007185] dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 border border-blue-200/60 dark:border-blue-800/40 px-2 py-1 rounded-full">
              {customRangeDays}d range · {customBucketMode}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => refetch()} disabled={isFetching}
            className="flex items-center gap-1.5 text-[11.5px] font-medium text-[#007185] dark:text-blue-400 hover:text-[#C45500] dark:hover:text-amber-400 px-3 py-1.5 rounded border border-[#D5D9D9] dark:border-border bg-white dark:bg-card transition-colors"
          >
            <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} /> Refresh
          </button>
          <button
            onClick={() => generateAnalyticsPDF(viewMode, summary, filteredOrders, { kpi: kpiRef.current, revChart: revChartRef.current, statusChart: stChartRef.current }, setIsDownloading)}
            disabled={isDownloading}
            className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[#0F1111] dark:text-foreground px-4 py-1.5 rounded border border-[#FFA41C] bg-gradient-to-b from-[#FFD78C] to-[#F5A623] dark:from-amber-500 dark:to-amber-600 hover:from-[#F5C26B] hover:to-[#E8951E] transition-all disabled:opacity-60 shadow-sm"
          >
            {isDownloading ? <><Loader2 size={12} className="animate-spin" /> Generating…</> : <><Download size={12} /> Export PDF</>}
          </button>
        </div>
      </div>

      {/* ── 4-metric KPI row ───────────────────────────────── */}
      <div ref={kpiRef} className="grid grid-cols-2 gap-2.5">
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

        {/* Pending */}
        <div className="bg-white dark:bg-card border border-[#D5D9D9] dark:border-border rounded-xl p-4">
          <p className="text-[10.5px] font-semibold text-[#565959] dark:text-muted-foreground uppercase tracking-wide mb-2">Pending</p>
          <div className="flex items-end justify-between gap-2">
            <p className="text-[28px] font-black leading-none tracking-tight" style={{ color: '#FF9900' }}>
              {summary.statuses.pending.count.toLocaleString()}
            </p>
            {summary.statuses.pending.change !== 0 && (
              <span className={cn(
                'flex items-center gap-0.5 text-[11px] font-bold mb-0.5',
                summary.statuses.pending.change >= 0 ? 'text-[#007600] dark:text-emerald-400' : 'text-[#CC0C39] dark:text-red-400'
              )}>
                {summary.statuses.pending.change >= 0 ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
                {Math.abs(summary.statuses.pending.change)}%
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-2.5 pt-2.5 border-t border-[#EAEDED] dark:border-border/40">
            <Clock size={11} className="text-[#565959] dark:text-muted-foreground" />
            <span className="text-[10px] text-[#565959] dark:text-muted-foreground">Awaiting action</span>
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

        {/* Remaining status cards merged in */}
        {(['confirmed','processing','shipped','cancelled'] as const).map(key => {
          const meta = STATUS_META[key];
          const { count, change } = summary.statuses[key];
          const pct = summary.total > 0 ? Math.round((count / summary.total) * 100) : 0;
          const Icon = meta.icon;
          return (
            <div key={key} className="bg-white dark:bg-card border border-[#D5D9D9] dark:border-border rounded-xl p-4">
              <p className="text-[10.5px] font-semibold text-[#565959] dark:text-muted-foreground uppercase tracking-wide mb-2">
                {meta.label}
              </p>
              <div className="flex items-end justify-between gap-2">
                <p className="text-[28px] font-black leading-none tracking-tight" style={{ color: meta.dot }}>
                  {count}
                </p>
                {change !== 0 && (
                  <span className={cn(
                    'flex items-center gap-0.5 text-[11px] font-bold mb-0.5',
                    change >= 0 ? 'text-[#007600] dark:text-emerald-400' : 'text-[#CC0C39] dark:text-red-400'
                  )}>
                    {change >= 0 ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
                    {Math.abs(change)}%
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 mt-2.5 pt-2.5 border-t border-[#EAEDED] dark:border-border/40">
                <Icon size={11} className="text-[#565959] dark:text-muted-foreground flex-shrink-0" />
                <span className="text-[10px] text-[#565959] dark:text-muted-foreground">{pct}% of orders</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Revenue chart ──────────────────────────────────── */}
      {chartData.length > 0 && (
        <div ref={revChartRef} className="bg-white dark:bg-card border border-[#D5D9D9] dark:border-border rounded-xl overflow-hidden">
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
        <div ref={stChartRef} className="bg-white dark:bg-card border border-[#D5D9D9] dark:border-border rounded-2xl overflow-hidden">
          {/* Header */}
          <div className="px-5 pt-4 pb-3 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-[14px] font-bold text-[#0F1111] dark:text-foreground">Status Breakdown by {viewLabel}</h3>
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

          {/* Toggleable status legend chips */}
          <div className="px-5 pb-3 flex flex-wrap gap-1.5">
            {ALL_STATUSES.map(s => {
              const { label, color } = STATUS_CHART[s];
              const active = visibleStatuses.has(s);
              return (
                <button
                  key={s}
                  onClick={() => toggleStatus(s)}
                  className={cn(
                    'flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full border transition-all',
                    active
                      ? 'border-transparent text-white'
                      : 'border-[#D5D9D9] dark:border-border bg-white dark:bg-card text-[#565959] dark:text-muted-foreground opacity-50'
                  )}
                  style={active ? { backgroundColor: color, borderColor: color } : {}}
                  title={active ? `Hide ${label}` : `Show ${label}`}
                >
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: active ? '#fff' : color }} />
                  {label}
                </button>
              );
            })}
          </div>

          {/* Chart */}
          <div className="px-3 pb-2">
            {orderChartType === 'area' ? (
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={chartData} margin={{ top: 4, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    {ALL_STATUSES.map(s => (
                      <linearGradient key={s} id={STATUS_CHART[s].gradId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={STATUS_CHART[s].color} stopOpacity={0.18} />
                        <stop offset="85%" stopColor={STATUS_CHART[s].color} stopOpacity={0.03} />
                        <stop offset="100%" stopColor={STATUS_CHART[s].color} stopOpacity={0} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid strokeDasharray="4 4" stroke="#E5E7EB" strokeOpacity={0.7} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#9CA3AF' }} axisLine={false} tickLine={false} dy={6} />
                  <YAxis tick={{ fontSize: 10, fill: '#9CA3AF' }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip content={<BarTooltip visibleStatuses={visibleStatuses} />} cursor={{ stroke: '#E5E7EB', strokeWidth: 1 }} />
                  {ALL_STATUSES.filter(s => visibleStatuses.has(s)).map(s => (
                    <Area key={s} type="monotone" dataKey={s} name={STATUS_CHART[s].label}
                      stroke={STATUS_CHART[s].color} strokeWidth={2}
                      fill={`url(#${STATUS_CHART[s].gradId})`} dot={false}
                      activeDot={{ r: 4, strokeWidth: 2, stroke: STATUS_CHART[s].color, fill: '#fff' }} />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={chartData} barGap={2} barCategoryGap="30%" margin={{ top: 4, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="4 4" stroke="#E5E7EB" strokeOpacity={0.7} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#9CA3AF' }} axisLine={false} tickLine={false} dy={6} />
                  <YAxis tick={{ fontSize: 10, fill: '#9CA3AF' }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip content={<BarTooltip visibleStatuses={visibleStatuses} />} cursor={{ fill: '#F1F5F9', fillOpacity: 0.7 }} />
                  {ALL_STATUSES.filter(s => visibleStatuses.has(s)).map(s => (
                    <Bar key={s} dataKey={s} name={STATUS_CHART[s].label}
                      fill={STATUS_CHART[s].color} radius={[4,4,0,0]} maxBarSize={22} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      )}

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

const BarTooltip = ({ active, payload, label, visibleStatuses: _vs }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card/95 backdrop-blur-sm border border-border/60 rounded-xl shadow-xl p-3 min-w-[150px]">
      <p className="text-[11px] font-bold text-foreground mb-2 pb-2 border-b border-border/40">{label}</p>
      {payload.map((p: any) => {
        const dotColor = p.stroke || (p.fill?.startsWith('url') ? p.color : p.fill);
        return (
          <div key={p.name} className="flex items-center justify-between gap-4 py-0.5">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: dotColor }} />
              <span className="text-[10px] text-muted-foreground">{p.name}</span>
            </div>
            <span className="text-[11px] font-bold text-foreground">{p.value}</span>
          </div>
        );
      })}
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
