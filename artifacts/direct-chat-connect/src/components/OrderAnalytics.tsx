import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { cn } from '@/lib/utils';
import { format, subDays, startOfWeek, startOfMonth, isWithinInterval, parseISO } from 'date-fns';
import {
  TrendingUp, TrendingDown, Package, Truck, XCircle, CheckCircle,
  ArrowUpRight, ArrowDownRight, Clock, PackageCheck, Loader2,
  ShoppingBag, CreditCard, Banknote, RefreshCw, BarChart2,
} from 'lucide-react';

type ViewMode = 'daily' | 'weekly' | 'monthly';

const STATUS_META: Record<string, { label: string; color: string; bg: string; icon: any; chartColor: string }> = {
  pending:    { label: 'Pending',    color: 'text-amber-600',   bg: 'bg-amber-500/10',   icon: Clock,        chartColor: 'hsl(38,92%,50%)' },
  confirmed:  { label: 'Confirmed',  color: 'text-blue-600',    bg: 'bg-blue-500/10',    icon: CheckCircle,  chartColor: 'hsl(217,91%,60%)' },
  processing: { label: 'Processing', color: 'text-violet-600',  bg: 'bg-violet-500/10',  icon: Package,      chartColor: 'hsl(270,70%,60%)' },
  shipped:    { label: 'Shipped',    color: 'text-cyan-600',    bg: 'bg-cyan-500/10',    icon: Truck,        chartColor: 'hsl(185,85%,45%)' },
  delivered:  { label: 'Delivered',  color: 'text-emerald-600', bg: 'bg-emerald-500/10', icon: PackageCheck, chartColor: 'hsl(142,71%,45%)' },
  cancelled:  { label: 'Cancelled',  color: 'text-red-500',     bg: 'bg-red-500/10',     icon: XCircle,      chartColor: 'hsl(0,84%,60%)' },
};

const PIE_COLORS = ['hsl(38,92%,50%)', 'hsl(217,91%,60%)', 'hsl(270,70%,60%)', 'hsl(185,85%,45%)', 'hsl(142,71%,45%)', 'hsl(0,84%,60%)'];

const OrderAnalytics = () => {
  const [viewMode, setViewMode] = useState<ViewMode>('daily');
  const [days, setDays] = useState(30);

  const { data: orders = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['orders-analytics'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 30000,
  });

  const dateRange = useMemo(() => {
    const end = new Date();
    const start = subDays(end, days);
    return { start, end };
  }, [days]);

  const filteredOrders = useMemo(() =>
    orders.filter(o => isWithinInterval(parseISO(o.created_at), dateRange)),
    [orders, dateRange]
  );

  const previousOrders = useMemo(() => {
    const end = subDays(dateRange.start, 1);
    const start = subDays(end, days);
    return orders.filter(o => isWithinInterval(parseISO(o.created_at), { start, end }));
  }, [orders, dateRange, days]);

  const calcChange = (curr: number, prev: number) =>
    prev === 0 ? (curr > 0 ? 100 : 0) : Math.round(((curr - prev) / prev) * 100);

  const summary = useMemo(() => {
    const count = (status: string) => filteredOrders.filter(o => o.status === status).length;
    const prevCount = (status: string) => previousOrders.filter(o => o.status === status).length;

    const total = filteredOrders.length;
    const revenue = filteredOrders.reduce((s, o) => s + (Number(o.total_price) || 0), 0);
    const collectAmount = filteredOrders.reduce((s, o) => s + (Number(o.amount_to_collect) || 0), 0);
    const paid = filteredOrders.filter(o => o.payment_status === 'paid').length;
    const unpaid = filteredOrders.filter(o => o.payment_status !== 'paid').length;

    const prevTotal = previousOrders.length;
    const prevRevenue = previousOrders.reduce((s, o) => s + (Number(o.total_price) || 0), 0);

    return {
      total, revenue, collectAmount, paid, unpaid,
      totalChange: calcChange(total, prevTotal),
      revenueChange: calcChange(revenue, prevRevenue),
      statuses: {
        pending:    { count: count('pending'),    change: calcChange(count('pending'),    prevCount('pending')) },
        confirmed:  { count: count('confirmed'),  change: calcChange(count('confirmed'),  prevCount('confirmed')) },
        processing: { count: count('processing'), change: calcChange(count('processing'), prevCount('processing')) },
        shipped:    { count: count('shipped'),     change: calcChange(count('shipped'),    prevCount('shipped')) },
        delivered:  { count: count('delivered'),  change: calcChange(count('delivered'),  prevCount('delivered')) },
        cancelled:  { count: count('cancelled'),  change: calcChange(count('cancelled'),  prevCount('cancelled')) },
      },
    };
  }, [filteredOrders, previousOrders]);

  const chartData = useMemo(() => {
    const buckets: Record<string, { label: string; total: number; delivered: number; cancelled: number; pending: number; revenue: number }> = {};
    filteredOrders.forEach(order => {
      const d = parseISO(order.created_at);
      let key: string, label: string;
      if (viewMode === 'daily') {
        key = format(d, 'yyyy-MM-dd'); label = format(d, 'dd MMM');
      } else if (viewMode === 'weekly') {
        const ws = startOfWeek(d, { weekStartsOn: 6 });
        key = format(ws, 'yyyy-MM-dd'); label = `W ${format(ws, 'dd MMM')}`;
      } else {
        const ms = startOfMonth(d);
        key = format(ms, 'yyyy-MM'); label = format(ms, 'MMM yyyy');
      }
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
      .map(([key, v]) => ({ name: STATUS_META[key].label, value: v.count, color: STATUS_META[key].chartColor })),
    [summary]
  );

  const paymentData = useMemo(() => [
    { name: 'Paid', value: summary.paid, color: 'hsl(142,71%,45%)' },
    { name: 'Unpaid', value: summary.unpaid, color: 'hsl(38,92%,50%)' },
  ].filter(d => d.value > 0), [summary]);

  if (isLoading) {
    return (
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          {[...Array(8)].map((_, i) => <div key={i} className="h-24 rounded-2xl bg-muted/50 animate-pulse" />)}
        </div>
        <div className="h-64 rounded-2xl bg-muted/50 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-5">

      {/* ── Controls bar ────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {/* View mode */}
          <div className="flex items-center bg-muted/50 rounded-xl p-1 gap-0.5">
            {(['daily', 'weekly', 'monthly'] as ViewMode[]).map(m => (
              <button key={m} onClick={() => setViewMode(m)}
                className={cn(
                  'text-[11px] font-semibold px-3 py-1.5 rounded-lg transition-all',
                  viewMode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {m === 'daily' ? 'Daily' : m === 'weekly' ? 'Weekly' : 'Monthly'}
              </button>
            ))}
          </div>
          {/* Day range */}
          <div className="flex items-center bg-muted/50 rounded-xl p-1 gap-0.5">
            {[7, 30, 90].map(d => (
              <button key={d} onClick={() => setDays(d)}
                className={cn(
                  'text-[11px] font-semibold px-3 py-1.5 rounded-lg transition-all',
                  days === d ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>

        <button onClick={() => refetch()} disabled={isFetching}
          className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-xl bg-muted/50 transition-colors"
        >
          <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* ── Revenue + Collect hero cards ─────────────────────────── */}
      <div className="grid grid-cols-2 gap-3">
        <HeroCard
          icon={TrendingUp}
          label="Total Revenue"
          value={`৳${summary.revenue.toLocaleString()}`}
          change={summary.revenueChange}
          gradient="from-primary/10 to-primary/5"
          iconColor="text-primary"
          valueColor="text-primary"
        />
        <HeroCard
          icon={TrendingDown}
          label="To Collect"
          value={`৳${summary.collectAmount.toLocaleString()}`}
          gradient="from-stat-blue/10 to-stat-blue/5"
          iconColor="text-stat-blue"
          valueColor="text-stat-blue"
        />
      </div>

      {/* ── Order summary row ─────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          icon={ShoppingBag}
          label="Total Orders"
          value={summary.total}
          change={summary.totalChange}
          iconColor="text-foreground"
          iconBg="bg-muted/60"
        />
        <StatCard
          icon={CreditCard}
          label="Paid"
          value={summary.paid}
          iconColor="text-emerald-600"
          iconBg="bg-emerald-500/10"
          suffix={summary.total > 0 ? `${Math.round((summary.paid / summary.total) * 100)}%` : undefined}
        />
      </div>

      {/* ── Status breakdown grid (all 6 statuses) ───────────────── */}
      <div>
        <SectionLabel icon={BarChart2} label="Order Status Breakdown" />
        <div className="grid grid-cols-3 gap-2">
          {(Object.entries(STATUS_META) as [string, typeof STATUS_META[string]][]).map(([key, meta]) => {
            const { count, change } = summary.statuses[key as keyof typeof summary.statuses];
            const pct = summary.total > 0 ? Math.round((count / summary.total) * 100) : 0;
            return (
              <StatusCard
                key={key}
                icon={meta.icon}
                label={meta.label}
                count={count}
                change={change}
                pct={pct}
                color={meta.color}
                bg={meta.bg}
                barColor={meta.chartColor}
              />
            );
          })}
        </div>
      </div>

      {/* ── Payment status bar ────────────────────────────────────── */}
      {summary.total > 0 && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Banknote size={14} className="text-muted-foreground" />
              <span className="text-xs font-semibold text-foreground">Payment Status</span>
            </div>
            <div className="flex items-center gap-3 text-[11px]">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
                <span className="text-muted-foreground">Paid: <span className="font-semibold text-foreground">{summary.paid}</span></span>
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" />
                <span className="text-muted-foreground">Unpaid: <span className="font-semibold text-foreground">{summary.unpaid}</span></span>
              </span>
            </div>
          </div>
          <div className="w-full h-3 rounded-full bg-muted overflow-hidden flex">
            {summary.paid > 0 && (
              <div
                className="h-full bg-emerald-500 transition-all duration-700 rounded-l-full"
                style={{ width: `${Math.round((summary.paid / summary.total) * 100)}%` }}
              />
            )}
            {summary.unpaid > 0 && (
              <div
                className="h-full bg-amber-400 transition-all duration-700 rounded-r-full"
                style={{ width: `${Math.round((summary.unpaid / summary.total) * 100)}%` }}
              />
            )}
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground mt-1.5">
            <span>{summary.total > 0 ? Math.round((summary.paid / summary.total) * 100) : 0}% paid</span>
            <span>{summary.total > 0 ? Math.round((summary.unpaid / summary.total) * 100) : 0}% unpaid</span>
          </div>
        </div>
      )}

      {/* ── Revenue trend chart ───────────────────────────────────── */}
      {chartData.length > 0 && (
        <ChartCard title="Revenue Trend">
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(217,91%,60%)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="hsl(217,91%,60%)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="revenue" name="Revenue (৳)" stroke="hsl(var(--primary))" strokeWidth={2.5} fill="url(#revGrad)" dot={false} activeDot={{ r: 5, strokeWidth: 2, fill: 'hsl(var(--background))' }} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* ── Orders bar chart ──────────────────────────────────────── */}
      {chartData.length > 0 && (
        <ChartCard title={`Orders by ${viewMode === 'daily' ? 'Day' : viewMode === 'weekly' ? 'Week' : 'Month'}`}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData} barGap={3}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
              <Bar dataKey="total" name="Total" fill="hsl(var(--primary))" radius={[5, 5, 0, 0]} />
              <Bar dataKey="delivered" name="Delivered" fill="hsl(142,71%,45%)" radius={[5, 5, 0, 0]} />
              <Bar dataKey="cancelled" name="Cancelled" fill="hsl(0,84%,60%)" radius={[5, 5, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* ── Pie charts row ────────────────────────────────────────── */}
      {(statusPieData.length > 0 || paymentData.length > 1) && (
        <div className="grid grid-cols-2 gap-3">
          {statusPieData.length > 0 && (
            <ChartCard title="Status Split">
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={statusPieData} cx="50%" cy="50%" innerRadius={48} outerRadius={75}
                    dataKey="value" strokeWidth={2} stroke="hsl(var(--background))"
                  >
                    {statusPieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '8px' }} />
                </PieChart>
              </ResponsiveContainer>
            </ChartCard>
          )}
          {paymentData.length > 1 && (
            <ChartCard title="Payment Split">
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={paymentData} cx="50%" cy="50%" innerRadius={48} outerRadius={75}
                    dataKey="value" strokeWidth={2} stroke="hsl(var(--background))"
                  >
                    {paymentData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                  <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '8px' }} />
                </PieChart>
              </ResponsiveContainer>
            </ChartCard>
          )}
        </div>
      )}

      {/* Empty state */}
      {filteredOrders.length === 0 && !isLoading && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Package size={36} className="text-muted-foreground/40 mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No orders in this period</p>
          <p className="text-xs text-muted-foreground/60 mt-1">Try selecting a longer date range</p>
        </div>
      )}
    </div>
  );
};

// ── Sub-components ────────────────────────────────────────────────────────────

const SectionLabel = ({ icon: Icon, label }: { icon: any; label: string }) => (
  <div className="flex items-center gap-2 mb-2.5">
    <Icon size={13} className="text-muted-foreground" />
    <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
  </div>
);

const HeroCard = ({ icon: Icon, label, value, change, gradient, iconColor, valueColor }: {
  icon: any; label: string; value: string; change?: number;
  gradient: string; iconColor: string; valueColor: string;
}) => {
  const isPositive = change !== undefined && change >= 0;
  return (
    <div className={cn('rounded-2xl border border-border bg-gradient-to-br p-4 transition-all hover:shadow-md hover:-translate-y-0.5', gradient)}>
      <div className="flex items-start justify-between mb-3">
        <div className="p-2 rounded-xl bg-background/50 backdrop-blur-sm">
          <Icon size={16} className={iconColor} />
        </div>
        {change !== undefined && (
          <span className={cn('flex items-center gap-0.5 text-[10px] font-bold px-2 py-0.5 rounded-full',
            isPositive ? 'bg-emerald-500/15 text-emerald-600' : 'bg-red-500/15 text-red-500'
          )}>
            {isPositive ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
            {Math.abs(change)}%
          </span>
        )}
      </div>
      <p className={cn('text-2xl font-bold tracking-tight', valueColor)}>{value}</p>
      <span className="text-[11px] text-muted-foreground font-medium mt-1 block">{label}</span>
    </div>
  );
};

const StatCard = ({ icon: Icon, label, value, change, iconColor, iconBg, suffix }: {
  icon: any; label: string; value: number; change?: number;
  iconColor: string; iconBg: string; suffix?: string;
}) => {
  const isPositive = change !== undefined && change >= 0;
  return (
    <div className="rounded-2xl border border-border bg-card p-4 transition-all hover:shadow-sm hover:border-primary/20">
      <div className="flex items-start justify-between mb-2.5">
        <div className={cn('p-2 rounded-xl', iconBg)}>
          <Icon size={16} className={iconColor} />
        </div>
        {change !== undefined && (
          <span className={cn('flex items-center gap-0.5 text-[10px] font-bold px-2 py-0.5 rounded-full',
            isPositive ? 'bg-emerald-500/10 text-emerald-600' : 'bg-red-500/10 text-red-500'
          )}>
            {isPositive ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
            {Math.abs(change)}%
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-1.5">
        <p className="text-2xl font-bold text-foreground">{value.toLocaleString()}</p>
        {suffix && <span className="text-[11px] font-semibold text-muted-foreground">{suffix}</span>}
      </div>
      <span className="text-[11px] text-muted-foreground font-medium mt-1 block">{label}</span>
    </div>
  );
};

const StatusCard = ({ icon: Icon, label, count, change, pct, color, bg, barColor }: {
  icon: any; label: string; count: number; change: number; pct: number;
  color: string; bg: string; barColor: string;
}) => {
  const isPositive = change >= 0;
  return (
    <div className="rounded-xl border border-border bg-card p-3 space-y-2 transition-all hover:shadow-sm">
      <div className="flex items-center justify-between">
        <div className={cn('p-1.5 rounded-lg', bg)}>
          <Icon size={13} className={color} />
        </div>
        {change !== 0 && (
          <span className={cn('flex items-center gap-0.5 text-[9px] font-bold',
            isPositive ? 'text-emerald-600' : 'text-red-500'
          )}>
            {isPositive ? <ArrowUpRight size={9} /> : <ArrowDownRight size={9} />}
            {Math.abs(change)}%
          </span>
        )}
      </div>
      <div>
        <p className={cn('text-xl font-bold leading-none', color)}>{count}</p>
        <span className="text-[10px] text-muted-foreground font-medium mt-0.5 block">{label}</span>
      </div>
      {pct > 0 && (
        <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
          <div className="h-full rounded-full transition-all duration-700"
            style={{ width: `${pct}%`, backgroundColor: barColor }}
          />
        </div>
      )}
    </div>
  );
};

const ChartCard = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="rounded-2xl border border-border bg-card p-4 transition-all hover:shadow-sm">
    <h3 className="text-xs font-semibold text-foreground mb-4 tracking-tight">{title}</h3>
    {children}
  </div>
);

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-xl shadow-lg p-3 min-w-[130px]">
      {label && <p className="text-[11px] font-semibold text-foreground mb-2">{label}</p>}
      {payload.map((entry: any, i: number) => (
        <div key={i} className="flex items-center justify-between gap-4 py-0.5">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
            <span className="text-[10px] text-muted-foreground">{entry.name}</span>
          </div>
          <span className="text-[10px] font-bold text-foreground">
            {typeof entry.value === 'number' ? entry.value.toLocaleString() : entry.value}
          </span>
        </div>
      ))}
    </div>
  );
};

export default OrderAnalytics;
