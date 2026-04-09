import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useSessions, useRecipientNames, useUpdateRecipientName, useAutoResolveNames, fetchMessages, SessionInfo } from '@/hooks/useChatHistory';
import { usePlatformConnections } from '@/hooks/usePlatformConnections';
import { Search, RefreshCw, Pencil, Check, X, MessageCircle, MessagesSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDistanceToNow, parseISO } from 'date-fns';

// ─── Avatar gradient helper ────────────────────────────────────────────────────
const GRADIENTS = [
  ['#6366f1', '#8b5cf6'],
  ['#3b82f6', '#06b6d4'],
  ['#10b981', '#059669'],
  ['#f59e0b', '#f97316'],
  ['#ec4899', '#f43f5e'],
  ['#8b5cf6', '#6366f1'],
  ['#14b8a6', '#3b82f6'],
  ['#f97316', '#ef4444'],
];
function getGradient(str: string): [string, string] {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return GRADIENTS[h % GRADIENTS.length] as [string, string];
}

// ─── 5-minute live-session helper ─────────────────────────────────────────────
const LIVE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function isLive(session: SessionInfo): boolean {
  try {
    return Date.now() - new Date(session.last_message_at).getTime() < LIVE_WINDOW_MS;
  } catch {
    return false;
  }
}

// Sort: live first (by last_message_at desc), then offline (by last_message_at desc)
function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    const aLive = isLive(a) ? 1 : 0;
    const bLive = isLive(b) ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive; // live first
    return new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime();
  });
}

// ─── SessionList ───────────────────────────────────────────────────────────────

export const SessionList = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: sessions, isLoading, refetch, isFetching } = useSessions();
  const { data: recipientNames } = useRecipientNames();
  const { data: platformConns = [] } = usePlatformConnections();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'active'>('all');

  useAutoResolveNames(
    sessions?.map(s => s.recipient) ?? [],
    recipientNames,
    platformConns
  );

  // After sessions data loads, give the background name-extraction 3 seconds to settle,
  // then invalidate the recipient-names cache so newly extracted names appear in the UI.
  const sessionsKeyRef = useRef('');
  useEffect(() => {
    if (!sessions) return;
    const key = sessions.map(s => s.recipient).join(',');
    if (key === sessionsKeyRef.current) return;
    sessionsKeyRef.current = key;
    const timer = setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ['recipient-names'] });
    }, 3000);
    return () => clearTimeout(timer);
  }, [sessions, queryClient]);

  const prefetchSession = useCallback((sessionId: string) => {
    queryClient.prefetchQuery({
      queryKey: ['chat-history', sessionId],
      staleTime: 0,
      queryFn: () => fetchMessages(sessionId),
    });
  }, [queryClient]);

  const sorted = sessions ? sortSessions(sessions) : [];

  const filtered = sorted.filter((s) => {
    const name = (recipientNames?.[s.recipient] || '').toLowerCase();
    const q = searchQuery.toLowerCase();
    const matchesSearch = name.includes(q) || s.recipient.includes(q);
    // Active tab: only sessions with last message within 5 minutes
    if (activeTab === 'active') return matchesSearch && isLive(s);
    return matchesSearch;
  });

  const activeCount = sessions?.filter(s => isLive(s)).length || 0;

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        {/* Search skeleton */}
        <div className="px-4 pb-3">
          <div className="h-10 rounded-xl bg-muted/60 animate-pulse" />
        </div>
        <div className="flex-1 px-3 space-y-1">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-3.5 rounded-2xl">
              <div className="w-11 h-11 rounded-full bg-muted animate-pulse flex-shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-3.5 bg-muted rounded-lg animate-pulse w-3/5" />
                <div className="h-2.5 bg-muted rounded-lg animate-pulse w-2/5" />
              </div>
              <div className="h-2.5 bg-muted rounded-lg animate-pulse w-14" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* ── Search ─────────────────────────────────────────────────────────── */}
      <div className="px-3 md:px-4 pb-3">
        <div className="relative group">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 group-focus-within:text-primary transition-colors duration-200" />
          <Input
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 h-10 rounded-2xl bg-muted/40 border-0 text-sm placeholder:text-muted-foreground/40 focus-visible:ring-1 focus-visible:ring-primary/30 focus-visible:bg-background transition-all duration-200"
          />
        </div>
      </div>

      {/* ── Tabs + Refresh ─────────────────────────────────────────────────── */}
      <div className="px-3 md:px-4 pb-3 flex items-center gap-2">
        <div className="flex bg-muted/40 rounded-2xl p-1 flex-1 gap-1">
          {(['all', 'active'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "flex-1 text-xs font-semibold py-2 rounded-xl transition-all duration-200",
                activeTab === tab
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {tab === 'all' ? 'All' : (
                <span className="flex items-center justify-center gap-1.5">
                  Active
                  {activeCount > 0 && (
                    <span className="text-[10px] font-bold bg-emerald-500 text-white rounded-full px-1.5 py-0.5 leading-none">
                      {activeCount}
                    </span>
                  )}
                </span>
              )}
            </button>
          ))}
        </div>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => refetch()}
          disabled={isFetching}
          className="h-9 w-9 rounded-xl hover:bg-muted/60 flex-shrink-0"
          title="Refresh"
        >
          <RefreshCw size={14} className={cn("text-muted-foreground", isFetching && "animate-spin")} />
        </Button>
      </div>

      {/* ── Count Label ────────────────────────────────────────────────────── */}
      {filtered && filtered.length > 0 && (
        <div className="px-4 pb-2">
          <span className="text-[10px] text-muted-foreground/50 font-bold uppercase tracking-widest">
            {filtered.length} {filtered.length === 1 ? 'conversation' : 'conversations'}
          </span>
        </div>
      )}

      {/* ── List ───────────────────────────────────────────────────────────── */}
      <ScrollArea className="flex-1">
        <div className="px-2 pb-4 space-y-0.5">
          {filtered?.map((session) => (
            <SessionCard
              key={session.session_id}
              session={session}
              recipientName={recipientNames?.[session.recipient]}
              onSelect={() => navigate(`/conversation/${session.session_id}?recipient=${session.recipient}`)}
              onPrefetch={() => prefetchSession(session.session_id)}
            />
          ))}

          {filtered?.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-muted/60 to-muted/30 flex items-center justify-center mb-4 shadow-inner">
                {searchQuery
                  ? <Search size={22} className="text-muted-foreground/40" />
                  : <MessagesSquare size={22} className="text-muted-foreground/40" />
                }
              </div>
              <p className="text-sm font-semibold text-foreground/60">
                {searchQuery ? 'No results found' : 'No conversations yet'}
              </p>
              <p className="text-[11px] text-muted-foreground/40 mt-1">
                {searchQuery ? 'Try a different search term' : 'Connect a database to see conversations'}
              </p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

// ─── SessionCard ───────────────────────────────────────────────────────────────

interface SessionCardProps {
  session: SessionInfo;
  onSelect: () => void;
  onPrefetch: () => void;
  recipientName?: string;
}

const SessionCard = ({ session, onSelect, onPrefetch, recipientName }: SessionCardProps) => {
  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const updateName = useUpdateRecipientName();

  const displayName = recipientName || session.recipient;
  const initials = recipientName
    ? recipientName.slice(0, 2).toUpperCase()
    : session.recipient.slice(-2).toUpperCase();
  const [g1, g2] = getGradient(session.recipient);

  const relativeTime = (() => {
    try { return formatDistanceToNow(parseISO(session.last_message_at), { addSuffix: true }); }
    catch { return ''; }
  })();

  const handleSave = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (nameInput.trim()) updateName.mutate({ recipientId: session.recipient, name: nameInput.trim() });
    setEditing(false);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onMouseEnter={onPrefetch}
      onKeyDown={e => e.key === 'Enter' && onSelect()}
      className="w-full px-3 py-3 text-left transition-all duration-200 group flex items-center gap-3 rounded-2xl hover:bg-muted/50 active:scale-[0.99] cursor-pointer"
    >
      {/* Avatar */}
      <div className="relative flex-shrink-0">
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center text-white text-sm font-bold shadow-md"
          style={{ background: `linear-gradient(135deg, ${g1} 0%, ${g2} 100%)` }}
        >
          {initials}
        </div>
        {/* Message count badge */}
        <div
          className="absolute -bottom-1 -right-1 min-w-[20px] h-5 rounded-full flex items-center justify-center text-white text-[10px] font-bold px-1 shadow border-2 border-background"
          style={{ background: `linear-gradient(135deg, ${g1} 0%, ${g2} 100%)` }}
        >
          {session.message_count > 99 ? '99+' : session.message_count}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Name row */}
        {editing ? (
          <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
            <Input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && nameInput.trim()) { updateName.mutate({ recipientId: session.recipient, name: nameInput.trim() }); setEditing(false); }
                if (e.key === 'Escape') setEditing(false);
              }}
              placeholder="Enter name..."
              className="h-7 text-sm px-2 rounded-lg border-border bg-background"
              autoFocus
            />
            <Button variant="ghost" size="icon" className="h-7 w-7 text-primary flex-shrink-0" onClick={handleSave}>
              <Check size={13} />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground flex-shrink-0"
              onClick={(e) => { e.stopPropagation(); setEditing(false); }}>
              <X size={13} />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-foreground text-[13px] truncate leading-tight">
              {displayName}
            </span>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); setNameInput(recipientName || ''); setEditing(true); }}
              onKeyDown={(e) => e.key === 'Enter' && setEditing(true)}
              className="hidden md:flex opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:text-primary text-muted-foreground flex-shrink-0 cursor-pointer"
            >
              <Pencil size={11} />
            </span>
          </div>
        )}

        {/* Sub row */}
        <div className="flex items-center gap-2 mt-0.5">
          {recipientName && (
            <span className="text-[10px] text-muted-foreground/50 font-mono truncate max-w-[90px]">
              {session.recipient}
            </span>
          )}
          {recipientName && <span className="text-muted-foreground/30 text-[10px]">·</span>}
          <div className="flex items-center gap-1">
            <span className={cn(
              "w-1.5 h-1.5 rounded-full flex-shrink-0",
              isLive(session) ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/30"
            )} />
            <span className={cn(
              "text-[11px] font-medium",
              isLive(session) ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground/40"
            )}>
              {isLive(session) ? 'Active' : 'Offline'}
            </span>
          </div>
        </div>
      </div>

      {/* Timestamp */}
      <span className="text-[10px] text-muted-foreground/50 whitespace-nowrap font-medium flex-shrink-0 self-start mt-1">
        {relativeTime}
      </span>
    </div>
  );
};
