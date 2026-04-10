import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Bot,
  Eye,
  EyeOff,
  Save,
  Loader2,
  CheckCircle2,
  Info,
  Zap,
  Key,
  Copy,
  Check,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  getN8nSettings,
  saveN8nSettings,
  useSavePromptDirect,
  useLoadPromptDirect,
  type N8nSettings,
} from '@/hooks/useN8n';

const DEFAULT_SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const DEFAULT_SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';

const SQL_CREATE_TABLE = `CREATE TABLE IF NOT EXISTS n8n_bot_settings (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT,
  node_id       TEXT,
  system_prompt TEXT,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);`;

const N8N_EXPRESSION = `{{ $('Fetch Prompt').first().json[0].system_prompt }}`;

const emptySettings = (): N8nSettings => ({
  n8nUrl: '',
  n8nApiKey: '',
  supabaseUrl: DEFAULT_SUPABASE_URL,
  supabaseAnonKey: DEFAULT_SUPABASE_ANON_KEY,
  mode: 'proxy',
});

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Copy failed — please select and copy manually.');
    }
  }, [value]);
  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1 px-2 py-1 text-[10px] rounded bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
      title={`Copy ${label || 'value'}`}
    >
      {copied ? (
        <Check size={10} className="text-emerald-500" />
      ) : (
        <Copy size={10} />
      )}
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

function GuideStep({ num, title, children }: { num: number; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold text-foreground flex items-center gap-1.5">
        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-violet-500/20 text-violet-600 dark:text-violet-400 text-[9px] font-bold flex-shrink-0">
          {num}
        </span>
        {title}
      </p>
      {children}
    </div>
  );
}

export const N8nPromptSettings = () => {
  const saved = getN8nSettings();

  const [form, setForm] = useState<N8nSettings>(() => ({
    ...emptySettings(),
    ...saved,
  }));
  const [credentialsSaved, setCredentialsSaved] = useState(
    !!(saved?.supabaseUrl && saved?.supabaseAnonKey)
  );
  const [showApiKey, setShowApiKey] = useState(false);
  const [showAnonKey, setShowAnonKey] = useState(false);
  const [editedPrompt, setEditedPrompt] = useState('');
  const [promptLoaded, setPromptLoaded] = useState(false);

  const set = <K extends keyof N8nSettings>(k: K, v: N8nSettings[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  const canSaveCredentials =
    form.supabaseUrl.trim() !== '' && form.supabaseAnonKey.trim() !== '';

  const handleSaveCredentials = () => {
    const trimmed: N8nSettings = {
      n8nUrl: form.n8nUrl.trim().replace(/\/$/, ''),
      n8nApiKey: form.n8nApiKey.trim(),
      supabaseUrl: form.supabaseUrl.trim().replace(/\/$/, ''),
      supabaseAnonKey: form.supabaseAnonKey.trim(),
      mode: 'proxy',
    };
    saveN8nSettings(trimmed);
    setForm(trimmed);
    setCredentialsSaved(true);
    toast.success('Credentials saved!');
  };

  const { data: savedPrompt } = useLoadPromptDirect(form.supabaseUrl, form.supabaseAnonKey);
  useEffect(() => {
    if (savedPrompt !== undefined && !promptLoaded) {
      setEditedPrompt(savedPrompt);
      setPromptLoaded(true);
    }
  }, [savedPrompt, promptLoaded]);

  const savePromptMutation = useSavePromptDirect();

  const handleSavePrompt = () => {
    if (!form.supabaseUrl || !form.supabaseAnonKey) {
      toast.error('Enter your Supabase URL and Anon Key first.');
      return;
    }
    savePromptMutation.mutate({
      prompt: editedPrompt,
      supabaseUrl: form.supabaseUrl,
      supabaseAnonKey: form.supabaseAnonKey,
    });
  };

  const fetchUrl = form.supabaseUrl
    ? `${form.supabaseUrl}/rest/v1/n8n_bot_settings?select=system_prompt&limit=1`
    : 'https://YOUR_PROJECT.supabase.co/rest/v1/n8n_bot_settings?select=system_prompt&limit=1';

  const anonKey = form.supabaseAnonKey || 'YOUR_SUPABASE_ANON_KEY';

  return (
    <div className="space-y-5">

      {/* ── Credentials ── */}
      <div className="space-y-3 bg-muted/30 rounded-xl p-4 border border-border">
        <div className="flex items-center gap-2 mb-1">
          <Key size={13} className="text-muted-foreground" />
          <p className="text-xs font-semibold text-foreground uppercase tracking-wider">
            Credentials
          </p>
          {credentialsSaved && (
            <CheckCircle2 size={13} className="text-emerald-500 ml-auto" />
          )}
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Supabase Project URL</Label>
          <Input
            placeholder="https://xxxx.supabase.co"
            value={form.supabaseUrl}
            onChange={(e) => {
              set('supabaseUrl', e.target.value);
              setCredentialsSaved(false);
              setPromptLoaded(false);
            }}
            data-testid="input-proxy-supabase-url"
            className="text-sm font-mono"
          />
          <p className="text-[10px] text-muted-foreground">
            Supabase Dashboard → Settings → API → Project URL
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Supabase Anon Key</Label>
          <div className="relative">
            <Input
              type={showAnonKey ? 'text' : 'password'}
              placeholder="eyJhbGciOiJIUzI1NiIs..."
              value={form.supabaseAnonKey}
              onChange={(e) => {
                set('supabaseAnonKey', e.target.value);
                setCredentialsSaved(false);
                setPromptLoaded(false);
              }}
              className="pr-9 text-sm font-mono"
              data-testid="input-proxy-anon-key"
            />
            <button
              type="button"
              onClick={() => setShowAnonKey(!showAnonKey)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showAnonKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Supabase Dashboard → Settings → API → anon public
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">
            n8n Instance URL{' '}
            <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <Input
            placeholder="https://your-n8n.app.n8n.cloud"
            value={form.n8nUrl}
            onChange={(e) => {
              set('n8nUrl', e.target.value);
              setCredentialsSaved(false);
            }}
            data-testid="input-n8n-url"
            className="text-sm font-mono"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">
            n8n API Key{' '}
            <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <div className="relative">
            <Input
              type={showApiKey ? 'text' : 'password'}
              placeholder="n8n_api_xxxxxxxx..."
              value={form.n8nApiKey}
              onChange={(e) => {
                set('n8nApiKey', e.target.value);
                setCredentialsSaved(false);
              }}
              className="pr-9 text-sm font-mono"
              data-testid="input-n8n-api-key"
            />
            <button
              type="button"
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>

        <Button
          onClick={handleSaveCredentials}
          disabled={!canSaveCredentials}
          size="sm"
          className="w-full"
          data-testid="button-save-n8n-credentials"
        >
          <Save size={13} className="mr-1.5" />
          Save Credentials
        </Button>
      </div>

      {/* ── Prompt Editor ── */}
      <div className="space-y-3 bg-muted/30 rounded-xl p-4 border border-border">
        <div className="flex items-center gap-2 mb-1">
          <Bot size={13} className="text-muted-foreground" />
          <p className="text-xs font-semibold text-foreground uppercase tracking-wider">
            System Prompt
          </p>
        </div>

        <textarea
          value={editedPrompt}
          onChange={(e) => setEditedPrompt(e.target.value)}
          data-testid="textarea-system-message"
          rows={10}
          className={cn(
            'w-full rounded-md border border-input bg-background px-3 py-2 text-sm',
            'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
            'resize-y font-mono leading-relaxed text-foreground',
            'min-h-[200px] placeholder:text-muted-foreground'
          )}
          placeholder={
            'You are a helpful sales agent for [Company].\n\nYour job is to...\n\nWrite your full system prompt here. Your n8n bot will read it from Supabase at the start of every chat.'
          }
        />

        <p className="text-[10px] text-muted-foreground">
          Saved to{' '}
          <code className="font-mono bg-muted px-1 rounded">n8n_bot_settings</code> table
          in your Supabase database. n8n fetches it at runtime — no redeployment needed.
        </p>

        <Button
          onClick={handleSavePrompt}
          disabled={savePromptMutation.isPending || !form.supabaseUrl || !form.supabaseAnonKey}
          size="sm"
          className="w-full"
          data-testid="button-save-prompt"
        >
          {savePromptMutation.isPending ? (
            <Loader2 size={13} className="animate-spin mr-1.5" />
          ) : (
            <Save size={13} className="mr-1.5" />
          )}
          {savePromptMutation.isPending ? 'Saving...' : 'Save Prompt'}
        </Button>
      </div>

      {/* ── n8n Setup Guide ── */}
      <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-4 space-y-5">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-violet-600 dark:text-violet-400 uppercase tracking-wider">
          <Zap size={11} /> Connect to n8n (one-time setup)
        </div>

        {/* Step 1 — Create Table */}
        <GuideStep num={1} title="Create the Supabase table">
          <p className="text-[11px] text-muted-foreground">
            In your Supabase project → <strong>SQL Editor</strong>, run:
          </p>
          <div className="relative">
            <pre className="text-[10px] bg-muted/60 border border-border rounded-lg p-3 overflow-x-auto text-foreground font-mono leading-relaxed pr-16">
              {SQL_CREATE_TABLE}
            </pre>
            <div className="absolute top-2 right-2">
              <CopyButton value={SQL_CREATE_TABLE} label="SQL" />
            </div>
          </div>
        </GuideStep>

        {/* Step 2 — HTTP Request Node */}
        <GuideStep num={2} title='Add "Fetch Prompt" HTTP Request node in n8n'>
          <p className="text-[11px] text-muted-foreground">
            In your n8n workflow, add an <strong>HTTP Request</strong> node named{' '}
            <code className="font-mono text-[10px] bg-muted px-1 rounded">Fetch Prompt</code>.
            Place it between the <em>Chat Trigger</em> and <em>AI Agent</em> nodes. Configure it:
          </p>
          <div className="space-y-2.5 text-[11px]">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground w-20 flex-shrink-0">Method</span>
              <code className="font-mono text-[10px] bg-muted px-2 py-0.5 rounded text-foreground">
                GET
              </code>
            </div>

            <div className="flex items-start gap-2">
              <span className="text-muted-foreground w-20 flex-shrink-0 pt-1">URL</span>
              <div className="flex items-start gap-2 flex-1 min-w-0">
                <code className="font-mono text-[10px] bg-muted px-2 py-1 rounded text-foreground break-all flex-1">
                  {fetchUrl}
                </code>
                <CopyButton value={fetchUrl} label="URL" />
              </div>
            </div>

            <div className="flex items-start gap-2">
              <span className="text-muted-foreground w-20 flex-shrink-0 pt-1">
                Header 1
              </span>
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <code className="font-mono text-[10px] bg-muted px-2 py-1 rounded text-foreground break-all flex-1">
                  {`apikey: ${anonKey}`}
                </code>
                <CopyButton value={`apikey: ${anonKey}`} label="apikey header" />
              </div>
            </div>

            <div className="flex items-start gap-2">
              <span className="text-muted-foreground w-20 flex-shrink-0 pt-1">
                Header 2
              </span>
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <code className="font-mono text-[10px] bg-muted px-2 py-1 rounded text-foreground break-all flex-1">
                  {`Authorization: Bearer ${anonKey}`}
                </code>
                <CopyButton value={`Authorization: Bearer ${anonKey}`} label="auth header" />
              </div>
            </div>
          </div>
        </GuideStep>

        {/* Step 3 — System Message Expression */}
        <GuideStep num={3} title="Set the AI Agent System Message">
          <p className="text-[11px] text-muted-foreground">
            Open the <strong>AI Agent</strong> node → <strong>Options</strong> →{' '}
            <strong>Add Option</strong> → <strong>System Message</strong>. Paste this expression:
          </p>
          <div className="flex items-center gap-2">
            <code className="font-mono text-[10px] bg-muted px-2 py-1.5 rounded text-foreground flex-1 break-all">
              {N8N_EXPRESSION}
            </code>
            <CopyButton value={N8N_EXPRESSION} label="expression" />
          </div>
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-[11px] text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 size={12} className="mt-0.5 flex-shrink-0" />
            <span>
              Done! After this setup, every "Save Prompt" in the dashboard instantly updates
              what your n8n bot says — no workflow edits or redeployments needed.
            </span>
          </div>
        </GuideStep>
      </div>

      {/* Info box */}
      <div className="rounded-xl border border-border bg-muted/20 p-3.5">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          <Info size={11} /> How it works
        </div>
        <div className="space-y-1 text-[11px] text-muted-foreground">
          <p>
            Your prompt is stored in{' '}
            <code className="font-mono text-[10px] bg-muted px-1 rounded">n8n_bot_settings</code>{' '}
            in Supabase. The <em>Fetch Prompt</em> HTTP Request node reads it at the start of
            every chat — so changes apply immediately to all new conversations.
          </p>
          <p>
            This approach is 100% reliable: no n8n workflow API calls, no schema errors.
          </p>
        </div>
      </div>
    </div>
  );
};
