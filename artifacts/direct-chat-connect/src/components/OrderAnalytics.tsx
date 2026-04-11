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

async function generateAnalyticsPDF(
  summary: SummaryType, viewMode: ViewMode, chartData: ChartRow[],
  filteredOrders: { status: string; total_price: unknown }[], setDownloading: (v: boolean) => void,
) {
  setDownloading(true);
  try {
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
    const W = 210; const MARGIN = 14; const CW = W - MARGIN * 2;
    const C = {
      primary: [37,99,235] as [number,number,number], indigo: [67,56,202] as [number,number,number],
      dark: [15,23,42] as [number,number,number], muted: [100,116,139] as [number,number,number],
      light: [241,245,249] as [number,number,number], white: [255,255,255] as [number,number,number],
      emerald: [16,185,129] as [number,number,number], red: [239,68,68] as [number,number,number],
      amber: [245,158,11] as [number,number,number], blue50: [239,246,255] as [number,number,number],
      blue200: [191,219,254] as [number,number,number], slate50: [248,250,252] as [number,number,number],
      slate200: [226,232,240] as [number,number,number],
    };
    const statusDotColors: Record<string,[number,number,number]> = {
      pending: C.amber, confirmed: C.primary, processing: [124,58,237],
      shipped: [6,182,212], delivered: C.emerald, cancelled: C.red,
    };
    const fill=(c:[number,number,number])=>pdf.setFillColor(...c);
    const stroke=(c:[number,number,number])=>pdf.setDrawColor(...c);
    const color=(c:[number,number,number])=>pdf.setTextColor(...c);
    fill(C.primary); pdf.rect(0,0,W*.55,40,'F');
    fill(C.indigo); pdf.rect(W*.55,0,W*.45,40,'F');
    fill(C.white); pdf.circle(MARGIN+9,20,8,'F');
    color(C.primary); pdf.setFontSize(13); pdf.setFont('helvetica','bold'); pdf.text('M',MARGIN+9,24,{align:'center'});
    color(C.white); pdf.setFontSize(17); pdf.setFont('helvetica','bold'); pdf.text('Chat Monitor',MARGIN+22,16);
    pdf.setFontSize(10); pdf.setFont('helvetica','normal'); pdf.text('Analytics Report',MARGIN+22,24);
    pdf.setFontSize(8);
    pdf.text(format(new Date(),'dd MMM yyyy'),W-MARGIN,14,{align:'right'});
    pdf.text(`Period: ${viewMode.charAt(0).toUpperCase()+viewMode.slice(1)}`,W-MARGIN,22,{align:'right'});
    pdf.text(`Generated: ${format(new Date(),'HH:mm')}`,W-MARGIN,30,{align:'right'});
    let y=50; const BW=(CW-5)/2; const BH=28;
    fill(C.blue50); stroke(C.blue200); pdf.setLineWidth(0.3); pdf.roundedRect(MARGIN,y,BW,BH,3,3,'FD');
    color(C.muted); pdf.setFontSize(7.5); pdf.setFont('helvetica','bold'); pdf.text('TOTAL REVENUE',MARGIN+4,y+8);
    color(C.primary); pdf.setFontSize(19); pdf.setFont('helvetica','bold'); pdf.text(`Tk. ${summary.revenue.toLocaleString()}`,MARGIN+4,y+20);
    const rc=summary.revenueChange; color(rc>=0?C.emerald:C.red); pdf.setFontSize(8); pdf.setFont('helvetica','normal');
    pdf.text(`${rc>=0?'+':''}${rc}% vs prev period`,MARGIN+4,y+26.5);
    const B2X=MARGIN+BW+5; fill(C.slate50); stroke(C.slate200); pdf.roundedRect(B2X,y,BW,BH,3,3,'FD');
    color(C.muted); pdf.setFontSize(7.5); pdf.setFont('helvetica','bold'); pdf.text('TOTAL ORDERS',B2X+4,y+8);
    color(C.dark); pdf.setFontSize(19); pdf.setFont('helvetica','bold'); pdf.text(summary.total.toLocaleString(),B2X+4,y+20);
    const tc=summary.totalChange; color(tc>=0?C.emerald:C.red); pdf.setFontSize(8); pdf.setFont('helvetica','normal');
    pdf.text(`${tc>=0?'+':''}${tc}% vs prev period`,B2X+4,y+26.5);
    y+=BH+12;
    color(C.dark); pdf.setFontSize(11); pdf.setFont('helvetica','bold'); pdf.text('Order Status Breakdown',MARGIN,y);
    fill(C.primary); pdf.rect(MARGIN,y+2.5,32,0.6,'F'); y+=9;
    const SC=[32,22,25,25,50]; const SH=['Status','Orders','Change','% Share','Revenue (Tk.)'];
    fill(C.primary); pdf.rect(MARGIN,y,CW,8,'F');
    color(C.white); pdf.setFontSize(8); pdf.setFont('helvetica','bold');
    let cx=MARGIN+3; SH.forEach((h,i)=>{pdf.text(h,cx,y+5.5);cx+=SC[i];}); y+=8;
    Object.entries(STATUS_META).forEach(([key,meta],idx)=>{
      const {count,change}=summary.statuses[key]??{count:0,change:0};
      const pct=summary.total>0?Math.round((count/summary.total)*100):0;
      const rev=filteredOrders.filter(o=>o.status===key).reduce((s,o)=>s+(Number(o.total_price)||0),0);
      fill(idx%2===0?C.slate50:C.white); pdf.rect(MARGIN,y,CW,8,'F');
      stroke(C.slate200); pdf.setLineWidth(0.2); pdf.line(MARGIN,y+8,MARGIN+CW,y+8);
      fill(statusDotColors[key]??C.muted); pdf.circle(MARGIN+5,y+4,2,'F');
      color(C.dark); pdf.setFontSize(8); pdf.setFont('helvetica','normal');
      cx=MARGIN+9; pdf.text(meta.label,cx,y+5.5); cx=MARGIN+SC[0]+3;
      pdf.text(count.toString(),cx,y+5.5); cx+=SC[1];
      color(change>=0?C.emerald:C.red); pdf.text(`${change>=0?'+':''}${change}%`,cx,y+5.5); cx+=SC[2];
      color(C.dark); pdf.text(`${pct}%`,cx,y+5.5); cx+=SC[3]; pdf.text(rev.toLocaleString(),cx,y+5.5);
      y+=8;
    });
    if(chartData.length>0){
      y+=12; if(y>240){pdf.addPage();y=20;}
      const periodLabel=viewMode==='daily'?'Daily':viewMode==='weekly'?'Weekly':'Monthly';
      color(C.dark); pdf.setFontSize(11); pdf.setFont('helvetica','bold'); pdf.text(`${periodLabel} Breakdown`,MARGIN,y);
      fill(C.primary); pdf.rect(MARGIN,y+2.5,32,0.6,'F'); y+=9;
      const PC=[36,28,28,28,42]; const PH=['Period','Total','Delivered','Cancelled','Revenue (Tk.)'];
      fill(C.primary); pdf.rect(MARGIN,y,CW,8,'F');
      color(C.white); pdf.setFontSize(8); pdf.setFont('helvetica','bold');
      cx=MARGIN+3; PH.forEach((h,i)=>{pdf.text(h,cx,y+5.5);cx+=PC[i];}); y+=8;
      chartData.slice(-20).forEach((row,idx)=>{
        if(y>270){pdf.addPage();y=20;}
        fill(idx%2===0?C.slate50:C.white); pdf.rect(MARGIN,y,CW,7,'F');
        stroke(C.slate200); pdf.setLineWidth(0.2); pdf.line(MARGIN,y+7,MARGIN+CW,y+7);
        color(C.dark); pdf.setFontSize(8); pdf.setFont('helvetica','normal');
        cx=MARGIN+3;
        pdf.text(row.label,cx,y+5);cx+=PC[0];
        pdf.text(row.total.toString(),cx,y+5);cx+=PC[1];
        pdf.text(row.delivered.toString(),cx,y+5);cx+=PC[2];
        pdf.text(row.cancelled.toString(),cx,y+5);cx+=PC[3];
        pdf.text(row.revenue.toLocaleString(),cx,y+5);
        y+=7;
      });
    }
    const pageCount=(pdf as any).getNumberOfPages();
    for(let i=1;i<=pageCount;i++){
      pdf.setPage(i); const pH=pdf.internal.pageSize.getHeight();
      fill(C.light); pdf.rect(0,pH-11,W,11,'F');
      stroke(C.slate200); pdf.setLineWidth(0.3); pdf.line(0,pH-11,W,pH-11);
      color(C.muted); pdf.setFontSize(7); pdf.setFont('helvetica','normal');
      pdf.text('Chat Monitor — Confidential Analytics Report',MARGIN,pH-4);
      pdf.text(`Page ${i} of ${pageCount}`,W-MARGIN,pH-4,{align:'right'});
    }
    pdf.save(`analytics-report-${format(new Date(),'dd-MMM-yyyy')}.pdf`);
  } finally { setDownloading(false); }
}

const OrderAnalytics = () => {
  const [viewMode, setViewMode] = useState<ViewMode>('daily');
  const [days] = useState(90);
  const [isDownloading, setIsDownloading] = useState(false);
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
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2.5">
          {[...Array(6)].map((_, i) => <div key={i} className="h-24 rounded-2xl bg-muted/40 animate-pulse" />)}
        </div>
        <div className="h-72 rounded-2xl bg-muted/40 animate-pulse" />
        <div className="h-64 rounded-2xl bg-muted/40 animate-pulse" />
      </div>
    );
  }

  const viewLabel = viewMode === 'daily' ? 'Day' : viewMode === 'weekly' ? 'Week' : 'Month';

  return (
    <div ref={pageRef} className="space-y-4">

      {/* ── Top controls bar ─────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {/* Period toggle — pill style */}
        <div className="flex items-center bg-muted/50 rounded-xl p-1 gap-0.5 border border-border/40">
          {(['daily', 'weekly', 'monthly'] as ViewMode[]).map(m => (
            <button key={m} onClick={() => setViewMode(m)}
              className={cn(
                'text-[11.5px] font-semibold px-3.5 py-1.5 rounded-lg transition-all duration-200',
                viewMode === m
                  ? 'bg-white dark:bg-zinc-800 text-foreground shadow-sm ring-1 ring-border/30'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => refetch()} disabled={isFetching}
            className="flex items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-xl bg-muted/40 border border-border/40 transition-all"
          >
            <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} /> Refresh
          </button>
          <button
            onClick={() => generateAnalyticsPDF(summary, viewMode, chartData, filteredOrders, setIsDownloading)}
            disabled={isDownloading}
            className="flex items-center gap-1.5 text-[11.5px] font-semibold text-white bg-primary hover:bg-primary/90 px-4 py-1.5 rounded-xl transition-all shadow-sm disabled:opacity-60"
          >
            {isDownloading ? <><Loader2 size={12} className="animate-spin" /> Generating…</> : <><Download size={12} /> Export PDF</>}
          </button>
        </div>
      </div>

      {/* ── Hero KPI row ──────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3">
        {/* Revenue card */}
        <div className="relative rounded-2xl overflow-hidden p-4 flex flex-col gap-2 min-h-[110px]"
          style={{ background: 'linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)' }}>
          {/* Decorative circle */}
          <div className="absolute -right-4 -top-4 w-24 h-24 rounded-full bg-white/10 pointer-events-none" />
          <div className="absolute -right-1 bottom-2 w-14 h-14 rounded-full bg-white/5 pointer-events-none" />
          <div className="flex items-center justify-between relative z-10">
            <div className="flex items-center gap-1.5">
              <div className="w-7 h-7 rounded-lg bg-white/20 flex items-center justify-center">
                <TrendingUp size={13} className="text-white" />
              </div>
              <span className="text-[10px] font-bold text-white/70 uppercase tracking-widest">Revenue</span>
            </div>
            <span className={cn(
              'flex items-center gap-0.5 text-[10px] font-bold px-2 py-0.5 rounded-full',
              summary.revenueChange >= 0 ? 'bg-emerald-400/25 text-emerald-200' : 'bg-red-400/25 text-red-200'
            )}>
              {summary.revenueChange >= 0 ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
              {Math.abs(summary.revenueChange)}%
            </span>
          </div>
          <div className="relative z-10 mt-1">
            <p className="text-[26px] font-black text-white leading-none tracking-tight">৳{summary.revenue.toLocaleString()}</p>
            <p className="text-[10px] text-white/55 mt-1.5">Total in period</p>
          </div>
        </div>

        {/* Orders card */}
        <div className="relative rounded-2xl overflow-hidden p-4 flex flex-col gap-2 min-h-[110px]"
          style={{ background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)' }}>
          <div className="absolute -right-4 -top-4 w-24 h-24 rounded-full bg-white/5 pointer-events-none" />
          <div className="absolute -right-1 bottom-2 w-14 h-14 rounded-full bg-white/[0.03] pointer-events-none" />
          <div className="flex items-center justify-between relative z-10">
            <div className="flex items-center gap-1.5">
              <div className="w-7 h-7 rounded-lg bg-white/10 flex items-center justify-center">
                <ShoppingBag size={13} className="text-white" />
              </div>
              <span className="text-[10px] font-bold text-white/50 uppercase tracking-widest">Orders</span>
            </div>
            <span className={cn(
              'flex items-center gap-0.5 text-[10px] font-bold px-2 py-0.5 rounded-full',
              summary.totalChange >= 0 ? 'bg-emerald-400/20 text-emerald-300' : 'bg-red-400/20 text-red-300'
            )}>
              {summary.totalChange >= 0 ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
              {Math.abs(summary.totalChange)}%
            </span>
          </div>
          <div className="relative z-10 mt-1">
            <p className="text-[26px] font-black text-white leading-none tracking-tight">{summary.total.toLocaleString()}</p>
            <p className="text-[10px] text-white/40 mt-1.5">Total in period</p>
          </div>
        </div>
      </div>

      {/* ── Status cards ────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-2">
        {(Object.entries(STATUS_META) as [string, typeof STATUS_META[string]][]).map(([key, meta]) => {
          const { count, change } = summary.statuses[key as keyof typeof summary.statuses];
          const pct = summary.total > 0 ? Math.round((count / summary.total) * 100) : 0;
          const Icon = meta.icon;
          return (
            <div key={key} className={cn('rounded-xl border p-3 flex flex-col gap-2 transition-all hover:shadow-sm', meta.bg, meta.border)}>
              <div className="flex items-center justify-between">
                <Icon size={13} className={meta.color} />
                {change !== 0 && <ChangePill value={change} tiny />}
              </div>
              <div>
                <p className={cn('text-xl font-bold leading-none', meta.color)}>{count}</p>
                <span className="text-[10px] text-muted-foreground font-medium mt-1 block">{meta.label}</span>
              </div>
              <div className="w-full h-1 rounded-full bg-black/8 dark:bg-white/10 overflow-hidden">
                <div className="h-full rounded-full transition-all duration-700"
                  style={{ width: pct > 0 ? `${pct}%` : '4px', backgroundColor: meta.dot }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Orders bar chart ────────────────────────────────── */}
      {chartData.length > 0 && (
        <div className="rounded-2xl border border-border/60 bg-card overflow-hidden">
          {/* Chart header */}
          <div className="px-5 pt-5 pb-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-7 h-7 rounded-lg bg-violet-500/10 flex items-center justify-center">
                    <BarChartIcon size={13} className="text-violet-500" />
                  </div>
                  <h3 className="text-[13px] font-bold text-foreground">Orders by {viewLabel}</h3>
                </div>
                <p className="text-[10.5px] text-muted-foreground ml-9">
                  {summary.total} total orders in this period
                </p>
              </div>
              {/* Inline stat chips */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <StatChip color="#3b82f6" label="Total" value={summary.total} />
                <StatChip color="#10b981" label="Delivered" value={summary.statuses.delivered.count} />
                <StatChip color="#ef4444" label="Cancelled" value={summary.statuses.cancelled.count} />
                <StatChip color="#f59e0b" label="Pending" value={summary.statuses.pending.count} />
              </div>
            </div>
          </div>

          {/* Chart body */}
          <div className="px-2 pb-5">
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={chartData} barGap={3} barCategoryGap="32%"
                margin={{ top: 4, right: 12, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="totalGrad2" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3b82f6" />
                    <stop offset="100%" stopColor="#2563eb" stopOpacity={0.85} />
                  </linearGradient>
                  <linearGradient id="delivGrad2" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#34d399" />
                    <stop offset="100%" stopColor="#10b981" stopOpacity={0.85} />
                  </linearGradient>
                  <linearGradient id="cancGrad2" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f87171" />
                    <stop offset="100%" stopColor="#ef4444" stopOpacity={0.85} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 6" stroke="hsl(var(--border))" strokeOpacity={0.3} vertical={false} />
                <XAxis dataKey="label"
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))', fontWeight: 500 }}
                  axisLine={false} tickLine={false} dy={7}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  axisLine={false} tickLine={false} allowDecimals={false}
                />
                <Tooltip content={<BarTooltip />}
                  cursor={{ fill: 'hsl(var(--muted))', fillOpacity: 0.45, radius: 6 }} />
                <Bar dataKey="total" name="Total" fill="url(#totalGrad2)" radius={[5,5,0,0]} maxBarSize={36} />
                <Bar dataKey="delivered" name="Delivered" fill="url(#delivGrad2)" radius={[5,5,0,0]} maxBarSize={36} />
                <Bar dataKey="cancelled" name="Cancelled" fill="url(#cancGrad2)" radius={[5,5,0,0]} maxBarSize={36} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ── Revenue area chart ──────────────────────────────── */}
      {chartData.length > 0 && (
        <div className="rounded-2xl border border-border/60 bg-card overflow-hidden">
          <div className="px-5 pt-5 pb-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
                    <TrendingUp size={13} className="text-primary" />
                  </div>
                  <h3 className="text-[13px] font-bold text-foreground">Revenue Trend</h3>
                </div>
                <p className="text-[10.5px] text-muted-foreground ml-9">
                  ৳{summary.revenue.toLocaleString()} total · {viewMode} breakdown
                </p>
              </div>
              <ChangePill value={summary.revenueChange} />
            </div>
          </div>
          <div className="px-2 pb-5">
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={chartData} margin={{ top: 4, right: 12, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="revGrad2" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.25} />
                    <stop offset="80%" stopColor="#3b82f6" stopOpacity={0.04} />
                    <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 6" stroke="hsl(var(--border))" strokeOpacity={0.3} vertical={false} />
                <XAxis dataKey="label"
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))', fontWeight: 500 }}
                  axisLine={false} tickLine={false} dy={7}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  axisLine={false} tickLine={false}
                  tickFormatter={(v: number) => v >= 1000 ? `${(v/1000).toFixed(0)}k` : `${v}`}
                />
                <Tooltip content={<RevenueTooltip />}
                  cursor={{ stroke: '#3b82f6', strokeWidth: 1, strokeDasharray: '4 2' }} />
                <Area type="monotone" dataKey="revenue" name="Revenue (৳)"
                  stroke="#3b82f6" strokeWidth={2.5}
                  fill="url(#revGrad2)" dot={false}
                  activeDot={{ r: 5, strokeWidth: 2.5, stroke: '#3b82f6', fill: 'hsl(var(--background))' }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ── Status distribution pie ─────────────────────────── */}
      {statusPieData.length > 0 && (
        <div className="rounded-2xl border border-border/60 bg-card overflow-hidden">
          <div className="px-5 pt-5 pb-4">
            <div className="flex items-center gap-2 mb-1">
              <div className="w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center">
                <PieChartIcon size={13} className="text-amber-500" />
              </div>
              <h3 className="text-[13px] font-bold text-foreground">Status Distribution</h3>
            </div>
            <p className="text-[10.5px] text-muted-foreground ml-9">
              {statusPieData.length} active status types · {summary.total} orders total
            </p>
          </div>
          <div className="px-4 pb-5">
            <div className="flex items-center gap-4">
              {/* Pie */}
              <div className="flex-shrink-0">
                <ResponsiveContainer width={180} height={180}>
                  <PieChart>
                    <defs>
                      {statusPieData.map((entry, i) => (
                        <radialGradient key={i} id={`pg${i}`} cx="50%" cy="50%" r="50%">
                          <stop offset="0%" stopColor={entry.color} stopOpacity={1} />
                          <stop offset="100%" stopColor={entry.color} stopOpacity={0.8} />
                        </radialGradient>
                      ))}
                    </defs>
                    <Pie data={statusPieData} cx="50%" cy="50%"
                      innerRadius={50} outerRadius={78}
                      dataKey="value" strokeWidth={3} stroke="hsl(var(--background))"
                      paddingAngle={3}>
                      {statusPieData.map((_, i) => <Cell key={i} fill={`url(#pg${i})`} />)}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              {/* Custom legend */}
              <div className="flex-1 space-y-2">
                {statusPieData.map((entry) => {
                  const pct = summary.total > 0 ? Math.round((entry.value / summary.total) * 100) : 0;
                  return (
                    <div key={entry.name} className="flex items-center gap-2.5">
                      <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: entry.dot }} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="text-[11px] font-semibold text-foreground">{entry.name}</span>
                          <span className="text-[10px] font-bold text-muted-foreground">{entry.value} <span className="text-muted-foreground/60">({pct}%)</span></span>
                        </div>
                        <div className="w-full h-1 rounded-full bg-muted/50 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: entry.dot, opacity: 0.8 }} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Empty state */}
      {filteredOrders.length === 0 && !isLoading && (
        <div className="flex flex-col items-center justify-center py-16 text-center rounded-2xl border border-dashed border-border/60">
          <div className="w-14 h-14 rounded-2xl bg-muted/40 flex items-center justify-center mb-4">
            <Package size={24} className="text-muted-foreground/40" />
          </div>
          <p className="text-sm font-semibold text-muted-foreground">No orders yet</p>
          <p className="text-[11px] text-muted-foreground/60 mt-1">Orders will appear here once n8n starts sending data</p>
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
