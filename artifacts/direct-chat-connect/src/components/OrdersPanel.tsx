import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useMemo, useRef, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { format, isToday, isYesterday, startOfWeek, startOfMonth, isAfter, parseISO, startOfDay, endOfDay } from 'date-fns';
import { cn } from '@/lib/utils';
import {
  Package, Clock, CheckCircle, XCircle, Truck, PackageCheck,
  Download, Trash2, CalendarDays, X, MoreHorizontal, FileText, Search,
} from 'lucide-react';
import { toast } from 'sonner';
import OrderDetailSheet from './OrderDetailSheet';

type DateFilter = 'all' | 'today' | 'yesterday' | 'week' | 'month' | 'custom';

const DATE_FILTER_OPTIONS: { value: DateFilter; label: string }[] = [
  { value: 'all',       label: 'All' },
  { value: 'today',     label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'week',      label: 'This Week' },
  { value: 'month',     label: 'This Month' },
];

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; border: string; dot: string; icon: any }> = {
  pending:    { label: 'Pending',    bg: 'bg-amber-50 dark:bg-amber-900/20',    text: 'text-amber-700 dark:text-amber-300',     border: 'border-amber-200 dark:border-amber-700/50',   dot: '#F59E0B', icon: Clock },
  confirmed:  { label: 'Confirmed',  bg: 'bg-blue-50 dark:bg-blue-900/20',      text: 'text-blue-700 dark:text-blue-300',       border: 'border-blue-200 dark:border-blue-700/50',     dot: '#3B82F6', icon: CheckCircle },
  processing: { label: 'Processing', bg: 'bg-violet-50 dark:bg-violet-900/20',  text: 'text-violet-700 dark:text-violet-300',   border: 'border-violet-200 dark:border-violet-700/50', dot: '#8B5CF6', icon: Package },
  shipped:    { label: 'Shipped',    bg: 'bg-cyan-50 dark:bg-cyan-900/20',      text: 'text-cyan-700 dark:text-cyan-300',       border: 'border-cyan-200 dark:border-cyan-700/50',     dot: '#06B6D4', icon: Truck },
  delivered:  { label: 'Delivered',  bg: 'bg-emerald-50 dark:bg-emerald-900/20',text: 'text-emerald-700 dark:text-emerald-300', border: 'border-emerald-200 dark:border-emerald-700/50',dot: '#10B981', icon: PackageCheck },
  cancelled:  { label: 'Cancelled',  bg: 'bg-red-50 dark:bg-red-900/20',        text: 'text-red-600 dark:text-red-400',         border: 'border-red-200 dark:border-red-700/50',       dot: '#EF4444', icon: XCircle },
};

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
  '#3B82F6', '#8B5CF6', '#10B981',
  '#F59E0B', '#06B6D4', '#EC4899', '#6366F1',
];
function avatarColor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[h];
}

async function generateInvoice(order: Order) {
  try {
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
    const W = 210; const M = 14; const CW = W - M * 2;

    type RGB = [number, number, number];
    const C: Record<string, RGB> = {
      navy:   [22, 50, 120], primary: [37, 99, 235], dark: [15, 17, 17],
      muted:  [86, 89, 89],  border: [213, 217, 217], bg: [248, 249, 250],
      white:  [255, 255, 255], green: [0, 118, 0], rowAlt: [248, 250, 252],
    };
    const fill  = (c: RGB) => pdf.setFillColor(...c);
    const stroke= (c: RGB) => pdf.setDrawColor(...c);
    const color = (c: RGB) => pdf.setTextColor(...c);
    const bold  = (s: number) => { pdf.setFont('helvetica', 'bold');   pdf.setFontSize(s); };
    const norm  = (s: number) => { pdf.setFont('helvetica', 'normal'); pdf.setFontSize(s); };

    const orderId = order.merchant_order_id || order.id.slice(0, 8).toUpperCase();
    const invoiceNo = `INV-${orderId}`;
    const total  = Number(order.total_price) || Number(order.amount_to_collect) || 0;
    const qty    = Number(order.quantity) || 1;
    const unit   = Number(order.unit_price) || total;

    // ── Header band ──────────────────────────────────────────
    fill(C.navy); pdf.rect(0, 0, W, 35, 'F');
    fill(C.primary); pdf.rect(0, 0, 5, 35, 'F');
    fill(C.white); pdf.circle(M + 9, 17.5, 7.5, 'F');
    color(C.primary); bold(11); pdf.text('CM', M + 9, 21, { align: 'center' });
    color(C.white); bold(18); pdf.text('Chat Monitor', M + 22, 13);
    norm(8.5); pdf.text('Order Invoice', M + 22, 21);
    pdf.setTextColor(180, 200, 255); norm(7.5);
    pdf.text(`Generated: ${format(new Date(), 'dd MMM yyyy, HH:mm')}`, M + 22, 28);

    // Invoice # + status badge — top-right
    color(C.white); bold(10); pdf.text(invoiceNo, W - M, 14, { align: 'right' });
    const statusLabel = (order.status || 'pending').charAt(0).toUpperCase() + order.status.slice(1);
    const statusColors: Record<string, RGB> = { delivered: C.green, cancelled: [204,12,57], pending: [180,90,0] };
    const sColor: RGB = statusColors[order.status] ?? C.primary;
    fill(sColor); pdf.roundedRect(W - M - 28, 18, 28, 8, 2, 2, 'F');
    color(C.white); bold(7); pdf.text(statusLabel.toUpperCase(), W - M - 14, 23, { align: 'center' });

    let y = 46;

    // ── Two-column: customer + order details ─────────────────
    const COL1 = M; const COL2 = W / 2 + 4;
    // Customer Info box
    fill(C.bg); stroke(C.border); pdf.setLineWidth(0.3);
    pdf.roundedRect(COL1, y, CW / 2 - 3, 42, 2, 2, 'FD');
    color(C.muted); norm(7); pdf.text('BILL TO', COL1 + 4, y + 7);
    color(C.dark); bold(10); pdf.text(order.customer_name || '—', COL1 + 4, y + 15);
    norm(8.5);
    if (order.customer_phone)   { color(C.muted); pdf.text('Phone:', COL1 + 4, y + 23); color(C.dark); pdf.text(order.customer_phone, COL1 + 20, y + 23); }
    if (order.customer_address) { color(C.muted); pdf.text('Addr:',  COL1 + 4, y + 30); color(C.dark); const addr = pdf.splitTextToSize(order.customer_address, 48); pdf.text(addr[0] || '', COL1 + 18, y + 30); }
    // Order Info box
    fill(C.bg); stroke(C.border);
    pdf.roundedRect(COL2, y, CW / 2 - 3, 42, 2, 2, 'FD');
    color(C.muted); norm(7); pdf.text('ORDER INFO', COL2 + 4, y + 7);
    const infoRows = [
      ['Order ID', orderId], ['Date', format(parseISO(order.created_at), 'dd MMM yyyy')],
      ['Payment', order.payment_status || 'N/A'], ['Invoice', invoiceNo],
    ];
    infoRows.forEach((r, i) => {
      const iy = y + 15 + i * 7;
      color(C.muted); norm(8); pdf.text(r[0] + ':', COL2 + 4, iy);
      color(C.dark); bold(8); pdf.text(r[1], COL2 + 4 + 26, iy);
    });
    y += 50;

    // ── Line items table ──────────────────────────────────────
    color(C.dark); bold(11); pdf.text('Items', M, y);
    fill(C.primary); pdf.rect(M, y + 2, 16, 0.8, 'F');
    y += 8;
    const COLS = [90, 25, 30, 37];
    const HEADS = ['DESCRIPTION', 'QTY', 'UNIT PRICE', 'TOTAL'];
    fill(C.navy); pdf.rect(M, y, CW, 8, 'F');
    color(C.white); bold(7.5); let cx = M + 3;
    HEADS.forEach((h, i) => { pdf.text(h, cx, y + 5.5); cx += COLS[i]; });
    y += 8;

    fill(C.rowAlt); pdf.rect(M, y, CW, 10, 'F');
    stroke(C.border); pdf.setLineWidth(0.15); pdf.line(M, y + 10, M + CW, y + 10);
    cx = M + 3;
    color(C.dark); bold(9); pdf.text(order.product_name || 'Product', cx, y + 6.5); cx += COLS[0];
    norm(9); pdf.text(qty.toString(), cx, y + 6.5); cx += COLS[1];
    pdf.text(`Tk. ${unit.toLocaleString()}`, cx, y + 6.5); cx += COLS[2];
    bold(9); color(C.primary); pdf.text(`Tk. ${total.toLocaleString()}`, cx, y + 6.5);
    if (order.sku) { color(C.muted); norm(7); pdf.text(`SKU: ${order.sku}`, M + 3, y + 9); }
    y += 18;

    // ── Totals block ──────────────────────────────────────────
    const TX = W - M - 70;
    fill(C.bg); stroke(C.border); pdf.roundedRect(TX, y, 70, 36, 2, 2, 'FD');
    color(C.muted); norm(8); pdf.text('Subtotal', TX + 4, y + 9); color(C.dark); pdf.text(`Tk. ${total.toLocaleString()}`, TX + 70 - 4, y + 9, { align: 'right' });
    stroke(C.border); pdf.line(TX + 4, y + 13, TX + 66, y + 13);
    if (order.amount_to_collect && order.amount_to_collect !== total) {
      color(C.muted); norm(8); pdf.text('To Collect', TX + 4, y + 19); color(C.dark); pdf.text(`Tk. ${Number(order.amount_to_collect).toLocaleString()}`, TX + 70 - 4, y + 19, { align: 'right' });
      stroke(C.border); pdf.line(TX + 4, y + 23, TX + 66, y + 23);
      fill(C.primary); pdf.roundedRect(TX + 2, y + 26, 66, 8, 1.5, 1.5, 'F');
      color(C.white); bold(9); pdf.text('GRAND TOTAL', TX + 6, y + 31);
      pdf.text(`Tk. ${total.toLocaleString()}`, TX + 68, y + 31, { align: 'right' });
    } else {
      fill(C.primary); pdf.roundedRect(TX + 2, y + 17, 66, 8, 1.5, 1.5, 'F');
      color(C.white); bold(9); pdf.text('GRAND TOTAL', TX + 6, y + 22);
      pdf.text(`Tk. ${total.toLocaleString()}`, TX + 68, y + 22, { align: 'right' });
    }
    y += 44;

    // ── Footer ─────────────────────────────────────────────────
    const PH = 297;
    fill(C.bg); pdf.rect(0, PH - 14, W, 14, 'F');
    stroke(C.border); pdf.setLineWidth(0.3); pdf.line(M, PH - 14, W - M, PH - 14);
    color(C.muted); norm(7);
    pdf.text('Chat Monitor  ·  Invoice  ·  Thank you for your business!', M, PH - 6);
    pdf.text(invoiceNo, W - M, PH - 6, { align: 'right' });

    pdf.save(`invoice-${orderId}-${format(new Date(), 'ddMMyyyy')}.pdf`);
    toast.success('Invoice downloaded');
  } catch (e) {
    console.error(e);
    toast.error('Failed to generate invoice');
  }
}

const OrdersPanel = () => {
  const queryClient = useQueryClient();
  const { data: localOrders = [] } = useLocalOrders();
  const { data: supabaseOrders = [] } = useSupabaseOrders();
  const orders = useMemo(
    () => mergeOrders(localOrders, supabaseOrders),
    [localOrders, supabaseOrders]
  );

  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const pickerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowDatePicker(false);
      }
    };
    if (showDatePicker) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showDatePicker]);

  useEffect(() => {
    if (!openMenuId) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openMenuId]);

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
    const now = new Date();
    const q = searchQuery.trim().toLowerCase();
    return orders.filter(o => {
      // Date filter
      if (dateFilter !== 'all') {
        const d = new Date(o.created_at);
        if (dateFilter === 'today'     && !isToday(d))     return false;
        if (dateFilter === 'yesterday' && !isYesterday(d)) return false;
        if (dateFilter === 'week'      && !isAfter(d, startOfWeek(now, { weekStartsOn: 0 }))) return false;
        if (dateFilter === 'month'     && !isAfter(d, startOfMonth(now))) return false;
        if (dateFilter === 'custom') {
          const from = customFrom ? startOfDay(parseISO(customFrom)) : null;
          const to   = customTo   ? endOfDay(parseISO(customTo))     : null;
          if (from && d < from) return false;
          if (to   && d > to)   return false;
        }
      }
      // Search filter
      if (q) {
        const haystack = [
          o.order_id, o.customer_name, o.customer_phone,
          o.product_name, o.product_sku, o.status,
        ].join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [orders, dateFilter, customFrom, customTo, searchQuery]);

  const newLocalCount = localOrders.length;

  return (
    <div className="flex flex-col h-full gap-0">

      {/* ── Amazon-style toolbar ─────────────────────────────── */}
      <div className="flex-shrink-0 px-0 pt-0 pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          {/* Left: date filter + custom picker + live badge */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Calendar icon — opens custom range picker */}
            <div className="relative" ref={pickerRef}>
              <button
                onClick={() => setShowDatePicker(v => !v)}
                title="Custom date range"
                className={cn(
                  'p-1.5 rounded-lg border transition-colors',
                  dateFilter === 'custom' || showDatePicker
                    ? 'bg-primary border-primary text-white'
                    : 'bg-white dark:bg-card border-[#D5D9D9] dark:border-border text-[#565959] dark:text-muted-foreground hover:bg-[#F7F8F8] dark:hover:bg-muted/30'
                )}
              >
                <CalendarDays size={14} />
              </button>

              {/* Date picker popover */}
              {showDatePicker && (
                <div className="absolute top-full left-0 mt-1.5 z-50 bg-white dark:bg-card border border-[#D5D9D9] dark:border-border rounded-xl shadow-xl p-4 min-w-[280px]">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-[12px] font-bold text-[#0F1111] dark:text-foreground">Custom Date Range</p>
                    <button onClick={() => setShowDatePicker(false)}
                      className="p-0.5 rounded text-[#767676] dark:text-muted-foreground hover:text-[#0F1111] dark:hover:text-foreground">
                      <X size={13} />
                    </button>
                  </div>

                  <div className="space-y-3">
                    <div>
                      <label className="text-[10.5px] font-semibold text-[#565959] dark:text-muted-foreground uppercase tracking-wide block mb-1">From</label>
                      <input
                        type="date"
                        value={customFrom}
                        max={customTo || undefined}
                        onChange={e => setCustomFrom(e.target.value)}
                        className="w-full px-3 py-2 text-[12.5px] rounded-lg border border-[#D5D9D9] dark:border-border bg-white dark:bg-muted/20 text-[#0F1111] dark:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                      />
                    </div>
                    <div>
                      <label className="text-[10.5px] font-semibold text-[#565959] dark:text-muted-foreground uppercase tracking-wide block mb-1">To</label>
                      <input
                        type="date"
                        value={customTo}
                        min={customFrom || undefined}
                        onChange={e => setCustomTo(e.target.value)}
                        className="w-full px-3 py-2 text-[12.5px] rounded-lg border border-[#D5D9D9] dark:border-border bg-white dark:bg-muted/20 text-[#0F1111] dark:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                      />
                    </div>
                  </div>

                  {/* Quick presets */}
                  <div className="mt-3 pt-3 border-t border-[#EAEDED] dark:border-border/40">
                    <p className="text-[10px] font-semibold text-[#767676] dark:text-muted-foreground uppercase tracking-wide mb-2">Quick select</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      {[
                        { label: 'Last 7 days',  days: 7 },
                        { label: 'Last 30 days', days: 30 },
                        { label: 'Last 90 days', days: 90 },
                        { label: 'This year',    days: 365 },
                      ].map(({ label, days }) => (
                        <button key={label}
                          onClick={() => {
                            const to = new Date();
                            const from = new Date();
                            from.setDate(from.getDate() - days);
                            setCustomFrom(format(from, 'yyyy-MM-dd'));
                            setCustomTo(format(to, 'yyyy-MM-dd'));
                          }}
                          className="text-[11px] font-medium text-[#007185] dark:text-primary bg-[#F0F7FF] dark:bg-primary/10 hover:bg-[#E0F0FF] dark:hover:bg-primary/20 px-2.5 py-1.5 rounded-lg border border-[#C8E0F0] dark:border-primary/20 transition-colors text-left"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Apply / Clear */}
                  <div className="flex items-center gap-2 mt-3">
                    <button
                      onClick={() => {
                        setDateFilter('custom');
                        setShowDatePicker(false);
                      }}
                      disabled={!customFrom && !customTo}
                      className="flex-1 py-2 rounded-lg text-[12px] font-semibold bg-primary text-white hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      Apply Range
                    </button>
                    {dateFilter === 'custom' && (
                      <button
                        onClick={() => {
                          setCustomFrom('');
                          setCustomTo('');
                          setDateFilter('all');
                          setShowDatePicker(false);
                        }}
                        className="px-3 py-2 rounded-lg text-[12px] font-medium text-[#565959] dark:text-muted-foreground border border-[#D5D9D9] dark:border-border hover:bg-[#F7F8F8] dark:hover:bg-muted/30 transition-colors"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Preset filter tabs */}
            <div className="flex items-center rounded-lg border border-[#D5D9D9] dark:border-border overflow-hidden">
              {DATE_FILTER_OPTIONS.map((opt, idx) => (
                <button
                  key={opt.value}
                  onClick={() => setDateFilter(opt.value)}
                  className={cn(
                    'px-3 py-1.5 text-[12px] font-medium transition-colors whitespace-nowrap',
                    idx !== 0 && 'border-l border-[#D5D9D9] dark:border-border',
                    dateFilter === opt.value
                      ? 'bg-primary text-white font-semibold'
                      : 'bg-white dark:bg-card text-[#0F1111] dark:text-foreground hover:bg-[#F7F8F8] dark:hover:bg-muted/30'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Custom range active badge */}
            {dateFilter === 'custom' && (customFrom || customTo) && (
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-primary bg-[#F0F7FF] dark:bg-primary/10 px-2.5 py-1.5 rounded-lg border border-[#C8E0F0] dark:border-primary/20">
                <CalendarDays size={11} />
                {customFrom ? format(parseISO(customFrom), 'dd MMM') : '∞'}
                {' → '}
                {customTo ? format(parseISO(customTo), 'dd MMM yy') : '∞'}
              </div>
            )}

            {newLocalCount > 0 && (
              <div className="flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 px-2.5 py-1.5 rounded-lg border border-amber-200 dark:border-amber-700/40 font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                {newLocalCount} live
              </div>
            )}
          </div>

          {/* Right: search + count + export */}
          <div className="flex items-center gap-2.5">
            {/* Search bar */}
            <div className="relative hidden sm:block">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#9CA3AF] dark:text-muted-foreground pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search orders…"
                className="pl-8 pr-3 py-1.5 text-[12px] rounded-lg border border-[#D5D9D9] dark:border-border bg-white dark:bg-card text-[#0F1111] dark:text-foreground placeholder:text-[#9CA3AF] dark:placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all w-40"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[#9CA3AF] hover:text-[#0F1111] dark:hover:text-foreground"
                >
                  <X size={11} />
                </button>
              )}
            </div>
            {orders.length > 0 && (
              <span className="text-[12px] text-[#565959] dark:text-muted-foreground font-medium hidden sm:block">
                {filtered.length === orders.length
                  ? `${orders.length} orders`
                  : `${filtered.length} / ${orders.length}`}
              </span>
            )}
            <button
              onClick={() => exportToCSV(filtered)}
              disabled={!filtered.length}
              className={cn(
                "flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[12px] font-semibold border transition-all",
                filtered.length
                  ? "bg-primary border-primary text-white hover:bg-primary/90 shadow-sm"
                  : "bg-white dark:bg-card border-[#D5D9D9] dark:border-border text-[#9CA3AF] cursor-not-allowed"
              )}
            >
              <Download size={13} /> Export CSV
            </button>
          </div>
        </div>
      </div>

      {/* ── Table card ───────────────────────────────────────── */}
      <div className="flex-1 overflow-auto min-h-0 rounded-xl border border-[#D5D9D9] dark:border-border bg-white dark:bg-card">
        {!orders.length ? (
          <div className="flex flex-col items-center justify-center h-full py-20 text-center gap-3">
            <div className="w-16 h-16 rounded-2xl bg-[#F7F8F8] dark:bg-muted/30 flex items-center justify-center">
              <Package size={28} className="text-[#C8CDD1] dark:text-muted-foreground/30" />
            </div>
            <div>
              <p className="text-[13px] font-semibold text-[#0F1111] dark:text-foreground">No orders yet</p>
              <p className="text-[11px] text-[#565959] dark:text-muted-foreground mt-1">Orders from n8n will appear here automatically</p>
            </div>
          </div>
        ) : !filtered.length ? (
          <div className="flex flex-col items-center justify-center h-full py-20 text-center gap-3">
            <div className="w-14 h-14 rounded-2xl bg-[#F7F8F8] dark:bg-muted/30 flex items-center justify-center">
              <CalendarDays size={22} className="text-[#C8CDD1] dark:text-muted-foreground/30" />
            </div>
            <div>
              <p className="text-[13px] font-semibold text-[#0F1111] dark:text-foreground">No orders in this period</p>
              <p className="text-[11px] text-[#565959] dark:text-muted-foreground mt-1">Try a different date filter</p>
            </div>
          </div>
        ) : (
          <table className="w-full border-collapse text-[13px]">
            {/* Sticky header — Amazon gray */}
            <thead className="sticky top-0 z-10">
              <tr className="bg-[#F3F4F5] dark:bg-muted/60 border-b border-[#D5D9D9] dark:border-border">
                <th className="text-left text-[11px] font-semibold text-[#565959] dark:text-muted-foreground px-4 py-3 w-[130px]">Order</th>
                <th className="text-left text-[11px] font-semibold text-[#565959] dark:text-muted-foreground px-4 py-3 hidden sm:table-cell">Product</th>
                <th className="text-left text-[11px] font-semibold text-[#565959] dark:text-muted-foreground px-4 py-3">Customer</th>
                <th className="text-left text-[11px] font-semibold text-[#565959] dark:text-muted-foreground px-4 py-3 hidden md:table-cell">Phone</th>
                <th className="text-right text-[11px] font-semibold text-[#565959] dark:text-muted-foreground px-4 py-3">Total</th>
                <th className="text-left text-[11px] font-semibold text-[#565959] dark:text-muted-foreground px-4 py-3">Status</th>
                <th className="text-left text-[11px] font-semibold text-[#565959] dark:text-muted-foreground px-4 py-3 hidden sm:table-cell">Date</th>
                <th className="w-10 px-3 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EAEDED] dark:divide-border/30">
              {filtered.map((order, idx) => {
                const cfg = STATUS_CONFIG[order.status] ?? STATUS_CONFIG.pending;
                const total = Number(order.total_price) || Number(order.amount_to_collect) || 0;
                const orderId = order.merchant_order_id || order.id.slice(0, 8).toUpperCase();
                const initStr = initials(order.customer_name);
                const avColor = avatarColor(order.id);

                return (
                  <tr
                    key={order.id}
                    onClick={() => setSelectedOrderId(order.id)}
                    className={cn(
                      'cursor-pointer group transition-colors',
                      idx % 2 === 0
                        ? 'bg-white dark:bg-card hover:bg-[#F7FAFA] dark:hover:bg-muted/20'
                        : 'bg-[#FAFAFA] dark:bg-muted/10 hover:bg-[#F0F4F4] dark:hover:bg-muted/25'
                    )}
                  >
                    {/* Order ID */}
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[12.5px] font-bold text-[#007185] dark:text-primary">
                          {orderId}
                        </span>
                        {order._source === 'local' && (
                          <span className="text-[8px] font-bold text-amber-600 bg-amber-400/15 px-1.5 py-0.5 rounded border border-amber-300/40 leading-none">
                            LIVE
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Product */}
                    <td className="px-4 py-3.5 hidden sm:table-cell max-w-[150px]">
                      <p className="text-[12.5px] text-[#0F1111] dark:text-foreground truncate font-medium">
                        {order.product_name || '—'}
                      </p>
                      {order.sku && (
                        <p className="text-[10.5px] text-[#767676] dark:text-muted-foreground mt-0.5">{order.sku}</p>
                      )}
                    </td>

                    {/* Customer */}
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0"
                          style={{ backgroundColor: avColor }}
                        >
                          {initStr}
                        </div>
                        <span className="text-[12.5px] text-[#0F1111] dark:text-foreground font-medium truncate max-w-[100px]">
                          {order.customer_name || '—'}
                        </span>
                      </div>
                    </td>

                    {/* Phone */}
                    <td className="px-4 py-3.5 whitespace-nowrap hidden md:table-cell">
                      <span className="text-[12px] text-[#565959] dark:text-muted-foreground tabular-nums">
                        {order.customer_phone || '—'}
                      </span>
                    </td>

                    {/* Total */}
                    <td className="px-4 py-3.5 whitespace-nowrap text-right">
                      <span className="text-[13px] font-bold text-[#0F1111] dark:text-foreground tabular-nums">
                        ৳{total.toLocaleString()}
                      </span>
                    </td>

                    {/* Status */}
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <span className={cn(
                        'inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full border',
                        cfg.bg, cfg.text, cfg.border,
                      )}>
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: cfg.dot }} />
                        {cfg.label}
                      </span>
                    </td>

                    {/* Date */}
                    <td className="px-4 py-3.5 whitespace-nowrap hidden sm:table-cell">
                      <span className="text-[11.5px] text-[#767676] dark:text-muted-foreground">
                        {smartDate(order.created_at)}
                      </span>
                    </td>

                    {/* Actions — 3-dot kebab menu */}
                    <td className="px-3 py-3.5 text-right" onClick={e => e.stopPropagation()}>
                      <div className="relative flex items-center justify-end">
                        <button
                          onClick={e => {
                            e.stopPropagation();
                            setOpenMenuId(openMenuId === order.id ? null : order.id);
                          }}
                          className={cn(
                            'p-1.5 rounded-md transition-colors',
                            openMenuId === order.id
                              ? 'bg-[#F0F4F4] dark:bg-muted/40 text-[#0F1111] dark:text-foreground'
                              : 'opacity-0 group-hover:opacity-100 text-[#565959] dark:text-muted-foreground hover:bg-[#F0F4F4] dark:hover:bg-muted/40 hover:text-[#0F1111] dark:hover:text-foreground'
                          )}
                        >
                          <MoreHorizontal size={15} />
                        </button>

                        {openMenuId === order.id && (
                          <div
                            ref={menuRef}
                            className="absolute top-full right-0 mt-1 z-50 bg-white dark:bg-card border border-[#D5D9D9] dark:border-border rounded-xl shadow-xl py-1 min-w-[168px]"
                          >
                            <button
                              onClick={e => {
                                e.stopPropagation();
                                setOpenMenuId(null);
                                generateInvoice(order);
                              }}
                              className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[12.5px] text-[#0F1111] dark:text-foreground hover:bg-[#F7F8F8] dark:hover:bg-muted/40 transition-colors"
                            >
                              <FileText size={13} className="text-[#007185] dark:text-blue-400 flex-shrink-0" />
                              <span>Generate Invoice</span>
                            </button>
                            <div className="mx-3 my-1 border-t border-[#EAEDED] dark:border-border/40" />
                            <button
                              onClick={e => {
                                e.stopPropagation();
                                setOpenMenuId(null);
                                if (window.confirm('Delete this order? This cannot be undone.')) {
                                  deleteMutation.mutate({ id: order.id, source: order._source });
                                }
                              }}
                              disabled={deleteMutation.isPending}
                              className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[12.5px] text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-40"
                            >
                              <Trash2 size={13} className="flex-shrink-0" />
                              <span>Delete Order</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <OrderDetailSheet
        orderId={selectedOrderId}
        onClose={() => setSelectedOrderId(null)}
      />
    </div>
  );
};

export default OrdersPanel;
