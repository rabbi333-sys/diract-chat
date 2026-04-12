import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Bot,
  Save,
  Loader2,
  CheckCircle2,
  Info,
  Zap,
  Copy,
  Check,
  Plus,
  Trash2,
  Pencil,
  Rocket,
  FileText,
  ChevronDown,
  ChevronRight,
  X,
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
import { getActiveConnection, onDbChange } from '@/lib/db-config';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SavedPrompt {
  id: string;
  name: string;
  content: string;
  updatedAt: string;
}

// ─── Local storage helpers ────────────────────────────────────────────────────

const PROMPTS_KEY = 'n8n_saved_prompts';
const DEPLOYED_KEY = 'n8n_deployed_prompt_id';

function loadLocalPrompts(): SavedPrompt[] {
  try {
    const raw = localStorage.getItem(PROMPTS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SavedPrompt[];
  } catch {
    return [];
  }
}

function persistLocalPrompts(prompts: SavedPrompt[]) {
  localStorage.setItem(PROMPTS_KEY, JSON.stringify(prompts));
}

function getDeployedId(): string {
  return localStorage.getItem(DEPLOYED_KEY) ?? '';
}

function setDeployedId(id: string) {
  localStorage.setItem(DEPLOYED_KEY, id);
}

function newPromptId() {
  return `prompt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Constants ────────────────────────────────────────────────────────────────

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

// ─── Small helpers ────────────────────────────────────────────────────────────

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Copy failed — please copy manually.');
    }
  }, [value]);
  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1 px-2 py-1 text-[10px] rounded bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
      title={`Copy ${label || 'value'}`}
    >
      {copied ? <Check size={10} className="text-emerald-500" /> : <Copy size={10} />}
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

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ─── Main component ───────────────────────────────────────────────────────────

export const N8nPromptSettings = () => {
  const saved = getN8nSettings();

  const [form, setForm] = useState<N8nSettings>(() => ({
    ...emptySettings(),
    ...saved,
  }));

  // ── Local prompt list ──────────────────────────────────────────────────────
  const [prompts, setPrompts] = useState<SavedPrompt[]>(() => {
    const local = loadLocalPrompts();
    return local;
  });
  const [selectedId, setSelectedId] = useState<string>(() => {
    const local = loadLocalPrompts();
    return local[0]?.id ?? '';
  });
  const [deployedId, setDeployedId_] = useState<string>(getDeployedId);

  // ── Editor state ───────────────────────────────────────────────────────────
  const [editName, setEditName] = useState('');
  const [editContent, setEditContent] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // ── Auto-sync Supabase creds ───────────────────────────────────────────────
  useEffect(() => {
    const sync = () => {
      const conn = getActiveConnection();
      if (conn && (!conn.dbType || conn.dbType === 'supabase') && conn.url && conn.anonKey) {
        setForm((prev) => {
          const updated: N8nSettings = { ...prev, supabaseUrl: conn.url, supabaseAnonKey: conn.anonKey };
          saveN8nSettings(updated);
          return updated;
        });
      }
    };
    sync();
    return onDbChange(sync);
  }, []);

  // ── Load deployed prompt from Supabase on first load ──────────────────────
  const { data: supabasePrompt } = useLoadPromptDirect(form.supabaseUrl, form.supabaseAnonKey);
  const supabaseSynced = useRef(false);
  useEffect(() => {
    if (supabasePrompt && !supabaseSynced.current && prompts.length === 0) {
      // Seed from Supabase if no local prompts exist
      const seeded: SavedPrompt = {
        id: newPromptId(),
        name: 'Default Prompt',
        content: supabasePrompt,
        updatedAt: new Date().toISOString(),
      };
      const list = [seeded];
      persistLocalPrompts(list);
      setPrompts(list);
      setSelectedId(seeded.id);
      supabaseSynced.current = true;
    } else if (!supabaseSynced.current) {
      supabaseSynced.current = true;
    }
  }, [supabasePrompt, prompts.length]);

  // ── Keep editor in sync with selected prompt ───────────────────────────────
  useEffect(() => {
    const p = prompts.find((x) => x.id === selectedId);
    if (p) {
      setEditName(p.name);
      setEditContent(p.content);
      setIsDirty(false);
    } else {
      setEditName('');
      setEditContent('');
      setIsDirty(false);
    }
  }, [selectedId, prompts]);

  // ── Mutations ──────────────────────────────────────────────────────────────
  const savePromptMutation = useSavePromptDirect();

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleNew = () => {
    const id = newPromptId();
    const p: SavedPrompt = {
      id,
      name: 'New Prompt',
      content: '',
      updatedAt: new Date().toISOString(),
    };
    const next = [p, ...prompts];
    persistLocalPrompts(next);
    setPrompts(next);
    setSelectedId(id);
    setIsDirty(false);
    setTimeout(() => nameInputRef.current?.focus(), 50);
  };

  const handleSaveLocally = () => {
    if (!selectedId) return;
    const next = prompts.map((p) =>
      p.id === selectedId
        ? { ...p, name: editName.trim() || 'Untitled', content: editContent, updatedAt: new Date().toISOString() }
        : p
    );
    persistLocalPrompts(next);
    setPrompts(next);
    setIsDirty(false);
    toast.success('Prompt saved locally.');
  };

  const handleDeploy = () => {
    if (!form.supabaseUrl || !form.supabaseAnonKey) {
      toast.error('Connect Supabase in Settings → Database first.');
      return;
    }
    const content = editContent;
    savePromptMutation.mutate(
      { prompt: content, supabaseUrl: form.supabaseUrl, supabaseAnonKey: form.supabaseAnonKey },
      {
        onSuccess: () => {
          setDeployedId_(selectedId);
          setDeployedId(selectedId);
          // also save locally
          const next = prompts.map((p) =>
            p.id === selectedId
              ? { ...p, name: editName.trim() || 'Untitled', content, updatedAt: new Date().toISOString() }
              : p
          );
          persistLocalPrompts(next);
          setPrompts(next);
          setIsDirty(false);
        },
      }
    );
  };

  const handleDelete = (id: string) => {
    const next = prompts.filter((p) => p.id !== id);
    persistLocalPrompts(next);
    setPrompts(next);
    if (selectedId === id) {
      setSelectedId(next[0]?.id ?? '');
    }
    if (deployedId === id) {
      setDeployedId_('');
      setDeployedId('');
    }
    setDeleteConfirmId(null);
  };

  const handleRenameCommit = (id: string) => {
    const next = prompts.map((p) =>
      p.id === id ? { ...p, name: renameVal.trim() || 'Untitled', updatedAt: new Date().toISOString() } : p
    );
    persistLocalPrompts(next);
    setPrompts(next);
    if (id === selectedId) setEditName(renameVal.trim() || 'Untitled');
    setRenamingId(null);
    setRenameVal('');
  };

  const selectedPrompt = prompts.find((p) => p.id === selectedId);
  const fetchUrl = form.supabaseUrl
    ? `${form.supabaseUrl}/rest/v1/n8n_bot_settings?select=system_prompt&limit=1`
    : 'https://YOUR_PROJECT.supabase.co/rest/v1/n8n_bot_settings?select=system_prompt&limit=1';
  const anonKey = form.supabaseAnonKey || 'YOUR_SUPABASE_ANON_KEY';

  return (
    <div className="space-y-5">

      {/* ── Main Editor Layout ─────────────────────────────────────────────── */}
      <div className="flex gap-3 min-h-[520px]">

        {/* ── Left: Prompt List ──────────────────────────────────────────── */}
        <div className="w-[220px] flex-shrink-0 flex flex-col gap-2">
          <Button
            size="sm"
            onClick={handleNew}
            className="w-full gap-1.5 text-xs h-8 bg-violet-600 hover:bg-violet-700 text-white shadow-sm"
          >
            <Plus size={13} /> New Prompt
          </Button>

          <div className="flex-1 space-y-1.5 overflow-y-auto max-h-[480px] pr-0.5">
            {prompts.length === 0 && (
              <div className="text-center text-[11px] text-muted-foreground pt-8 space-y-1">
                <FileText size={28} className="mx-auto text-muted-foreground/40" />
                <p>No prompts yet.</p>
                <p className="text-[10px]">Click "New Prompt" to start.</p>
              </div>
            )}
            {prompts.map((p) => {
              const isSelected = p.id === selectedId;
              const isDeployed = p.id === deployedId;
              return (
                <div
                  key={p.id}
                  onClick={() => {
                    if (renamingId === p.id) return;
                    setSelectedId(p.id);
                    setDeleteConfirmId(null);
                  }}
                  className={cn(
                    'group relative rounded-xl px-3 py-2.5 cursor-pointer transition-all border',
                    isSelected
                      ? 'bg-violet-500/10 border-violet-500/40 shadow-sm'
                      : 'bg-muted/30 border-border hover:border-violet-400/30 hover:bg-muted/60'
                  )}
                >
                  {/* Name row */}
                  {renamingId === p.id ? (
                    <Input
                      autoFocus
                      value={renameVal}
                      onChange={(e) => setRenameVal(e.target.value)}
                      onBlur={() => handleRenameCommit(p.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRenameCommit(p.id);
                        if (e.key === 'Escape') { setRenamingId(null); setRenameVal(''); }
                        e.stopPropagation();
                      }}
                      className="h-6 text-xs px-1.5 py-0"
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <div className="flex items-center gap-1 min-w-0">
                      <p className={cn('text-[12px] font-medium truncate flex-1', isSelected ? 'text-violet-700 dark:text-violet-300' : 'text-foreground')}>
                        {p.name}
                      </p>
                      {isDeployed && (
                        <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-emerald-500" title="Deployed to n8n" />
                      )}
                    </div>
                  )}

                  {/* Preview */}
                  {renamingId !== p.id && (
                    <p className="text-[10px] text-muted-foreground truncate mt-0.5 leading-tight">
                      {p.content.slice(0, 60) || <span className="italic">Empty</span>}
                    </p>
                  )}

                  {/* Time + actions */}
                  <div className="flex items-center justify-between mt-1.5">
                    <span className="text-[9px] text-muted-foreground/60">{timeAgo(p.updatedAt)}</span>
                    {isSelected && renamingId !== p.id && (
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => { e.stopPropagation(); setRenamingId(p.id); setRenameVal(p.name); }}
                          className="p-1 rounded hover:bg-violet-500/20 text-muted-foreground hover:text-violet-600 transition-colors"
                          title="Rename"
                        >
                          <Pencil size={10} />
                        </button>
                        {deleteConfirmId === p.id ? (
                          <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => handleDelete(p.id)}
                              className="p-1 rounded bg-red-500/20 text-red-500 hover:bg-red-500/30 text-[9px] font-medium"
                            >
                              <Check size={10} />
                            </button>
                            <button
                              onClick={() => setDeleteConfirmId(null)}
                              className="p-1 rounded hover:bg-muted text-muted-foreground"
                            >
                              <X size={10} />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(p.id); }}
                            className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-500 transition-colors"
                            title="Delete"
                          >
                            <Trash2 size={10} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {isDeployed && (
                    <div className="mt-1.5 flex items-center gap-1 text-[9px] text-emerald-600 dark:text-emerald-400 font-medium">
                      <Rocket size={9} /> Live on n8n
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Right: Editor ─────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col gap-3 min-w-0">
          {selectedPrompt ? (
            <>
              {/* Name field */}
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Input
                    ref={nameInputRef}
                    value={editName}
                    onChange={(e) => { setEditName(e.target.value); setIsDirty(true); }}
                    placeholder="Prompt name..."
                    className="h-9 text-sm font-semibold pl-3 pr-3 border-border focus:border-violet-500/60"
                  />
                </div>
                {selectedPrompt.id === deployedId && (
                  <span className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold whitespace-nowrap bg-emerald-500/10 border border-emerald-500/20 px-2 py-1 rounded-full">
                    <Rocket size={10} /> Live
                  </span>
                )}
              </div>

              {/* Textarea */}
              <textarea
                value={editContent}
                onChange={(e) => { setEditContent(e.target.value); setIsDirty(true); }}
                data-testid="textarea-system-message"
                rows={14}
                className={cn(
                  'flex-1 w-full rounded-xl border border-input bg-background px-4 py-3 text-sm',
                  'focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500/50',
                  'resize-none font-mono leading-relaxed text-foreground',
                  'placeholder:text-muted-foreground/50 transition-colors'
                )}
                placeholder={'You are a helpful sales agent for [Company].\n\nYour job is to...\n\nWrite your full system prompt here.'}
              />

              {/* Action bar */}
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSaveLocally}
                  disabled={!isDirty}
                  className="gap-1.5 text-xs h-8"
                >
                  <Save size={12} />
                  Save
                </Button>

                <div className="flex-1" />

                <p className="text-[10px] text-muted-foreground hidden sm:block">
                  Saves to <code className="font-mono bg-muted px-1 rounded">n8n_bot_settings</code> in Supabase
                </p>

                <Button
                  size="sm"
                  onClick={handleDeploy}
                  disabled={savePromptMutation.isPending || !form.supabaseUrl || !form.supabaseAnonKey}
                  className="gap-1.5 text-xs h-8 bg-violet-600 hover:bg-violet-700 text-white shadow-sm"
                  data-testid="button-save-prompt"
                >
                  {savePromptMutation.isPending ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Rocket size={12} />
                  )}
                  {savePromptMutation.isPending ? 'Deploying...' : 'Deploy to n8n'}
                </Button>
              </div>

              {!form.supabaseUrl && (
                <p className="text-[10px] text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                  Connect Supabase in <strong>Settings → Database</strong> to enable deployment.
                </p>
              )}
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground gap-3 rounded-xl border border-dashed border-border bg-muted/10">
              <Bot size={36} className="text-muted-foreground/30" />
              <div className="space-y-1">
                <p className="text-sm font-medium">No prompt selected</p>
                <p className="text-[11px]">Create a new prompt or select one from the list.</p>
              </div>
              <Button size="sm" onClick={handleNew} className="gap-1.5 bg-violet-600 hover:bg-violet-700 text-white">
                <Plus size={13} /> New Prompt
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* ── n8n Setup Guide (collapsible) ──────────────────────────────────── */}
      <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 overflow-hidden">
        <button
          onClick={() => setGuideOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-violet-500/5 transition-colors"
        >
          <Zap size={12} className="text-violet-500 flex-shrink-0" />
          <span className="text-[11px] font-semibold text-violet-600 dark:text-violet-400 uppercase tracking-wider flex-1">
            Connect to n8n (one-time setup)
          </span>
          {guideOpen ? <ChevronDown size={13} className="text-violet-500" /> : <ChevronRight size={13} className="text-violet-500" />}
        </button>

        {guideOpen && (
          <div className="px-4 pb-4 space-y-5 border-t border-violet-500/20">
            <div className="pt-3" />

            <GuideStep num={1} title="Create the Supabase table">
              <p className="text-[11px] text-muted-foreground">In your Supabase project → <strong>SQL Editor</strong>, run:</p>
              <div className="relative">
                <pre className="text-[10px] bg-muted/60 border border-border rounded-lg p-3 overflow-x-auto text-foreground font-mono leading-relaxed pr-16">
                  {SQL_CREATE_TABLE}
                </pre>
                <div className="absolute top-2 right-2">
                  <CopyButton value={SQL_CREATE_TABLE} label="SQL" />
                </div>
              </div>
            </GuideStep>

            <GuideStep num={2} title='Add "Fetch Prompt" HTTP Request node in n8n'>
              <p className="text-[11px] text-muted-foreground">
                Add an <strong>HTTP Request</strong> node named{' '}
                <code className="font-mono text-[10px] bg-muted px-1 rounded">Fetch Prompt</code> between the <em>Chat Trigger</em> and <em>AI Agent</em> nodes:
              </p>
              <div className="space-y-2 text-[11px]">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground w-20 flex-shrink-0">Method</span>
                  <code className="font-mono text-[10px] bg-muted px-2 py-0.5 rounded text-foreground">GET</code>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-muted-foreground w-20 flex-shrink-0 pt-1">URL</span>
                  <div className="flex items-start gap-2 flex-1 min-w-0">
                    <code className="font-mono text-[10px] bg-muted px-2 py-1 rounded text-foreground break-all flex-1">{fetchUrl}</code>
                    <CopyButton value={fetchUrl} label="URL" />
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-muted-foreground w-20 flex-shrink-0 pt-1">Header 1</span>
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <code className="font-mono text-[10px] bg-muted px-2 py-1 rounded text-foreground break-all flex-1">{`apikey: ${anonKey}`}</code>
                    <CopyButton value={`apikey: ${anonKey}`} label="apikey header" />
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-muted-foreground w-20 flex-shrink-0 pt-1">Header 2</span>
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <code className="font-mono text-[10px] bg-muted px-2 py-1 rounded text-foreground break-all flex-1">{`Authorization: Bearer ${anonKey}`}</code>
                    <CopyButton value={`Authorization: Bearer ${anonKey}`} label="auth header" />
                  </div>
                </div>
              </div>
            </GuideStep>

            <GuideStep num={3} title="Set the AI Agent System Message">
              <p className="text-[11px] text-muted-foreground">
                Open <strong>AI Agent</strong> node → <strong>Options</strong> → <strong>System Message</strong>. Paste:
              </p>
              <div className="flex items-center gap-2">
                <code className="font-mono text-[10px] bg-muted px-2 py-1.5 rounded text-foreground flex-1 break-all">{N8N_EXPRESSION}</code>
                <CopyButton value={N8N_EXPRESSION} label="expression" />
              </div>
              <div className="flex items-start gap-2 p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-[11px] text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 size={12} className="mt-0.5 flex-shrink-0" />
                <span>Done! Every "Deploy to n8n" click instantly updates what your bot says — no workflow edits needed.</span>
              </div>
            </GuideStep>
          </div>
        )}
      </div>

      {/* ── How it works ──────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-muted/20 p-3.5">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          <Info size={11} /> How it works
        </div>
        <div className="space-y-1 text-[11px] text-muted-foreground">
          <p>
            Create multiple prompts and give each a name. Click <strong>Deploy to n8n</strong> to push the active prompt to your Supabase <code className="font-mono text-[10px] bg-muted px-1 rounded">n8n_bot_settings</code> table.
            Your n8n bot fetches it at the start of each chat — changes take effect immediately.
          </p>
        </div>
      </div>

    </div>
  );
};
