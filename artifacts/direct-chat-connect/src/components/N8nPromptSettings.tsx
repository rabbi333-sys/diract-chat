import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Bot,
  Eye,
  EyeOff,
  Save,
  Loader2,
  RefreshCw,
  CheckCircle2,
  ChevronDown,
  Info,
  Zap,
  Key,
  Globe,
  Server,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  getN8nSettings,
  saveN8nSettings,
  useN8nWorkflows,
  useN8nWorkflow,
  useUpdateN8nPrompt,
  findAiAgentNodes,
  getSystemMessage,
  type N8nSettings,
  type N8nConnectionMode,
  type N8nNode,
} from '@/hooks/useN8n';

const DEFAULT_SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const DEFAULT_SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';

const emptySettings = (): N8nSettings => ({
  n8nUrl: '',
  n8nApiKey: '',
  supabaseUrl: DEFAULT_SUPABASE_URL,
  supabaseAnonKey: DEFAULT_SUPABASE_ANON_KEY,
  mode: 'proxy',
});

export const N8nPromptSettings = () => {
  const saved = getN8nSettings();
  const [form, setForm] = useState<N8nSettings>(() => ({
    ...emptySettings(),
    ...saved,
  }));
  const [credentialsSaved, setCredentialsSaved] = useState(!!saved?.n8nUrl);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showAnonKey, setShowAnonKey] = useState(false);
  const [loadWorkflows, setLoadWorkflows] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [editedPrompt, setEditedPrompt] = useState('');
  const [promptDirty, setPromptDirty] = useState(false);

  const set = <K extends keyof N8nSettings>(k: K, v: N8nSettings[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  const isProxyMode = form.mode === 'proxy';

  const canSaveCredentials =
    form.n8nUrl.trim() !== '' &&
    form.n8nApiKey.trim() !== '' &&
    (!isProxyMode || (form.supabaseUrl.trim() !== '' && form.supabaseAnonKey.trim() !== ''));

  const handleSaveCredentials = () => {
    const trimmed: N8nSettings = {
      n8nUrl: form.n8nUrl.trim().replace(/\/$/, ''),
      n8nApiKey: form.n8nApiKey.trim(),
      supabaseUrl: form.supabaseUrl.trim().replace(/\/$/, ''),
      supabaseAnonKey: form.supabaseAnonKey.trim(),
      mode: form.mode,
    };
    saveN8nSettings(trimmed);
    setForm(trimmed);
    setCredentialsSaved(true);
    setLoadWorkflows(false);
    setSelectedWorkflowId(null);
    setSelectedNodeId(null);
    setEditedPrompt('');
    setPromptDirty(false);
    toast.success('Credentials saved!');
  };

  const activeSettings: N8nSettings | null = credentialsSaved ? form : null;

  const {
    data: workflows = [],
    isLoading: workflowsLoading,
    isError: workflowsError,
    error: workflowsErr,
    refetch: refetchWorkflows,
  } = useN8nWorkflows(activeSettings, loadWorkflows);

  const {
    data: workflow,
    isLoading: workflowLoading,
    isError: workflowError,
    error: workflowErr,
  } = useN8nWorkflow(activeSettings, selectedWorkflowId);

  const updatePromptMutation = useUpdateN8nPrompt();

  useEffect(() => {
    if (workflowsError && workflowsErr) {
      toast.error(
        `Workflows load failed: ${workflowsErr instanceof Error ? workflowsErr.message : 'Unknown error'}`
      );
    }
  }, [workflowsError, workflowsErr]);

  useEffect(() => {
    if (workflowError && workflowErr) {
      toast.error(
        `Workflow load failed: ${workflowErr instanceof Error ? workflowErr.message : 'Unknown error'}`
      );
    }
  }, [workflowError, workflowErr]);

  const agentNodes: N8nNode[] = workflow ? findAiAgentNodes(workflow.nodes) : [];

  useEffect(() => {
    if (agentNodes.length > 0 && !selectedNodeId && workflow) {
      const first = agentNodes[0];
      setSelectedNodeId(first.id);
      setEditedPrompt(getSystemMessage(first));
      setPromptDirty(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentNodes.length, workflow?.id]);

  const handleNodeSelect = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    if (workflow) {
      const node = workflow.nodes.find((n) => n.id === nodeId);
      if (node) {
        setEditedPrompt(getSystemMessage(node));
        setPromptDirty(false);
      }
    }
  };

  const handleSavePrompt = () => {
    if (!activeSettings || !selectedWorkflowId || !selectedNodeId) return;
    updatePromptMutation.mutate(
      {
        settings: activeSettings,
        workflowId: selectedWorkflowId,
        nodeId: selectedNodeId,
        newPrompt: editedPrompt,
      },
      { onSuccess: () => setPromptDirty(false) }
    );
  };

  const handleLoadWorkflows = () => {
    setSelectedWorkflowId(null);
    setSelectedNodeId(null);
    setEditedPrompt('');
    setPromptDirty(false);
    setLoadWorkflows(true);
    setTimeout(() => refetchWorkflows(), 50);
  };

  const handleModeChange = (mode: N8nConnectionMode) => {
    set('mode', mode);
    setCredentialsSaved(false);
  };

  return (
    <div className="space-y-5">
      {/* ── Connection Mode ── */}
      <div className="space-y-2">
        <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Connection Mode
        </Label>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => handleModeChange('proxy')}
            data-testid="mode-proxy"
            className={cn(
              'flex items-center gap-2 px-3 py-2.5 rounded-xl border text-left transition-all',
              form.mode === 'proxy'
                ? 'border-primary bg-primary/5 shadow-sm'
                : 'border-border hover:border-primary/30 hover:bg-muted/40'
            )}
          >
            <Server
              size={14}
              className={form.mode === 'proxy' ? 'text-primary' : 'text-muted-foreground'}
            />
            <div>
              <p className={cn('text-xs font-semibold', form.mode === 'proxy' ? 'text-primary' : 'text-foreground')}>
                Supabase Proxy
              </p>
              <p className="text-[10px] text-muted-foreground">Via Supabase Edge Function</p>
            </div>
          </button>
          <button
            onClick={() => handleModeChange('direct')}
            data-testid="mode-direct"
            className={cn(
              'flex items-center gap-2 px-3 py-2.5 rounded-xl border text-left transition-all',
              form.mode === 'direct'
                ? 'border-emerald-500 bg-emerald-500/5 shadow-sm'
                : 'border-border hover:border-emerald-500/30 hover:bg-muted/40'
            )}
          >
            <Globe
              size={14}
              className={form.mode === 'direct' ? 'text-emerald-600' : 'text-muted-foreground'}
            />
            <div>
              <p className={cn('text-xs font-semibold', form.mode === 'direct' ? 'text-emerald-600' : 'text-foreground')}>
                Direct API
              </p>
              <p className="text-[10px] text-muted-foreground">n8n CORS required</p>
            </div>
          </button>
        </div>
        {form.mode === 'direct' && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-700 dark:text-amber-400">
            <Info size={12} className="mt-0.5 flex-shrink-0" />
            <span>
              Direct mode requires CORS to be enabled in n8n:{' '}
              <code className="font-mono text-[10px] bg-amber-500/20 px-1 rounded">N8N_CORS_ORIGIN=*</code>
            </span>
          </div>
        )}
      </div>

      {/* ── Step 1: Credentials ── */}
      <div className="space-y-3 bg-muted/30 rounded-xl p-4 border border-border">
        <div className="flex items-center gap-2 mb-1">
          <Key size={13} className="text-muted-foreground" />
          <p className="text-xs font-semibold text-foreground uppercase tracking-wider">
            Step 1 — Credentials
          </p>
          {credentialsSaved && <CheckCircle2 size={13} className="text-emerald-500 ml-auto" />}
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">n8n Instance URL</Label>
          <Input
            placeholder="https://your-n8n.app.n8n.cloud"
            value={form.n8nUrl}
            onChange={(e) => { set('n8nUrl', e.target.value); setCredentialsSaved(false); }}
            data-testid="input-n8n-url"
            className="text-sm font-mono"
          />
          <p className="text-[10px] text-muted-foreground">Your n8n instance base URL</p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">n8n API Key</Label>
          <div className="relative">
            <Input
              type={showApiKey ? 'text' : 'password'}
              placeholder="n8n_api_xxxxxxxx..."
              value={form.n8nApiKey}
              onChange={(e) => { set('n8nApiKey', e.target.value); setCredentialsSaved(false); }}
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
          <p className="text-[10px] text-muted-foreground">n8n → Settings → n8n API → Create API Key</p>
        </div>

        {isProxyMode && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs">
                Supabase Project URL{' '}
                <span className="text-muted-foreground font-normal">(proxy only)</span>
              </Label>
              <Input
                placeholder="https://xxxx.supabase.co"
                value={form.supabaseUrl}
                onChange={(e) => { set('supabaseUrl', e.target.value); setCredentialsSaved(false); }}
                data-testid="input-proxy-supabase-url"
                className="text-sm font-mono"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">
                Supabase Anon Key{' '}
                <span className="text-muted-foreground font-normal">(proxy only)</span>
              </Label>
              <div className="relative">
                <Input
                  type={showAnonKey ? 'text' : 'password'}
                  placeholder="eyJhbGciOiJIUzI1NiIs..."
                  value={form.supabaseAnonKey}
                  onChange={(e) => { set('supabaseAnonKey', e.target.value); setCredentialsSaved(false); }}
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
                Supabase Dashboard → Settings → API → anon public key
              </p>
            </div>
          </>
        )}

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

      {/* ── Step 2: Load Workflows ── */}
      {credentialsSaved && (
        <div className="space-y-3 bg-muted/30 rounded-xl p-4 border border-border">
          <div className="flex items-center gap-2 mb-1">
            <Zap size={13} className="text-muted-foreground" />
            <p className="text-xs font-semibold text-foreground uppercase tracking-wider">
              Step 2 — Select a Workflow
            </p>
          </div>

          <Button
            onClick={handleLoadWorkflows}
            size="sm"
            variant="outline"
            className="w-full"
            disabled={workflowsLoading}
            data-testid="button-load-workflows"
          >
            {workflowsLoading ? (
              <Loader2 size={13} className="animate-spin mr-1.5" />
            ) : (
              <RefreshCw size={13} className="mr-1.5" />
            )}
            {workflowsLoading ? 'Loading workflows...' : 'Load Workflows'}
          </Button>

          {!workflowsLoading && loadWorkflows && workflows.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs">Workflow</Label>
              <div className="relative">
                <select
                  className={cn(
                    'w-full appearance-none h-9 rounded-md border border-input bg-background px-3 pr-8 py-1 text-sm',
                    'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 text-foreground'
                  )}
                  value={selectedWorkflowId || ''}
                  onChange={(e) => {
                    setSelectedWorkflowId(e.target.value || null);
                    setSelectedNodeId(null);
                    setEditedPrompt('');
                    setPromptDirty(false);
                  }}
                  data-testid="select-workflow"
                >
                  <option value="">— Select a Workflow —</option>
                  {workflows.map((wf) => (
                    <option key={wf.id} value={wf.id}>
                      {wf.name} {wf.active ? '✓' : '(Inactive)'}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={14}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
                />
              </div>
            </div>
          )}

          {!workflowsLoading && loadWorkflows && workflows.length === 0 && !workflowsError && (
            <p className="text-xs text-muted-foreground text-center py-2">
              No workflows found
            </p>
          )}
        </div>
      )}

      {/* ── Step 3: Prompt Editor ── */}
      {selectedWorkflowId && (
        <div className="space-y-3 bg-muted/30 rounded-xl p-4 border border-border">
          <div className="flex items-center gap-2 mb-1">
            <Bot size={13} className="text-muted-foreground" />
            <p className="text-xs font-semibold text-foreground uppercase tracking-wider">
              Step 3 — Edit System Message
            </p>
          </div>

          {workflowLoading && (
            <div className="flex items-center gap-2 py-4 justify-center">
              <Loader2 size={16} className="animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Workflow loading...</span>
            </div>
          )}

          {workflow && agentNodes.length === 0 && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-400">
              <Info size={13} className="mt-0.5 flex-shrink-0" />
              <span>
                No AI Agent node found in this workflow.
                <br />
                <span className="text-[10px] text-muted-foreground mt-1 block">
                  (requires @n8n/n8n-nodes-langchain.agent node)
                </span>
              </span>
            </div>
          )}

          {workflow && agentNodes.length > 1 && (
            <div className="space-y-1.5">
              <Label className="text-xs">AI Agent Node</Label>
              <div className="relative">
                <select
                  className={cn(
                    'w-full appearance-none h-9 rounded-md border border-input bg-background px-3 pr-8 py-1 text-sm',
                    'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 text-foreground'
                  )}
                  value={selectedNodeId || ''}
                  onChange={(e) => handleNodeSelect(e.target.value)}
                  data-testid="select-agent-node"
                >
                  {agentNodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.name} ({node.type.split('.').pop()})
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={14}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
                />
              </div>
            </div>
          )}

          {workflow && agentNodes.length === 1 && (
            <div className="flex items-center gap-2 px-3 py-2 bg-violet-500/10 border border-violet-500/20 rounded-lg">
              <Bot size={13} className="text-violet-500 flex-shrink-0" />
              <div>
                <p className="text-xs font-medium text-foreground">{agentNodes[0].name}</p>
                <p className="text-[10px] text-muted-foreground">{agentNodes[0].type.split('.').pop()}</p>
              </div>
            </div>
          )}

          {workflow && agentNodes.length > 0 && selectedNodeId && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs">System Message</Label>
                {promptDirty && (
                  <span className="text-[10px] text-amber-500 font-medium">● Unsaved changes</span>
                )}
              </div>
              <textarea
                value={editedPrompt}
                onChange={(e) => {
                  setEditedPrompt(e.target.value);
                  setPromptDirty(true);
                }}
                data-testid="textarea-system-message"
                rows={10}
                className={cn(
                  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm',
                  'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                  'resize-y font-mono leading-relaxed text-foreground',
                  'min-h-[200px] placeholder:text-muted-foreground'
                )}
                placeholder="System message will appear here..."
              />
              <p className="text-[10px] text-muted-foreground">
                Changes apply to new conversations after saving.
              </p>

              <Button
                onClick={handleSavePrompt}
                disabled={!promptDirty || updatePromptMutation.isPending}
                size="sm"
                className="w-full"
                data-testid="button-save-prompt"
              >
                {updatePromptMutation.isPending ? (
                  <Loader2 size={13} className="animate-spin mr-1.5" />
                ) : (
                  <Save size={13} className="mr-1.5" />
                )}
                {updatePromptMutation.isPending ? 'Saving...' : 'Save Prompt'}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ── Supabase Table Setup Guide ── */}
      <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-3.5 space-y-3">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-violet-600 dark:text-violet-400 uppercase tracking-wider">
          <Zap size={11} /> Supabase Table Setup (one-time)
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Prompts are saved to a <code className="font-mono text-[10px] bg-muted px-1 rounded">n8n_bot_settings</code> table in your Supabase database.
          Run this SQL once in your Supabase <strong>SQL Editor</strong>:
        </p>
        <pre className="text-[10px] bg-muted/60 border border-border rounded-lg p-3 overflow-x-auto text-foreground font-mono leading-relaxed whitespace-pre-wrap break-all">{`CREATE TABLE IF NOT EXISTS n8n_bot_settings (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT,
  node_id     TEXT,
  system_prompt TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);`}</pre>
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold text-foreground">How n8n reads the prompt:</p>
          <ol className="text-[11px] text-muted-foreground space-y-1 list-decimal list-inside">
            <li>In your n8n workflow, add an <strong>HTTP Request</strong> node at the start</li>
            <li>Method: <code className="font-mono text-[10px] bg-muted px-1 rounded">GET</code></li>
            <li>URL: <code className="font-mono text-[10px] bg-muted px-1 rounded">{'YOUR_SUPABASE_URL/rest/v1/n8n_bot_settings?select=system_prompt&limit=1'}</code></li>
            <li>Add header: <code className="font-mono text-[10px] bg-muted px-1 rounded">apikey: YOUR_SUPABASE_ANON_KEY</code></li>
            <li>Use <code className="font-mono text-[10px] bg-muted px-1 rounded">{'{{$json[0].system_prompt}}'}</code> as the AI Agent's System Message</li>
          </ol>
        </div>
      </div>

      {/* Info box */}
      <div className="rounded-xl border border-border bg-muted/20 p-3.5">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          <Info size={11} /> How to use
        </div>
        <div className="space-y-1 text-[11px] text-muted-foreground">
          <p><strong>Supabase Proxy:</strong> Deploy the Edge Function and provide n8n URL + API key + Supabase key</p>
          <p><strong>Direct API:</strong> Set{' '}
            <code className="font-mono text-[10px] bg-muted px-1 rounded">N8N_CORS_ORIGIN=*</code>{' '}
            in your n8n instance environment
          </p>
          <p><strong>n8n API Key:</strong> n8n → Settings → n8n API → Generate Key</p>
        </div>
        <p className="text-[10px] text-muted-foreground/60 mt-2 border-t border-border pt-2">
          Credentials are stored locally in localStorage. In proxy mode, n8n credentials are forwarded to the Supabase Edge Function; in direct mode, they go only to your n8n instance.
        </p>
      </div>
    </div>
  );
};
