import { useQuery } from '@tanstack/react-query';
import { useState, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import {
  Package, Clock, CheckCircle, XCircle, Truck, PackageCheck,
  User, MapPin, Calendar, ChevronRight, Download,
  Webhook, Search, Hash, Tag, Phone,
} from 'lucide-react';
import { toast } from 'sonner';
import OrderDetailSheet from './OrderDetailSheet';

// ─── Status config ──────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; border: string; icon: any }> = {
  pending:    { label: 'Pending',    bg: 'bg-amber-50 dark:bg-amber-950/30',    text: 'text-amber-600 dark:text-amber-400',    border: 'border-amber-200 dark:border-amber-800',   icon: Clock },
  confirmed:  { label: 'Confirmed',  bg: 'bg-blue-50 dark:bg-blue-950/30',      text: 'text-blue-600 dark:text-blue-400',      border: 'border-blue-200 dark:border-blue-800',     icon: CheckCircle },
  processing: { label: 'Processing', bg: 'bg-violet-50 dark:bg-violet-950/30',  text: 'text-violet-600 dark:text-violet-400',  border: 'border-violet-200 dark:border-violet-800', icon: Package },
  shipped:    { label: 'Shipped',    bg: 'bg-cyan-50 dark:bg-cyan-950/30',      text: 'text-cyan-600 dark:text-cyan-400',      border: 'border-cyan-200 dark:border-cyan-800',     icon: Truck },
  delivered:  { label: 'Delivered',  bg: 'bg-emerald-50 dark:bg-emerald-950/30',text: 'text-emerald-600 dark:text-emerald-400',border: 'border-emerald-200 dark:border-emerald-800',icon: PackageCheck },
  cancelled:  { label: 'Cancelled',  bg: 'bg-red-50 dark:bg-red-950/30',        text: 'text-red-600 dark:text-red-400',        border: 'border-red-200 dark:border-red-800',       icon: XCircle },
};

// ─── Order interface ─────────────────────────────────────────────────────────

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
  merchant_order_id?: string;
  status: string;
  created_at: string;
  _source?: 'local' | 'supabase';
}

// ─── Data hooks ──────────────────────────────────────────────────────────────

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
  toast.success(`${orders.length} orders exported to CSV`);
}

// ─── Main Component ───────────────────────────────────────────────────────────

const OrdersPanel = () => {
  const { data: localOrders = [] } = useLocalOrders();
  const { data: supabaseOrders = [] } = useSupabaseOrders();
  const orders = mergeOrders(localOrders, supabaseOrders);

  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    let list = orders;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(o =>
        (o.product_name ?? '').toLowerCase().includes(q) ||
        (o.customer_name ?? '').toLowerCase().includes(q) ||
        (o.customer_phone ?? '').toLowerCase().includes(q) ||
        (o.merchant_order_id ?? '').toLowerCase().includes(q) ||
        (o.sku ?? '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [orders, search]);

  const newLocalCount = localOrders.length;

  return (
    <div className="flex flex-col h-full gap-2.5">

      {/* Toolbar: search + CSV */}
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

      {/* Order list */}
      <div className="flex-1 overflow-y-auto min-h-0 space-y-2 pr-0.5">
        {!orders.length ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
              <Package size={28} className="text-muted-foreground/40" />
            </div>
            <p className="text-sm font-semibold text-muted-foreground">No orders yet</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Orders from n8n will appear here</p>
          </div>
        ) : !filtered.length ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Search size={28} className="text-muted-foreground/40 mb-3" />
            <p className="text-sm font-semibold text-muted-foreground">No matches</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Try adjusting your search or filter</p>
          </div>
        ) : (
          filtered.map(order => {
            const cfg = STATUS_CONFIG[order.status] ?? STATUS_CONFIG.pending;
            const StatusIcon = cfg.icon;
            const unitPrice = Number(order.unit_price) || 0;
            const qty = Number(order.quantity) || 1;
            const total = Number(order.total_price) || 0;
            const collect = Number(order.amount_to_collect) || 0;

            return (
              <div
                key={order.id}
                onClick={() => setSelectedOrderId(order.id)}
                className="group rounded-2xl border border-border bg-card hover:border-primary/30 hover:shadow-md transition-all duration-200 cursor-pointer active:scale-[0.995] overflow-hidden"
              >
                {/* Card top bar: status + order ID + date */}
                <div className={cn("flex items-center justify-between px-4 py-2.5 border-b", cfg.bg, cfg.border)}>
                  <div className="flex items-center gap-2">
                    <span className={cn("flex items-center gap-1 text-[11px] font-bold", cfg.text)}>
                      <StatusIcon size={12} />
                      {cfg.label}
                    </span>
                    {order._source === 'local' && (
                      <span className="text-[9px] font-bold text-amber-600 bg-amber-500/20 px-1.5 py-0.5 rounded-md flex items-center gap-0.5">
                        <Webhook size={8} /> LIVE
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {order.merchant_order_id && (
                      <span className="flex items-center gap-1 text-[10px] font-mono font-semibold text-muted-foreground">
                        <Hash size={9} />
                        {order.merchant_order_id}
                      </span>
                    )}
                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Calendar size={10} />
                      {format(new Date(order.created_at), 'dd MMM, HH:mm')}
                    </span>
                    <ChevronRight size={13} className="text-muted-foreground/50 group-hover:text-primary transition-colors" />
                  </div>
                </div>

                {/* Card body */}
                <div className="px-4 py-3 space-y-2.5">
                  {/* Product row */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-bold text-foreground leading-tight">
                        {order.product_name || 'Unknown Product'}
                      </h3>
                      <div className="flex items-center gap-2 mt-0.5">
                        {order.sku && (
                          <span className="flex items-center gap-1 text-[10px] text-muted-foreground font-mono">
                            <Tag size={9} /> {order.sku}
                          </span>
                        )}
                        <span className="text-[10px] text-muted-foreground font-medium">
                          Qty: {qty}
                        </span>
                      </div>
                    </div>

                    {/* Price breakdown */}
                    <div className="text-right flex-shrink-0">
                      {unitPrice > 0 && qty > 1 && (
                        <p className="text-[10px] text-muted-foreground">
                          ৳{unitPrice.toLocaleString()} × {qty}
                        </p>
                      )}
                      <p className="text-base font-extrabold text-foreground">
                        ৳{total > 0 ? total.toLocaleString() : (collect || 0).toLocaleString()}
                      </p>
                      {collect > 0 && collect !== total && (
                        <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold">
                          Collect ৳{collect.toLocaleString()}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Customer row */}
                  {(order.customer_name || order.customer_phone || order.customer_address) && (
                    <div className="flex flex-col gap-1 pt-2 border-t border-border/40">
                      {(order.customer_name || order.customer_phone) && (
                        <div className="flex items-center gap-3">
                          {order.customer_name && (
                            <span className="flex items-center gap-1.5 text-xs text-foreground font-medium">
                              <User size={11} className="text-muted-foreground flex-shrink-0" />
                              {order.customer_name}
                            </span>
                          )}
                          {order.customer_phone && (
                            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <Phone size={11} className="flex-shrink-0" />
                              {order.customer_phone}
                            </span>
                          )}
                        </div>
                      )}
                      {order.customer_address && (
                        <span className="flex items-start gap-1.5 text-[11px] text-muted-foreground line-clamp-1">
                          <MapPin size={11} className="flex-shrink-0 mt-0.5" />
                          {order.customer_address}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
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
