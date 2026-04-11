import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import {
  Package, Clock, CheckCircle, XCircle, Truck, Hash,
  Phone, MapPin, User, Copy, Calendar, Tag, PackageCheck, Loader2,
  FileText, CreditCard, Send, Eye, Zap, X, PhoneCall,
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
  try {
    const res = await fetch(`/api/local/orders/${orderId}`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.id) return { order: data, source: 'local' };
    }
  } catch { /* ignore */ }

  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .single();
  if (error) throw error;
  return { order: data as Record<string, any>, source: 'supabase' };
}

interface Props {
  orderId: string | null;
  onClose: () => void;
}

const OrderDetailSheet = ({ orderId, onClose }: Props) => {
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
      queryClient.invalidateQueries({ queryKey: ['local-orders'] });
      queryClient.invalidateQueries({ queryKey: ['supabase-orders'] });
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

  if (!orderId) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Sheet — slides up from bottom */}
      <div className="fixed inset-x-0 bottom-0 z-50 flex flex-col max-h-[92dvh] rounded-t-3xl bg-background border-t border-border shadow-2xl animate-in slide-in-from-bottom duration-300">

        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
          <div className="w-10 h-1 rounded-full bg-muted-foreground/20" />
        </div>

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border flex-shrink-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              {isLoading ? (
                <div className="h-5 w-32 bg-muted animate-pulse rounded" />
              ) : (
                <h2 className="text-base font-bold text-foreground truncate">
                  {order?.product_name || 'Order Details'}
                </h2>
              )}
              {isLocal && !isLoading && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-500 border border-orange-500/20 flex-shrink-0">
                  <Zap size={10} /> LIVE
                </span>
              )}
            </div>
            {order && (
              <p className="text-xs text-muted-foreground">
                {order.merchant_order_id ? `#${order.merchant_order_id}` : 'Order Details'}
              </p>
            )}
          </div>
          {order && (() => {
            const cfg = STATUS_CONFIG[order.status] || STATUS_CONFIG.pending;
            const StatusIcon = cfg.icon;
            return (
              <span className={cn(
                "inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full flex-shrink-0",
                cfg.bg, cfg.text
              )}>
                <StatusIcon size={13} />
                {cfg.label}
              </span>
            );
          })()}
          <button
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-muted transition-colors flex-shrink-0"
          >
            <X size={18} className="text-muted-foreground" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto overscroll-contain">
          {isLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-7 h-7 animate-spin text-primary" />
            </div>
          ) : !order ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16">
              <Package size={40} className="text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">Order not found</p>
            </div>
          ) : (
            <div className="px-5 py-4 space-y-3 pb-8">

              {/* Customer Info */}
              <Section icon={User} title="Customer Info">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <InfoRow icon={User} label="Name" value={order.customer_name} />
                  <InfoRow icon={Phone} label="Phone" value={order.customer_phone} onCopy={copyText} onCall={phone => { window.location.href = `tel:${phone}`; }} />
                </div>
                <InfoRow icon={MapPin} label="Address" value={order.customer_address} />
              </Section>

              {/* Order Info */}
              <Section icon={Hash} title="Order Info">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <InfoRow icon={Hash} label="Merchant Order ID" value={order.merchant_order_id} onCopy={copyText} />
                  <InfoRow icon={Calendar} label="Date" value={safeDate(order.created_at)} />
                  <InfoRow icon={Package} label="Product Name" value={order.product_name} />
                  <InfoRow icon={Tag} label="SKU" value={order.sku} />
                  {order.consignment_id && <InfoRow icon={Tag} label="Consignment ID" value={order.consignment_id} onCopy={copyText} />}
                </div>
              </Section>

              {/* Pricing — all 4 fields always visible */}
              <Section icon={CreditCard} title="Pricing">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <PriceBox label="Quantity" value={String(order.quantity || 1)} />
                  <PriceBox label="Per Product Price" value={order.unit_price ? `৳${Number(order.unit_price).toLocaleString()}` : '—'} />
                  <PriceBox label="Total Price" value={order.total_price ? `৳${Number(order.total_price).toLocaleString()}` : '—'} highlight />
                  <PriceBox label="Amount to Collect" value={order.amount_to_collect ? `৳${Number(order.amount_to_collect).toLocaleString()}` : '—'} success />
                </div>
              </Section>

              {/* Delivery Stats */}
              {(order.total_parcels || order.total_delivered || order.total_cancel || order.order_receive_ratio) && (
                <Section icon={Truck} title="Delivery Stats">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <StatBox label="Total Parcels" value={order.total_parcels || 0} />
                    <StatBox label="Delivered" value={order.total_delivered || 0} color="text-emerald-500" />
                    <StatBox label="Cancelled" value={order.total_cancel || 0} color="text-red-500" />
                    <StatBox label="Success Rate" value={order.order_receive_ratio || '0%'} color="text-primary" />
                  </div>
                </Section>
              )}

              {/* Courier Stats */}
              {(order.pathao || order.steadfast || order.paperfly || order.redex) && (
                <Section icon={Send} title="Courier Info">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <StatBox label="Pathao" value={order.pathao || 0} />
                    <StatBox label="Steadfast" value={order.steadfast || 0} />
                    <StatBox label="Paperfly" value={order.paperfly || 0} />
                    <StatBox label="Redex" value={order.redex || 0} />
                  </div>
                </Section>
              )}

              {/* Notes */}
              {order.notes && (
                <Section icon={FileText} title="Notes">
                  <p className="text-sm text-foreground leading-relaxed bg-muted/30 p-3 rounded-xl">{order.notes}</p>
                </Section>
              )}

              {/* Cancel Reason */}
              {order.reason_for_cancel && (
                <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4 space-y-2">
                  <h3 className="text-sm font-bold text-red-500 flex items-center gap-2">
                    <XCircle size={15} /> Cancellation Reason
                  </h3>
                  <p className="text-sm text-red-600 dark:text-red-400 leading-relaxed">{order.reason_for_cancel}</p>
                </div>
              )}

              {/* Status Update */}
              <Section icon={Eye} title="Update Status">
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
                            ? cn(sCfg.bg, sCfg.text, sCfg.border, "ring-2 ring-offset-1 ring-offset-background")
                            : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                        )}
                      >
                        <SIcon size={17} />
                        {sCfg.label}
                      </button>
                    );
                  })}
                </div>
              </Section>

              {/* Raw Data */}
              {order.order_data && typeof order.order_data === 'object' && Object.keys(order.order_data as object).length > 0 && (
                <details className="rounded-2xl border border-border bg-background overflow-hidden">
                  <summary className="px-4 py-3 text-xs font-bold text-muted-foreground cursor-pointer hover:bg-muted/30 uppercase tracking-wider">
                    📊 Raw Data
                  </summary>
                  <pre className="px-4 py-3 text-[11px] font-mono text-muted-foreground overflow-x-auto max-h-40 bg-muted/20 leading-relaxed">
                    {JSON.stringify(order.order_data, null, 2)}
                  </pre>
                </details>
              )}

            </div>
          )}
        </div>
      </div>
    </>
  );
};

/* Sub-components */
const Section = ({ icon: Icon, title, children }: { icon: any; title: string; children: React.ReactNode }) => (
  <div className="rounded-2xl border border-border bg-background p-4 space-y-3">
    <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
      <Icon size={15} className="text-primary" /> {title}
    </h3>
    {children}
  </div>
);

const InfoRow = ({ icon: Icon, label, value, onCopy, onCall }: {
  icon: any; label: string; value: string | null | undefined;
  onCopy?: (t: string) => void; onCall?: (t: string) => void;
}) => (
  <div className="flex items-center gap-3 p-3 rounded-xl bg-muted/20 border border-border/50">
    <Icon size={13} className="text-muted-foreground flex-shrink-0" />
    <div className="flex-1 min-w-0">
      <span className="text-[10px] text-muted-foreground block">{label}</span>
      <span className="text-sm font-medium text-foreground truncate block">{value || '—'}</span>
    </div>
    {onCall && value && (
      <a
        href={`tel:${value}`}
        onClick={e => { e.stopPropagation(); onCall(value); }}
        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white transition-colors text-[11px] font-semibold shadow-sm"
        title={`Call ${value}`}
      >
        <PhoneCall size={11} />
        <span>Call</span>
      </a>
    )}
    {onCopy && value && (
      <button onClick={() => onCopy(value)} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
        <Copy size={11} />
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
      "text-sm font-bold mb-0.5",
      highlight && "text-primary",
      success && "text-emerald-500",
      !highlight && !success && "text-foreground"
    )}>{value}</div>
    <div className="text-[10px] text-muted-foreground">{label}</div>
  </div>
);

const StatBox = ({ label, value, color }: { label: string; value: number | string; color?: string }) => (
  <div className="text-center p-3 rounded-xl bg-muted/20 border border-border/50">
    <div className={cn("text-sm font-bold mb-0.5", color || "text-foreground")}>{value}</div>
    <div className="text-[10px] text-muted-foreground">{label}</div>
  </div>
);

export default OrderDetailSheet;
