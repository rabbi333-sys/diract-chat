import { useQuery } from '@tanstack/react-query';
import { useState, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import {
  Package, Clock, CheckCircle, XCircle, Truck, PackageCheck,
  Download, Search, Trash2, Webhook,
} from 'lucide-react';
import { toast } from 'sonner';
import OrderDetailSheet from './OrderDetailSheet';

// ─── Status config ────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; icon: any }> = {
  pending:    { label: 'pending',    bg: 'bg-amber-100 dark:bg-amber-900/40',   text: 'text-amber-700 dark:text-amber-300',  icon: Clock },
  confirmed:  { label: 'confirmed',  bg: 'bg-blue-100 dark:bg-blue-900/40',     text: 'text-blue-700 dark:text-blue-300',    icon: CheckCircle },
  processing: { label: 'processing', bg: 'bg-violet-100 dark:bg-violet-900/40', text: 'text-violet-700 dark:text-violet-300',icon: Package },
  shipped:    { label: 'shipped',    bg: 'bg-cyan-100 dark:bg-cyan-900/40',     text: 'text-cyan-700 dark:text-cyan-300',    icon: Truck },
  delivered:  { label: 'delivered',  bg: 'bg-emerald-100 dark:bg-emerald-900/40',text: 'text-emerald-700 dark:text-emerald-300',icon: PackageCheck },
  cancelled:  { label: 'cancelled',  bg: 'bg-red-100 dark:bg-red-900/40',       text: 'text-red-700 dark:text-red-300',      icon: XCircle },
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

// ─── Main Component ───────────────────────────────────────────────────────────

const OrdersPanel = () => {
  const { data: localOrders = [] } = useLocalOrders();
  const { data: supabaseOrders = [] } = useSupabaseOrders();
  const orders = mergeOrders(localOrders, supabaseOrders);

  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

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
    <div className="flex flex-col h-full gap-2.5">

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Search by product, customer, phone, order ID..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-2 text-xs rounded-xl border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 placeholder:text-muted-foreground/50"
          />
        </div>
        {newLocalCount > 0 && (
          <div className="flex items-center gap-1.5 text-[10px] text-amber-600 bg-amber-500/10 px-2.5 py-2 rounded-xl border border-amber-500/20 flex-shrink-0">
            <Webhook size={11} />
            <span className="font-bold">{newLocalCount} live</span>
          </div>
        )}
        <button
          onClick={() => exportToCSV(filtered)}
          disabled={!filtered.length}
          className={cn(
            "flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all flex-shrink-0",
            filtered.length
              ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm"
              : "bg-muted text-muted-foreground cursor-not-allowed"
          )}
        >
          <Download size={13} /> CSV
        </button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto min-h-0 rounded-xl border border-border bg-card">
        {!orders.length ? (
          <div className="flex flex-col items-center justify-center h-full py-20 text-center">
            <div className="w-14 h-14 rounded-2xl bg-muted/50 flex items-center justify-center mb-3">
              <Package size={24} className="text-muted-foreground/40" />
            </div>
            <p className="text-sm font-semibold text-muted-foreground">No orders yet</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Orders from n8n will appear here</p>
          </div>
        ) : !filtered.length ? (
          <div className="flex flex-col items-center justify-center h-full py-20 text-center">
            <Search size={24} className="text-muted-foreground/40 mb-3" />
            <p className="text-sm font-semibold text-muted-foreground">No matches found</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left text-[11px] font-semibold text-muted-foreground px-4 py-3 whitespace-nowrap">Order Number</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground px-4 py-3 whitespace-nowrap">Customer</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground px-4 py-3 whitespace-nowrap">Phone</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground px-4 py-3 whitespace-nowrap">Total</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground px-4 py-3 whitespace-nowrap">Payment</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground px-4 py-3 whitespace-nowrap">Status</th>
                <th className="text-left text-[11px] font-semibold text-muted-foreground px-4 py-3 whitespace-nowrap">Date</th>
                <th className="px-3 py-3 w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {filtered.map(order => {
                const cfg = STATUS_CONFIG[order.status] ?? STATUS_CONFIG.pending;
                const total = Number(order.total_price) || Number(order.amount_to_collect) || 0;
                const paymentStatus = order.payment_status || 'unpaid';

                return (
                  <tr
                    key={order.id}
                    onClick={() => setSelectedOrderId(order.id)}
                    className="hover:bg-muted/30 transition-colors cursor-pointer group"
                  >
                    {/* Order Number */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="font-semibold text-foreground text-xs">
                        {order.merchant_order_id || order.id.slice(0, 8).toUpperCase()}
                      </span>
                      {order._source === 'local' && (
                        <span className="ml-1.5 text-[8px] font-bold text-amber-600 bg-amber-100 dark:bg-amber-900/40 px-1 py-0.5 rounded">
                          LIVE
                        </span>
                      )}
                    </td>

                    {/* Customer */}
                    <td className="px-4 py-3">
                      <span className="text-xs text-foreground font-medium">
                        {order.customer_name || '—'}
                      </span>
                    </td>

                    {/* Phone */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="text-xs text-muted-foreground">
                        {order.customer_phone || '—'}
                      </span>
                    </td>

                    {/* Total */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="text-xs font-semibold text-foreground">
                        ৳{total.toLocaleString()}
                      </span>
                    </td>

                    {/* Payment */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="text-xs text-muted-foreground">
                        {paymentStatus}
                      </span>
                    </td>

                    {/* Status */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={cn(
                        "inline-block text-[11px] font-semibold px-2.5 py-1 rounded-md",
                        cfg.bg, cfg.text
                      )}>
                        {cfg.label}
                      </span>
                    </td>

                    {/* Date */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="text-xs text-muted-foreground">
                        {format(new Date(order.created_at), 'M/d/yyyy')}
                      </span>
                    </td>

                    {/* Delete icon (visual only) */}
                    <td className="px-3 py-3 text-right">
                      <button
                        onClick={e => { e.stopPropagation(); toast.info('Select order to manage'); }}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/50 hover:text-red-500 p-1 rounded"
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
