import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import {
  Package, Clock, CheckCircle, XCircle, Truck, PackageCheck,
  User, MapPin, Calendar, Loader2, ChevronRight, Download, Webhook
} from 'lucide-react';
import { toast } from 'sonner';
import OrderDetailSheet from './OrderDetailSheet';

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; icon: any }> = {
  pending:    { label: 'Pending',    bg: 'bg-amber-500/10',    text: 'text-amber-500',    icon: Clock },
  confirmed:  { label: 'Confirmed',  bg: 'bg-blue-500/10',     text: 'text-blue-500',     icon: CheckCircle },
  processing: { label: 'Processing', bg: 'bg-violet-500/10',   text: 'text-violet-500',   icon: Package },
  shipped:    { label: 'Shipped',    bg: 'bg-cyan-500/10',     text: 'text-cyan-500',     icon: Truck },
  delivered:  { label: 'Delivered',  bg: 'bg-emerald-500/10',  text: 'text-emerald-500',  icon: PackageCheck },
  cancelled:  { label: 'Cancelled',  bg: 'bg-red-500/10',      text: 'text-red-500',      icon: XCircle },
};

interface Order {
  id: string;
  product_name?: string;
  customer_name?: string;
  customer_phone?: string;
  customer_address?: string;
  quantity?: number;
  total_price?: number;
  amount_to_collect?: number;
  merchant_order_id?: string;
  status: string;
  created_at: string;
  _source?: 'local' | 'supabase';
}

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

const OrdersPanel = () => {
  const { data: localOrders = [] } = useLocalOrders();
  const { data: supabaseOrders = [] } = useSupabaseOrders();
  const orders = mergeOrders(localOrders, supabaseOrders);
  const isLoading = false;
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  const newLocalCount = localOrders.length;

  const exportToCSV = () => {
    if (!orders.length) {
      toast.error('No data to export');
      return;
    }
    const headers = ['Product', 'Customer', 'Phone', 'Quantity', 'Price', 'Status', 'Date'];
    const rows = orders.map(o => [
      o.product_name, o.customer_name || '', o.customer_phone || '',
      o.quantity, o.total_price || o.amount_to_collect || 0,
      STATUS_CONFIG[o.status]?.label || o.status,
      format(new Date(o.created_at), 'dd/MM/yyyy HH:mm')
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `orders_${format(new Date(), 'dd-MM-yyyy')}.csv`;
    link.click();
    toast.success(`${orders.length} orders exported`);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        {newLocalCount > 0 ? (
          <div className="flex items-center gap-1.5 text-[11px] text-amber-600 bg-amber-500/10 px-2.5 py-1.5 rounded-xl border border-amber-500/20">
            <Webhook size={11} />
            <span><span className="font-bold">{newLocalCount}</span> webhook orders</span>
          </div>
        ) : <div />}
        <button
          onClick={exportToCSV}
          disabled={!orders.length}
          className={cn(
            "flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all",
            orders.length
              ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm"
              : "bg-muted text-muted-foreground cursor-not-allowed"
          )}
        >
          <Download size={16} />
          CSV Export
        </button>
      </div>

      {/* Order List */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : !orders.length ? (
          <div className="text-center py-16">
            <Package size={48} className="mx-auto text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No orders found</p>
          </div>
        ) : (
          <div className="space-y-2 pb-6">
            {orders.map(order => {
              const cfg = STATUS_CONFIG[order.status] || STATUS_CONFIG.pending;
              const StatusIcon = cfg.icon;
              return (
                <div
                  key={order.id}
                  onClick={() => setSelectedOrderId(order.id)}
                  className="rounded-2xl border border-border bg-background p-4 cursor-pointer hover:border-primary/30 hover:shadow-md transition-all active:scale-[0.99] group"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <h3 className="text-base font-bold text-foreground truncate">
                          {order.product_name || 'Unknown Product'}
                        </h3>
                        {order._source === 'local' && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold text-amber-600 bg-amber-500/10 px-1.5 py-0.5 rounded-md flex-shrink-0">
                            <Webhook size={8} /> LIVE
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        Qty: {order.quantity || 1}
                        {order.merchant_order_id && ` • #${order.merchant_order_id}`}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={cn(
                        "inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full",
                        cfg.bg, cfg.text
                      )}>
                        <StatusIcon size={12} />
                        {cfg.label}
                      </span>
                      <ChevronRight size={16} className="text-muted-foreground group-hover:text-primary transition-colors" />
                    </div>
                  </div>

                  {(order.customer_name || order.customer_phone) && (
                    <div className="flex items-center gap-2 text-sm mb-1.5">
                      <User size={13} className="text-muted-foreground" />
                      <span className="font-medium text-foreground">{order.customer_name}</span>
                      {order.customer_phone && (
                        <span className="text-muted-foreground">• {order.customer_phone}</span>
                      )}
                    </div>
                  )}

                  {order.customer_address && (
                    <div className="flex items-start gap-2 text-sm mb-2">
                      <MapPin size={13} className="text-muted-foreground mt-0.5" />
                      <span className="text-muted-foreground line-clamp-1">{order.customer_address}</span>
                    </div>
                  )}

                  <div className="flex items-center justify-between pt-2 border-t border-border/50">
                    <span className="text-lg font-bold text-foreground">
                      ৳{order.total_price || order.amount_to_collect || 0}
                    </span>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Calendar size={12} />
                      {format(new Date(order.created_at), 'dd MMM, HH:mm')}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Order Detail Sheet (popup) */}
      <OrderDetailSheet
        orderId={selectedOrderId}
        onClose={() => setSelectedOrderId(null)}
      />
    </div>
  );
};

export default OrdersPanel;
