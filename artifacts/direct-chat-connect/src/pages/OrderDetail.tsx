import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import {
  ArrowLeft, Package, Clock, CheckCircle, XCircle, Truck, Hash,
  Phone, MapPin, User, Copy, Calendar, Tag, PackageCheck, Loader2,
  FileText, CreditCard, Send, Eye, Zap
} from 'lucide-react';

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; icon: any; border: string }> = {
  pending:    { label: 'Pending',    bg: 'bg-amber-500/10',    text: 'text-amber-500',    icon: Clock,        border: 'border-amber-500/30' },
  confirmed:  { label: 'Confirmed',  bg: 'bg-blue-500/10',     text: 'text-blue-500',     icon: CheckCircle,  border: 'border-blue-500/30' },
  processing: { label: 'Processing', bg: 'bg-violet-500/10',   text: 'text-violet-500',   icon: Package,      border: 'border-violet-500/30' },
  shipped:    { label: 'Shipped',    bg: 'bg-cyan-500/10',     text: 'text-cyan-500',     icon: Truck,        border: 'border-cyan-500/30' },
  delivered:  { label: 'Delivered',  bg: 'bg-emerald-500/10',  text: 'text-emerald-500',  icon: PackageCheck, border: 'border-emerald-500/30' },
  cancelled:  { label: 'Cancelled',  bg: 'bg-red-500/10',      text: 'text-red-500',      icon: XCircle,      border: 'border-red-500/30' },
};

const STATUS_OPTIONS = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];

async function fetchOrder(orderId: string): Promise<{ order: Record<string, any>; source: 'local' | 'supabase' }> {
  // Try local first
  try {
    const res = await fetch(`/api/local/orders/${orderId}`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.id) return { order: data, source: 'local' };
    }
  } catch { /* ignore */ }

  // Fallback to Supabase
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .single();
  if (error) throw error;
  return { order: data as Record<string, any>, source: 'supabase' };
}

const OrderDetail = () => {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: result, isLoading } = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => fetchOrder(orderId!),
    enabled: !!orderId,
  });

  const order = result?.order;
  const isLocal = result?.source === 'local';

  const updateStatus = useMutation({
    mutationFn: async (status: string) => {
      if (isLocal) {
        const res = await fetch(`/api/local/orders/${orderId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        if (!res.ok) throw new Error('Update failed');
      } else {
        const { error } = await supabase
          .from('orders')
          .update({ status, updated_at: new Date().toISOString() } as any)
          .eq('id', orderId!);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['order', orderId] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      toast.success('✅ Status updated');
    },
    onError: (err: any) => toast.error(err.message),
  });

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied!');
  };

  const safeDate = (val: string | null | undefined) => {
    if (!val) return null;
    try { return format(new Date(val), 'dd MMM yyyy, hh:mm a'); } catch { return null; }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!order) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
        <Package size={48} className="text-muted-foreground/30" />
        <p className="text-muted-foreground">Order not found</p>
        <button onClick={() => navigate(-1)} className="text-sm text-primary hover:underline">Go back</button>
      </div>
    );
  }

  const cfg = STATUS_CONFIG[order.status] || STATUS_CONFIG.pending;
  const StatusIcon = cfg.icon;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/80 backdrop-blur-xl border-b border-border">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="p-2 rounded-xl hover:bg-muted transition-colors"
          >
            <ArrowLeft size={20} className="text-foreground" />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-foreground truncate">{order.product_name}</h1>
              {isLocal && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-500 border border-orange-500/20 flex-shrink-0">
                  <Zap size={10} /> LIVE
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {order.merchant_order_id ? `#${order.merchant_order_id}` : 'Order Details'}
            </p>
          </div>
          <span className={cn(
            "inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full",
            cfg.bg, cfg.text
          )}>
            <StatusIcon size={14} />
            {cfg.label}
          </span>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        {/* Customer Info Card */}
        <div className="rounded-2xl border border-border bg-background p-5 space-y-4">
          <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
            <User size={16} className="text-primary" /> Customer Info
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <InfoRow icon={User} label="Name" value={order.customer_name} />
            <InfoRow icon={Phone} label="Phone" value={order.customer_phone} onCopy={copyText} />
          </div>
          {order.customer_address && (
            <InfoRow icon={MapPin} label="Address" value={order.customer_address} />
          )}
        </div>

        {/* Order Info Card */}
        <div className="rounded-2xl border border-border bg-background p-5 space-y-4">
          <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
            <Hash size={16} className="text-primary" /> Order Info
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {order.merchant_order_id && <InfoRow icon={Hash} label="Merchant Order ID" value={order.merchant_order_id} onCopy={copyText} />}
            {order.consignment_id && <InfoRow icon={Tag} label="Consignment ID" value={order.consignment_id} onCopy={copyText} />}
            <InfoRow icon={Package} label="Product" value={order.product_name} />
            {order.sku && <InfoRow icon={Tag} label="SKU" value={order.sku} />}
            {safeDate(order.created_at) && <InfoRow icon={Calendar} label="Date" value={safeDate(order.created_at)!} />}
            {safeDate(order.updated_at) && <InfoRow icon={Calendar} label="Updated" value={safeDate(order.updated_at)!} />}
          </div>
        </div>

        {/* Price Card */}
        <div className="rounded-2xl border border-border bg-background p-5 space-y-4">
          <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
            <CreditCard size={16} className="text-primary" /> Pricing
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <PriceBox label="Quantity" value={String(order.quantity || 1)} />
            <PriceBox label="Unit Price" value={order.unit_price ? `৳${order.unit_price}` : '—'} />
            <PriceBox label="Total" value={order.total_price ? `৳${order.total_price}` : '—'} highlight />
            <PriceBox label="To Collect" value={order.amount_to_collect ? `৳${order.amount_to_collect}` : '—'} success />
          </div>
        </div>

        {/* Delivery Stats */}
        {(order.total_parcels || order.total_delivered || order.total_cancel || order.order_receive_ratio) && (
          <div className="rounded-2xl border border-border bg-background p-5 space-y-4">
            <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
              <Truck size={16} className="text-primary" /> Delivery Stats
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatBox label="Total Parcels" value={order.total_parcels || 0} />
              <StatBox label="Delivered" value={order.total_delivered || 0} color="text-emerald-500" />
              <StatBox label="Cancelled" value={order.total_cancel || 0} color="text-red-500" />
              <StatBox label="Success Rate" value={order.order_receive_ratio || '0%'} color="text-primary" />
            </div>
          </div>
        )}

        {/* Courier Stats */}
        {(order.pathao || order.steadfast || order.paperfly || order.redex) ? (
          <div className="rounded-2xl border border-border bg-background p-5 space-y-4">
            <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
              <Send size={16} className="text-primary" /> Courier Info
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatBox label="Pathao" value={order.pathao || 0} />
              <StatBox label="Steadfast" value={order.steadfast || 0} />
              <StatBox label="Paperfly" value={order.paperfly || 0} />
              <StatBox label="Redex" value={order.redex || 0} />
            </div>
          </div>
        ) : null}

        {/* Notes */}
        {order.notes && (
          <div className="rounded-2xl border border-border bg-background p-5 space-y-3">
            <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
              <FileText size={16} className="text-primary" /> Notes
            </h3>
            <p className="text-sm text-foreground leading-relaxed bg-muted/30 p-3 rounded-xl">{order.notes}</p>
          </div>
        )}

        {/* Cancel Reason */}
        {order.reason_for_cancel && (
          <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-5 space-y-3">
            <h3 className="text-sm font-bold text-red-500 flex items-center gap-2">
              <XCircle size={16} /> Cancellation Reason
            </h3>
            <p className="text-sm text-red-600 dark:text-red-400 leading-relaxed">{order.reason_for_cancel}</p>
          </div>
        )}

        {/* Status Update */}
        <div className="rounded-2xl border border-border bg-background p-5 space-y-4">
          <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
            <Eye size={16} className="text-primary" /> Update Status
          </h3>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {STATUS_OPTIONS.map(s => {
              const sCfg = STATUS_CONFIG[s];
              const SIcon = sCfg.icon;
              const isActive = order.status === s;
              return (
                <button
                  key={s}
                  disabled={isActive || updateStatus.isPending}
                  onClick={() => updateStatus.mutate(s)}
                  className={cn(
                    "flex flex-col items-center gap-1.5 px-2 py-3 rounded-xl border text-[11px] font-semibold transition-all",
                    isActive
                      ? cn(sCfg.bg, sCfg.text, sCfg.border, "ring-2 ring-offset-1 ring-offset-background ring-current/30")
                      : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <SIcon size={18} />
                  {sCfg.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Raw Data */}
        {order.order_data && typeof order.order_data === 'object' && Object.keys(order.order_data as object).length > 0 && (
          <details className="rounded-2xl border border-border bg-background overflow-hidden">
            <summary className="px-5 py-3 text-xs font-bold text-muted-foreground cursor-pointer hover:bg-muted/30 uppercase tracking-wider">
              📊 Raw Data
            </summary>
            <pre className="px-5 py-3 text-[11px] font-mono text-muted-foreground overflow-x-auto max-h-48 bg-muted/20 leading-relaxed">
              {JSON.stringify(order.order_data, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
};

/* Sub Components */
const InfoRow = ({ icon: Icon, label, value, onCopy }: {
  icon: any; label: string; value: string | null | undefined; onCopy?: (t: string) => void;
}) => (
  <div className="flex items-center gap-3 p-3 rounded-xl bg-muted/20 border border-border/50">
    <Icon size={14} className="text-muted-foreground flex-shrink-0" />
    <div className="flex-1 min-w-0">
      <span className="text-[10px] text-muted-foreground block">{label}</span>
      <span className="text-sm font-medium text-foreground truncate block">{value || '—'}</span>
    </div>
    {onCopy && value && (
      <button onClick={() => onCopy(value)} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
        <Copy size={12} />
      </button>
    )}
  </div>
);

const PriceBox = ({ label, value, highlight, success }: {
  label: string; value: string; highlight?: boolean; success?: boolean;
}) => (
  <div className={cn(
    "text-center p-3 rounded-xl border",
    highlight && "bg-primary/5 border-primary/20",
    success && "bg-emerald-500/5 border-emerald-500/20",
    !highlight && !success && "bg-muted/20 border-border"
  )}>
    <div className={cn(
      "text-base font-bold mb-1",
      highlight && "text-primary",
      success && "text-emerald-500",
      !highlight && !success && "text-foreground"
    )}>{value}</div>
    <div className="text-[10px] text-muted-foreground">{label}</div>
  </div>
);

const StatBox = ({ label, value, color }: { label: string; value: number | string; color?: string }) => (
  <div className="text-center p-3 rounded-xl bg-muted/20 border border-border/50">
    <div className={cn("text-base font-bold mb-1", color || "text-foreground")}>{value}</div>
    <div className="text-[10px] text-muted-foreground">{label}</div>
  </div>
);

export default OrderDetail;
