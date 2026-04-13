import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useSessions, useRecipientNames, useUpdateRecipientName, useAutoResolveNames, fetchMessages, useDbConnectionKey, SessionInfo } from '@/hooks/useChatHistory';
import { usePlatformConnections } from '@/hooks/usePlatformConnections';
import { detectPlatform, Platform, PLATFORM_CONFIG } from '@/lib/platformDetect';
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

// Active = last message within the past 5 minutes
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
function isWithin5Min(ts: string | null | undefined): boolean {
  if (!ts) return false;
  return Date.now() - new Date(ts).getTime() < ACTIVE_WINDOW_MS;
}

// Sort: active first (by last_message_at desc), then offline (by last_message_at desc)
function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    const aLive = isWithin5Min(a.last_message_at) ? 1 : 0;
    const bLive = isWithin5Min(b.last_message_at) ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive; // active first
    return new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime();
  });
}

// ─── Platform full-circle avatar ──────────────────────────────────────────────
// Renders the platform logo as the entire avatar circle (no small badge)
export const PlatformAvatar = ({
  platform,
  sizePx = 48,
  className = '',
}: {
  platform: Platform;
  sizePx?: number;
  className?: string;
}) => {
  if (platform === 'unknown') return null;
  const cfg = PLATFORM_CONFIG[platform];
  const bg = cfg.gradient ?? cfg.color;
  const iconPx = Math.round(sizePx * 0.52);
  return (
    <div
      className={`rounded-full flex items-center justify-center shadow-md ${className}`}
      style={{ width: sizePx, height: sizePx, background: bg, flexShrink: 0 }}
      title={cfg.label}
    >
      {platform === 'whatsapp' && (
        <svg width={iconPx} height={iconPx} viewBox="0 0 24 24" fill="white">
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
          <path d="M12 0C5.373 0 0 5.373 0 12c0 2.125.553 4.118 1.522 5.847L.057 23.428a.5.5 0 00.609.61l5.657-1.484A11.945 11.945 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.811 9.811 0 01-5.032-1.383l-.36-.214-3.733.979 1-3.645-.236-.376A9.818 9.818 0 012.182 12C2.182 6.57 6.57 2.182 12 2.182S21.818 6.57 21.818 12 17.43 21.818 12 21.818z"/>
        </svg>
      )}
      {platform === 'facebook' && (
        <svg width={iconPx} height={iconPx} viewBox="0 0 24 24" fill="white">
          <path d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.41c0-3.025 1.792-4.697 4.533-4.697 1.312 0 2.686.236 2.686.236v2.97H15.83c-1.491 0-1.956.93-1.956 1.886v2.268h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z"/>
        </svg>
      )}
      {platform === 'instagram' && (
        <svg width={iconPx} height={iconPx} viewBox="0 0 24 24" fill="white">
          <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/>
        </svg>
      )}
    </div>
  );
};

// ─── SessionList ───────────────────────────────────────────────────────────────

type SessionListProps = {
  /** When provided, clicking a session calls this instead of navigating to the conversation page */
  onSelect?: (sessionId: string, recipient: string) => void;
  /** The currently selected session ID (highlights the active row in inbox mode) */
  selectedSessionId?: string;
};

export const SessionList = ({ onSelect, selectedSessionId }: SessionListProps = {}) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: sessions, isLoading, refetch, isFetching } = useSessions();
  const { data: recipientNames } = useRecipientNames();
  const { data: platformConns = [] } = usePlatformConnections();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'active'>('all');
  const [platformFilter, setPlatformFilter] = useState<'all' | Platform>('all');

  // ── Frozen order: sort only on first load or manual refresh ──────────────
  // Prevents conversations from jumping around during background auto-polls.
  const [frozenIds, setFrozenIds] = useState<string[]>([]);
  const isManualRefetch = useRef(false);

  // Seed frozen order when data first arrives
  useEffect(() => {
    if (!sessions || sessions.length === 0) return;
    if (frozenIds.length === 0) {
      setFrozenIds(sortSessions(sessions).map(s => s.session_id));
    }
  }, [sessions]);

  // After a manual refresh completes, update the frozen order
  useEffect(() => {
    if (!isFetching && isManualRefetch.current && sessions) {
      isManualRefetch.current = false;
      setFrozenIds(sortSessions(sessions).map(s => s.session_id));
    }
  }, [isFetching, sessions]);

  const handleManualRefresh = useCallback(() => {
    isManualRefetch.current = true;
    refetch();
  }, [refetch]);

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

  const dbKey = useDbConnectionKey();

  const prefetchSession = useCallback((sessionId: string) => {
    queryClient.prefetchQuery({
      queryKey: ['chat-history', sessionId, dbKey],
      staleTime: 30_000,
      queryFn: () => fetchMessages(sessionId),
    });
  }, [queryClient, dbKey]);

  // Apply frozen order: existing sessions in frozen order, new sessions prepended
  const sorted = useMemo(() => {
    if (!sessions) return [];
    if (frozenIds.length === 0) return sortSessions(sessions);
    const sessionMap = new Map(sessions.map(s => [s.session_id, s]));
    const ordered: SessionInfo[] = [];
    // First: sessions in frozen order
    for (const id of frozenIds) {
      const s = sessionMap.get(id);
      if (s) ordered.push(s);
    }
    // Then: any new sessions not yet in the frozen list (prepend at top)
    const frozenSet = new Set(frozenIds);
    const newSessions = sortSessions(sessions.filter(s => !frozenSet.has(s.session_id)));
    return [...newSessions, ...ordered];
  }, [sessions, frozenIds]);

  // Determine which platforms have sessions (for showing filter chips)
  type KnownPlatform = 'whatsapp' | 'facebook' | 'instagram';
  const platformsWithSessions = useMemo<KnownPlatform[]>(() => {
    if (!sorted || sorted.length === 0) return [];
    const seen = new Set<KnownPlatform>();
    for (const s of sorted) {
      const p = detectPlatform(s.recipient, platformConns, { sessionId: s.session_id, dbPlatform: s.platform });
      if (p === 'whatsapp' || p === 'facebook' || p === 'instagram') seen.add(p);
    }
    return (['whatsapp', 'facebook', 'instagram'] as const).filter(p => seen.has(p));
  }, [sorted, platformConns]);

  const filtered = sorted.filter((s) => {
    const name = (recipientNames?.[s.recipient] || '').toLowerCase();
    const q = searchQuery.toLowerCase();
    if (!name.includes(q) && !s.recipient.includes(q)) return false;
    // Platform filter applies regardless of active/all tab
    if (platformFilter !== 'all') {
      const p = detectPlatform(s.recipient, platformConns, { sessionId: s.session_id, dbPlatform: s.platform });
      if (p !== platformFilter) return false;
    }
    // Active tab: additionally require last message within 5 minutes
    if (activeTab === 'active') return isWithin5Min(s.last_message_at);
    return true;
  });

  // Active count scoped to the current platform filter
  const activeCount = useMemo(() => {
    if (!sorted.length) return 0;
    return sorted.filter(s => {
      if (!isWithin5Min(s.last_message_at)) return false;
      if (platformFilter !== 'all') {
        const p = detectPlatform(s.recipient, platformConns, { sessionId: s.session_id, dbPlatform: s.platform });
        return p === platformFilter;
      }
      return true;
    }).length;
  }, [sorted, platformFilter, platformConns]);

  // ── Eager background pre-warm (top 3 only) ───────────────────────────────
  // Pre-fetch only the top 3 sessions so clicking them feels instant.
  // Prefetching every session floods the network on large lists.
  const lastPrefetchKey = useRef('');
  useEffect(() => {
    if (!filtered || filtered.length === 0) return;
    const top3 = filtered.slice(0, 3);
    const key = top3.map(s => s.session_id).join(',');
    if (key === lastPrefetchKey.current) return;
    lastPrefetchKey.current = key;

    const timers: ReturnType<typeof setTimeout>[] = [];
    top3.forEach((s, i) => {
      const t = setTimeout(() => {
        queryClient.prefetchQuery({
          queryKey: ['chat-history', s.session_id, dbKey],
          staleTime: 30_000,
          queryFn: () => fetchMessages(s.session_id),
        });
      }, i * 80);
      timers.push(t);
    });
    return () => timers.forEach(clearTimeout);
  }, [filtered, queryClient, dbKey]);

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
      <div className="px-3 md:px-4 pb-2 flex items-center gap-2">
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
          onClick={handleManualRefresh}
          disabled={isFetching}
          className="h-9 w-9 rounded-xl hover:bg-muted/60 flex-shrink-0"
          title="Refresh"
        >
          <RefreshCw size={14} className={cn("text-muted-foreground", isFetching && "animate-spin")} />
        </Button>
      </div>

      {/* ── Platform filter chips ───────────────────────────────────────────── */}
      {platformsWithSessions.length >= 1 && (
        <div className="px-3 md:px-4 pb-2 flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
          <button
            onClick={() => setPlatformFilter('all')}
            className={cn(
              'flex-shrink-0 text-[11px] font-semibold px-3 py-1 rounded-full border transition-all duration-150',
              platformFilter === 'all'
                ? 'bg-foreground text-background border-foreground'
                : 'bg-transparent text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground'
            )}
          >
            All
          </button>
          {platformsWithSessions.map((p) => {
            const cfg = PLATFORM_CONFIG[p];
            const isActive = platformFilter === p;
            return (
              <button
                key={p}
                onClick={() => setPlatformFilter(isActive ? 'all' : p)}
                className={cn(
                  'flex-shrink-0 flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-all duration-150',
                  isActive
                    ? 'text-white border-transparent'
                    : 'bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-foreground/40'
                )}
                style={isActive ? { background: cfg.gradient ?? cfg.color, borderColor: cfg.color } : {}}
              >
                <span
                  className="w-3 h-3 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ background: cfg.gradient ?? cfg.color }}
                >
                  {p === 'whatsapp' && (
                    <svg viewBox="0 0 20 20" fill="none" className="w-2 h-2">
                      <path d="M14.5 10.75c-.2-.1-.95-.47-1.1-.52-.15-.06-.26-.09-.37.08-.11.17-.42.52-.51.63-.1.11-.19.12-.35.04-.94-.47-1.56-.84-2.18-1.9-.17-.29.17-.27.48-.9.05-.1.03-.2-.01-.27-.04-.08-.37-.9-.51-1.23-.13-.33-.27-.28-.37-.29-.1 0-.21-.02-.32-.02s-.29.04-.44.22c-.15.17-.58.57-.58 1.38s.59 1.6.68 1.71c.08.11 1.16 1.77 2.82 2.48.39.17.7.27.94.35.4.12.76.1 1.04.06.32-.05.98-.4 1.12-.79.14-.39.14-.73.1-.8-.04-.07-.15-.11-.32-.19z" fill="white"/>
                      <path d="M10 2C5.6 2 2 5.6 2 10c0 1.4.4 2.8 1 4l-1.1 3.9L5.9 17c1.2.6 2.5 1 4.1 1 4.4 0 8-3.6 8-8s-3.6-8-8-8zm0 14.5c-1.3 0-2.6-.4-3.6-1l-.3-.2-2.2.6.6-2.2-.2-.3C3.4 12.4 3 11.2 3 10c0-3.9 3.1-7 7-7s7 3.1 7 7-3.1 7-7 7z" fill="white"/>
                    </svg>
                  )}
                  {p === 'facebook' && (
                    <svg viewBox="0 0 20 20" fill="none" className="w-2 h-2">
                      <path d="M12 6.5h-1.5C10 6.5 10 7 10 7.5V9h2l-.3 2H10v5H8v-5H6V9h2V7.5C8 5.6 9.3 5 11 5h1v1.5z" fill="white"/>
                    </svg>
                  )}
                  {p === 'instagram' && (
                    <svg viewBox="0 0 20 20" fill="none" className="w-2 h-2">
                      <rect x="3.5" y="3.5" width="13" height="13" rx="3.5" stroke="white" strokeWidth="2" fill="none"/>
                      <circle cx="10" cy="10" r="3" stroke="white" strokeWidth="2" fill="none"/>
                      <circle cx="14" cy="6" r="1" fill="white"/>
                    </svg>
                  )}
                </span>
                {cfg.label}
              </button>
            );
          })}
        </div>
      )}

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
              platform={detectPlatform(session.recipient, platformConns, { sessionId: session.session_id, dbPlatform: session.platform })}
              isSelected={selectedSessionId === session.session_id}
              onSelect={() =>
                onSelect
                  ? onSelect(session.session_id, session.recipient)
                  : navigate(`/conversation/${session.session_id}?recipient=${session.recipient}`)
              }
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
  platform: Platform;
  isSelected?: boolean;
}

const SessionCard = ({ session, onSelect, onPrefetch, recipientName, platform, isSelected }: SessionCardProps) => {
  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const updateName = useUpdateRecipientName();

  const displayName = recipientName || session.recipient;
  const initials = recipientName
    ? recipientName.slice(0, 2).toUpperCase()
    : session.recipient.slice(-2).toUpperCase();
  const [g1, g2] = getGradient(session.recipient);

  const relativeTime = (() => {
    if (!session.last_message_at || session.last_message_at === '2000-01-01T00:00:00.000Z') return '—';
    try { return formatDistanceToNow(parseISO(session.last_message_at), { addSuffix: true }); }
    catch { return '—'; }
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
      className={cn(
        "w-full px-3 py-3 text-left transition-all duration-200 group flex items-center gap-3 rounded-2xl active:scale-[0.99] cursor-pointer",
        isSelected
          ? "bg-primary/10 border border-primary/20"
          : "hover:bg-muted/50"
      )}
    >
      {/* Avatar */}
      <div className="relative flex-shrink-0">
        {platform !== 'unknown' ? (
          <PlatformAvatar platform={platform} sizePx={48} />
        ) : (
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center text-white text-sm font-bold shadow-md"
            style={{ background: `linear-gradient(135deg, ${g1} 0%, ${g2} 100%)` }}
          >
            {initials}
          </div>
        )}
        {/* Active/offline indicator dot — green if last message < 5 min ago */}
        {isWithin5Min(session.last_message_at) ? (
          <span className="absolute -bottom-0.5 -left-0.5 w-3.5 h-3.5 rounded-full border-2 border-background bg-emerald-500 animate-pulse" />
        ) : (
          <span className="absolute -bottom-0.5 -left-0.5 w-3.5 h-3.5 rounded-full border-2 border-background bg-muted-foreground/30" />
        )}
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

        {/* Sub row — last message preview */}
        <p className="text-[11px] text-muted-foreground/60 truncate mt-0.5 leading-snug max-w-[200px]">
          {(() => {
            const t = session.last_message_text || '';
            if (t.startsWith('data:image/') || t === '[image]') return '📷 Photo';
            if (t.startsWith('data:video/') || t === '[video]') return '🎥 Video';
            if (t.startsWith('data:audio/') || t === '[voice message]' || t === '[audio]') return '🎤 Voice message';
            if (t) return t;
            return recipientName ? session.recipient : 'No messages yet';
          })()}
        </p>
      </div>

      {/* Timestamp */}
      <span className="text-[10px] text-muted-foreground/50 whitespace-nowrap font-medium flex-shrink-0 self-start mt-1">
        {relativeTime}
      </span>
    </div>
  );
};
