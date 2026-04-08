import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getActiveConnection, onDbChange, normalizeDbType, isValidDbType, MainDbType, MainDbConnection } from '@/lib/db-config';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  Copy, Check, Eye, EyeOff, RefreshCw, Shield, ChevronDown, ChevronRight,
  Terminal, AlertTriangle, Loader2,
  ClipboardCopy, Database, Webhook, Zap, Globe, Pencil, Save, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// Reactive hook: re-renders callers whenever active DB connection changes.
// Listens to both the custom meta_db_change event (same-tab) and the
// browser storage event (cross-tab) to stay in sync.
function useActiveConnection(): MainDbConnection | null {
  const [conn, setConn] = useState<MainDbConnection | null>(() => getActiveConnection());
  useEffect(() => {
    const refresh = () => setConn(getActiveConnection());
    const unsubscribe = onDbChange(refresh);
    window.addEventListener('storage', refresh);
    return () => {
      unsubscribe();
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return conn;
}

/* ── Published URL (localStorage) ─────────────────────────────────── */
const PUBLISHED_URL_KEY = 'meta_automation_published_url';
function usePublishedUrl() {
  const [url, setUrl] = useState<string>(() => {
    try { return localStorage.getItem(PUBLISHED_URL_KEY) ?? ''; } catch { return ''; }
  });
  const save = (val: string) => {
    const trimmed = val.trim().replace(/\/$/, '');
    try { localStorage.setItem(PUBLISHED_URL_KEY, trimmed); } catch { }
    setUrl(trimmed);
  };
  return { url, save };
}

// Table creation SQL — per DB type, per table

// handoff_requests
const HANDOFF_SQL: Record<MainDbType, string> = {
  supabase: `CREATE TABLE IF NOT EXISTS public.handoff_requests (
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
DROP POLICY IF EXISTS "Allow all" ON public.handoff_requests;
-- Dev policy: allows public insert from n8n/webhooks.
-- Production: use service_role key in n8n (bypasses RLS) and tighten this policy.
CREATE POLICY "Allow all" ON public.handoff_requests FOR ALL USING (true);
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.handoff_requests; EXCEPTION WHEN OTHERS THEN NULL; END $$;`,

  postgresql: `-- Requires PostgreSQL 13+ (gen_random_uuid is built-in since PG13)
CREATE TABLE IF NOT EXISTS handoff_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id VARCHAR(255),
  recipient VARCHAR(255),
  reason TEXT NOT NULL DEFAULT 'Human assistance needed',
  message TEXT,
  priority VARCHAR(50) DEFAULT 'normal',
  status VARCHAR(50) DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);`,

  mysql: `-- Requires MySQL 8.0.13+ for DEFAULT (UUID()); use app-generated UUIDs on older versions
CREATE TABLE IF NOT EXISTS handoff_requests (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  session_id VARCHAR(255),
  recipient VARCHAR(255),
  reason TEXT NOT NULL,
  message TEXT,
  priority VARCHAR(50) DEFAULT 'normal',
  status VARCHAR(50) DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`,

  mongodb: `// MongoDB creates collections automatically on first insert.
// Optionally create with schema validation:
db.createCollection("handoff_requests", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["reason"],
      properties: {
        session_id: { bsonType: "string" },
        recipient:  { bsonType: "string" },
        reason:     { bsonType: "string" },
        message:    { bsonType: "string" },
        priority:   { enum: ["normal", "high", "urgent"] },
        status:     { bsonType: "string" }
      }
    }
  }
});`,

  redis: `# Redis uses key-value patterns — no schema needed.
# Recommended key pattern:
#   handoff:{session_id}
#
# Store as Hash:
#   HSET handoff:{session_id} recipient "Name" reason "..." message "..." priority "normal"
#
# Or store as JSON string:
#   SET handoff:{session_id} '{"recipient":"Name","reason":"..."}' EX 86400`,
};

/* failed_automations */
const FAILURES_SQL: Record<MainDbType, string> = {
  supabase: `CREATE TABLE IF NOT EXISTS public.failed_automations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
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
DROP POLICY IF EXISTS "Allow all" ON public.failed_automations;
-- Dev policy: allows public insert from n8n/webhooks.
-- Production: use service_role key in n8n (bypasses RLS) and tighten this policy.
CREATE POLICY "Allow all" ON public.failed_automations FOR ALL USING (true);
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.failed_automations; EXCEPTION WHEN OTHERS THEN NULL; END $$;`,

  postgresql: `-- Requires PostgreSQL 13+ (gen_random_uuid is built-in since PG13)
CREATE TABLE IF NOT EXISTS failed_automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_name VARCHAR(255),
  error_message TEXT NOT NULL,
  source VARCHAR(100) DEFAULT 'n8n',
  session_id VARCHAR(255),
  recipient VARCHAR(255),
  severity VARCHAR(50) DEFAULT 'error',
  resolved BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);`,

  mysql: `-- Requires MySQL 8.0.13+ for DEFAULT (UUID()); use app-generated UUIDs on older versions
CREATE TABLE IF NOT EXISTS failed_automations (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  workflow_name VARCHAR(255),
  error_message TEXT NOT NULL,
  source VARCHAR(100) DEFAULT 'n8n',
  session_id VARCHAR(255),
  recipient VARCHAR(255),
  severity VARCHAR(50) DEFAULT 'error',
  resolved TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`,

  mongodb: `// MongoDB creates collections automatically on first insert.
db.createCollection("failed_automations");`,

  redis: `# Redis key pattern for failures:
#   failure:{workflow}:{timestamp}
#
# HSET failure:WorkflowName:1234567890 workflow_name "WorkflowName" error_message "..." severity "error"
# Or JSON: SET failure:{workflow}:{ts} '{"error":"..."}' EX 604800`,
};

/* orders */
const ORDERS_SQL: Record<MainDbType, string> = {
  supabase: `CREATE TABLE IF NOT EXISTS public.orders (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  merchant_order_id text,
  customer_name text,
  customer_phone text,
  customer_address text,
  product_name text DEFAULT 'Unknown Product',
  sku text,
  quantity integer DEFAULT 1,
  unit_price numeric,
  total_price numeric,
  amount_to_collect numeric,
  payment_status text DEFAULT 'unpaid',
  status text DEFAULT 'pending',
  reason_for_cancel text,
  notes text,
  session_id text,
  source text DEFAULT 'webhook',
  order_data jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now() NOT NULL
);
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all" ON public.orders;
-- Dev policy: allows public insert from n8n/webhooks.
-- Production: use service_role key in n8n (bypasses RLS) and tighten this policy.
CREATE POLICY "Allow all" ON public.orders FOR ALL USING (true);
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.orders; EXCEPTION WHEN OTHERS THEN NULL; END $$;`,

  postgresql: `-- Requires PostgreSQL 13+ (gen_random_uuid is built-in since PG13)
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_order_id VARCHAR(255),
  customer_name VARCHAR(255),
  customer_phone VARCHAR(50),
  customer_address TEXT,
  product_name VARCHAR(255) DEFAULT 'Unknown Product',
  sku VARCHAR(255),
  quantity INTEGER DEFAULT 1,
  unit_price NUMERIC,
  total_price NUMERIC,
  amount_to_collect NUMERIC,
  payment_status VARCHAR(50) DEFAULT 'unpaid',
  status VARCHAR(50) DEFAULT 'pending',
  reason_for_cancel TEXT,
  notes TEXT,
  session_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);`,

  mysql: `-- Requires MySQL 8.0.13+ for DEFAULT (UUID()); use app-generated UUIDs on older versions
CREATE TABLE IF NOT EXISTS orders (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  merchant_order_id VARCHAR(255),
  customer_name VARCHAR(255),
  customer_phone VARCHAR(50),
  customer_address TEXT,
  product_name VARCHAR(255) DEFAULT 'Unknown Product',
  sku VARCHAR(255),
  quantity INT DEFAULT 1,
  unit_price DECIMAL(10,2),
  total_price DECIMAL(10,2),
  amount_to_collect DECIMAL(10,2),
  payment_status VARCHAR(50) DEFAULT 'unpaid',
  status VARCHAR(50) DEFAULT 'pending',
  reason_for_cancel TEXT,
  notes TEXT,
  session_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`,

  mongodb: `// MongoDB creates collections automatically on first insert.
db.createCollection("orders");`,

  redis: `# Redis key pattern for orders:
#   order:{merchant_order_id}
#
# HSET order:BI-0016 merchant_order_id "BI-0016" customer_name "Zakariea" customer_phone "01758481876" customer_address "Dhaka" product_name "Cotton Saree" sku "CSR-001" quantity "1" unit_price "3491" total_price "3491" amount_to_collect "3491" payment_status "unpaid" status "pending"
# Or JSON: SET order:{id} '{"merchant_order_id":"BI-0016","status":"pending"}' EX 2592000`,
};

/* ── Full setup SQL — all 5 database types ──────────────────────── */

const FULL_SETUP_SQL = `-- ═══════════════════════════════════════════════
-- META AUTOMATION — Full Database Setup (Supabase)
-- Run this ONCE in Supabase → SQL Editor
-- ═══════════════════════════════════════════════

-- 1. Human Handoff Requests
${HANDOFF_SQL.supabase}

-- 2. Failed Automations
${FAILURES_SQL.supabase}

-- 3. Orders
${ORDERS_SQL.supabase}

-- 4. AI Control
CREATE TABLE IF NOT EXISTS public.ai_control (
  session_id text PRIMARY KEY,
  ai_enabled boolean DEFAULT true NOT NULL,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.ai_control ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for ai_control" ON public.ai_control;
CREATE POLICY "Allow all for ai_control" ON public.ai_control FOR ALL USING (true);

-- 5. API Keys
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
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);`;

const FULL_SETUP_SQL_POSTGRESQL = `-- ═══════════════════════════════════════════════
-- META AUTOMATION — Full Database Setup (PostgreSQL)
-- Run this ONCE in your PostgreSQL client
-- Requires PostgreSQL 13+
-- ═══════════════════════════════════════════════

-- 1. Human Handoff Requests
${HANDOFF_SQL.postgresql}

-- 2. Failed Automations
${FAILURES_SQL.postgresql}

-- 3. Orders
${ORDERS_SQL.postgresql}

-- 4. AI Control
CREATE TABLE IF NOT EXISTS ai_control (
  session_id VARCHAR(255) PRIMARY KEY,
  ai_enabled BOOLEAN DEFAULT true NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);`;

const FULL_SETUP_SQL_MYSQL = `-- ═══════════════════════════════════════════════
-- META AUTOMATION — Full Database Setup (MySQL)
-- Run this ONCE in your MySQL client
-- Requires MySQL 8.0.13+
-- ═══════════════════════════════════════════════

-- 1. Human Handoff Requests
${HANDOFF_SQL.mysql}

-- 2. Failed Automations
${FAILURES_SQL.mysql}

-- 3. Orders
${ORDERS_SQL.mysql}

-- 4. AI Control
CREATE TABLE IF NOT EXISTS ai_control (
  session_id VARCHAR(255) PRIMARY KEY,
  ai_enabled TINYINT(1) DEFAULT 1 NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);`;

const FULL_SETUP_SQL_MONGODB = `// ═══════════════════════════════════════════════
// META AUTOMATION — Full Database Setup (MongoDB)
// Run in MongoDB Shell or Compass
// Collections are created automatically on first insert.
// Optionally create them explicitly:
// ═══════════════════════════════════════════════

db.createCollection("handoff_requests");
db.createCollection("failed_automations");
db.createCollection("orders");
db.createCollection("ai_control");

// Recommended indexes for orders:
db.orders.createIndex({ status: 1 });
db.orders.createIndex({ created_at: -1 });
db.orders.createIndex({ merchant_order_id: 1 });

// Recommended indexes for handoff_requests:
db.handoff_requests.createIndex({ session_id: 1 });
db.handoff_requests.createIndex({ status: 1 });`;

const FULL_SETUP_SQL_REDIS = `# ═══════════════════════════════════════════════
# META AUTOMATION — Key Patterns (Redis)
# Redis requires no schema — just use these key patterns in n8n
# ═══════════════════════════════════════════════

# Orders  →  order:{merchant_order_id}
# HSET order:BI-0016 merchant_order_id "BI-0016" customer_name "Zakariea" \\
#   customer_phone "01758481876" customer_address "Dhaka" \\
#   product_name "Cotton Saree" sku "CSR-001" quantity "1" \\
#   unit_price "3491" total_price "3491" amount_to_collect "3491" \\
#   payment_status "unpaid" status "pending"

# Human Handoff  →  handoff:{session_id}
# HSET handoff:{session_id} recipient "Name" reason "..." priority "normal"

# Failed Automations  →  failure:{workflow}:{timestamp}
# HSET failure:BotFlow:1234567890 workflow_name "BotFlow" error_message "..."

# AI Control  →  ai_control:{session_id}
# SET ai_control:{session_id} "true"

# Set expiry as needed:
# EXPIRE order:BI-0016 2592000   (30 days)`;

const FULL_SETUP_BY_DB: Record<MainDbType, string> = {
  supabase:   FULL_SETUP_SQL,
  postgresql: FULL_SETUP_SQL_POSTGRESQL,
  mysql:      FULL_SETUP_SQL_MYSQL,
  mongodb:    FULL_SETUP_SQL_MONGODB,
  redis:      FULL_SETUP_SQL_REDIS,
};

// Endpoint definitions
interface EndpointDef {
  key: string;
  label: string;
  table: string;
  colorText: string;
  colorBg: string;
  colorBorder: string;
  fields: { name: string; example: string }[];
  bodyJson: Record<string, string | number>;
  createSql: Record<MainDbType, string>;
  n8nInsertQuery: { pg: string; mysql: string };
  mongoDoc: string;
  redisKey: string;
  redisValue: string;
}

const ENDPOINTS: EndpointDef[] = [
  {
    key: 'handoff',
    label: 'Human Handoff',
    table: 'handoff_requests',
    colorText: 'text-primary',
    colorBg: 'bg-primary/10',
    colorBorder: 'border-primary/25',
    fields: [
      { name: 'recipient', example: 'Customer Name' },
      { name: 'reason',    example: 'Why human is needed' },
      { name: 'message',   example: "Customer's last message" },
      { name: 'priority',  example: 'normal / high / urgent' },
    ],
    bodyJson: { recipient: 'Customer Name', reason: 'Human help needed', message: 'Last message', priority: 'normal' },
    createSql: HANDOFF_SQL,
    n8nInsertQuery: {
      pg: `INSERT INTO handoff_requests (session_id, recipient, reason, message, priority)
VALUES (
  '{{ $json.session_id }}',
  '{{ $json.recipient }}',
  '{{ $json.reason }}',
  '{{ $json.message }}',
  '{{ $json.priority }}'
);`,
      mysql: `INSERT INTO handoff_requests (session_id, recipient, reason, message, priority)
VALUES (
  '{{ $json.session_id }}',
  '{{ $json.recipient }}',
  '{{ $json.reason }}',
  '{{ $json.message }}',
  '{{ $json.priority }}'
);`,
    },
    mongoDoc: `{
  "session_id": "{{ $json.session_id }}",
  "recipient":  "{{ $json.recipient }}",
  "reason":     "{{ $json.reason }}",
  "message":    "{{ $json.message }}",
  "priority":   "{{ $json.priority }}"
}`,
    redisKey: 'handoff:{{ $json.session_id }}',
    redisValue: '{{ JSON.stringify($json) }}',
  },
  {
    key: 'failure',
    label: 'Log Failure',
    table: 'failed_automations',
    colorText: 'text-destructive',
    colorBg: 'bg-destructive/10',
    colorBorder: 'border-destructive/25',
    fields: [
      { name: 'workflow_name', example: 'WhatsApp Bot' },
      { name: 'error_message', example: 'API timeout after 30s' },
      { name: 'severity',      example: 'error / warning / critical' },
      { name: 'source',        example: 'n8n' },
    ],
    bodyJson: { workflow_name: 'WhatsApp Bot Flow', error_message: 'API timeout after 30s', severity: 'error', source: 'n8n' },
    createSql: FAILURES_SQL,
    n8nInsertQuery: {
      pg: `INSERT INTO failed_automations (workflow_name, error_message, severity, source, session_id, recipient)
VALUES (
  '{{ $json.workflow_name }}',
  '{{ $json.error_message }}',
  '{{ $json.severity }}',
  '{{ $json.source }}',
  '{{ $json.session_id }}',
  '{{ $json.recipient }}'
);`,
      mysql: `INSERT INTO failed_automations (workflow_name, error_message, severity, source, session_id, recipient)
VALUES (
  '{{ $json.workflow_name }}',
  '{{ $json.error_message }}',
  '{{ $json.severity }}',
  '{{ $json.source }}',
  '{{ $json.session_id }}',
  '{{ $json.recipient }}'
);`,
    },
    mongoDoc: `{
  "workflow_name": "{{ $json.workflow_name }}",
  "error_message": "{{ $json.error_message }}",
  "severity":      "{{ $json.severity }}",
  "source":        "{{ $json.source }}",
  "session_id":    "{{ $json.session_id }}"
}`,
    redisKey: 'failure:{{ $json.workflow_name }}:{{ Date.now() }}',
    redisValue: '{{ JSON.stringify($json) }}',
  },
  {
    key: 'order',
    label: 'Receive Order',
    table: 'orders',
    colorText: 'text-amber-500',
    colorBg: 'bg-amber-500/10',
    colorBorder: 'border-amber-500/25',
    fields: [
      { name: 'merchant_order_id', example: 'BI-0016' },
      { name: 'customer_name',     example: 'Zakariea' },
      { name: 'customer_phone',    example: '01758481876' },
      { name: 'customer_address',  example: 'Dhaka, Bangladesh' },
      { name: 'product_name',      example: 'Cotton Saree' },
      { name: 'sku',               example: 'CSR-001' },
      { name: 'quantity',          example: '1' },
      { name: 'unit_price',        example: '3491' },
      { name: 'total_price',       example: '3491' },
      { name: 'amount_to_collect', example: '3491' },
      { name: 'payment_status',    example: 'unpaid' },
      { name: 'status',            example: 'pending' },
    ],
    bodyJson: {
      merchant_order_id: 'BI-0016',
      customer_name:     'Zakariea',
      customer_phone:    '01758481876',
      customer_address:  'Dhaka, Bangladesh',
      product_name:      'Cotton Saree',
      sku:               'CSR-001',
      quantity:          1,
      unit_price:        3491,
      total_price:       3491,
      amount_to_collect: 3491,
      payment_status:    'unpaid',
      status:            'pending',
    },
    createSql: ORDERS_SQL,
    n8nInsertQuery: {
      pg: `INSERT INTO orders (
  merchant_order_id, customer_name, customer_phone, customer_address,
  product_name, sku, quantity, unit_price, total_price, amount_to_collect,
  payment_status, status
)
VALUES (
  '{{ $json.merchant_order_id }}',
  '{{ $json.customer_name }}',
  '{{ $json.customer_phone }}',
  '{{ $json.customer_address }}',
  '{{ $json.product_name }}',
  '{{ $json.sku }}',
  {{ $json.quantity }},
  {{ $json.unit_price }},
  {{ $json.total_price }},
  {{ $json.amount_to_collect }},
  '{{ $json.payment_status }}',
  '{{ $json.status }}'
);`,
      mysql: `INSERT INTO orders (
  merchant_order_id, customer_name, customer_phone, customer_address,
  product_name, sku, quantity, unit_price, total_price, amount_to_collect,
  payment_status, status
)
VALUES (
  '{{ $json.merchant_order_id }}',
  '{{ $json.customer_name }}',
  '{{ $json.customer_phone }}',
  '{{ $json.customer_address }}',
  '{{ $json.product_name }}',
  '{{ $json.sku }}',
  {{ $json.quantity }},
  {{ $json.unit_price }},
  {{ $json.total_price }},
  {{ $json.amount_to_collect }},
  '{{ $json.payment_status }}',
  '{{ $json.status }}'
);`,
    },
    mongoDoc: `{
  "merchant_order_id": "{{ $json.merchant_order_id }}",
  "customer_name":     "{{ $json.customer_name }}",
  "customer_phone":    "{{ $json.customer_phone }}",
  "customer_address":  "{{ $json.customer_address }}",
  "product_name":      "{{ $json.product_name }}",
  "sku":               "{{ $json.sku }}",
  "quantity":          {{ $json.quantity }},
  "unit_price":        {{ $json.unit_price }},
  "total_price":       {{ $json.total_price }},
  "amount_to_collect": {{ $json.amount_to_collect }},
  "payment_status":    "{{ $json.payment_status }}",
  "status":            "{{ $json.status }}"
}`,
    redisKey: 'order:{{ $json.merchant_order_id }}',
    redisValue: '{{ JSON.stringify($json) }}',
  },
];

// Helper components
const CodeBlock = ({ code, maxH = 'max-h-52' }: { code: string; maxH?: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success('Copied!');
  };
  return (
    <div className="relative rounded-xl bg-zinc-950 border border-zinc-800 overflow-hidden">
      <pre className={cn('text-[10px] font-mono text-zinc-300 p-4 overflow-x-auto whitespace-pre leading-relaxed', maxH)}>{code}</pre>
      <button
        onClick={copy}
        className="absolute top-2.5 right-2.5 flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] font-semibold transition-colors"
      >
        {copied ? <><Check size={10} /> Copied!</> : <><ClipboardCopy size={10} /> Copy</>}
      </button>
    </div>
  );
};

const FieldsGrid = ({ fields, epKey, copiedKey, onCopy }: {
  fields: { name: string; example: string }[];
  epKey: string;
  copiedKey: string | null;
  onCopy: (text: string, key: string) => void;
}) => (
  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
    {fields.map((f, i) => {
      const ck = `${epKey}-field-${i}`;
      return (
        <div key={i} className="flex items-center gap-1.5 min-w-0">
          <button
            onClick={() => onCopy(f.name, ck)}
            className="text-[10px] font-mono font-semibold text-foreground hover:text-primary transition-colors flex items-center gap-1 group flex-shrink-0"
          >
            {f.name}
            {copiedKey === ck ? <Check size={8} className="text-primary" /> : <Copy size={8} className="opacity-0 group-hover:opacity-60" />}
          </button>
          <span className="text-[10px] text-muted-foreground/60 truncate">{f.example}</span>
        </div>
      );
    })}
  </div>
);

// Primary section: DB-aware, no domain needed

const DB_LABELS: Record<MainDbType, { icon: string; label: string; color: string }> = {
  supabase:   { icon: '⚡', label: 'Supabase',   color: 'text-emerald-600' },
  postgresql: { icon: '🐘', label: 'PostgreSQL', color: 'text-blue-600' },
  mysql:      { icon: '🐬', label: 'MySQL',      color: 'text-cyan-600' },
  mongodb:    { icon: '🍃', label: 'MongoDB',    color: 'text-green-600' },
  redis:      { icon: '🔴', label: 'Redis',      color: 'text-red-500' },
};

const SmartWebhookSection = ({ activeConn }: { activeConn: MainDbConnection | null }) => {
  const rawDbType = activeConn?.dbType;
  const unknownDbType = !!activeConn && !isValidDbType(rawDbType);
  const dbType = normalizeDbType(rawDbType);
  const supabaseUrl = activeConn?.url?.replace(/\/$/, '') || '';
  const anonKey = activeConn?.anonKey || '';
  const dbInfo = DB_LABELS[dbType];
  const isSupabase = dbType === 'supabase';
  const isPostgres = dbType === 'postgresql';
  const isMysql = dbType === 'mysql';
  const isMongo = dbType === 'mongodb';
  const isRedis = dbType === 'redis';

  const [openEp, setOpenEp] = useState<string | null>(null);
  const [openCreate, setOpenCreate] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
    toast.success('Copied!');
  };

  const buildCurl = (ep: EndpointDef) => {
    const url = `${supabaseUrl}/rest/v1/${ep.table}`;
    const key = anonKey || 'YOUR_ANON_KEY';
    const body = JSON.stringify(ep.bodyJson, null, 2);
    return `curl -X POST '${url}' \\
  -H 'apikey: ${key}' \\
  -H 'Authorization: Bearer ${key}' \\
  -H 'Content-Type: application/json' \\
  -H 'Prefer: return=representation' \\
  -d '${body}'`;
  };

  const noConn = !activeConn;

  return (
    <div className="rounded-2xl border border-primary/25 bg-primary/3 overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-primary/15 flex items-center gap-3">
        <div className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
          <Database size={18} className="text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-foreground">Webhook & API Endpoints</h3>
            <span className="text-[10px] font-bold text-primary bg-primary/10 border border-primary/20 px-2 py-0.5 rounded-full flex items-center gap-1">
              <Zap size={9} /> No Domain Required
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            n8n sends data directly to your database — no deployed URL needed
          </p>
        </div>
        {activeConn && (
          <div className={cn('flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted/50 border border-border/40 text-[10px] font-semibold flex-shrink-0', dbInfo.color)}>
            <span>{dbInfo.icon}</span> {dbInfo.label}
          </div>
        )}
      </div>

      <div className="p-4 space-y-3">

        {/* No connection warning */}
        {noConn && (
          <div className="flex items-center gap-2 p-3 rounded-xl bg-amber-500/8 border border-amber-500/25">
            <AlertTriangle size={13} className="text-amber-500 flex-shrink-0" />
            <p className="text-[11px] text-muted-foreground">
              Connect a database first (Settings → Database) to see your webhook endpoints.
            </p>
          </div>
        )}

        {/* Unknown DB type warning */}
        {unknownDbType && (
          <div className="flex items-center gap-2 p-3 rounded-xl bg-destructive/8 border border-destructive/25">
            <AlertTriangle size={13} className="text-destructive flex-shrink-0" />
            <p className="text-[11px] text-muted-foreground">
              Unknown database type <code className="font-mono text-foreground">{rawDbType || 'undefined'}</code>. Re-save your connection in Settings → Database to fix this.
            </p>
          </div>
        )}

        {/* Supabase anon key display */}
        {isSupabase && anonKey && (
          <div className="flex items-center gap-2 p-2.5 rounded-xl bg-muted/40 border border-border/40">
            <Shield size={12} className="text-muted-foreground flex-shrink-0" />
            <span className="text-[10px] text-muted-foreground">Anon Key:</span>
            <code className="flex-1 text-[10px] font-mono text-foreground truncate">
              {anonKey.slice(0, 20)}••••••••
            </code>
            <button
              onClick={() => copy(anonKey, 'anonkey-top')}
              className="flex-shrink-0 p-1 rounded-md hover:bg-muted transition-colors"
              title="Copy anon key"
            >
              {copiedKey === 'anonkey-top' ? <Check size={11} className="text-primary" /> : <Copy size={11} className="text-muted-foreground" />}
            </button>
          </div>
        )}

        {/* How it works — contextual note per DB type */}
        {!noConn && (
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-muted/30 border border-border/30">
            <Terminal size={12} className="text-muted-foreground mt-0.5 flex-shrink-0" />
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {isSupabase && <>In n8n, add an <strong>HTTP Request</strong> node. Use the cURL below — URL and headers are pre-filled with your Supabase credentials.</>}
              {isPostgres && <>In n8n, add a <strong>Postgres</strong> node with "Execute Query". Use the INSERT query below. Connect it using your PostgreSQL host/port/credentials.</>}
              {isMysql   && <>In n8n, add a <strong>MySQL</strong> node with "Execute Query". Use the INSERT query below. Connect it using your MySQL host/port/credentials.</>}
              {isMongo   && <>In n8n, add a <strong>MongoDB</strong> node. Use "Insert Document" operation with the document template below.</>}
              {isRedis   && <>In n8n, add a <strong>Redis</strong> node. Use "HSET" operation with the key pattern and field values below.</>}
            </p>
          </div>
        )}

        {/* Endpoint Cards — only shown when a valid DB is connected */}
        {!noConn && !unknownDbType && ENDPOINTS.map(ep => {
          const isOpen = openEp === ep.key;
          const isCreateOpen = openCreate === `${ep.key}-create`;
          const restUrl = isSupabase ? `${supabaseUrl}/rest/v1/${ep.table}` : '';

          return (
            <div key={ep.key} className={cn('rounded-xl border bg-background overflow-hidden', ep.colorBorder)}>

              {/* Card header — split into clickable toggle area + action buttons to avoid nested buttons */}
              <div className="flex items-center gap-2.5 px-3.5 py-3 hover:bg-muted/30 transition-colors">
                <button
                  onClick={() => setOpenEp(isOpen ? null : ep.key)}
                  className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
                  aria-expanded={isOpen}
                >
                  <div className={cn('h-6 w-6 rounded-lg flex items-center justify-center flex-shrink-0', ep.colorBg)}>
                    <Webhook size={12} className={ep.colorText} />
                  </div>
                  <span className={cn('text-[11px] font-bold flex-shrink-0', ep.colorText)}>{ep.label}</span>
                  <code className="flex-1 text-[10px] font-mono text-muted-foreground truncate min-w-0">
                    {isSupabase
                      ? `→ /rest/v1/${ep.table}`
                      : isPostgres || isMysql
                        ? `INSERT INTO ${ep.table}`
                        : isMongo
                          ? `db.${ep.table}.insertOne()`
                          : isRedis
                            ? `HSET ${ep.table}:*`
                            : ep.table}
                  </code>
                </button>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {isSupabase && supabaseUrl && (
                    <button
                      onClick={() => copy(restUrl, `${ep.key}-url`)}
                      className="flex items-center gap-1 px-2 py-1 rounded-lg bg-muted hover:bg-muted/80 text-muted-foreground text-[10px] font-semibold transition-colors"
                    >
                      {copiedKey === `${ep.key}-url` ? <Check size={10} className="text-primary" /> : <Copy size={10} />}
                      URL
                    </button>
                  )}
                  <button
                    onClick={() => setOpenEp(isOpen ? null : ep.key)}
                    className="flex items-center justify-center w-5 h-5"
                    aria-label={isOpen ? 'Collapse' : 'Expand'}
                  >
                    {isOpen ? <ChevronDown size={13} className="text-muted-foreground" /> : <ChevronRight size={13} className="text-muted-foreground" />}
                  </button>
                </div>
              </div>

              {/* Expanded content */}
              {isOpen && (
                <div className="border-t border-border/40 space-y-4 px-3.5 py-4 animate-in slide-in-from-top-1 duration-150">

                  {/* Connection Method Badge */}
                  <div className="flex items-center gap-2">
                    <div className={cn('h-5 w-5 rounded-md flex items-center justify-center flex-shrink-0', ep.colorBg)}>
                      <Webhook size={10} className={ep.colorText} />
                    </div>
                    <span className="text-[10px] font-semibold text-muted-foreground">
                      {isSupabase  && 'HTTP Request (REST API)'}
                      {isPostgres  && 'Postgres Node → Execute Query'}
                      {isMysql     && 'MySQL Node → Execute Query'}
                      {isMongo     && 'MongoDB Node → Insert Document'}
                      {isRedis     && 'Redis Node → HSET'}
                    </span>
                  </div>

                  {/* Supabase: URL + Headers + Body + cURL */}
                  {isSupabase && (
                    <>
                      {/* URL */}
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Endpoint URL</p>
                        <div className="flex items-center gap-2">
                          <code className="flex-1 text-[10px] bg-muted/60 rounded-lg px-3 py-2 font-mono text-primary truncate">
                            {restUrl || 'Connect your Supabase database first'}
                          </code>
                          {restUrl && (
                            <button onClick={() => copy(restUrl, `${ep.key}-url2`)} className="text-[10px] px-2 py-1.5 rounded-lg bg-muted hover:bg-muted/80 text-muted-foreground flex items-center gap-1 flex-shrink-0">
                              {copiedKey === `${ep.key}-url2` ? <Check size={10} /> : <Copy size={10} />}
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Headers */}
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Headers (n8n → Send Headers → Using Fields Below)</p>
                        <div className="rounded-xl border border-border overflow-hidden divide-y divide-border/40">
                          {[
                            { name: 'apikey',        value: anonKey || 'YOUR_ANON_KEY' },
                            { name: 'Authorization', value: `Bearer ${anonKey || 'YOUR_ANON_KEY'}` },
                            { name: 'Content-Type',  value: 'application/json' },
                            { name: 'Prefer',        value: 'return=representation' },
                          ].map((h, i) => (
                            <div key={i} className="grid grid-cols-2 px-3 py-2 gap-2">
                              <div className="flex items-center gap-1.5">
                                <code className="text-[10px] font-mono text-foreground">{h.name}</code>
                                <button onClick={() => copy(h.name, `h-n-${ep.key}-${i}`)} className="text-muted-foreground hover:text-foreground">
                                  {copiedKey === `h-n-${ep.key}-${i}` ? <Check size={9} className="text-primary" /> : <Copy size={9} />}
                                </button>
                              </div>
                              <div className="flex items-center gap-1.5 min-w-0">
                                <code className="text-[10px] font-mono text-muted-foreground truncate flex-1">
                                  {h.value.length > 28 ? h.value.slice(0, 18) + '...' : h.value}
                                </code>
                                <button onClick={() => copy(h.value, `h-v-${ep.key}-${i}`)} className="text-muted-foreground hover:text-foreground flex-shrink-0">
                                  {copiedKey === `h-v-${ep.key}-${i}` ? <Check size={9} className="text-primary" /> : <Copy size={9} />}
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Body fields */}
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Body Fields (n8n → Body → Using Fields Below)</p>
                        <FieldsGrid fields={ep.fields} epKey={ep.key} copiedKey={copiedKey} onCopy={copy} />
                      </div>

                      {/* cURL */}
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Ready-to-Copy cURL</p>
                        <CodeBlock code={buildCurl(ep)} />
                      </div>
                    </>
                  )}

                  {/* PostgreSQL / MySQL: INSERT query */}
                  {(isPostgres || isMysql) && (
                    <>
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
                          Connection Details
                        </p>
                        <div className="rounded-xl border border-border overflow-hidden divide-y divide-border/40 bg-muted/20">
                          {[
                            { label: 'Node Type',  value: isPostgres ? 'Postgres' : 'MySQL' },
                            { label: 'Operation',  value: 'Execute Query' },
                            { label: 'Host',       value: `${activeConn?.host || 'your-db-host'}:${activeConn?.port || (isPostgres ? '5432' : '3306')}` },
                          ].map((row, i) => (
                            <div key={i} className="flex items-center gap-3 px-3 py-2.5">
                              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide w-20 flex-shrink-0">{row.label}</span>
                              <code className="text-[10px] font-mono text-foreground flex-1 truncate">{row.value}</code>
                              <button onClick={() => copy(row.value, `pg-${ep.key}-${i}`)} className="ml-auto text-muted-foreground hover:text-foreground flex-shrink-0">
                                {copiedKey === `pg-${ep.key}-${i}` ? <Check size={9} className="text-primary" /> : <Copy size={9} />}
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">INSERT Query (paste into n8n Query field)</p>
                        <CodeBlock code={isPostgres ? ep.n8nInsertQuery.pg : ep.n8nInsertQuery.mysql} />
                      </div>
                    </>
                  )}

                  {/* MongoDB: no-schema note + document template */}
                  {isMongo && (
                    <>
                      {/* No schema needed */}
                      <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-emerald-500/8 border border-emerald-500/20">
                        <Check size={12} className="text-emerald-600 mt-0.5 flex-shrink-0" />
                        <p className="text-[11px] text-emerald-700 leading-relaxed">
                          <span className="font-semibold">No table or schema creation needed.</span>{' '}
                          MongoDB creates the <code className="bg-emerald-500/10 px-1 rounded font-mono">{ep.table}</code> collection automatically on first insert.
                        </p>
                      </div>

                      {/* Node config */}
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">n8n Node Config</p>
                        <div className="rounded-xl border border-border overflow-hidden divide-y divide-border/40 bg-muted/20">
                          {[
                            { label: 'Node Type',  value: 'MongoDB' },
                            { label: 'Operation',  value: 'Insert Document' },
                            { label: 'Collection', value: ep.table },
                          ].map((row, i) => (
                            <div key={i} className="flex items-center gap-3 px-3 py-2.5">
                              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide w-24 flex-shrink-0">{row.label}</span>
                              <code className="text-[10px] font-mono text-foreground flex-1 truncate">{row.value}</code>
                              <button onClick={() => copy(row.value, `mongo-${ep.key}-${i}`)} className="ml-auto text-muted-foreground hover:text-foreground flex-shrink-0">
                                {copiedKey === `mongo-${ep.key}-${i}` ? <Check size={9} className="text-primary" /> : <Copy size={9} />}
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Document template */}
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Document Template (paste into n8n Document field)</p>
                        <CodeBlock code={ep.mongoDoc} />
                      </div>
                    </>
                  )}

                  {/* Redis: key pattern + HSET code block */}
                  {isRedis && (
                    <>
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Key Pattern</p>
                        <div className="flex items-center gap-2">
                          <code className="flex-1 text-[10px] bg-muted/60 rounded-lg px-3 py-2 font-mono text-primary truncate">
                            {ep.redisKey}
                          </code>
                          <button onClick={() => copy(ep.redisKey, `redis-key-${ep.key}`)} className="text-[10px] px-2 py-1.5 rounded-lg bg-muted hover:bg-muted/80 text-muted-foreground flex items-center gap-1 flex-shrink-0">
                            {copiedKey === `redis-key-${ep.key}` ? <Check size={10} className="text-primary" /> : <Copy size={10} />}
                          </button>
                        </div>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">HSET Command (n8n Redis Node → HSET operation)</p>
                        <CodeBlock code={[
                          `HSET ${ep.redisKey}`,
                          ...ep.fields.map(f => `  ${f.name.padEnd(20)} "{{ $json.${f.name} }}"`)
                        ].join(' \\\n')} />
                      </div>
                    </>
                  )}

                  {/* Create Table SQL (collapsible) — hidden for MongoDB (no schema needed) */}
                  {!isMongo && (
                    <div className="border-t border-border/30 pt-3">
                      <button
                        onClick={() => setOpenCreate(isCreateOpen ? null : `${ep.key}-create`)}
                        className="flex items-center gap-2 text-[10px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <Database size={11} />
                        Create Table / Schema Setup
                        {isCreateOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                      </button>
                      {isCreateOpen && (
                        <div className="mt-2 animate-in slide-in-from-top-1 duration-150">
                          <p className="text-[10px] text-muted-foreground mb-2">
                            Run this once in your {dbInfo.label} to create the <code className="bg-muted px-1 py-0.5 rounded">{ep.table}</code> table:
                          </p>
                          <CodeBlock code={ep.createSql[dbType]} />
                        </div>
                      )}
                    </div>
                  )}

                </div>
              )}
            </div>
          );
        })}

        {/* Footer tip */}
        {!noConn && (
          <div className="flex items-start gap-2 px-1 pt-1">
            <AlertTriangle size={11} className="text-muted-foreground/60 mt-0.5 flex-shrink-0" />
            <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
              {isSupabase
                ? 'n8n → HTTP Request → Method: POST → Body Content Type: JSON → paste cURL or configure fields'
                : `n8n → ${DB_LABELS[dbType].label} node → Execute Query (or Insert Document) → paste the query/template above`}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

// DB setup section — all 5 database types
const DB_SETUP_META: Record<MainDbType, { title: string; hint: string; lang: string }> = {
  supabase:   { title: 'Supabase: Create All Tables at Once',   hint: 'Open Supabase Dashboard → SQL Editor → paste below → click Run.',         lang: 'sql' },
  postgresql: { title: 'PostgreSQL: Create All Tables at Once', hint: 'Run in your PostgreSQL client (psql, DBeaver, TablePlus, etc.).',           lang: 'sql' },
  mysql:      { title: 'MySQL: Create All Tables at Once',      hint: 'Run in your MySQL client (MySQL Workbench, DBeaver, TablePlus, etc.).',     lang: 'sql' },
  mongodb:    { title: 'MongoDB: Create Collections',           hint: 'Run in MongoDB Shell (mongosh) or paste in Compass → Mongosh tab.',        lang: 'js'  },
  redis:      { title: 'Redis: Key Patterns Reference',         hint: 'No schema needed. Use these key patterns in your n8n Redis node.',         lang: 'bash'},
};

const DbSetupSection = ({ activeConn }: { activeConn: MainDbConnection | null }) => {
  const dbType = normalizeDbType(activeConn?.dbType);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!activeConn) return null;

  const meta = DB_SETUP_META[dbType];
  const setupSql = FULL_SETUP_BY_DB[dbType] ?? FULL_SETUP_SQL;
  const dbInfo = DB_LABELS[dbType];

  const handleCopy = async () => {
    await navigator.clipboard.writeText(setupSql);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
    toast.success('Copied!');
  };

  return (
    <div className="rounded-2xl border border-border bg-gradient-to-br from-muted/30 to-muted/10 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-5 py-4 flex items-center gap-3 hover:bg-muted/30 transition-colors text-left"
        data-testid="button-toggle-db-setup"
      >
        <div className="h-9 w-9 rounded-xl bg-emerald-500/10 flex items-center justify-center flex-shrink-0">
          <Database size={18} className="text-emerald-500" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Create Table / Schema Setup</h3>
          <p className="text-[11px] text-muted-foreground truncate">
            {meta.hint}
          </p>
        </div>
        <span className={cn('text-[10px] font-semibold px-2 py-0.5 rounded-full mr-1 whitespace-nowrap flex items-center gap-1', dbInfo.color, 'bg-muted/50 border border-border/40')}>
          {dbInfo.icon} {dbInfo.label}
        </span>
        {open ? <ChevronDown size={15} className="text-muted-foreground" /> : <ChevronRight size={15} className="text-muted-foreground" />}
      </button>
      {open && (
        <div className="px-5 pb-5 space-y-3 border-t border-border/50 pt-4 animate-in slide-in-from-top-2 duration-200">
          <div className="flex items-start gap-2 p-3 rounded-xl bg-emerald-500/8 border border-emerald-500/20">
            <AlertTriangle size={13} className="text-emerald-600 mt-0.5 flex-shrink-0" />
            <p className="text-[11px] text-muted-foreground leading-relaxed">{meta.hint}</p>
          </div>
          <div className="relative rounded-xl bg-zinc-950 border border-zinc-800 overflow-hidden">
            <pre className="text-[10px] font-mono text-zinc-400 p-4 overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-72">
              {setupSql}
            </pre>
            <button
              onClick={handleCopy}
              className="absolute top-2.5 right-2.5 flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] font-semibold transition-colors"
              data-testid="button-copy-setup-sql"
            >
              {copied ? <><Check size={10} /> Copied!</> : <><ClipboardCopy size={10} /> Copy All</>}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// Advanced section: traditional HTTP webhooks (requires deployed URL)
const AdvancedHttpSection = () => {
  const [open, setOpen] = useState(false);
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
    toast.success('Copied!');
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
      key: 'handoff', label: 'Human Handoff',  color: 'text-primary',     bg: 'bg-primary/10',     url: `${origin}/webhook/handoff`,
      curlBody: `{\n  "recipient": "Customer Name",\n  "reason": "Human help needed",\n  "message": "Last message",\n  "priority": "normal"\n}`,
    },
    {
      key: 'failure', label: 'Log Failure',    color: 'text-destructive', bg: 'bg-destructive/10', url: `${origin}/webhook/failure`,
      curlBody: `{\n  "workflow_name": "WhatsApp Bot Flow",\n  "error_message": "API timeout after 30s",\n  "severity": "error",\n  "source": "n8n"\n}`,
    },
    {
      key: 'order',   label: 'Receive Order',  color: 'text-amber-500',   bg: 'bg-amber-500/10',   url: `${origin}/webhook/order`,
      curlBody: `{\n  "customer_name": "Zakariea",\n  "customer_phone": "01758481876",\n  "product_name": "Cotton Saree",\n  "quantity": 1,\n  "total_price": 3491,\n  "status": "pending"\n}`,
    },
  ];

  const urlIsSet = !!publishedUrl;

  return (
    <div className="rounded-2xl border border-border bg-gradient-to-br from-muted/30 to-muted/10 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-5 py-4 border-b border-border/50 flex items-center gap-3 hover:bg-muted/30 transition-colors text-left"
        data-testid="button-toggle-advanced-webhooks"
      >
        <div className="h-9 w-9 rounded-xl bg-violet-500/10 flex items-center justify-center flex-shrink-0">
          <Globe size={18} className="text-violet-500" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-foreground">Advanced: HTTP Webhooks</h3>
          <p className="text-[11px] text-muted-foreground">
            For users who have deployed this app — traditional webhook URLs
          </p>
        </div>
        <span className="text-[10px] font-semibold text-violet-600 bg-violet-500/10 border border-violet-500/20 px-2 py-0.5 rounded-full mr-1 whitespace-nowrap">
          Needs Deployed URL
        </span>
        {open ? <ChevronDown size={15} className="text-muted-foreground" /> : <ChevronRight size={15} className="text-muted-foreground" />}
      </button>

      {open && (
        <div className="p-5 space-y-4 animate-in slide-in-from-top-2 duration-200">
          {/* Published URL configurator */}
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
                <p className="text-[10px] text-muted-foreground">
                  Enter your deployed app URL. Example: <code className="bg-muted px-1 rounded">https://myapp.replit.app</code>
                </p>
                <div className="flex gap-2">
                  <input
                    value={urlDraft}
                    onChange={e => setUrlDraft(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSaveUrl()}
                    placeholder="https://your-app.replit.app"
                    className="flex-1 px-3 py-2 rounded-xl border border-border/60 bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500/30 placeholder:font-sans placeholder:text-muted-foreground/40"
                    autoFocus
                  />
                  <button
                    onClick={handleSaveUrl}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-[11px] font-bold transition-colors"
                  >
                    <Save size={12} /> Save
                  </button>
                  {urlIsSet && (
                    <button
                      onClick={() => setEditingUrl(false)}
                      className="flex items-center justify-center w-9 h-9 rounded-xl border border-border/60 hover:bg-muted transition-colors text-muted-foreground"
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
          </div>

          {/* Webhook cards */}
          <div className="space-y-2">
            {webhooks.map(wh => {
              const curlCmd = `curl -X POST '${wh.url}' \\\n  -H "Content-Type: application/json" \\\n  -d '${wh.curlBody}'`;
              const isCurlOpen = openCurl === wh.key;
              return (
                <div key={wh.key} className={`rounded-xl border border-border bg-background overflow-hidden ${!urlIsSet ? 'opacity-60' : ''}`}>
                  <div className="flex items-center gap-2.5 px-3.5 py-3">
                    <div className={`h-6 w-6 rounded-lg ${wh.bg} flex items-center justify-center flex-shrink-0`}>
                      <Webhook size={12} className={wh.color} />
                    </div>
                    <span className={`text-[11px] font-bold flex-shrink-0 ${wh.color}`}>{wh.label}</span>
                    <code className="flex-1 text-[10px] font-mono text-muted-foreground truncate min-w-0">{wh.url}</code>
                    <button
                      onClick={() => copy(wh.url, wh.key)}
                      className="flex items-center gap-1 px-2 py-1 rounded-lg bg-muted hover:bg-muted/80 text-muted-foreground text-[10px] font-semibold flex-shrink-0"
                    >
                      {copiedKey === wh.key ? <Check size={10} className="text-primary" /> : <Copy size={10} />} URL
                    </button>
                  </div>
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
                      <div className="px-3.5 pb-3">
                        <CodeBlock code={curlCmd} maxH="max-h-36" />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

// API key section
const API_KEYS_SQL = `CREATE TABLE IF NOT EXISTS public.api_keys (
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
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);`;

function genApiKey(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Main export
const WebhookSettings = () => {
  const queryClient = useQueryClient();
  const [showKey, setShowKey] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [isCreatingKey, setIsCreatingKey] = useState(false);
  const [tableMissing, setTableMissing] = useState(false);
  const hasAttemptedCreate = useRef(false);

  const activeConn = useActiveConnection();
  const baseUrl = activeConn?.url?.replace(/\/$/, '') ?? '';
  const hasDb = !!baseUrl && normalizeDbType(activeConn?.dbType) === 'supabase';

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
        if (msg.includes('does not exist') || msg.includes('relation') || msg.includes('42P01')) return null;
        throw error;
      }
      return (data as any) ?? null;
    },
    retry: false,
    enabled: hasDb,
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
          if (msg.includes('42P01') || msg.includes('does not exist') || msg.includes('relation "public.api_keys"')) {
            setTableMissing(true);
          } else {
            toast.error('Could not create API key');
          }
        } else {
          queryClient.invalidateQueries({ queryKey: ['api-key'] });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('42P01') || msg.includes('does not exist')) setTableMissing(true);
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
      : 'Run setup SQL to create api_keys table first';

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

  return (
    <div className="space-y-4">

      {/* ① Primary: DB-aware endpoints — no domain needed */}
      <SmartWebhookSection activeConn={activeConn} />

      {/* ② DB Tables setup (Supabase: all-in-one SQL) */}
      <DbSetupSection activeConn={activeConn} />

      {/* ③ API Key (Supabase only) */}
      {hasDb && (
        <div className="rounded-2xl border border-border bg-gradient-to-br from-muted/30 to-muted/10 overflow-hidden p-5 space-y-3">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Shield size={18} className="text-primary" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Your API Key</h3>
              <p className="text-[11px] text-muted-foreground">Auto-generated for your Supabase account</p>
            </div>
          </div>

          {tableMissing ? (
            <div className="space-y-3">
              <div className="p-3 rounded-xl bg-amber-500/8 border border-amber-500/20">
                <p className="text-[11px] text-amber-600">
                  The <code className="bg-muted px-1 py-0.5 rounded">api_keys</code> table is missing.
                  Run the SQL setup above first.
                </p>
              </div>
              <div className="relative rounded-xl bg-zinc-950 border border-zinc-800 overflow-hidden">
                <pre className="text-[10px] font-mono text-zinc-400 p-4 overflow-x-auto whitespace-pre-wrap max-h-32">{API_KEYS_SQL}</pre>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="flex-1 flex items-center gap-2 px-3 py-2.5 rounded-xl bg-muted/60 border border-border/40">
                  {isLoadingKey || isCreatingKey ? (
                    <Loader2 size={13} className="text-muted-foreground animate-spin" />
                  ) : (
                    <Shield size={13} className="text-primary flex-shrink-0" />
                  )}
                  <code className="flex-1 text-[11px] font-mono text-foreground truncate">{keyDisplay}</code>
                </div>
                <Button
                  variant="outline" size="icon" className="h-10 w-10 rounded-xl"
                  onClick={() => setShowKey(s => !s)}
                  disabled={!userApiKey}
                >
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </Button>
                <Button
                  variant="outline" size="icon" className="h-10 w-10 rounded-xl"
                  onClick={() => { if (userApiKey) { navigator.clipboard.writeText(userApiKey); setCopiedKey(true); toast.success('API Key copied!'); setTimeout(() => setCopiedKey(false), 2000); } }}
                  disabled={!userApiKey}
                  data-testid="button-copy-api-key"
                >
                  {copiedKey ? <Check size={14} className="text-primary" /> : <Copy size={14} />}
                </Button>
                <Button
                  variant="outline" size="icon" className="h-10 w-10 rounded-xl"
                  onClick={regenerateKey}
                  disabled={!userApiKey || isLoadingKey}
                  title="Regenerate key"
                >
                  <RefreshCw size={14} />
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground ml-1">
                Use this key in the <code className="bg-muted px-1 py-0.5 rounded">x-api-key</code> header when calling your Edge Functions.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ④ Advanced: HTTP Webhooks (requires deployed URL) */}
      <AdvancedHttpSection />
    </div>
  );
};

export default WebhookSettings;
