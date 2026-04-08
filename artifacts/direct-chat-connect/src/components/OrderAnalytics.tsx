import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { cn } from '@/lib/utils';
import { format, subDays, startOfWeek, startOfMonth, isWithinInterval, parseISO } from 'date-fns';
import { TrendingUp, TrendingDown, Package, Truck, XCircle, CheckCircle, ArrowUpRight, ArrowDownRight } from 'lucide-react';

type ViewMode = 'daily' | 'weekly' | 'monthly';

const COLORS = [
  'hsl(217, 91%, 60%)',
  'hsl(142, 71%, 45%)',
  'hsl(0, 84%, 60%)',
  'hsl(38, 92%, 50%)',
  'hsl(270, 70%, 60%)',
  'hsl(25, 95%, 53%)',
];

const OrderAnalytics = () => {
  const [viewMode, setViewMode] = useState<ViewMode>('daily');
  const [days, setDays] = useState(30);

  const { data: orders = [], isLoading } = useQuery({
    queryKey: ['orders-analytics'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data;
    },
    refetchInterval: 30000,
  });

  const dateRange = useMemo(() => {
    const end = new Date();
    const start = subDays(end, days);
    return { start, end };
  }, [days]);

  const filteredOrders = useMemo(() => {
    return orders.filter(o => {
      const d = parseISO(o.created_at);
      return isWithinInterval(d, { start: dateRange.start, end: dateRange.end });
    });
  }, [orders, dateRange]);

  const previousRange = useMemo(() => {
    const end = subDays(dateRange.start, 1);
    const start = subDays(end, days);
    return { start, end };
  }, [dateRange, days]);

  const previousOrders = useMemo(() => {
    return orders.filter(o => {
      const d = parseISO(o.created_at);
      return isWithinInterval(d, { start: previousRange.start, end: previousRange.end });
    });
  }, [orders, previousRange]);

  const summary = useMemo(() => {
    const total = filteredOrders.length;
    const delivered = filteredOrders.filter(o => o.status === 'delivered').length;
    const cancelled = filteredOrders.filter(o => o.status === 'cancelled').length;
    const pending = filteredOrders.filter(o => o.status === 'pending').length;
    const revenue = filteredOrders.reduce((sum, o) => sum + (Number(o.total_price) || 0), 0);
    const collectAmount = filteredOrders.reduce((sum, o) => sum + (Number(o.amount_to_collect) || 0), 0);

    const prevTotal = previousOrders.length;
    const prevRevenue = previousOrders.reduce((sum, o) => sum + (Number(o.total_price) || 0), 0);
    const prevDelivered = previousOrders.filter(o => o.status === 'delivered').length;
    const prevCancelled = previousOrders.filter(o => o.status === 'cancelled').length;

    const calcChange = (curr: number, prev: number) => prev === 0 ? (curr > 0 ? 100 : 0) : Math.round(((curr - prev) / prev) * 100);

    return {
      total, delivered, cancelled, pending, revenue, collectAmount,
      totalChange: calcChange(total, prevTotal),
      revenueChange: calcChange(revenue, prevRevenue),
      deliveredChange: calcChange(delivered, prevDelivered),
      cancelledChange: calcChange(cancelled, prevCancelled),
    };
  }, [filteredOrders, previousOrders]);

  const chartData = useMemo(() => {
    const buckets: Record<string, { label: string; total: number; delivered: number; cancelled: number; pending: number; revenue: number }> = {};

    filteredOrders.forEach(order => {
      const d = parseISO(order.created_at);
      let key: string;
      let label: string;

      if (viewMode === 'daily') {
        key = format(d, 'yyyy-MM-dd');
        label = format(d, 'dd MMM');
      } else if (viewMode === 'weekly') {
        const ws = startOfWeek(d, { weekStartsOn: 6 });
        key = format(ws, 'yyyy-MM-dd');
        label = `W ${format(ws, 'dd MMM')}`;
      } else {
        const ms = startOfMonth(d);
        key = format(ms, 'yyyy-MM');
        label = format(ms, 'MMM yyyy');
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

  const statusData = useMemo(() => {
    const counts: Record<string, number> = {};
    filteredOrders.forEach(o => {
      counts[o.status] = (counts[o.status] || 0) + 1;
    });
    return Object.entries(counts).map(([name, value]) => ({ name: statusLabel(name), value }));
  }, [filteredOrders]);

  const courierData = useMemo(() => {
    const p = filteredOrders.reduce((s, o) => s + (Number((o as any).pathao) || 0), 0);
    const st = filteredOrders.reduce((s, o) => s + (Number((o as any).steadfast) || 0), 0);
    const pf = filteredOrders.reduce((s, o) => s + (Number((o as any).paperfly) || 0), 0);
    const r = filteredOrders.reduce((s, o) => s + (Number((o as any).redex) || 0), 0);
    return [
      { name: 'Pathao', value: p },
      { name: 'Steadfast', value: st },
      { name: 'Paperfly', value: pf },
      { name: 'Redex', value: r },
    ].filter(c => c.value > 0);
  }, [filteredOrders]);

  if (isLoading) {
    return (
      <div className="space-y-6 p-1">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map(i => (
            <div key={i} className="h-28 bg-muted/50 rounded-2xl animate-pulse" />
          ))}
        </div>
        <div className="h-72 bg-muted/50 rounded-2xl animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center bg-muted/50 rounded-xl p-1 gap-0.5">
          {(['daily', 'weekly', 'monthly'] as ViewMode[]).map(m => (
            <button key={m} onClick={() => setViewMode(m)}
              className={cn(
                "text-xs font-medium px-4 py-2 rounded-lg transition-all duration-200",
                viewMode === m
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {m === 'daily' ? 'Daily' : m === 'weekly' ? 'Weekly' : 'Monthly'}
            </button>
          ))}
        </div>
        <div className="flex items-center bg-muted/50 rounded-xl p-1 gap-0.5">
          {[7, 30, 90].map(d => (
            <button key={d} onClick={() => setDays(d)}
              className={cn(
                "text-xs font-medium px-3 py-1.5 rounded-lg transition-all duration-200",
                days === d
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {d} Days
            </button>
          ))}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <PremiumCard icon={Package} label="Total Orders" value={summary.total} change={summary.totalChange} />
        <PremiumCard icon={CheckCircle} label="Delivered" value={summary.delivered} change={summary.deliveredChange} variant="success" />
        <PremiumCard icon={XCircle} label="Cancelled" value={summary.cancelled} change={summary.cancelledChange} variant="destructive" />
        <PremiumCard icon={Truck} label="Pending" value={summary.pending} variant="warning" />
        <PremiumCard icon={TrendingUp} label="Total Revenue" value={`৳${summary.revenue.toLocaleString()}`} change={summary.revenueChange} variant="primary" />
        <PremiumCard icon={TrendingDown} label="To Collect" value={`৳${summary.collectAmount.toLocaleString()}`} variant="info" />
      </div>

      {/* Revenue Area Chart */}
      {chartData.length > 0 && (
        <ChartContainer title="Revenue Trend">
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="revenueGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="revenue" name="Revenue (৳)" stroke="hsl(var(--primary))" strokeWidth={2.5} fill="url(#revenueGrad)" dot={false} activeDot={{ r: 5, strokeWidth: 2, fill: 'hsl(var(--background))' }} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartContainer>
      )}

      {/* Orders Bar Chart */}
      {chartData.length > 0 && (
        <ChartContainer title={`Orders (${viewMode === 'daily' ? 'Daily' : viewMode === 'weekly' ? 'Weekly' : 'Monthly'})`}>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '12px' }} />
              <Bar dataKey="total" name="Total" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
              <Bar dataKey="delivered" name="Delivered" fill="hsl(142, 71%, 45%)" radius={[6, 6, 0, 0]} />
              <Bar dataKey="cancelled" name="Cancelled" fill="hsl(0, 84%, 60%)" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartContainer>
      )}

      {/* Pie Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {statusData.length > 0 && (
          <ChartContainer title="Status Distribution">
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={statusData} cx="50%" cy="50%" innerRadius={55} outerRadius={85} dataKey="value" strokeWidth={2} stroke="hsl(var(--background))"
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  labelLine={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1 }}
                >
                  {statusData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
              </PieChart>
            </ResponsiveContainer>
          </ChartContainer>
        )}

        {courierData.length > 0 && (
          <ChartContainer title="Courier Distribution">
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={courierData} cx="50%" cy="50%" innerRadius={55} outerRadius={85} dataKey="value" strokeWidth={2} stroke="hsl(var(--background))"
                  label={({ name, value }) => `${name}: ${value}`}
                  labelLine={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1 }}
                >
                  {courierData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
              </PieChart>
            </ResponsiveContainer>
          </ChartContainer>
        )}
      </div>
    </div>
  );
};

// Premium Summary Card
const PremiumCard = ({ icon: Icon, label, value, change, variant = 'default' }: {
  icon: any; label: string; value: string | number; change?: number; variant?: 'default' | 'success' | 'destructive' | 'warning' | 'primary' | 'info';
}) => {
  const variantStyles: Record<string, { icon: string; value: string; bg: string }> = {
    default: { icon: 'text-foreground', value: 'text-foreground', bg: 'bg-muted/40' },
    success: { icon: 'text-stat-green', value: 'text-stat-green', bg: 'bg-stat-green/8' },
    destructive: { icon: 'text-destructive', value: 'text-destructive', bg: 'bg-destructive/8' },
    warning: { icon: 'text-warning', value: 'text-warning', bg: 'bg-warning/8' },
    primary: { icon: 'text-primary', value: 'text-primary', bg: 'bg-primary/8' },
    info: { icon: 'text-stat-blue', value: 'text-stat-blue', bg: 'bg-stat-blue/8' },
  };

  const styles = variantStyles[variant];
  const isPositive = change !== undefined && change >= 0;

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border bg-card p-5 transition-all duration-300 hover:shadow-md hover:border-primary/20 hover:-translate-y-0.5">
      <div className="flex items-start justify-between mb-3">
        <div className={cn("p-2.5 rounded-xl", styles.bg)}>
          <Icon size={18} className={styles.icon} />
        </div>
        {change !== undefined && (
          <div className={cn(
            "flex items-center gap-0.5 text-[11px] font-semibold px-2 py-1 rounded-full",
            isPositive ? "text-stat-green bg-stat-green/10" : "text-destructive bg-destructive/10"
          )}>
            {isPositive ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
            {Math.abs(change)}%
          </div>
        )}
      </div>
      <p className={cn("text-2xl font-bold tracking-tight", styles.value)}>{value}</p>
      <span className="text-xs text-muted-foreground font-medium mt-1.5 block">{label}</span>
    </div>
  );
};

// Chart Container
const ChartContainer = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="rounded-2xl border border-border bg-card p-5 transition-all duration-300 hover:shadow-sm">
    <h3 className="text-sm font-semibold text-foreground mb-5 tracking-tight">{title}</h3>
    {children}
  </div>
);

// Custom Tooltip
const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-xl shadow-lg p-3 min-w-[140px]">
      <p className="text-xs font-semibold text-foreground mb-2">{label}</p>
      {payload.map((entry: any, i: number) => (
        <div key={i} className="flex items-center justify-between gap-4 py-0.5">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
            <span className="text-[11px] text-muted-foreground">{entry.name}</span>
          </div>
          <span className="text-[11px] font-semibold text-foreground">{typeof entry.value === 'number' ? entry.value.toLocaleString() : entry.value}</span>
        </div>
      ))}
    </div>
  );
};

function statusLabel(s: string): string {
  const map: Record<string, string> = {
    pending: 'Pending',
    confirmed: 'Confirmed',
    processing: 'Processing',
    shipped: 'Shipped',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
  };
  return map[s] || s;
}

export default OrderAnalytics;
