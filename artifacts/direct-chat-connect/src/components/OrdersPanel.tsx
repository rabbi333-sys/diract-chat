import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { format, isToday, isYesterday } from 'date-fns';
import { cn } from '@/lib/utils';
import {
  Package, Clock, CheckCircle, XCircle, Truck, PackageCheck,
  Download, Search, Trash2, Webhook, X,
} from 'lucide-react';
import { toast } from 'sonner';
import OrderDetailSheet from './OrderDetailSheet';

// ─── Status config ────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; dot: string; icon: any }> = {
  pending:    { label: 'Pending',    bg: 'bg-amber-50 dark:bg-amber-900/30',    text: 'text-amber-700 dark:text-amber-300',   dot: 'bg-amber-400',   icon: Clock },
  confirmed:  { label: 'Confirmed',  bg: 'bg-blue-50 dark:bg-blue-900/30',      text: 'text-blue-700 dark:text-blue-300',     dot: 'bg-blue-500',    icon: CheckCircle },
  processing: { label: 'Processing', bg: 'bg-violet-50 dark:bg-violet-900/30',  text: 'text-violet-700 dark:text-violet-300', dot: 'bg-violet-500',  icon: Package },
  shipped:    { label: 'Shipped',    bg: 'bg-cyan-50 dark:bg-cyan-900/30',      text: 'text-cyan-700 dark:text-cyan-300',     dot: 'bg-cyan-500',    icon: Truck },
  delivered:  { label: 'Delivered',  bg: 'bg-emerald-50 dark:bg-emerald-900/30',text: 'text-emerald-700 dark:text-emerald-300',dot: 'bg-emerald-500', icon: PackageCheck },
  cancelled:  { label: 'Cancelled',  bg: 'bg-red-50 dark:bg-red-900/30',        text: 'text-red-600 dark:text-red-400',       dot: 'bg-red-500',     icon: XCircle },
};

// ─── Order interface ──────────────────────────────────────────────────────────

interface Order {
  id: string;
  product_name?: string;
  sku?: string;
  customer_name?: string;
  customer_phone?: string;
  customer_address?: string;
  quantity?: number;
  unit_price?: number;
  total_price?: number;
  amount_to_collect?: number;
  payment_status?: string;
  merchant_order_id?: string;
  status: string;
  created_at: string;
  _source?: 'local' | 'supabase';
}

// ─── Data hooks ───────────────────────────────────────────────────────────────

const useLocalOrders = () =>
  useQuery({
    queryKey: ['local-orders'],
    retry: false,
    refetchInterval: 5000,
    queryFn: async (): Promise<Order[]> => {
      try {
        const res = await fetch('/api/local/orders');
        if (!res.ok) return [];
        const data = await res.json();
        return (Array.isArray(data) ? data : []).map((d: Order) => ({ ...d, _source: 'local' as const }));
      } catch { return []; }
    },
  });

const useSupabaseOrders = () =>
  useQuery({
    queryKey: ['supabase-orders'],
    retry: false,
    refetchInterval: 15000,
    queryFn: async (): Promise<Order[]> => {
      try {
        const { data, error } = await supabase
          .from('orders')
          .select('*')
          .order('created_at', { ascending: false });
        if (error) return [];
        return ((data ?? []) as unknown as Order[]).map(d => ({ ...d, _source: 'supabase' as const }));
      } catch { return []; }
    },
  });

function mergeOrders(local: Order[], remote: Order[]): Order[] {
  const seen = new Set<string>();
  const result: Order[] = [];
  for (const item of [...local, ...remote]) {
    if (!seen.has(item.id)) { seen.add(item.id); result.push(item); }
  }
  return result.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export const useOrders = () => {
  const { data: local = [] } = useLocalOrders();
  const { data: remote = [] } = useSupabaseOrders();
  return { data: mergeOrders(local, remote), isLoading: false };
};

// ─── CSV Export ───────────────────────────────────────────────────────────────

function exportToCSV(orders: Order[]) {
  if (!orders.length) { toast.error('No data to export'); return; }

  const headers = [
    'merchant_order_id', 'date', 'address', 'name', 'phone',
    'product_name', 'sku', 'quantity', 'per_product_price', 'total_price', 'amount_to_collect',
  ];

  const escape = (v: any) => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const rows = orders.map(o => [
    o.merchant_order_id ?? '',
    format(new Date(o.created_at), 'dd/MM/yyyy HH:mm'),
    o.customer_address ?? '',
    o.customer_name ?? '',
    o.customer_phone ?? '',
    o.product_name ?? '',
    o.sku ?? '',
    o.quantity ?? 1,
    o.unit_price ?? '',
    o.total_price ?? '',
    o.amount_to_collect ?? '',
  ].map(escape));

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `orders_${format(new Date(), 'dd-MM-yyyy')}.csv`;
  link.click();
  toast.success(`${orders.length} orders exported`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function smartDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isToday(d))     return `Today, ${format(d, 'h:mm a')}`;
  if (isYesterday(d)) return `Yesterday, ${format(d, 'h:mm a')}`;
  return format(d, 'dd MMM yyyy');
}

function initials(name?: string): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

const AVATAR_COLORS = [
  'bg-blue-500', 'bg-violet-500', 'bg-emerald-500',
  'bg-amber-500', 'bg-cyan-500', 'bg-pink-500', 'bg-indigo-500',
];

function avatarColor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[h];
}

// ─── Main Component ───────────────────────────────────────────────────────────

const OrdersPanel = () => {
  const queryClient = useQueryClient();
  const { data: localOrders = [] } = useLocalOrders();
  const { data: supabaseOrders = [] } = useSupabaseOrders();
  const orders = useMemo(
    () => mergeOrders(localOrders, supabaseOrders),
    [localOrders, supabaseOrders]
  );

  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const deleteMutation = useMutation({
    mutationFn: async ({ id, source }: { id: string; source?: string }) => {
      if (source === 'local') {
        const res = await fetch(`/api/local/orders/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to delete local order');
        return;
      }
      const { error } = await supabase.from('orders').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['local-orders'] });
      queryClient.invalidateQueries({ queryKey: ['supabase-orders'] });
      toast.success('Order deleted');
    },
    onError: () => toast.error('Failed to delete order'),
  });

  const filtered = useMemo(() => {
    if (!search.trim()) return orders;
    const q = search.toLowerCase();
    return orders.filter(o =>
      (o.product_name ?? '').toLowerCase().includes(q) ||
      (o.customer_name ?? '').toLowerCase().includes(q) ||
      (o.customer_phone ?? '').toLowerCase().includes(q) ||
      (o.merchant_order_id ?? '').toLowerCase().includes(q) ||
      (o.sku ?? '').toLowerCase().includes(q)
    );
  }, [orders, search]);

  const newLocalCount = localOrders.length;

  return (
    <div className="flex flex-col h-full gap-3">

      {/* ── Toolbar ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2.5 flex-shrink-0">
        {/* Search */}
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" />
          <input
            type="text"
            placeholder="Search orders, customers, phone..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-8 py-2.5 text-[13px] rounded-xl border border-border/60 bg-background focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all placeholder:text-muted-foreground/40"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground transition-colors"
            >
              <X size={13} />
            </button>
          )}
        </div>

        {/* Live badge */}
        {newLocalCount > 0 && (
          <div className="flex items-center gap-1.5 text-[11px] text-amber-600 bg-amber-500/10 px-3 py-2.5 rounded-xl border border-amber-500/20 flex-shrink-0 font-semibold">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            {newLocalCount} live
          </div>
        )}

        {/* Result count */}
        {orders.length > 0 && (
          <span className="text-[11px] text-muted-foreground font-medium flex-shrink-0 hidden sm:block">
            {filtered.length === orders.length ? `${orders.length} orders` : `${filtered.length} / ${orders.length}`}
          </span>
        )}

        {/* CSV button */}
        <button
          onClick={() => exportToCSV(filtered)}
          disabled={!filtered.length}
          className={cn(
            "flex items-center gap-2 px-4 py-2.5 rounded-xl text-[12px] font-semibold transition-all flex-shrink-0",
            filtered.length
              ? "bg-primary text-white hover:bg-primary/90 shadow-sm hover:shadow-md"
              : "bg-muted text-muted-foreground cursor-not-allowed"
          )}
        >
          <Download size={13} /> Export CSV
        </button>
      </div>

      {/* ── Table / Empty states ─────────────────────────────────────── */}
      <div className="flex-1 overflow-auto scrollbar-hide min-h-0 rounded-2xl border border-border/60 bg-card">
        {!orders.length ? (
          <div className="flex flex-col items-center justify-center h-full py-20 text-center gap-3">
            <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center">
              <Package size={28} className="text-muted-foreground/30" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">No orders yet</p>
              <p className="text-xs text-muted-foreground mt-1">Orders from n8n will appear here automatically</p>
            </div>
          </div>
        ) : !filtered.length ? (
          <div className="flex flex-col items-center justify-center h-full py-20 text-center gap-3">
            <div className="w-14 h-14 rounded-2xl bg-muted/50 flex items-center justify-center">
              <Search size={22} className="text-muted-foreground/30" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">No results</p>
              <p className="text-xs text-muted-foreground mt-1">Try a different search term</p>
            </div>
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="bg-muted/60 backdrop-blur border-b border-border/60">
                <th className="text-left text-[11px] font-semibold text-muted-foreground px-5 py-3.5 w-[130px]">Order</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground px-4 py-3.5 hidden sm:table-cell">Product</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground px-4 py-3.5">Customer</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground px-4 py-3.5 hidden md:table-cell">Phone</th>
                <th className="text-right text-[11px] font-semibold text-muted-foreground px-4 py-3.5">Total</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground px-4 py-3.5">Status</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground px-4 py-3.5 hidden sm:table-cell">Date</th>
                <th className="w-12 px-4 py-3.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {filtered.map((order) => {
                const cfg = STATUS_CONFIG[order.status] ?? STATUS_CONFIG.pending;
                const total = Number(order.total_price) || Number(order.amount_to_collect) || 0;
                const orderId = order.merchant_order_id || order.id.slice(0, 8).toUpperCase();
                const initStr = initials(order.customer_name);
                const avatarBg = avatarColor(order.id);

                return (
                  <tr
                    key={order.id}
                    onClick={() => setSelectedOrderId(order.id)}
                    className="cursor-pointer group transition-colors hover:bg-muted/30"
                  >
                    {/* Order ID */}
                    <td className="px-5 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[13px] font-bold text-foreground">
                          {orderId}
                        </span>
                        {order._source === 'local' && (
                          <span className="text-[8px] font-bold text-amber-600 bg-amber-400/15 px-1.5 py-0.5 rounded-full border border-amber-400/30 leading-none">
                            LIVE
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Product */}
                    <td className="px-4 py-4 hidden sm:table-cell">
                      <span className="text-[12px] text-foreground truncate max-w-[140px] block">
                        {order.product_name || '—'}
                      </span>
                      {order.sku && (
                        <span className="text-[10px] text-muted-foreground/70">
                          {order.sku}
                        </span>
                      )}
                    </td>

                    {/* Customer */}
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-2.5">
                        <div className={cn(
                          'w-8 h-8 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0',
                          avatarBg
                        )}>
                          {initStr}
                        </div>
                        <span className="text-[13px] text-foreground font-medium truncate max-w-[110px]">
                          {order.customer_name || '—'}
                        </span>
                      </div>
                    </td>

                    {/* Phone */}
                    <td className="px-4 py-4 whitespace-nowrap hidden md:table-cell">
                      <span className="text-[12px] text-muted-foreground tabular-nums">
                        {order.customer_phone || '—'}
                      </span>
                    </td>

                    {/* Total */}
                    <td className="px-4 py-4 whitespace-nowrap text-right">
                      <span className="text-[13px] font-bold text-foreground tabular-nums">
                        ৳{total.toLocaleString()}
                      </span>
                    </td>

                    {/* Status */}
                    <td className="px-4 py-4 whitespace-nowrap">
                      <span className={cn(
                        "inline-flex items-center gap-1.5 text-[11.5px] font-medium px-2.5 py-1 rounded-full",
                        cfg.bg, cfg.text,
                      )}>
                        <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', cfg.dot)} />
                        {cfg.label}
                      </span>
                    </td>

                    {/* Date */}
                    <td className="px-4 py-4 whitespace-nowrap hidden sm:table-cell">
                      <span className="text-[12px] text-muted-foreground">
                        {smartDate(order.created_at)}
                      </span>
                    </td>

                    {/* Delete */}
                    <td className="px-4 py-4 text-right">
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          if (window.confirm('Delete this order?')) {
                            deleteMutation.mutate({ id: order.id, source: order._source });
                          }
                        }}
                        disabled={deleteMutation.isPending}
                        className="opacity-0 group-hover:opacity-100 transition-all text-muted-foreground/40 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 p-1.5 rounded-lg disabled:opacity-20"
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Order Detail Sheet */}
      <OrderDetailSheet
        orderId={selectedOrderId}
        onClose={() => setSelectedOrderId(null)}
      />
    </div>
  );
};

export default OrdersPanel;
