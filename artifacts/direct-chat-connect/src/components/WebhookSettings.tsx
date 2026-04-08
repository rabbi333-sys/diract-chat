import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getActiveConnection } from '@/lib/db-config';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  Copy, Check, Eye, EyeOff, RefreshCw, Shield, ChevronDown, ChevronRight,
  Terminal, FileJson, AlertOctagon, ShoppingBag, HandMetal, AlertTriangle, Loader2,
  ClipboardCopy, Database, Webhook, Zap, Globe, Pencil, Save, X,
} from 'lucide-react';
import DeployFunctions from '@/components/DeployFunctions';

const PUBLISHED_URL_KEY = 'meta_automation_published_url';

function usePublishedUrl() {
  const [url, setUrl] = useState<string>(() => {
    try { return localStorage.getItem(PUBLISHED_URL_KEY) ?? ''; } catch { return ''; }
  });

  const save = (val: string) => {
    const trimmed = val.trim().replace(/\/$/, '');
    try { localStorage.setItem(PUBLISHED_URL_KEY, trimmed); } catch { /* ignore */ }
    setUrl(trimmed);
  };

  return { url, save };
}

const API_KEYS_SQL = `-- Run this ONCE in your Supabase SQL Editor
CREATE TABLE IF NOT EXISTS public.api_keys (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  api_key text NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own api keys" ON public.api_keys;
CREATE POLICY "Users manage own api keys" ON public.api_keys
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);`;

const FULL_SETUP_SQL = `-- ═══════════════════════════════════════════════
-- META AUTOMATION — Full Database Setup SQL
-- Run this ONCE in Supabase → SQL Editor
-- ═══════════════════════════════════════════════

-- 1. API Keys table
CREATE TABLE IF NOT EXISTS public.api_keys (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  api_key text NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own api keys" ON public.api_keys;
CREATE POLICY "Users manage own api keys" ON public.api_keys
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 2. Human Handoff Requests table
CREATE TABLE IF NOT EXISTS public.handoff_requests (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id text,
  recipient text,
  reason text NOT NULL DEFAULT 'Human assistance needed',
  message text,
  priority text NOT NULL DEFAULT 'normal',
  agent_data jsonb DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  notes text,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL
);
ALTER TABLE public.handoff_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for handoff" ON public.handoff_requests;
CREATE POLICY "Allow all for handoff" ON public.handoff_requests
  FOR ALL USING (true);

-- 3. Failed Automations table
CREATE TABLE IF NOT EXISTS public.failed_automations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid,
  workflow_name text,
  error_message text NOT NULL,
  error_details jsonb DEFAULT '{}',
  source text DEFAULT 'n8n',
  session_id text,
  recipient text,
  severity text DEFAULT 'error',
  resolved boolean DEFAULT false,
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL
);
ALTER TABLE public.failed_automations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for failures" ON public.failed_automations;
CREATE POLICY "Allow all for failures" ON public.failed_automations
  FOR ALL USING (true);

-- 4. AI Control table (for chat AI on/off)
CREATE TABLE IF NOT EXISTS public.ai_control (
  session_id text PRIMARY KEY,
  user_id uuid,
  ai_enabled boolean DEFAULT true NOT NULL,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.ai_control ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for ai_control" ON public.ai_control;
CREATE POLICY "Allow all for ai_control" ON public.ai_control
  FOR ALL USING (true);

-- 5. Orders table
CREATE TABLE IF NOT EXISTS public.orders (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  merchant_order_id text,
  consignment_id text,
  customer_name text,
  customer_phone text,
  customer_address text,
  product_name text DEFAULT 'Unknown Product',
  sku text,
  quantity integer DEFAULT 1,
  unit_price numeric,
  total_price numeric,
  amount_to_collect numeric,
  total_parcels integer DEFAULT 0,
  total_delivered integer DEFAULT 0,
  total_cancel integer DEFAULT 0,
  order_receive_ratio text DEFAULT '0%',
  pathao integer DEFAULT 0,
  steadfast integer DEFAULT 0,
  paperfly integer DEFAULT 0,
  redex integer DEFAULT 0,
  status text DEFAULT 'pending',
  reason_for_cancel text,
  notes text,
  session_id text,
  recipient_id text,
  source text DEFAULT 'webhook',
  order_data jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now() NOT NULL
);
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for orders" ON public.orders;
CREATE POLICY "Allow all for orders" ON public.orders
  FOR ALL USING (true);

-- 6. Enable Realtime (so dashboard updates instantly)
ALTER PUBLICATION supabase_realtime ADD TABLE public.handoff_requests;
ALTER PUBLICATION supabase_realtime ADD TABLE public.failed_automations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_control;
ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;`;

const SqlCopyBlock = ({ sql }: { sql: string }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };
  return (
    <div className="relative rounded-xl bg-zinc-950 border border-zinc-800 overflow-hidden">
      <pre className="text-[10px] font-mono text-zinc-400 p-4 overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-44">{sql}</pre>
      <button
        onClick={handleCopy}
        className="absolute top-2.5 right-2.5 flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] font-semibold transition-colors"
        data-testid="button-copy-sql-webhook"
      >
        <ClipboardCopy size={10} /> {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
};

const LocalWebhookSection = () => {
  const { url: publishedUrl, save: savePublishedUrl } = usePublishedUrl();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [openCurl, setOpenCurl] = useState<string | null>(null);
  const [editingUrl, setEditingUrl] = useState(!publishedUrl);
  const [urlDraft, setUrlDraft] = useState(publishedUrl || '');

  const origin = publishedUrl || 'https://your-app.replit.app';

  const copy = (text: string, key: string) => {
    if (!text || text.includes('your-app.replit.app')) {
      toast.error('Set your Published App URL first');
      return;
    }
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleSaveUrl = () => {
    if (!urlDraft.trim()) { toast.error('Please enter your published URL'); return; }
    let val = urlDraft.trim();
    if (!val.startsWith('http')) val = 'https://' + val;
    savePublishedUrl(val);
    setEditingUrl(false);
    toast.success('Published URL saved!');
  };

  const webhooks = [
    {
      key: 'handoff',
      label: 'Human Handoff',
      color: 'text-primary',
      bg: 'bg-primary/10',
      borderColor: 'border-primary/25',
      url: `${origin}/webhook/handoff`,
      fields: [
        { name: 'recipient',  example: 'Customer Name' },
        { name: 'reason',     example: 'Why human is needed' },
        { name: 'message',    example: "Customer's last message" },
        { name: 'priority',   example: 'normal / high / urgent' },
      ],
      curlBody: `{\n  "recipient": "Customer Name",\n  "reason": "Customer needs human help",\n  "message": "Customer\\'s last message",\n  "priority": "normal"\n}`,
    },
    {
      key: 'failure',
      label: 'Log Failure',
      color: 'text-destructive',
      bg: 'bg-destructive/10',
      borderColor: 'border-destructive/25',
      url: `${origin}/webhook/failure`,
      fields: [
        { name: 'workflow_name',  example: 'WhatsApp Bot' },
        { name: 'error_message',  example: 'API timeout after 30s' },
        { name: 'severity',       example: 'error / warning / critical' },
        { name: 'source',         example: 'n8n' },
      ],
      curlBody: `{\n  "workflow_name": "WhatsApp Bot Flow",\n  "error_message": "API timeout after 30s",\n  "severity": "error",\n  "source": "n8n"\n}`,
    },
    {
      key: 'order',
      label: 'Receive Order',
      color: 'text-amber-500',
      bg: 'bg-amber-500/10',
      borderColor: 'border-amber-500/25',
      url: `${origin}/webhook/order`,
      fields: [
        { name: 'customer_name',  example: 'Zakariea' },
        { name: 'customer_phone', example: '01758481876' },
        { name: 'product_name',   example: 'Cotton Saree' },
        { name: 'quantity',       example: '1' },
        { name: 'total_price',    example: '3491' },
        { name: 'status',         example: 'pending' },
      ],
      curlBody: `{\n  "customer_name": "Zakariea",\n  "customer_phone": "01758481876",\n  "product_name": "Cotton Saree",\n  "quantity": 1,\n  "total_price": 3491,\n  "status": "pending"\n}`,
    },
  ];

  const urlIsSet = !!publishedUrl;

  return (
    <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-emerald-500/20 flex items-center gap-3">
        <div className="h-9 w-9 rounded-xl bg-emerald-500/15 flex items-center justify-center flex-shrink-0">
          <Webhook size={18} className="text-emerald-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-foreground">Direct Dashboard Webhook</h3>
            <span className="text-[10px] font-bold text-emerald-700 bg-emerald-500/15 border border-emerald-500/25 px-2 py-0.5 rounded-full flex items-center gap-1">
              <Zap size={9} /> No Database Required
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            POST to this URL from n8n and data will appear in the Dashboard instantly
          </p>
        </div>
      </div>

      {/* Published URL configurator */}
      <div className="px-4 pt-4 pb-2">
        <div className={`rounded-xl border p-3.5 transition-colors ${urlIsSet && !editingUrl ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-400/40 bg-amber-500/5'}`}>
          <div className="flex items-center gap-2 mb-2">
            <Globe size={13} className={urlIsSet && !editingUrl ? 'text-emerald-500' : 'text-amber-500'} />
            <span className="text-[11px] font-bold text-foreground">Your Published App URL</span>
            {urlIsSet && !editingUrl && (
              <button
                onClick={() => { setUrlDraft(publishedUrl); setEditingUrl(true); }}
                className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                <Pencil size={10} /> Edit
              </button>
            )}
          </div>

          {editingUrl ? (
            <div className="space-y-2">
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                Enter the URL where this app is <strong>deployed/published</strong>. n8n will POST webhook data to this URL.
                <br />
                <span className="text-amber-600 dark:text-amber-400">Example: <code className="bg-muted px-1 rounded">https://myapp.replit.app</code></span>
              </p>
              <div className="flex gap-2">
                <input
                  value={urlDraft}
                  onChange={e => setUrlDraft(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSaveUrl()}
                  placeholder="https://your-app.replit.app"
                  className="flex-1 px-3 py-2 rounded-xl border border-border/60 bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500/40 placeholder:font-sans placeholder:text-muted-foreground/40 transition-all"
                  autoFocus
                />
                <button
                  onClick={handleSaveUrl}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-[11px] font-bold transition-colors flex-shrink-0"
                >
                  <Save size={12} /> Save
                </button>
                {urlIsSet && (
                  <button
                    onClick={() => setEditingUrl(false)}
                    className="flex items-center justify-center w-9 h-9 rounded-xl border border-border/60 hover:bg-muted transition-colors text-muted-foreground flex-shrink-0"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
              <code className="text-[11px] font-mono text-emerald-700 dark:text-emerald-400 flex-1 truncate">{publishedUrl}</code>
              <Check size={12} className="text-emerald-500 flex-shrink-0" />
            </div>
          )}

          {!urlIsSet && !editingUrl && (
            <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1">
              ⚠️ Set your published URL above so webhook URLs are correct for your deployment.
            </p>
          )}
        </div>
      </div>

      {/* Webhook cards */}
      <div className="p-4 space-y-3">
        {webhooks.map(wh => {
          const curlCmd = `curl -X POST '${wh.url}' \\\n  -H "Content-Type: application/json" \\\n  -d '${wh.curlBody}'`;
          const isCurlOpen = openCurl === wh.key;

          return (
            <div key={wh.key} className={`rounded-xl border ${wh.borderColor} bg-background overflow-hidden ${!urlIsSet ? 'opacity-60' : ''}`}>
              {/* URL row */}
              <div className="flex items-center gap-2.5 px-3.5 py-3">
                <div className={`h-6 w-6 rounded-lg ${wh.bg} flex items-center justify-center flex-shrink-0`}>
                  <Webhook size={12} className={wh.color} />
                </div>
                <span className={`text-[11px] font-bold flex-shrink-0 ${wh.color}`}>{wh.label}</span>
                <code className="flex-1 text-[10px] font-mono text-muted-foreground truncate min-w-0">{wh.url}</code>
                <button
                  onClick={() => copy(wh.url, wh.key)}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg bg-muted hover:bg-muted/80 text-muted-foreground text-[10px] font-semibold flex-shrink-0 transition-colors"
                >
                  {copiedKey === wh.key ? <Check size={10} className="text-primary" /> : <Copy size={10} />}
                  URL
                </button>
              </div>

              {/* Fields */}
              <div className="border-t border-border/40 px-3.5 pb-2.5 pt-2.5">
                <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground/60 mb-2">
                  Body Parameters (n8n → Using Fields Below)
                </p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  {wh.fields.map((f, i) => (
                    <div key={i} className="flex items-center gap-1.5 min-w-0">
                      <button
                        onClick={() => copy(f.name, `${wh.key}-f-${i}`)}
                        className="text-[10px] font-mono font-semibold text-foreground hover:text-primary transition-colors flex items-center gap-1 group flex-shrink-0"
                      >
                        {f.name}
                        {copiedKey === `${wh.key}-f-${i}` ? <Check size={8} className="text-primary" /> : <Copy size={8} className="opacity-0 group-hover:opacity-60" />}
                      </button>
                      <span className="text-[10px] text-muted-foreground/60 truncate">{f.example}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* cURL toggle */}
              <div className="border-t border-border/40">
                <button
                  onClick={() => setOpenCurl(isCurlOpen ? null : wh.key)}
                  className="w-full flex items-center gap-2 px-3.5 py-2 hover:bg-muted/30 transition-colors text-left"
                >
                  <Terminal size={12} className="text-muted-foreground flex-shrink-0" />
                  <span className="text-[10px] font-semibold text-muted-foreground flex-1">cURL Example</span>
                  {isCurlOpen ? <ChevronDown size={12} className="text-muted-foreground" /> : <ChevronRight size={12} className="text-muted-foreground" />}
                </button>

                {isCurlOpen && (
                  <div className="px-3.5 pb-3 animate-in slide-in-from-top-1 duration-150">
                    <div className="relative">
                      <pre className="text-[10px] font-mono text-zinc-300 bg-zinc-950 p-3 rounded-xl border border-zinc-800 overflow-x-auto whitespace-pre leading-relaxed">
                        {curlCmd}
                      </pre>
                      <button
                        onClick={() => copy(curlCmd, `${wh.key}-curl`)}
                        className="absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[9px] font-semibold transition-colors"
                      >
                        {copiedKey === `${wh.key}-curl` ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        <div className="flex items-start gap-2 px-1">
          <AlertTriangle size={11} className="text-emerald-600 mt-0.5 flex-shrink-0" />
          <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
            n8n → HTTP Request → Method: <strong>POST</strong> → Body Content Type: <strong>JSON</strong> → Specify Body: <strong>Using Fields Below</strong>
          </p>
        </div>
      </div>
    </div>
  );
};

const DirectRestApiSection = ({ projectUrl, anonKey }: { projectUrl: string; anonKey: string }) => {
  const [open, setOpen] = useState(false);
  const [openSub, setOpenSub] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const base = projectUrl.replace(/\/$/, '');

  const endpoints = [
    {
      key: 'handoff',
      label: 'Human Handoff',
      color: 'text-primary',
      bg: 'bg-primary/10',
      table: 'handoff_requests',
      fields: [
        { name: 'recipient',  value: 'Customer Name',            note: "customer's name" },
        { name: 'reason',     value: 'Why human agent needed',   note: 'reason' },
        { name: 'message',    value: "Customer's last message",  note: 'last message' },
        { name: 'priority',   value: 'normal',                   note: 'normal / high / urgent' },
      ],
    },
    {
      key: 'failure',
      label: 'Log Failure',
      color: 'text-destructive',
      bg: 'bg-destructive/10',
      table: 'failed_automations',
      fields: [
        { name: 'workflow_name',  value: 'WhatsApp Bot Flow',    note: 'workflow name' },
        { name: 'error_message',  value: 'API timeout after 30s',note: 'error message' },
        { name: 'severity',       value: 'error',                note: 'error / warning / info' },
        { name: 'source',         value: 'n8n',                  note: 'where it came from' },
      ],
    },
    {
      key: 'order',
      label: 'Receive Order',
      color: 'text-amber-500',
      bg: 'bg-amber-500/10',
      table: 'orders',
      fields: [
        { name: 'customer_name',  value: 'Zakariea',             note: "customer's name" },
        { name: 'customer_phone', value: '01758481876',          note: 'phone number' },
        { name: 'product_name',   value: 'Cotton Saree',         note: 'product name' },
        { name: 'quantity',       value: '1',                    note: 'quantity' },
        { name: 'total_price',    value: '3491',                 note: 'total price' },
        { name: 'status',         value: 'pending',              note: 'pending / delivered / cancelled' },
      ],
    },
  ];

  return (
    <div className="rounded-2xl border border-indigo-500/30 bg-indigo-500/5 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-5 py-4 border-b border-indigo-500/20 flex items-center gap-3 hover:bg-indigo-500/10 transition-colors text-left"
        data-testid="button-toggle-direct-api"
      >
        <div className="h-9 w-9 rounded-xl bg-indigo-500/15 flex items-center justify-center flex-shrink-0">
          <Terminal size={18} className="text-indigo-500" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-foreground">Alternative: Direct REST API</h3>
          <p className="text-[11px] text-muted-foreground">
            No Edge Functions — directly from n8n to Supabase REST API → Database
          </p>
        </div>
        <span className="text-[10px] font-semibold text-indigo-600 bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 rounded-full mr-1 whitespace-nowrap">
          No Deploy Needed
        </span>
        {open ? <ChevronDown size={15} className="text-muted-foreground" /> : <ChevronRight size={15} className="text-muted-foreground" />}
      </button>

      {open && (
        <div className="p-5 space-y-4 animate-in slide-in-from-top-2 duration-200">
          <div className="flex items-start gap-2 p-3 rounded-xl bg-indigo-500/8 border border-indigo-500/20">
            <AlertTriangle size={13} className="text-indigo-500 mt-0.5 flex-shrink-0" />
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Use the <strong>HTTP Request node</strong> in n8n. No Edge Functions deployment needed.
              Just create the tables in Supabase SQL Editor (Step 1).
            </p>
          </div>

          {/* Anon Key */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
              API Key (Anon Key)
            </p>
            <div className="flex items-center gap-2">
              <div className="flex-1 bg-background rounded-xl border border-border px-3 py-2 font-mono text-[10px] text-foreground truncate">
                {anonKey ? `${anonKey.slice(0, 16)}••••••••••••` : '— connect Supabase first —'}
              </div>
              {anonKey && (
                <Button
                  variant="outline" size="icon" className="h-8 w-8 rounded-xl flex-shrink-0"
                  onClick={() => copy(anonKey, 'anon')}
                  data-testid="button-copy-anon-key"
                >
                  {copiedKey === 'anon' ? <Check size={13} className="text-primary" /> : <Copy size={13} />}
                </Button>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1 ml-1">
              In n8n Headers, provide both <code className="bg-muted px-1 py-0.5 rounded text-[10px]">apikey</code> and <code className="bg-muted px-1 py-0.5 rounded text-[10px]">Authorization: Bearer ...</code>
            </p>
          </div>

          {/* Endpoint list */}
          <div className="space-y-2">
            {endpoints.map(ep => {
              const url = `${base}/rest/v1/${ep.table}`;
              const headers = [
                { name: 'apikey',         value: anonKey || 'YOUR_ANON_KEY' },
                { name: 'Authorization',  value: `Bearer ${anonKey || 'YOUR_ANON_KEY'}` },
                { name: 'Content-Type',   value: 'application/json' },
                { name: 'Prefer',         value: 'return=representation' },
              ];

              return (
                <div key={ep.key} className="rounded-xl border border-border bg-background overflow-hidden">
                  <button
                    onClick={() => setOpenSub(openSub === ep.key ? null : ep.key)}
                    className="w-full flex items-center gap-2.5 px-3.5 py-3 hover:bg-muted/40 transition-colors text-left"
                  >
                    <div className={`h-6 w-6 rounded-lg ${ep.bg} flex items-center justify-center flex-shrink-0`}>
                      <FileJson size={12} className={ep.color} />
                    </div>
                    <span className="text-xs font-semibold text-foreground flex-1">{ep.label}</span>
                    <code className="text-[10px] text-muted-foreground font-mono truncate max-w-[180px]">
                      /rest/v1/{ep.table}
                    </code>
                    <span
                      role="button"
                      tabIndex={0}
                      className="h-6 w-6 rounded-lg flex items-center justify-center flex-shrink-0 hover:bg-muted cursor-pointer"
                      onClick={e => { e.stopPropagation(); copy(url, ep.key + '-url'); }}
                      onKeyDown={e => e.key === 'Enter' && copy(url, ep.key + '-url')}
                    >
                      {copiedKey === ep.key + '-url' ? <Check size={11} className="text-primary" /> : <Copy size={11} className="text-muted-foreground" />}
                    </span>
                    {openSub === ep.key ? <ChevronDown size={13} className="text-muted-foreground flex-shrink-0" /> : <ChevronRight size={13} className="text-muted-foreground flex-shrink-0" />}
                  </button>

                  {openSub === ep.key && (
                    <div className="border-t border-border/50 px-3.5 py-4 space-y-4 animate-in slide-in-from-top-1 duration-150">

                      {/* URL row */}
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">URL</p>
                        <div className="flex items-center gap-2">
                          <code className="flex-1 text-[10px] bg-muted/60 rounded-lg px-3 py-2 font-mono text-foreground truncate">{url}</code>
                          <button onClick={() => copy(url, ep.key+'-url2')} className="text-[10px] px-2 py-1.5 rounded-lg bg-muted hover:bg-muted/80 text-muted-foreground flex items-center gap-1 flex-shrink-0">
                            {copiedKey === ep.key+'-url2' ? <Check size={10}/> : <Copy size={10}/>}
                          </button>
                        </div>
                      </div>

                      {/* Headers table */}
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                          Headers (n8n → Send Headers → Using Fields Below)
                        </p>
                        <div className="rounded-xl border border-border overflow-hidden">
                          <div className="grid grid-cols-2 bg-muted/40 px-3 py-1.5 border-b border-border">
                            <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Name</span>
                            <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Value</span>
                          </div>
                          {headers.map((h, i) => (
                            <div key={i} className={`grid grid-cols-2 px-3 py-2 gap-2 ${i < headers.length - 1 ? 'border-b border-border/40' : ''}`}>
                              <div className="flex items-center gap-1.5">
                                <code className="text-[10px] font-mono text-foreground">{h.name}</code>
                                <button onClick={() => copy(h.name, `h-name-${ep.key}-${i}`)} className="text-muted-foreground hover:text-foreground">
                                  {copiedKey === `h-name-${ep.key}-${i}` ? <Check size={9} className="text-primary"/> : <Copy size={9}/>}
                                </button>
                              </div>
                              <div className="flex items-center gap-1.5 min-w-0">
                                <code className="text-[10px] font-mono text-muted-foreground truncate flex-1">{h.value.length > 30 ? h.value.slice(0, 20) + '...' : h.value}</code>
                                <button onClick={() => copy(h.value, `h-val-${ep.key}-${i}`)} className="text-muted-foreground hover:text-foreground flex-shrink-0">
                                  {copiedKey === `h-val-${ep.key}-${i}` ? <Check size={9} className="text-primary"/> : <Copy size={9}/>}
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Body fields table */}
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                          Body Parameters (n8n → Body → Using Fields Below)
                        </p>
                        <div className="rounded-xl border border-border overflow-hidden">
                          <div className="grid grid-cols-2 bg-muted/40 px-3 py-1.5 border-b border-border">
                            <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Name</span>
                            <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Value (example)</span>
                          </div>
                          {ep.fields.map((f, i) => (
                            <div key={i} className={`grid grid-cols-2 px-3 py-2 gap-2 ${i < ep.fields.length - 1 ? 'border-b border-border/40' : ''}`}>
                              <div className="flex items-center gap-1.5">
                                <code className="text-[10px] font-mono text-foreground">{f.name}</code>
                                <button onClick={() => copy(f.name, `b-name-${ep.key}-${i}`)} className="text-muted-foreground hover:text-foreground">
                                  {copiedKey === `b-name-${ep.key}-${i}` ? <Check size={9} className="text-primary"/> : <Copy size={9}/>}
                                </button>
                              </div>
                              <div className="flex items-center gap-1.5 min-w-0">
                                <code className="text-[10px] font-mono text-muted-foreground truncate flex-1">{f.value}</code>
                                <button onClick={() => copy(f.value, `b-val-${ep.key}-${i}`)} className="text-muted-foreground hover:text-foreground flex-shrink-0">
                                  {copiedKey === `b-val-${ep.key}-${i}` ? <Check size={9} className="text-primary"/> : <Copy size={9}/>}
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                        <p className="text-[9px] text-muted-foreground/70 mt-1.5 ml-1">
                          In n8n, set "Body Content Type: JSON" and add each field separately
                        </p>
                      </div>

                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

const DbSetupSection = () => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(FULL_SETUP_SQL);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="rounded-2xl border border-border bg-gradient-to-br from-muted/30 to-muted/10 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-5 py-4 border-b border-border/50 flex items-center gap-3 hover:bg-muted/30 transition-colors text-left"
        data-testid="button-toggle-db-setup"
      >
        <div className="h-9 w-9 rounded-xl bg-emerald-500/10 flex items-center justify-center flex-shrink-0">
          <Database size={18} className="text-emerald-500" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-foreground">Database Tables Setup</h3>
          <p className="text-[11px] text-muted-foreground">
            Run this SQL in Supabase SQL Editor — creates all tables and realtime at once
          </p>
        </div>
        <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full mr-1">
          Step 1
        </span>
        {open ? <ChevronDown size={15} className="text-muted-foreground" /> : <ChevronRight size={15} className="text-muted-foreground" />}
      </button>
      {open && (
        <div className="p-5 space-y-3 animate-in slide-in-from-top-2 duration-200">
          <div className="flex items-start gap-2 p-3 rounded-xl bg-emerald-500/8 border border-emerald-500/20">
            <AlertTriangle size={13} className="text-emerald-600 mt-0.5 flex-shrink-0" />
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Open <strong>Supabase Dashboard → SQL Editor</strong> → paste the SQL below → click <strong>Run</strong>.
              Then proceed to Step 2 (Deploy Functions).
            </p>
          </div>
          <div className="relative rounded-xl bg-zinc-950 border border-zinc-800 overflow-hidden">
            <pre className="text-[10px] font-mono text-zinc-400 p-4 overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-60">
              {FULL_SETUP_SQL}
            </pre>
            <button
              onClick={handleCopy}
              className="absolute top-2.5 right-2.5 flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] font-semibold transition-colors"
              data-testid="button-copy-setup-sql"
            >
              {copied ? <><Check size={10} /> Copied!</> : <><ClipboardCopy size={10} /> Copy All</>}
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground ml-1">
            Run this once — all tables and Realtime will be set up.
          </p>
        </div>
      )}
    </div>
  );
};

function genApiKey(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

const WebhookSettings = () => {
  const queryClient = useQueryClient();
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [openSection, setOpenSection] = useState<string | null>(null);
  const [isCreatingKey, setIsCreatingKey] = useState(false);
  const [tableMissing, setTableMissing] = useState(false);
  const hasAttemptedCreate = useRef(false);

  const activeConn = getActiveConnection();
  const baseUrl = activeConn?.url?.replace(/\/$/, '') ?? '';
  const hasDb = !!baseUrl;

  const { data: apiKeyData, refetch: refetchApiKey, isLoading: isLoadingKey } = useQuery({
    queryKey: ['api-key'],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;
      const { data, error } = await supabase
        .from('api_keys' as any)
        .select('*')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .maybeSingle();
      if (error) {
        const msg = error.message ?? '';
        if (msg.includes('does not exist') || msg.includes('relation') || msg.includes('42P01')) {
          return null;
        }
        throw error;
      }
      return (data as any) ?? null;
    },
    retry: false,
  });

  useEffect(() => {
    if (!hasDb) return;
    if (isLoadingKey || isCreatingKey) return;
    if (apiKeyData !== null && apiKeyData !== undefined) return;
    if (hasAttemptedCreate.current) return;

    hasAttemptedCreate.current = true;

    const autoCreate = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      setIsCreatingKey(true);
      try {
        const newKey = genApiKey();
        const { error } = await supabase
          .from('api_keys' as any)
          .upsert(
            { user_id: user.id, api_key: newKey, is_active: true, updated_at: new Date().toISOString() },
            { onConflict: 'user_id' }
          );
        if (error) {
          const msg = error.message ?? '';
          const isTableMissing = msg.includes('42P01') || msg.includes('does not exist') || msg.includes('relation "public.api_keys"');
          if (isTableMissing) {
            setTableMissing(true);
          } else {
            toast.error('Could not create API key');
          }
        } else {
          queryClient.invalidateQueries({ queryKey: ['api-key'] });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const isTableMissing = msg.includes('42P01') || msg.includes('does not exist');
        if (isTableMissing) {
          setTableMissing(true);
        }
      } finally {
        setIsCreatingKey(false);
      }
    };

    autoCreate();
  }, [apiKeyData, isLoadingKey, hasDb]);

  const userApiKey: string = (apiKeyData as any)?.api_key ?? '';
  const keyDisplay = isLoadingKey || isCreatingKey
    ? '••••••••••••••••••••••••'
    : userApiKey
      ? (showKey ? userApiKey : userApiKey.slice(0, 8) + '••••••••••••••••' + userApiKey.slice(-4))
      : 'Run setup SQL below to create api_keys table';

  const regenerateKey = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const newKey = genApiKey();
    const { error } = await supabase
      .from('api_keys' as any)
      .upsert(
        { user_id: user.id, api_key: newKey, is_active: true, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );
    if (error) {
      toast.error('Failed to regenerate key');
    } else {
      refetchApiKey();
      toast.success('API Key regenerated!');
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied!`);
  };

  const copyUrl = (url: string, key: string) => {
    if (!url) return;
    navigator.clipboard.writeText(url);
    setCopiedUrl(key);
    toast.success('URL copied!');
    setTimeout(() => setCopiedUrl(null), 2000);
  };

  const endpoints = [
    {
      key: 'handoff',
      icon: HandMetal,
      iconBg: 'bg-primary/10',
      iconColor: 'text-primary',
      title: 'Human Handoff',
      description: 'Send human handoff requests from your n8n workflow',
      url: `${baseUrl}/functions/v1/human-handoff`,
      postBody: `{
  "recipient": "Customer Name",
  "reason": "Why human agent is needed",
  "message": "Customer's last message"
}`,
      noApiKey: false,
    },
    {
      key: 'failure',
      icon: AlertOctagon,
      iconBg: 'bg-destructive/10',
      iconColor: 'text-destructive',
      title: 'Failure Logging',
      description: 'Log automation failures from your n8n workflows',
      url: `${baseUrl}/functions/v1/log-failure`,
      postBody: `{
  "workflow_name": "WhatsApp Bot Flow",
  "error_message": "API timeout after 30s",
  "severity": "error",
  "recipient": "Customer Name",
  "error_details": {
    "node": "HTTP Request",
    "status_code": 504
  }
}`,
      noApiKey: false,
    },
    {
      key: 'order',
      icon: ShoppingBag,
      iconBg: 'bg-amber-500/10',
      iconColor: 'text-amber-500',
      title: 'Order Webhook',
      description: 'Receive new orders from n8n, Make, or Zapier',
      url: `${baseUrl}/functions/v1/receive-order`,
      postBody: `{
  "merchant_order_id": "1758481876",
  "consignment_id": "CON-12345",
  "date": "2026-03-09",
  "address": "Dhaka, 909",
  "name": "Zakariea",
  "phone": "1758481876",
  "product_name": "Green Cotton Saree",
  "SKU": "LSHR17368",
  "quantity": 1,
  "price": 3491,
  "total_price": 3491,
  "amount_to_collect": 3491,
  "Total_parcels": 0,
  "Total_delivered": 0,
  "Total_cancel": 0,
  "Order_recive_ratio": "0%",
  "Pathao": 0,
  "Steadfast": 0,
  "Paperfly": 0,
  "Redex": 0,
  "Status": "Pending",
  "Reason_for_cancel": ""
}`,
      noApiKey: true,
    },
  ];

  const toggleSection = (section: string) => {
    setOpenSection(openSection === section ? null : section);
  };

  return (
    <div className="space-y-6">
      <LocalWebhookSection />
    </div>
  );
};

export default WebhookSettings;
