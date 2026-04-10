import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

const N8N_STORAGE_KEY = 'chat_monitor_n8n_settings';

export type N8nConnectionMode = 'proxy' | 'direct';

export interface N8nSettings {
  n8nUrl: string;
  n8nApiKey: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  mode: N8nConnectionMode;
}

export interface N8nNode {
  id: string;
  name: string;
  type: string;
  parameters: Record<string, unknown>;
  position?: [number, number];
  typeVersion?: number;
}

export interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
  nodes: N8nNode[];
  connections: Record<string, unknown>;
  settings?: Record<string, unknown>;
  staticData?: unknown;
  tags?: Array<{ id: string; name: string }>;
  pinData?: Record<string, unknown>;
  versionId?: string;
  meta?: Record<string, unknown>;
}

export interface N8nWorkflowListItem {
  id: string;
  name: string;
  active: boolean;
}

export const getN8nSettings = (): N8nSettings | null => {
  try {
    const raw = localStorage.getItem(N8N_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as N8nSettings;
    if (!parsed.mode) parsed.mode = 'proxy';
    return parsed;
  } catch {
    return null;
  }
};

export const saveN8nSettings = (settings: N8nSettings): void => {
  localStorage.setItem(N8N_STORAGE_KEY, JSON.stringify(settings));
};

export const clearN8nSettings = (): void => {
  localStorage.removeItem(N8N_STORAGE_KEY);
};

const PRIMARY_AGENT_TYPE = '@n8n/n8n-nodes-langchain.agent';
const FALLBACK_AGENT_TYPES = [
  '@n8n/n8n-nodes-langchain.openAi',
  'n8n-nodes-base.openAi',
  '@n8n/n8n-nodes-langchain.chatOpenAi',
  'n8n-nodes-langchain.agent',
];

export function getSystemMessage(node: N8nNode): string {
  const p = node.parameters;
  if (!p) return '';
  const candidates = [
    p.systemMessage,
    p.system_message,
    p.prompt,
    p.systemPrompt,
    (p.options as Record<string, unknown> | undefined)?.systemMessage,
  ];
  for (const raw of candidates) {
    if (typeof raw === 'string' && raw.trim()) return raw;
    if (typeof raw === 'object' && raw !== null) {
      const obj = raw as Record<string, unknown>;
      const v = String(obj.value ?? obj.content ?? '');
      if (v.trim()) return v;
    }
  }
  return '';
}

export function findAiAgentNodes(nodes: N8nNode[]): N8nNode[] {
  const primary = nodes.filter((n) => n.type === PRIMARY_AGENT_TYPE);
  if (primary.length > 0) return primary;

  return nodes.filter(
    (n) => FALLBACK_AGENT_TYPES.includes(n.type) && getSystemMessage(n).trim() !== ''
  );
}

async function callDirect(
  settings: N8nSettings,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const cleanUrl = settings.n8nUrl.replace(/\/$/, '');
  const url = `${cleanUrl}/api/v1/${path}`;

  const opts: RequestInit = {
    method: method.toUpperCase(),
    headers: {
      'X-N8N-API-KEY': settings.n8nApiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };

  if (body !== undefined && ['PUT', 'POST', 'PATCH'].includes(method.toUpperCase())) {
    opts.body = JSON.stringify(body);
  }

  const response = await fetch(url, opts);
  const data = await response.json().catch(() => ({ error: 'Invalid JSON response' }));

  if (!response.ok) {
    const errMsg =
      (data as Record<string, unknown>)?.message ||
      (data as Record<string, unknown>)?.error ||
      `HTTP ${response.status}`;
    throw new Error(String(errMsg));
  }

  return data;
}

async function callProxy(
  settings: N8nSettings,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const cleanSupabaseUrl = settings.supabaseUrl.replace(/\/$/, '');
  const proxyUrl = `${cleanSupabaseUrl}/functions/v1/n8n-proxy`;

  const response = await fetch(proxyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.supabaseAnonKey}`,
    },
    body: JSON.stringify({
      n8nUrl: settings.n8nUrl,
      n8nApiKey: settings.n8nApiKey,
      method,
      path,
      body,
    }),
  });

  const data = await response.json().catch(() => ({ error: 'Invalid JSON response' }));

  if (!response.ok) {
    const errMsg =
      (data as Record<string, unknown>)?.error ||
      (data as Record<string, unknown>)?.message ||
      `HTTP ${response.status}`;
    throw new Error(String(errMsg));
  }

  if ((data as Record<string, unknown>)?.error) {
    throw new Error(String((data as Record<string, unknown>).error));
  }

  return data;
}

async function callN8n(
  settings: N8nSettings,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  return settings.mode === 'direct'
    ? callDirect(settings, method, path, body)
    : callProxy(settings, method, path, body);
}

/**
 * Public helper — calls the Supabase n8n-proxy edge function using the
 * credentials stored in localStorage. Throws if no settings are saved.
 */
export async function callN8nProxy(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const settings = getN8nSettings();
  if (!settings) throw new Error('No n8n settings configured');
  return callProxy(settings, method, path, body);
}

export const useN8nWorkflows = (settings: N8nSettings | null, enabled: boolean) => {
  return useQuery({
    queryKey: ['n8n-workflows', settings?.n8nUrl, settings?.mode],
    queryFn: async () => {
      if (!settings) throw new Error('No n8n settings configured');
      const data = await callN8n(settings, 'GET', 'workflows?limit=100');
      const list = (data as Record<string, unknown>)?.data as N8nWorkflowListItem[];
      return Array.isArray(list) ? list : [];
    },
    enabled:
      enabled &&
      !!settings?.n8nUrl &&
      !!settings?.n8nApiKey &&
      (settings.mode === 'direct' || (!!settings?.supabaseUrl && !!settings?.supabaseAnonKey)),
    staleTime: 30000,
    retry: 1,
  });
};

export const useN8nWorkflow = (settings: N8nSettings | null, workflowId: string | null) => {
  return useQuery({
    queryKey: ['n8n-workflow', workflowId, settings?.mode],
    queryFn: async () => {
      if (!settings || !workflowId) throw new Error('Missing settings or workflow ID');
      const data = await callN8n(settings, 'GET', `workflows/${workflowId}`);
      return data as N8nWorkflow;
    },
    enabled: !!settings && !!workflowId,
    staleTime: 10000,
    retry: 1,
  });
};

/** Helper: apply the new prompt text to a workflow node's parameters in-place. */
function applyPromptToNode(p: Record<string, unknown>, newPrompt: string): void {
  if (p.systemMessage !== undefined) {
    p.systemMessage = newPrompt;
  } else if (p.system_message !== undefined) {
    p.system_message = newPrompt;
  } else if (p.systemPrompt !== undefined) {
    p.systemPrompt = newPrompt;
  } else if (p.prompt !== undefined) {
    p.prompt = newPrompt;
  } else if (
    p.options &&
    typeof p.options === 'object' &&
    (p.options as Record<string, unknown>).systemMessage !== undefined
  ) {
    (p.options as Record<string, unknown>).systemMessage = newPrompt;
  } else {
    p.systemMessage = newPrompt;
  }
}

/** Helper: build a minimal PUT body that n8n accepts (no extra read-only fields). */
function buildPutBody(wf: N8nWorkflow): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
  };
  if (wf.settings && Object.keys(wf.settings).length > 0) body.settings = wf.settings;
  if (wf.pinData && Object.keys(wf.pinData as object).length > 0) body.pinData = wf.pinData;
  if (wf.versionId) body.versionId = wf.versionId;
  if (wf.tags && wf.tags.length > 0) body.tags = wf.tags.map((t) => ({ id: t.id }));
  return body;
}

/** Save the system prompt directly to Supabase n8n_bot_settings table. */
export const useSavePromptDirect = () => {
  return useMutation({
    mutationFn: async ({
      prompt,
      supabaseUrl,
      supabaseAnonKey,
    }: {
      prompt: string;
      supabaseUrl: string;
      supabaseAnonKey: string;
    }) => {
      const { createClient } = await import('@supabase/supabase-js');
      const client = createClient(supabaseUrl, supabaseAnonKey);
      const { error } = await client.from('n8n_bot_settings').upsert({
        id: 'default',
        workflow_id: null,
        node_id: null,
        system_prompt: prompt,
        updated_at: new Date().toISOString(),
      });
      if (error) {
        if (error.code === '42P01') {
          throw new Error('Table not found — run the SQL in Step 1 first');
        }
        throw new Error(error.message);
      }
    },
    onSuccess: () => {
      toast.success('Prompt saved! Your n8n bot will use it from next conversation.');
    },
    onError: (error: Error) => {
      toast.error(`Save failed: ${error.message}`);
    },
  });
};

/** Load the saved system prompt from Supabase n8n_bot_settings table. */
export const useLoadPromptDirect = (supabaseUrl: string, supabaseAnonKey: string) => {
  return useQuery({
    queryKey: ['n8n-prompt-direct', supabaseUrl, supabaseAnonKey],
    queryFn: async () => {
      if (!supabaseUrl || !supabaseAnonKey) return '';
      const { createClient } = await import('@supabase/supabase-js');
      const client = createClient(supabaseUrl, supabaseAnonKey);
      const { data, error } = await client
        .from('n8n_bot_settings')
        .select('system_prompt')
        .eq('id', 'default')
        .maybeSingle();
      if (error || !data) return '';
      return (data.system_prompt as string) || '';
    },
    enabled: !!supabaseUrl && !!supabaseAnonKey,
    staleTime: 10000,
    retry: false,
  });
};

// useUpdateN8nPrompt is kept for potential future use (n8n direct workflow editing).
export const useUpdateN8nPrompt = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      settings,
      workflowId,
      nodeId,
      newPrompt,
    }: {
      settings: N8nSettings;
      workflowId: string;
      nodeId: string;
      newPrompt: string;
    }): Promise<{ savedVia: 'supabase' | 'n8n' }> => {

      // ── Strategy 1: save to Supabase n8n_bot_settings table (no API schema issues) ──
      try {
        const { supabase } = await import('@/integrations/supabase/client');
        const { error: sbError } = await supabase
          .from('n8n_bot_settings')
          .upsert({
            id: `${workflowId}_${nodeId}`,
            workflow_id: workflowId,
            node_id: nodeId,
            system_prompt: newPrompt,
            updated_at: new Date().toISOString(),
          });

        if (!sbError) {
          // Supabase saved — also try n8n PUT silently as bonus (ignore errors)
          try {
            const fresh = (await callN8n(settings, 'GET', `workflows/${workflowId}`)) as N8nWorkflow;
            const wf: N8nWorkflow = JSON.parse(JSON.stringify(fresh));
            const idx = wf.nodes.findIndex((n) => n.id === nodeId);
            if (idx !== -1) {
              applyPromptToNode(wf.nodes[idx].parameters, newPrompt);
              await callN8n(settings, 'PUT', `workflows/${workflowId}`, buildPutBody(wf));
            }
          } catch {
            // n8n PUT failed — that's OK, Supabase has the prompt
          }
          return { savedVia: 'supabase' };
        }
      } catch {
        // Supabase not available — fall through to n8n direct save
      }

      // ── Strategy 2: direct n8n PUT (fallback) ──────────────────────────────
      const fresh = (await callN8n(settings, 'GET', `workflows/${workflowId}`)) as N8nWorkflow;
      const wf: N8nWorkflow = JSON.parse(JSON.stringify(fresh));
      const idx = wf.nodes.findIndex((n) => n.id === nodeId);
      if (idx === -1) throw new Error('AI Agent node not found in workflow');
      applyPromptToNode(wf.nodes[idx].parameters, newPrompt);
      await callN8n(settings, 'PUT', `workflows/${workflowId}`, buildPutBody(wf));
      return { savedVia: 'n8n' };
    },
    onSuccess: (result, { workflowId }) => {
      queryClient.invalidateQueries({ queryKey: ['n8n-workflow', workflowId] });
      if (result.savedVia === 'supabase') {
        toast.success('Prompt saved to Supabase! n8n reads it from your database.');
      } else {
        toast.success('Prompt saved directly to n8n workflow!');
      }
    },
    onError: (error: Error) => {
      toast.error(`Save failed: ${error.message}`);
    },
  });
};
