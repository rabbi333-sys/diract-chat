import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useChatHistory, useSessions, useRecipientNames, useAutoResolveNames, fetchNameFromMeta, fetchMessages, ChatMessage as ChatMessageType } from '@/hooks/useChatHistory';
import { getStoredConnection, insertMessageToExternalDb } from '@/lib/externalDb';
import { ChatMessage, parseSegments } from '@/components/ChatMessage';
import { PlatformAvatar } from '@/components/SessionList';
import { ArrowLeft, Send, Loader2, Smile, X, Mic, Square, Info, ImageIcon, BotOff, Bot, RefreshCw, Plus, ChevronUp, Paperclip, Download, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Keyboard, Play } from 'lucide-react';
import { detectPlatform, storePlatform, PLATFORM_CONFIG, Platform } from '@/lib/platformDetect';
import { useAiControl } from '@/hooks/useAiControl';
import { useTeamRole } from '@/hooks/useTeamRole';
import { Button } from '@/components/ui/button';
import { usePlatformConnections, PlatformConnection } from '@/hooks/usePlatformConnections';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

// ─── Constants ────────────────────────────────────────────────────────────────
const LS_REACTIONS_PREFIX = 'cm_reactions_';
const LS_STATUS_PREFIX    = 'cm_mstatus_';  // platformMsgId → 'sent'|'delivered'|'read'
const LS_MSG_IDX_PREFIX   = 'cm_msidx_';   // compositeKey → platformMsgId

function loadStatusStore(sid: string): Record<string, 'sent'|'delivered'|'read'> {
  try { return JSON.parse(localStorage.getItem(LS_STATUS_PREFIX + sid) || '{}') as Record<string, 'sent'|'delivered'|'read'>; }
  catch { return {}; }
}
function saveStatusStore(sid: string, s: Record<string, 'sent'|'delivered'|'read'>) {
  try { localStorage.setItem(LS_STATUS_PREFIX + sid, JSON.stringify(s)); } catch { /* quota */ }
}
function loadMsgIndex(sid: string): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(LS_MSG_IDX_PREFIX + sid) || '{}') as Record<string, string>; }
  catch { return {}; }
}
function saveMsgIndex(sid: string, idx: Record<string, string>) {
  try { localStorage.setItem(LS_MSG_IDX_PREFIX + sid, JSON.stringify(idx)); } catch { /* quota */ }
}
/** Composite key for message index: first 50 chars of text + minute-precision timestamp */
function msgIndexKey(text: string, ts: string) {
  return `${text.slice(0, 50)}|${ts.slice(0, 16)}`;
}

/**
 * Typed interface for calling Supabase against untyped (custom) tables.
 * Using `unknown` instead of `any` keeps the escape hatch explicit and narrow.
 */
type SupabaseUpsertFrom = {
  from: (table: string) => {
    upsert: (
      data: Record<string, string>,
      options: { onConflict: string }
    ) => Promise<{ error: { message: string } | null }>;
  };
};
type SupabaseSelectFrom = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => Promise<{
        data: Array<Record<string, string>> | null;
      }>;
    };
  };
};

/**
 * Persist an outbound platform message ID to the Supabase cross-device index table.
 * This allows the msgIndex to survive localStorage clearing and work across devices.
 * Required table DDL (run once in Supabase):
 *   CREATE TABLE message_platform_ids (
 *     session_id           TEXT NOT NULL,
 *     platform_message_id  TEXT NOT NULL,
 *     msg_text_prefix      TEXT NOT NULL,
 *     sent_at_minute       TEXT NOT NULL,
 *     PRIMARY KEY (session_id, platform_message_id)
 *   );
 */
async function persistPlatformIdToSupabase(
  sessionId: string,
  platformMsgId: string,
  msgText: string,
  msgTs: string
): Promise<void> {
  try {
    await (supabase as unknown as SupabaseUpsertFrom)
      .from('message_platform_ids')
      .upsert(
        {
          session_id: sessionId,
          platform_message_id: platformMsgId,
          msg_text_prefix: msgText.slice(0, 50),
          sent_at_minute: msgTs.slice(0, 16),
        },
        { onConflict: 'session_id,platform_message_id' }
      );
  } catch { /* graceful — table may not exist yet */ }
}

const QUICK_REPLIES = [
  'Thank you! Is there anything else you need?',
  'Let me check, please wait a moment',
  'Yes, I can help you with that',
  'Sorry, could you please explain in more detail?',
];
const EMOJI_LIST = ['👍','❤️','😊','🙏','👋','✅','🎉','💯','🔥','⭐','😂','🤝','👏','💪','🙌','😇'];

// ─── Gradient helper ───────────────────────────────────────────────────────────
const GRADIENTS = ['from-violet-500 to-purple-600','from-blue-500 to-cyan-600','from-emerald-500 to-teal-600','from-orange-500 to-amber-600','from-pink-500 to-rose-600','from-indigo-500 to-blue-600'];
function getGradient(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return GRADIENTS[h % GRADIENTS.length];
}

// ─── Meta API helpers ─────────────────────────────────────────────────────────

async function waPost(conn: PlatformConnection, recipient: string, body: object) {
  const phoneId = conn.phone_number_id;
  if (!phoneId) throw new Error('WhatsApp Phone Number ID not set');
  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.access_token}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient, ...body }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'WhatsApp error');
  return data;
}

async function fbPost(conn: PlatformConnection, recipient: string, message: object) {
  const res = await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${conn.access_token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipient }, message }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Facebook error');
  return data;
}

// Send typing indicator to platform (best-effort — silently ignores failures)
// WhatsApp: attempts {phone}/messages with type:"typing_on" (Cloud API experimental)
// Facebook & Instagram: sender_action via /me/messages (officially supported)
async function sendTypingAction(
  conn: PlatformConnection,
  platform: Platform,
  recipient: string,
  action: 'typing_on' | 'typing_off',
): Promise<void> {
  try {
    if (platform === 'whatsapp') {
      const phoneId = conn.phone_number_id;
      if (!phoneId) return;
      // Best-effort: WhatsApp Cloud API experimental typing indicator
      await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.access_token}` },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: recipient,
          type: action === 'typing_on' ? 'typing_on' : 'typing_off',
        }),
      });
      return;
    }
    // Facebook & Instagram: sender_action via /me/messages
    await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${conn.access_token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipient }, sender_action: action }),
    });
  } catch { /* best-effort — ignore network errors */ }
}

// Upload file to WhatsApp media → returns media_id
async function waUploadFile(conn: PlatformConnection, file: Blob, filename: string, mimeType: string): Promise<string> {
  const phoneId = conn.phone_number_id;
  if (!phoneId) throw new Error('WhatsApp Phone Number ID not set');
  const form = new FormData();
  form.append('file', file, filename);
  form.append('type', mimeType);
  form.append('messaging_product', 'whatsapp');
  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${conn.access_token}` },
    body: form,
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Upload failed');
  return data.id as string;
}

// Upload file to Facebook → returns attachment_id
async function fbUploadFile(conn: PlatformConnection, file: File, mediaType: 'image' | 'audio' | 'video' | 'file'): Promise<string> {
  const form = new FormData();
  form.append('message', JSON.stringify({ attachment: { type: mediaType, payload: {} } }));
  form.append('filedata', file, file.name);
  const res = await fetch(`https://graph.facebook.com/v19.0/me/message_attachments?access_token=${conn.access_token}`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'FB upload failed');
  return data.attachment_id as string;
}

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

// ─── Pending message tracker (for optimistic revert) ─────────────────────────
let _msgCounter = Date.now();
const nextId = () => ++_msgCounter;

// ─── Fullscreen media viewer (lightbox + video modal) ────────────────────────
interface MediaViewerProps {
  url: string;
  type: 'image' | 'video';
  allImages: string[];
  onClose: () => void;
  onNavigate: (url: string) => void;
}

function MediaViewer({ url, type, allImages, onClose, onNavigate }: MediaViewerProps) {
  const [scale, setScale] = useState(1);
  const currentIdx = type === 'image' ? allImages.indexOf(url) : -1;
  const hasPrev = currentIdx > 0;
  const hasNext = currentIdx >= 0 && currentIdx < allImages.length - 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft'  && hasPrev) onNavigate(allImages[currentIdx - 1]);
      if (e.key === 'ArrowRight' && hasNext)  onNavigate(allImages[currentIdx + 1]);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, hasPrev, hasNext, currentIdx, allImages, onNavigate]);

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center" onClick={onClose}>
      {/* Top toolbar */}
      <div className="absolute top-0 left-0 right-0 flex items-center justify-between p-3 z-10 pointer-events-none">
        <span className="text-white/50 text-sm tabular-nums">
          {currentIdx >= 0 && allImages.length > 1 ? `${currentIdx + 1} / ${allImages.length}` : ''}
        </span>
        <div className="flex items-center gap-1.5 pointer-events-auto">
          {type === 'image' && <>
            <button onClick={e => { e.stopPropagation(); setScale(s => Math.max(0.5, +(s - 0.25).toFixed(2))); }}
              className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors">
              <ZoomOut size={17} />
            </button>
            <button onClick={e => { e.stopPropagation(); setScale(s => Math.min(4, +(s + 0.25).toFixed(2))); }}
              className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors">
              <ZoomIn size={17} />
            </button>
          </>}
          <a href={url} download title="Download"
            className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
            onClick={e => e.stopPropagation()}>
            <Download size={17} />
          </a>
          <button onClick={onClose}
            className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors">
            <X size={17} />
          </button>
        </div>
      </div>

      {/* Prev arrow */}
      {hasPrev && (
        <button
          onClick={e => { e.stopPropagation(); onNavigate(allImages[currentIdx - 1]); }}
          className="absolute left-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white z-10 transition-colors">
          <ChevronLeft size={24} />
        </button>
      )}

      {/* Content */}
      <div onClick={e => e.stopPropagation()} className="flex items-center justify-center max-w-[90vw] max-h-[85vh]">
        {type === 'image' ? (
          <img
            src={url}
            alt="fullscreen"
            style={{ transform: `scale(${scale})`, transition: 'transform 0.2s', transformOrigin: 'center' }}
            className="max-w-[90vw] max-h-[85vh] object-contain rounded-xl select-none"
          />
        ) : (
          <video src={url} controls autoPlay className="max-w-[90vw] max-h-[85vh] rounded-xl" />
        )}
      </div>

      {/* Next arrow */}
      {hasNext && (
        <button
          onClick={e => { e.stopPropagation(); onNavigate(allImages[currentIdx + 1]); }}
          className="absolute right-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white z-10 transition-colors">
          <ChevronRight size={24} />
        </button>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
const Conversation = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { data: messages, isLoading, error, refetch } = useChatHistory(sessionId);
  const { data: sessions } = useSessions();
  const { data: recipientNames } = useRecipientNames();
  const { data: platformConns = [] } = usePlatformConnections();
  const { displayName: agentName } = useTeamRole();

  const [replyText, setReplyText] = useState('');
  const [localMessages, setLocalMessages] = useState<ChatMessageType[]>([]);
  const [replyingTo, setReplyingTo] = useState<ChatMessageType | null>(null);

  // ── Load More (older messages pagination) ───────────────────────────────────
  // olderMessages = pages fetched via "Load More", prepended to the DB messages
  const [olderMessages, setOlderMessages] = useState<ChatMessageType[]>([]);
  const [loadMoreOffset, setLoadMoreOffset] = useState(30);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const isLoadingMoreRef = useRef(false); // prevent auto-scroll when loading older
  // hasMore: show "Load More" if initial page was exactly 30, or last load-more was exactly 30
  const [hasMore, setHasMore] = useState(false);
  // Set hasMore once the initial fetch resolves
  useEffect(() => {
    if (!isLoading && messages) {
      setHasMore((messages.length + olderMessages.length) >= 30 && messages.length >= 30);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  const handleLoadMore = useCallback(async () => {
    if (!sessionId || isLoadingMore || !hasMore) return;
    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    try {
      // Save scroll position so we can restore it after prepend
      const container = scrollContainerRef.current;
      const prevScrollHeight = container?.scrollHeight ?? 0;

      const older = await fetchMessages(sessionId, 30, loadMoreOffset);
      if (older.length > 0) {
        setOlderMessages(prev => {
          // Deduplicate by id
          const existingIds = new Set([...prev].map(m => String(m.id)));
          const fresh = older.filter(m => !existingIds.has(String(m.id)));
          return [...fresh, ...prev];
        });
        setLoadMoreOffset(n => n + older.length);
        setHasMore(older.length >= 30);
        // Restore scroll position after DOM update (so user doesn't jump to top)
        requestAnimationFrame(() => {
          if (container) {
            container.scrollTop = container.scrollHeight - prevScrollHeight;
          }
          isLoadingMoreRef.current = false;
        });
      } else {
        setHasMore(false);
        isLoadingMoreRef.current = false;
      }
    } catch {
      isLoadingMoreRef.current = false;
    } finally {
      setIsLoadingMore(false);
    }
  }, [sessionId, isLoadingMore, hasMore, loadMoreOffset]);

  // Panel toggles
  const [showEmoji, setShowEmoji] = useState(false);
  const [showQuickReplies, setShowQuickReplies] = useState(false);

  // Upload state
  const [uploadingId, setUploadingId] = useState<number | null>(null);

  // Multi-image staging (Messenger-style)
  const [pendingFiles,    setPendingFiles]    = useState<File[]>([]);
  const [pendingPreviews, setPendingPreviews] = useState<string[]>([]);

  // Voice recording
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Media viewer (lightbox + video modal)
  const [mediaViewer, setMediaViewer] = useState<{ url: string; type: 'image' | 'video'; allImages: string[] } | null>(null);

  // ── Emoji reactions ─────────────────────────────────────────────────────────
  // Start empty; populated by the sessionId-change effect below (covers both
  // initial mount and conversation navigation without remount).
  const [reactions, setReactions] = useState<Record<string, string[]>>({});

  // ── Message status map — keyed by platformMsgId ──────────────────────────
  const [msgStatuses, setMsgStatuses] = useState<Record<string, 'sent' | 'delivered' | 'read'>>({});

  // ── Message index — compositeKey(text, ts) → platformMsgId ───────────────
  const [msgIndex, setMsgIndex] = useState<Record<string, string>>({});

  // ── Typing indicator (send) ────────────────────────────────────────────────
  const [typingActive, setTypingActive] = useState(false);
  const typingThrottleRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingOffTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Customer typing (receive) ──────────────────────────────────────────────
  const [customerTyping, setCustomerTyping] = useState(false);
  const customerTypingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const docInputRef  = useRef<HTMLInputElement>(null);
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const hasInitialScrolled = useRef(false);

  const queryClient = useQueryClient();
  const [fetchingName, setFetchingName] = useState(false);

  const searchParams = new URLSearchParams(window.location.search);
  const recipient = searchParams.get('recipient') || '';
  const displayName = recipient ? recipientNames?.[recipient] || recipient : 'Conversation';
  const nameIsId = displayName === recipient && /^\d{10,}$/.test(recipient);
  const initials = displayName.slice(0, 2).toUpperCase();
  const grad = getGradient(recipient);

  const waConn = platformConns.find(c => c.platform === 'whatsapp' && c.is_active);
  const fbConn = platformConns.find(c => c.platform === 'facebook' && c.is_active);
  const igConn = platformConns.find(c => c.platform === 'instagram' && c.is_active);

  // Look up the current session record (provides DB-level platform field if available)
  const currentSessionRecord = useMemo(
    () => sessions?.find(s => s.session_id === sessionId),
    [sessions, sessionId]
  );

  // Detect which platform this session belongs to
  const sessionPlatform: Platform = useMemo(
    () => detectPlatform(recipient, platformConns, {
      sessionId,
      dbPlatform: currentSessionRecord?.platform,
    }),
    [recipient, platformConns, sessionId, currentSessionRecord?.platform]
  );

  // Pick the connection that matches the detected platform
  const activeConn = (() => {
    switch (sessionPlatform) {
      case 'whatsapp': return waConn || fbConn || igConn;
      case 'facebook': return fbConn || igConn || waConn;
      case 'instagram': return igConn || fbConn || waConn;
      default: return waConn || fbConn || igConn;
    }
  })();

  const canReply = !!activeConn && !!recipient;
  const supportsVoice = !!(
    (sessionPlatform === 'whatsapp' && waConn) ||
    (sessionPlatform === 'facebook' && fbConn) ||
    (sessionPlatform === 'instagram' && igConn) ||
    (sessionPlatform === 'unknown' && (waConn || fbConn || igConn))
  );

  const { aiEnabled, toggle: toggleAi, isPending: aiTogglePending } = useAiControl(sessionId);

  // ── When arriving from HandoffPanel with ?disable_ai=1, immediately turn AI off ──
  const disableAiOnOpen = searchParams.get('disable_ai') === '1';
  useEffect(() => {
    if (!disableAiOnOpen || !sessionId) return;
    const qk = ['ai-control', sessionId];
    // 1. Cancel any in-flight fetch so it can't land and overwrite our write
    queryClient.cancelQueries({ queryKey: qk });
    // 2. Optimistic: set AI as OFF immediately in the UI
    queryClient.setQueryData(qk, false);
    // 3. Persist to DB
    supabase.from('ai_control').upsert(
      { session_id: sessionId, ai_enabled: false, updated_at: new Date().toISOString() },
      { onConflict: 'session_id' }
    ).then(({ error }) => {
      if (error) {
        // Revert optimistic only on real DB error
        queryClient.invalidateQueries({ queryKey: qk });
      }
      // On success: realtime subscription in useAiControl will keep cache in sync
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]); // run once on mount

  useAutoResolveNames(
    recipient ? [recipient] : [],
    recipientNames,
    platformConns
  );

  // Auto-fetch name when conversation opens and name is still an ID
  useEffect(() => {
    if (!nameIsId || fetchingName) return;
    const metaTokens = platformConns
      .filter(c => c.is_active && (c.platform === 'facebook' || c.platform === 'instagram') && c.access_token)
      .map(c => c.access_token);
    if (metaTokens.length === 0) return;

    setFetchingName(true);
    fetchNameFromMeta(recipient, metaTokens).then(name => {
      if (name) queryClient.invalidateQueries({ queryKey: ['recipient-names'] });
    }).finally(() => setFetchingName(false));
  }, [recipient, nameIsId, platformConns.length]);

  const handleFetchName = async () => {
    const metaTokens = platformConns
      .filter(c => c.is_active && (c.platform === 'facebook' || c.platform === 'instagram') && c.access_token)
      .map(c => c.access_token);
    if (metaTokens.length === 0) {
      toast.error('No active Facebook/Instagram connection found in Settings');
      return;
    }
    setFetchingName(true);
    try {
      const name = await fetchNameFromMeta(recipient, metaTokens);
      if (name) {
        await queryClient.invalidateQueries({ queryKey: ['recipient-names'] });
        toast.success(`Name resolved: ${name}`);
      } else {
        toast.error('Could not fetch name — check your access token');
      }
    } finally {
      setFetchingName(false);
    }
  };

  // Deduplicate: remove local optimistic messages already present in DB response
  const dbAgentMessages = (messages || []).filter(m => m.sender === 'Agent');
  const dbAgentTexts = new Set(dbAgentMessages.map(m => m.message_text));
  const dedupedLocal = localMessages.filter(m => {
    // Exact match — always deduplicate
    if (dbAgentTexts.has(m.message_text)) return false;
    // Blob media: suppress local preview once DB already has the real data URL version
    if (m.message_text.startsWith('blob-image:') &&
        dbAgentMessages.some(db => db.message_text?.startsWith('data:image/'))) return false;
    if (m.message_text.startsWith('blob-video:') &&
        dbAgentMessages.some(db => db.message_text?.startsWith('data:video/'))) return false;
    if (m.message_text.startsWith('blob-audio:') &&
        dbAgentMessages.some(db =>
          db.message_text?.startsWith('data:audio/') || db.message_text?.startsWith('blob-audio:'))) return false;
    if (m.message_text.startsWith('blob-doc:') &&
        dbAgentMessages.some(db => db.message_text?.startsWith('doc-data:'))) return false;
    return true;
  });

  // olderMessages prepended so the full list is chronological
  const allMessages = [...olderMessages, ...(messages || []), ...dedupedLocal];

  // Collect all image URLs in the conversation for lightbox prev/next navigation.
  // Uses parseSegments so it picks up images inside mixed text+URL messages too.
  const allImageUrls = useMemo(() => {
    const urls: string[] = [];
    for (const m of allMessages) {
      if (!m.message_text) continue;
      const segs = parseSegments(m.message_text);
      for (const seg of segs) {
        if (seg.type === 'image') urls.push(seg.url);
      }
    }
    return urls;
  }, [allMessages]);

  // Open lightbox / video modal
  const handleMediaClick = useCallback((url: string, type: 'image' | 'video') => {
    setMediaViewer({ url, type, allImages: type === 'image' ? allImageUrls : [] });
  }, [allImageUrls]);

  // Active = any message within the last 5 minutes (either party), or the DB flag as fallback
  const ACTIVE_WINDOW = 5 * 60 * 1000;
  const latestTs = allMessages.length > 0
    ? new Date(allMessages[allMessages.length - 1].timestamp).getTime()
    : 0;
  const isSessionActive =
    (latestTs > 0 && Date.now() - latestTs < ACTIVE_WINDOW) ||
    (sessions?.find(s => s.session_id === sessionId)?.is_active ?? false);

  const scrollToBottom = useCallback((instant = false) => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (instant) {
      el.scrollTop = el.scrollHeight;
      setTimeout(() => { el.scrollTop = el.scrollHeight; }, 80);
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, []);

  useEffect(() => {
    // Never auto-scroll when loading older messages — we restore position manually
    if (isLoadingMoreRef.current) return;
    if (!hasInitialScrolled.current && allMessages.length > 0) {
      hasInitialScrolled.current = true;
      scrollToBottom(true); // instant jump on first load
    } else if (hasInitialScrolled.current) {
      scrollToBottom(false); // smooth scroll for new real-time messages
    }
  }, [allMessages.length, scrollToBottom]);

  // ── Optimistic add ──────────────────────────────────────────────────────────
  const addOptimistic = (id: number, text: string, replyTo?: ChatMessageType | null) => {
    setLocalMessages(prev => [...prev, {
      id,
      session_id: sessionId || '',
      sender: 'Agent',
      message_text: text,
      timestamp: new Date().toISOString(),
      replyTo: replyTo || undefined,
      _sending: true,
    }]);
  };

  const revertOptimistic = (id: number) => {
    setLocalMessages(prev => prev.filter(m => m.id !== id));
  };

  /**
   * Mark a local optimistic message as sent.
   * Pass msgText + msgTs to index the message text/timestamp → platformMsgId mapping,
   * which allows DB-fetched messages (lacking _platformMsgId) to show their status.
   */
  const markSent = (id: number, platformMsgId?: string, msgText?: string, msgTs?: string) => {
    setLocalMessages(prev => prev.map(m => m.id === id
      ? { ...m, _sending: false, _status: 'sent' as const, _platformMsgId: platformMsgId }
      : m
    ));
    setMsgStatuses(prev => {
      const next = { ...prev, [String(id)]: 'sent' as const };
      if (platformMsgId) next[platformMsgId] = 'sent';
      return next;
    });
    // Index: compositeKey(text, ts) → platformMsgId so DB messages can look up status
    if (platformMsgId && msgText && msgTs) {
      setMsgIndex(prev => ({ ...prev, [msgIndexKey(msgText, msgTs)]: platformMsgId }));
      // Also persist to Supabase for cross-device, cross-localStorage durability
      if (sessionId) {
        void persistPlatformIdToSupabase(sessionId, platformMsgId, msgText, msgTs);
      }
    }
  };

  const markDelivered = (id: number | string) => {
    setLocalMessages(prev => prev.map(m => String(m.id) === String(id) ? { ...m, _status: 'delivered' as const } : m));
    setMsgStatuses(prev => ({ ...prev, [String(id)]: 'delivered' }));
  };

  const markRead = (id: number | string) => {
    setLocalMessages(prev => prev.map(m => String(m.id) === String(id) ? { ...m, _status: 'read' as const } : m));
    setMsgStatuses(prev => ({ ...prev, [String(id)]: 'read' }));
  };

  // ── Per-session store lifecycle ────────────────────────────────────────────
  // Runs on initial mount AND whenever sessionId changes (conversation navigation).
  // 1. Loads per-session stores from localStorage (instant, synchronous).
  // 2. Hydrates msgStatuses from Supabase message_status table for historical
  //    delivery/read events that were persisted by the webhook backend.
  //    Requires a `message_status` table with PK (session_id, platform_message_id).
  //    Falls back gracefully if the table does not exist.
  useEffect(() => {
    if (!sessionId) return;

    // Reset + reload from localStorage for this session
    setReactions(() => {
      try {
        const raw = localStorage.getItem(LS_REACTIONS_PREFIX + sessionId);
        return raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
      } catch { return {}; }
    });
    const localStatuses = loadStatusStore(sessionId);
    setMsgStatuses(localStatuses);
    setMsgIndex(loadMsgIndex(sessionId));

    // Hydrate historical statuses and cross-device msgIndex from Supabase tables.
    // Both operations are merged under local state (local wins on conflict).
    void (async () => {
      const sb = supabase as unknown as SupabaseSelectFrom;
      try {
        // 1. Hydrate message statuses from message_status table
        const { data: statusData } = await sb
          .from('message_status')
          .select('platform_message_id, status')
          .eq('session_id', sessionId);
        if (statusData && statusData.length > 0) {
          const remote: Record<string, 'sent' | 'delivered' | 'read'> = {};
          for (const row of statusData) {
            if (row.platform_message_id && row.status && row.status !== 'reaction') {
              remote[row.platform_message_id] = row.status as 'sent' | 'delivered' | 'read';
            }
          }
          if (Object.keys(remote).length > 0) {
            setMsgStatuses(prev => ({ ...remote, ...prev }));
          }
        }
      } catch { /* message_status table may not exist — no-op */ }

      try {
        // 2. Hydrate cross-device msgIndex from message_platform_ids table.
        //    This allows status/reaction lookups to work on any device, even if
        //    localStorage was cleared or the user opened the session fresh.
        const { data: idxData } = await sb
          .from('message_platform_ids')
          .select('platform_message_id, msg_text_prefix, sent_at_minute')
          .eq('session_id', sessionId);
        if (idxData && idxData.length > 0) {
          const remoteIdx: Record<string, string> = {};
          for (const row of idxData) {
            if (row.platform_message_id && row.msg_text_prefix && row.sent_at_minute) {
              remoteIdx[msgIndexKey(row.msg_text_prefix, row.sent_at_minute)] = row.platform_message_id;
            }
          }
          if (Object.keys(remoteIdx).length > 0) {
            setMsgIndex(prev => ({ ...remoteIdx, ...prev }));
          }
        }
      } catch { /* message_platform_ids table may not exist — localStorage index still applies */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Persist reactions to localStorage whenever they change
  useEffect(() => {
    if (!sessionId) return;
    try { localStorage.setItem(LS_REACTIONS_PREFIX + sessionId, JSON.stringify(reactions)); }
    catch { /* ignore quota errors */ }
  }, [reactions, sessionId]);

  // Persist message statuses (keyed by platformMsgId) to localStorage
  useEffect(() => {
    if (!sessionId) return;
    saveStatusStore(sessionId, msgStatuses);
  }, [msgStatuses, sessionId]);

  // Persist message index (text+ts composite → platformMsgId) to localStorage
  useEffect(() => {
    if (!sessionId) return;
    saveMsgIndex(sessionId, msgIndex);
  }, [msgIndex, sessionId]);

  // Refs to track the active Supabase channels so rapid sessionId changes do not
  // leave stale subscriptions open (Supabase has a per-client channel limit).
  const typingChannelRef    = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const msgStatusChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Subscribe to Supabase realtime for customer typing events
  useEffect(() => {
    if (!sessionId) return;

    // Clean up any previous channel before creating a new one
    if (typingChannelRef.current) {
      supabase.removeChannel(typingChannelRef.current);
      typingChannelRef.current = null;
    }

    const channel = supabase
      .channel(`typing:${sessionId}`)
      .on('broadcast', { event: 'typing' }, () => {
        setCustomerTyping(true);
        if (customerTypingTimerRef.current) clearTimeout(customerTypingTimerRef.current);
        customerTypingTimerRef.current = setTimeout(() => setCustomerTyping(false), 5000);
      })
      .subscribe();

    typingChannelRef.current = channel;

    return () => {
      typingChannelRef.current = null;
      supabase.removeChannel(channel);
      if (customerTypingTimerRef.current) clearTimeout(customerTypingTimerRef.current);
    };
  }, [sessionId]);

  // Subscribe to Supabase realtime for message status updates (delivered/read)
  // and incoming customer reactions forwarded via webhook pipeline
  useEffect(() => {
    if (!sessionId) return;

    // Clean up any previous channel before creating a new one
    if (msgStatusChannelRef.current) {
      supabase.removeChannel(msgStatusChannelRef.current);
      msgStatusChannelRef.current = null;
    }

    const channel = supabase
      .channel(`msg_status:${sessionId}`)
      .on('broadcast', { event: 'delivered' }, (payload: { payload?: { message_id?: string; message_ids?: string[] } }) => {
        // message_ids contains all concrete FB delivery mids when multiple messages
        // were delivered in one webhook; message_id is the first/primary one.
        const { message_id, message_ids } = payload?.payload ?? {};
        const ids = message_ids ?? (message_id ? [message_id] : []);
        ids.forEach(id => markDelivered(id));
      })
      .on('broadcast', { event: 'read' }, (payload: { payload?: { message_id?: string } }) => {
        const msgId = payload?.payload?.message_id;
        if (msgId) markRead(msgId);
      })
      .on('broadcast', { event: 'read_watermark' }, (payload: { payload?: { watermark?: number; message_id?: string } }) => {
        // FB/IG read receipts carry a watermark (Unix ms) indicating all messages
        // delivered before that time have been read by the recipient.
        const raw = payload?.payload;
        const watermark: number | undefined =
          raw?.watermark ??
          // Fallback: parse from the synthetic 'fb_watermark:xxxxx' message_id
          (raw?.message_id?.startsWith('fb_watermark:')
            ? Number(raw.message_id.replace('fb_watermark:', ''))
            : undefined);
        if (!watermark || isNaN(watermark)) return;
        // Collect platform IDs for messages before the watermark while updating status
        const platIdsToRead: string[] = [];
        setLocalMessages(prev => prev.map(m => {
          if (
            (m.sender === 'Agent' || m.sender === 'AI') &&
            new Date(m.timestamp).getTime() <= watermark
          ) {
            // Resolve platform ID using all available sources
            const platId =
              m._platformMsgId ||
              m.platform_message_id ||
              msgIndex[msgIndexKey(m.message_text, m.timestamp || '')];
            if (platId) platIdsToRead.push(platId);
            return { ...m, _status: 'read' as const };
          }
          return m;
        }));
        // Update msgStatuses for the resolved platform IDs
        if (platIdsToRead.length > 0) {
          setMsgStatuses(prev => {
            const next = { ...prev };
            for (const platId of platIdsToRead) {
              next[platId] = 'read';
            }
            return next;
          });
        }
      })
      .on('broadcast', { event: 'reaction' }, (payload: { payload?: { message_id?: string; emoji?: string } }) => {
        const { message_id, emoji } = payload?.payload ?? {};
        if (!message_id || !emoji) return;
        setReactions(prev => {
          const existing = prev[message_id] || [];
          return { ...prev, [message_id]: [...existing, emoji] };
        });
      })
      .subscribe();

    msgStatusChannelRef.current = channel;

    return () => {
      msgStatusChannelRef.current = null;
      supabase.removeChannel(channel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ── Remove a staged image ──────────────────────────────────────────────────
  const removePendingFile = useCallback((index: number) => {
    setPendingPreviews(prev => { URL.revokeObjectURL(prev[index]); return prev.filter((_, i) => i !== index); });
    setPendingFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  // ── Typing indicator (agent → customer) ───────────────────────────────────
  const handleTyping = useCallback(() => {
    if (!activeConn || !recipient) return;
    // Throttle: send typing_on at most once per 3 seconds
    if (!typingThrottleRef.current) {
      sendTypingAction(activeConn, sessionPlatform, recipient, 'typing_on');
      setTypingActive(true);
      typingThrottleRef.current = setTimeout(() => {
        typingThrottleRef.current = null;
      }, 3000);
    }
    // Auto-send typing_off 5 seconds after last keystroke
    if (typingOffTimerRef.current) clearTimeout(typingOffTimerRef.current);
    typingOffTimerRef.current = setTimeout(() => {
      if (activeConn) sendTypingAction(activeConn, sessionPlatform, recipient, 'typing_off');
      setTypingActive(false);
    }, 5000);
  }, [activeConn, recipient, sessionPlatform]);

  const stopTypingIndicator = useCallback(() => {
    if (typingOffTimerRef.current) clearTimeout(typingOffTimerRef.current);
    if (typingThrottleRef.current) clearTimeout(typingThrottleRef.current);
    typingThrottleRef.current = null;
    typingOffTimerRef.current = null;
    if (typingActive && activeConn && recipient) {
      sendTypingAction(activeConn, sessionPlatform, recipient, 'typing_off');
    }
    setTypingActive(false);
  }, [typingActive, activeConn, recipient, sessionPlatform]);

  // ── Emoji reactions ────────────────────────────────────────────────────────
  const handleReact = useCallback(async (msg: ChatMessageType, emoji: string) => {
    // Resolve the real platform message ID — checked in priority order:
    // 1. _platformMsgId — set on optimistic messages right after send
    // 2. platform_message_id — extracted directly from the DB row by normalizeRow
    //    (available when n8n stores wamid/mid in the message record)
    // 3. msgIndex lookup — cross-device index persisted to Supabase message_platform_ids
    //    table and also kept in localStorage; covers outbound DB-fetched messages
    const resolvedPlatId =
      msg._platformMsgId ||
      msg.platform_message_id ||
      msgIndex[msgIndexKey(msg.message_text, msg.timestamp || '')];

    // Storage key for reactions — prefer platformId so UI and webhook events share it
    const reactionKey = resolvedPlatId || String(msg.id);

    setReactions(prev => {
      const existing = prev[reactionKey] || [];
      // Toggle: if already reacted with same emoji, remove it; otherwise add
      const updated = existing.includes(emoji)
        ? existing.filter(e => e !== emoji)
        : [...existing, emoji];
      return { ...prev, [reactionKey]: updated };
    });

    // Platform send: WhatsApp supports reactions via Cloud API (message type "reaction").
    // Facebook Messenger and Instagram do NOT expose a public send-reaction endpoint.
    // We only call the WA API when resolvedPlatId is a confirmed platform ID (wamid)
    // — never with numeric local optimistic IDs, which the API would reject.
    try {
      if (sessionPlatform === 'whatsapp' && waConn && resolvedPlatId) {
        await waPost(waConn, recipient, {
          type: 'reaction',
          reaction: { message_id: resolvedPlatId, emoji },
        });
      }
      // Facebook/Instagram: no public reaction-send API — UI/localStorage only.
    } catch { /* best-effort — reactions are always stored locally regardless */ }
  }, [sessionPlatform, waConn, recipient, msgIndex]);

  // ── Unified send (text + optional staged images) ───────────────────────────
  const handleSend = () => {
    const text = replyText.trim();
    const files = pendingFiles;
    if (!text && !files.length) return;
    if (!activeConn) { toast.error('Add a connection in Settings first'); return; }

    const rt = replyingTo;

    // Clear inputs instantly + stop typing indicator
    stopTypingIndicator();
    setReplyText('');
    setPendingFiles([]);
    setPendingPreviews(prev => { prev.forEach(URL.revokeObjectURL); return []; });
    setReplyingTo(null);
    setShowEmoji(false);
    setShowQuickReplies(false);
    inputRef.current?.focus();

    (async () => {
      const hasFiles = files.length > 0;

      if (hasFiles) {
        // When media is staged: send files first.
        // WhatsApp: caption is embedded in the first media message.
        // FB/IG: caption is sent as a separate text after all media.
        const isWa = sessionPlatform === 'whatsapp' || (!sessionPlatform && !!waConn && !fbConn && !igConn);
        const [firstFile, ...restFiles] = files;
        // First file gets caption (WA embeds it; FB/IG ignores, sends separately below)
        await handleFileSelected(firstFile, text || undefined);
        for (const file of restFiles) {
          await handleFileSelected(file);
        }
        // For non-WA platforms: send caption text as a follow-up message after media
        if (text && !isWa) {
          const id = nextId();
          const sentTs = new Date().toISOString();
          addOptimistic(id, text, rt);
          insertMessageToExternalDb(getStoredConnection(), {
            session_id: sessionId || '',
            sender: 'Agent',
            message_text: text,
            timestamp: sentTs,
            recipient,
          });
          try {
            let platformMsgId: string | undefined;
            if (sessionPlatform === 'instagram') {
              if (!igConn) throw new Error('Instagram connection not configured');
              const r = await fbPost(igConn, recipient, { text });
              platformMsgId = r?.message_id;
            } else if (sessionPlatform === 'facebook') {
              if (!fbConn) throw new Error('Facebook connection not configured');
              const r = await fbPost(fbConn, recipient, { text });
              platformMsgId = r?.message_id;
            } else {
              const metaConn = fbConn || igConn;
              if (!metaConn) throw new Error('No messaging connection configured');
              const r = await fbPost(metaConn, recipient, { text });
              platformMsgId = r?.message_id;
            }
            storePlatform(recipient, sessionPlatform);
            markSent(id, platformMsgId, text, sentTs);
            await queryClient.invalidateQueries({ queryKey: ['chat-history', sessionId] });
            queryClient.invalidateQueries({ queryKey: ['sessions'] });
            revertOptimistic(id);
          } catch (err: unknown) {
            revertOptimistic(id);
            toast.error(err instanceof Error ? err.message : 'Failed to send');
          }
        }
      } else if (text) {
        // Text-only message
        const id = nextId();
        const sentTs = new Date().toISOString();
        addOptimistic(id, text, rt);
        insertMessageToExternalDb(getStoredConnection(), {
          session_id: sessionId || '',
          sender: 'Agent',
          message_text: text,
          timestamp: sentTs,
          recipient,
        });
        try {
          let platformMsgId: string | undefined;
          if (sessionPlatform === 'instagram') {
            if (!igConn) throw new Error('Instagram connection not configured');
            const r = await fbPost(igConn, recipient, { text });
            platformMsgId = r?.message_id;
          } else if (sessionPlatform === 'facebook') {
            if (!fbConn) throw new Error('Facebook connection not configured');
            const r = await fbPost(fbConn, recipient, { text });
            platformMsgId = r?.message_id;
          } else if (sessionPlatform === 'whatsapp') {
            if (!waConn) throw new Error('WhatsApp connection not configured');
            const r = await waPost(waConn, recipient, { type: 'text', text: { body: text } });
            platformMsgId = (r?.messages as Array<{id: string}>)?.[0]?.id;
          } else {
            if (waConn) {
              const r = await waPost(waConn, recipient, { type: 'text', text: { body: text } });
              platformMsgId = (r?.messages as Array<{id: string}>)?.[0]?.id;
            } else if (fbConn) {
              const r = await fbPost(fbConn, recipient, { text });
              platformMsgId = r?.message_id;
            } else if (igConn) {
              const r = await fbPost(igConn, recipient, { text });
              platformMsgId = r?.message_id;
            } else throw new Error('No messaging connection configured');
          }
          storePlatform(recipient, sessionPlatform);
          markSent(id, platformMsgId, text, sentTs);
          await queryClient.invalidateQueries({ queryKey: ['chat-history', sessionId] });
          queryClient.invalidateQueries({ queryKey: ['sessions'] });
          revertOptimistic(id);
        } catch (err: unknown) {
          revertOptimistic(id);
          toast.error(err instanceof Error ? err.message : 'Failed to send');
        }
      }
    })();
  };

  // ── Send image from file picker ─────────────────────────────────────────────
  // caption: shown on WhatsApp alongside the media; ignored on FB/IG (text sent separately)
  const handleFileSelected = useCallback(async (file: File, caption?: string) => {
    if (!activeConn) { toast.error('Add a connection in Settings first'); return; }
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    const isAudio = file.type.startsWith('audio/');
    const mediaType: 'image' | 'audio' | 'video' = isImage ? 'image' : isAudio ? 'audio' : 'video';

    // Optimistic: show local preview instantly
    // Prefix the blob URL so ChatMessage knows the media type
    const rawUrl = URL.createObjectURL(file);
    const prefix = isImage ? 'blob-image:' : isVideo ? 'blob-video:' : 'blob-audio:';
    const localUrl = prefix + rawUrl;
    const id = nextId();
    addOptimistic(id, localUrl, replyingTo);
    setReplyingTo(null);
    setUploadingId(id);

    try {
      const dataUrl = await fileToDataUrl(file);
      // Capture timestamp once — used in DB insert AND in the status index
      const sentTs = new Date().toISOString();
      // Await DB write so the data URL is committed before we refetch
      await insertMessageToExternalDb(getStoredConnection(), {
        session_id: sessionId || '',
        sender: 'Agent',
        message_text: dataUrl,
        timestamp: sentTs,
        recipient,
      });
      let platformMsgId: string | undefined;
      if (sessionPlatform === 'whatsapp') {
        if (!waConn) throw new Error('WhatsApp connection not configured');
        const mediaId = await waUploadFile(waConn, file, file.name, file.type);
        const waType = isImage ? 'image' : isAudio ? 'audio' : 'video';
        // WhatsApp supports caption on image & video (not audio)
        const captionField = caption && (isImage || isVideo) ? { caption } : {};
        const r = await waPost(waConn, recipient, { type: waType, [waType]: { id: mediaId, ...captionField } });
        platformMsgId = (r?.messages as Array<{id: string}>)?.[0]?.id;
      } else if (sessionPlatform === 'instagram') {
        if (!igConn) throw new Error('Instagram connection not configured');
        const attachId = await fbUploadFile(igConn, file, mediaType);
        const r = await fbPost(igConn, recipient, { attachment: { type: mediaType, payload: { attachment_id: attachId } } });
        platformMsgId = r?.message_id;
      } else if (sessionPlatform === 'facebook') {
        if (!fbConn) throw new Error('Facebook connection not configured');
        const attachId = await fbUploadFile(fbConn, file, mediaType);
        const r = await fbPost(fbConn, recipient, { attachment: { type: mediaType, payload: { attachment_id: attachId } } });
        platformMsgId = r?.message_id;
      } else {
        // unknown: prefer WA, fall back to Meta
        if (waConn) {
          const mediaId = await waUploadFile(waConn, file, file.name, file.type);
          const waType = isImage ? 'image' : isAudio ? 'audio' : 'video';
          const captionField = caption && (isImage || isVideo) ? { caption } : {};
          const r = await waPost(waConn, recipient, { type: waType, [waType]: { id: mediaId, ...captionField } });
          platformMsgId = (r?.messages as Array<{id: string}>)?.[0]?.id;
        } else {
          const metaConn = fbConn || igConn;
          if (!metaConn) throw new Error('No messaging connection configured');
          const attachId = await fbUploadFile(metaConn, file, mediaType);
          const r = await fbPost(metaConn, recipient, { attachment: { type: mediaType, payload: { attachment_id: attachId } } });
          platformMsgId = r?.message_id;
        }
      }
      storePlatform(recipient, sessionPlatform);
      // Index dataUrl so DB-fetched version of this message can look up its status
      markSent(id, platformMsgId, dataUrl, sentTs);
      // Remove local blob BEFORE refetching so the optimistic and the DB
      // version never appear at the same time (fixes double-video bug).
      revertOptimistic(id);
      URL.revokeObjectURL(rawUrl);
      // Refetch DB — the data URL version now shows in its place
      await queryClient.invalidateQueries({ queryKey: ['chat-history', sessionId] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    } catch (err: unknown) {
      revertOptimistic(id);
      URL.revokeObjectURL(rawUrl);
      toast.error(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setUploadingId(null);
    }
  }, [activeConn, waConn, fbConn, igConn, recipient, replyingTo, sessionId, sessionPlatform]);

  // ── Send document from file picker ──────────────────────────────────────────
  const handleDocSelected = useCallback(async (file: File) => {
    if (!activeConn) { toast.error('Add a connection in Settings first'); return; }
    const blobUrl = URL.createObjectURL(file);
    const localText = `blob-doc:${file.name}|||${file.size}|||${blobUrl}`;
    const id = nextId();
    addOptimistic(id, localText, replyingTo);
    setReplyingTo(null);
    setUploadingId(id);
    try {
      const dataUrl = await fileToDataUrl(file);
      const storedText = `doc-data:${file.name}|||${file.size}|||${dataUrl}`;
      // Capture timestamp once for consistency between DB and status index
      const sentTs = new Date().toISOString();
      await insertMessageToExternalDb(getStoredConnection(), {
        session_id: sessionId || '',
        sender: 'Agent',
        message_text: storedText,
        timestamp: sentTs,
        recipient,
      });
      let platformMsgId: string | undefined;
      if (sessionPlatform === 'whatsapp' && waConn) {
        const mediaId = await waUploadFile(waConn, file, file.name, file.type);
        const r = await waPost(waConn, recipient, { type: 'document', document: { id: mediaId, filename: file.name } });
        platformMsgId = (r?.messages as Array<{id: string}>)?.[0]?.id;
      } else if (sessionPlatform === 'facebook' && fbConn) {
        const attachId = await fbUploadFile(fbConn, file, 'file');
        const r = await fbPost(fbConn, recipient, { attachment: { type: 'file', payload: { attachment_id: attachId } } });
        platformMsgId = r?.message_id;
      } else if (sessionPlatform === 'instagram' && igConn) {
        const attachId = await fbUploadFile(igConn, file, 'file');
        const r = await fbPost(igConn, recipient, { attachment: { type: 'file', payload: { attachment_id: attachId } } });
        platformMsgId = r?.message_id;
      } else if (sessionPlatform === 'unknown') {
        if (waConn) {
          const mediaId = await waUploadFile(waConn, file, file.name, file.type);
          const r = await waPost(waConn, recipient, { type: 'document', document: { id: mediaId, filename: file.name } });
          platformMsgId = (r?.messages as Array<{id: string}>)?.[0]?.id;
        } else {
          const metaConn = fbConn || igConn;
          if (!metaConn) throw new Error('No messaging connection configured');
          const attachId = await fbUploadFile(metaConn, file, 'file');
          const r = await fbPost(metaConn, recipient, { attachment: { type: 'file', payload: { attachment_id: attachId } } });
          platformMsgId = r?.message_id;
        }
      } else {
        throw new Error('No connection available for this platform');
      }
      storePlatform(recipient, sessionPlatform);
      // Index storedText so DB-fetched version of this document can look up its status
      markSent(id, platformMsgId, storedText, sentTs);
      revertOptimistic(id);
      URL.revokeObjectURL(blobUrl);
      await queryClient.invalidateQueries({ queryKey: ['chat-history', sessionId] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    } catch (err: unknown) {
      revertOptimistic(id);
      URL.revokeObjectURL(blobUrl);
      toast.error(err instanceof Error ? err.message : 'Failed to send document');
    } finally {
      setUploadingId(null);
    }
  }, [activeConn, waConn, fbConn, igConn, recipient, replyingTo, sessionId, sessionPlatform]);

  // ── Voice recording ─────────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
        ? 'audio/ogg;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const mr = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mr;
      audioChunksRef.current = [];
      mr.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mr.start(200);
      setRecording(true);
      setRecordingSeconds(0);
      recordTimerRef.current = setInterval(() => setRecordingSeconds(s => s + 1), 1000);
    } catch {
      toast.error('Allow microphone access (browser permission)');
    }
  }, []);

  const stopAndSendVoice = useCallback(async () => {
    const mr = mediaRecorderRef.current;
    if (!mr || !recording) return;
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    setRecording(false);
    setRecordingSeconds(0);

    await new Promise<void>(res => { mr.onstop = () => res(); mr.stop(); });
    mr.stream.getTracks().forEach(t => t.stop());

    const mimeType = mr.mimeType || 'audio/webm';
    const blob = new Blob(audioChunksRef.current, { type: mimeType });
    if (blob.size < 500) { toast.error('Recording too short, please try again'); return; }
    if (!activeConn) { toast.error('Add a connection in Settings first'); return; }

    // Optimistic: show audio player immediately
    const localUrl = URL.createObjectURL(blob);
    const id = nextId();
    const rt = replyingTo;
    addOptimistic(id, localUrl, rt);
    setReplyingTo(null);
    setUploadingId(id);

    (async () => {
      try {
        const audioDataUrl = await fileToDataUrl(blob);
        // Capture timestamp once for consistency between DB and status index
        const sentTs = new Date().toISOString();
        // Await DB write so data URL is committed before refetch
        await insertMessageToExternalDb(getStoredConnection(), {
          session_id: sessionId || '',
          sender: 'Agent',
          message_text: audioDataUrl,
          timestamp: sentTs,
          recipient,
        });
        const ext = mimeType.includes('ogg') ? 'voice.ogg' : mimeType.includes('mp4') ? 'voice.mp4' : 'voice.webm';
        const uploadMime = mimeType.includes('ogg') ? 'audio/ogg' : mimeType.includes('mp4') ? 'audio/mp4' : 'audio/webm';
        const audioFile = new File([blob], ext, { type: uploadMime });

        let platformMsgId: string | undefined;
        if (sessionPlatform === 'whatsapp' && waConn) {
          const mediaId = await waUploadFile(waConn, blob, ext, uploadMime);
          const r = await waPost(waConn, recipient, { type: 'audio', audio: { id: mediaId } });
          platformMsgId = (r?.messages as Array<{id: string}>)?.[0]?.id;
          storePlatform(recipient, 'whatsapp');
        } else if (sessionPlatform === 'facebook' && fbConn) {
          const attachId = await fbUploadFile(fbConn, audioFile, 'audio');
          const r = await fbPost(fbConn, recipient, { attachment: { type: 'audio', payload: { attachment_id: attachId } } });
          platformMsgId = r?.message_id;
          storePlatform(recipient, 'facebook');
        } else if (sessionPlatform === 'instagram' && igConn) {
          const attachId = await fbUploadFile(igConn, audioFile, 'audio');
          const r = await fbPost(igConn, recipient, { attachment: { type: 'audio', payload: { attachment_id: attachId } } });
          platformMsgId = r?.message_id;
          storePlatform(recipient, 'instagram');
        } else if (sessionPlatform === 'unknown') {
          if (waConn) {
            const mediaId = await waUploadFile(waConn, blob, ext, uploadMime);
            const r = await waPost(waConn, recipient, { type: 'audio', audio: { id: mediaId } });
            platformMsgId = (r?.messages as Array<{id: string}>)?.[0]?.id;
          } else {
            const metaConn = fbConn || igConn;
            if (!metaConn) throw new Error('No messaging connection configured');
            const attachId = await fbUploadFile(metaConn, audioFile, 'audio');
            const r = await fbPost(metaConn, recipient, { attachment: { type: 'audio', payload: { attachment_id: attachId } } });
            platformMsgId = r?.message_id;
          }
        } else {
          throw new Error('No connection available for this platform');
        }
        // Index audioDataUrl so the DB-fetched voice message can look up its status
        markSent(id, platformMsgId, audioDataUrl, sentTs);
        await queryClient.invalidateQueries({ queryKey: ['chat-history', sessionId] });
        queryClient.invalidateQueries({ queryKey: ['sessions'] });
        revertOptimistic(id);
        URL.revokeObjectURL(localUrl);
      } catch (err: unknown) {
        revertOptimistic(id);
        URL.revokeObjectURL(localUrl);
        toast.error(err instanceof Error ? err.message : 'Failed to send voice');
      } finally {
        setUploadingId(null);
      }
    })();
  }, [recording, activeConn, waConn, fbConn, igConn, recipient, replyingTo, sessionId, sessionPlatform]);

  const cancelRecording = useCallback(() => {
    if (!mediaRecorderRef.current) return;
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    try { mediaRecorderRef.current.stop(); mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop()); } catch {}
    setRecording(false);
    setRecordingSeconds(0);
  }, []);

  const fmtSec = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  // ── Loading / Error ─────────────────────────────────────────────────────────
  // Only show the skeleton when there is truly no data yet (first open, nothing
  // in cache). With eager prefetch + placeholderData this should almost never
  // show — the vast majority of opens will have cached messages immediately.
  if (isLoading && !messages?.length) return (
    <div className="h-screen flex flex-col bg-background">
      <div className="h-14 px-4 flex items-center gap-3 border-b border-border/50">
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={() => navigate('/')}><ArrowLeft size={18} /></Button>
        <div className="h-9 w-9 rounded-full bg-muted animate-pulse" />
        <div className="space-y-1.5"><div className="h-3.5 w-28 bg-muted rounded animate-pulse" /><div className="h-2.5 w-16 bg-muted rounded animate-pulse" /></div>
      </div>
      <div className="flex-1 p-4 space-y-3">
        {[false,true,false,true].map((r,i) => (
          <div key={i} className={`flex ${r?'justify-end':'justify-start'} items-end gap-2`}>
            {!r && <div className="w-7 h-7 rounded-full bg-muted animate-pulse" />}
            <div className={`h-12 rounded-2xl bg-muted animate-pulse ${r?'w-44':'w-52'}`} />
          </div>
        ))}
      </div>
    </div>
  );

  // Only show the error screen when there's an error AND no cached/placeholder
  // messages to display. If we have previous data (placeholderData), let it
  // render normally below — a subtle banner handles the error.
  if (error && !messages?.length) return (
    <div className="h-screen flex flex-col bg-background">
      <div className="h-14 px-4 flex items-center gap-3 border-b border-border">
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={() => navigate('/')}><ArrowLeft size={18} /></Button>
        <div className="flex flex-col min-w-0">
          <span className="font-semibold text-sm truncate">{displayName}</span>
          {sessionId && <span className="text-xs text-muted-foreground truncate">{sessionId}</span>}
        </div>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground text-sm">
        <span>Could not load messages</span>
        <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
      </div>
    </div>
  );

  // ── Message grouping ──────────────────────────────────────────────────────
  // Determines isFirst / isLast for each message in a consecutive-sender group
  const groupedMessages = allMessages.map((msg, i) => {
    const prev = allMessages[i - 1];
    const next = allMessages[i + 1];
    const isFirst = !prev || prev.sender !== msg.sender;
    const isLast  = !next || next.sender !== msg.sender;
    return { msg, isFirst, isLast };
  });

  return (
    <div className="h-screen flex flex-col bg-background">

      {/* Hidden file input — multiple for images; single for video/audio */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,video/*,audio/*"
        className="hidden"
        onChange={e => {
          const files = Array.from(e.target.files || []);
          e.target.value = '';
          if (!files.length) return;
          const stageable = files.filter(f => f.type.startsWith('image/') || f.type.startsWith('video/'));
          const audio = files.filter(f => f.type.startsWith('audio/'));
          // Audio → send immediately (no caption support)
          audio.forEach(f => handleFileSelected(f));
          // Images & videos → stage in thumbnail strip for caption
          if (stageable.length) {
            const previews = stageable.map(f => URL.createObjectURL(f));
            setPendingFiles(prev => [...prev, ...stageable]);
            setPendingPreviews(prev => [...prev, ...previews]);
            // Auto-focus text input so user can type a caption right away
            setTimeout(() => inputRef.current?.focus(), 50);
          }
        }}
      />
      {/* Hidden document input */}
      <input
        ref={docInputRef}
        type="file"
        accept="application/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.ppt,.pptx,.zip,.rar"
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) handleDocSelected(file);
        }}
      />

      {/* ── Header ───────────────────────────────────────────────────────────── */}
      <header className="flex-shrink-0 border-b border-border/30 bg-background/95 backdrop-blur-sm">
        <div className="h-[60px] px-2 md:px-3 flex items-center gap-2 max-w-3xl mx-auto w-full">
          <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full hover:bg-muted flex-shrink-0" onClick={() => navigate('/')}>
            <ArrowLeft size={19} />
          </Button>

          {/* Avatar */}
          <div className="relative flex-shrink-0">
            {sessionPlatform !== 'unknown' ? (
              <PlatformAvatar platform={sessionPlatform} sizePx={40} />
            ) : (
              <div className={cn('w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-bold shadow bg-gradient-to-br', grad)}>
                {initials}
              </div>
            )}
            <span className={cn('absolute -bottom-0.5 -left-0.5 w-3 h-3 rounded-full border-2 border-background', isSessionActive ? 'bg-emerald-500' : 'bg-zinc-400')} />
          </div>

          {/* Name + status */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h2 className="font-bold text-foreground text-[15px] truncate leading-tight">{displayName}</h2>
              {nameIsId && (
                <button
                  onClick={handleFetchName}
                  disabled={fetchingName}
                  title="Fetch real name from Facebook"
                  className="flex-shrink-0 p-1 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                >
                  <RefreshCw size={11} className={fetchingName ? 'animate-spin' : ''} />
                </button>
              )}
              {/* Platform chip */}
              {sessionPlatform !== 'unknown' && (() => {
                const cfg = PLATFORM_CONFIG[sessionPlatform];
                const chipBg = cfg.gradient ? cfg.gradient : cfg.color + '22';
                const chipColor = cfg.gradient ? '#fff' : cfg.color;
                return (
                  <span
                    className="flex-shrink-0 flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                    style={{ background: chipBg, color: chipColor }}
                  >
                    {sessionPlatform === 'whatsapp' && (
                      <svg viewBox="0 0 20 20" fill="none" className="w-2.5 h-2.5">
                        <path d="M10 2C5.6 2 2 5.6 2 10c0 1.4.4 2.8 1 4l-1.1 3.9L5.9 17c1.2.6 2.5 1 4.1 1 4.4 0 8-3.6 8-8s-3.6-8-8-8zm4.5 8.75c-.2-.1-.95-.47-1.1-.52-.15-.06-.26-.09-.37.08-.11.17-.42.52-.51.63-.1.11-.19.12-.35.04-.94-.47-1.56-.84-2.18-1.9-.17-.29.17-.27.48-.9.05-.1.03-.2-.01-.27-.04-.08-.37-.9-.51-1.23-.13-.33-.27-.28-.37-.29-.1 0-.21-.02-.32-.02s-.29.04-.44.22c-.15.17-.58.57-.58 1.38s.59 1.6.68 1.71c.08.11 1.16 1.77 2.82 2.48.39.17.7.27.94.35.4.12.76.1 1.04.06.32-.05.98-.4 1.12-.79.14-.39.14-.73.1-.8-.04-.07-.15-.11-.32-.19z" fill="currentColor"/>
                      </svg>
                    )}
                    {sessionPlatform === 'facebook' && (
                      <svg viewBox="0 0 20 20" fill="none" className="w-2.5 h-2.5">
                        <path d="M12 6.5h-1.5C10 6.5 10 7 10 7.5V9h2l-.3 2H10v5H8v-5H6V9h2V7.5C8 5.6 9.3 5 11 5h1v1.5z" fill="currentColor"/>
                      </svg>
                    )}
                    {sessionPlatform === 'instagram' && (
                      <svg viewBox="0 0 20 20" fill="none" className="w-2.5 h-2.5">
                        <rect x="3.5" y="3.5" width="13" height="13" rx="3.5" stroke="currentColor" strokeWidth="2" fill="none"/>
                        <circle cx="10" cy="10" r="3" stroke="currentColor" strokeWidth="2" fill="none"/>
                        <circle cx="14" cy="6" r="1" fill="currentColor"/>
                      </svg>
                    )}
                    {cfg.label}
                  </span>
                );
              })()}
            </div>
            <p className={cn('text-[11px] font-medium leading-none mt-0.5', isSessionActive ? 'text-emerald-500' : 'text-muted-foreground/50')}>
              {fetchingName ? 'Fetching name…' : isSessionActive ? 'Active now' : 'Offline'}
            </p>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {/* AI ON/OFF toggle */}
            <button
              onClick={toggleAi}
              disabled={aiTogglePending}
              title={aiEnabled ? 'AI is ON — click to turn off' : 'AI is OFF — click to turn on'}
              data-testid="button-ai-toggle"
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-bold transition-all duration-200 select-none',
                aiEnabled
                  ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 hover:bg-emerald-500/25'
                  : 'text-red-600 dark:text-red-400 bg-red-500/10 border border-red-400/30 hover:bg-red-500/20',
                aiTogglePending && 'opacity-60 cursor-wait'
              )}
            >
              {aiTogglePending
                ? <Loader2 size={12} className="animate-spin" />
                : aiEnabled ? <Bot size={12} /> : <BotOff size={12} />
              }
              AI {aiEnabled ? 'ON' : 'OFF'}
            </button>

            <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full hover:bg-muted text-muted-foreground">
              <Info size={18} />
            </Button>
          </div>
        </div>
      </header>

      {/* ── Messages ─────────────────────────────────────────────────────────── */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide">
        <div className="px-2 md:px-3 py-3 space-y-0 max-w-3xl mx-auto">

          {/* Load More button — appears at top when older messages exist */}
          {hasMore && (
            <div className="flex justify-center pb-3">
              <button
                onClick={handleLoadMore}
                disabled={isLoadingMore}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold bg-muted border border-border/50 text-muted-foreground hover:bg-muted/80 hover:text-foreground transition-all disabled:opacity-50"
              >
                {isLoadingMore
                  ? <><Loader2 size={11} className="animate-spin" /> Loading…</>
                  : <><ChevronUp size={11} /> Load older messages</>
                }
              </button>
            </div>
          )}

          {allMessages.length > 0 && (
            <div className="flex items-center gap-3 py-2 mb-1">
              <div className="flex-1 h-px bg-border/30" />
              <span className="text-[10px] text-muted-foreground/40 font-medium px-2 uppercase tracking-wider">Today</span>
              <div className="flex-1 h-px bg-border/30" />
            </div>
          )}

          {groupedMessages.map(({ msg, isFirst, isLast }) => {
            // Resolve platform message ID for status/reaction lookup — in priority order:
            // 1. _platformMsgId — set after a successful platform send (optimistic flow)
            // 2. platform_message_id — extracted from DB row by normalizeRow
            //    (set when n8n stores wamid/mid in the chat history record)
            // 3. msgIndex lookup — cross-device index (Supabase message_platform_ids
            //    table + localStorage) mapping text+timestamp → platformMsgId
            const resolvedPlatId =
              msg._platformMsgId ||
              msg.platform_message_id ||
              msgIndex[msgIndexKey(msg.message_text, msg.timestamp || '')];
            const statusKey = resolvedPlatId || String(msg.id);
            return (
            <div key={`${msg.id}`} className="relative">
              <ChatMessage
                message={msg}
                onReply={canReply ? setReplyingTo : undefined}
                onMediaClick={handleMediaClick}
                onReact={canReply ? handleReact : undefined}
                reactions={reactions[statusKey]}
                statusOverride={msgStatuses[statusKey]}
                isFirst={isFirst}
                isLast={isLast}
              />
              {uploadingId === msg.id && (
                <div className={cn('flex items-center gap-1 text-[10px] text-muted-foreground mt-0.5', msg.sender === 'Agent' || msg.sender === 'AI' ? 'justify-end pr-10' : 'justify-start pl-10')}>
                  <Loader2 size={9} className="animate-spin" />
                  <span>Sending…</span>
                </div>
              )}
            </div>
            );
          })}

          {allMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="w-16 h-16 rounded-2xl bg-muted/60 flex items-center justify-center mb-4">
                <span className="text-3xl">💬</span>
              </div>
              <p className="text-sm font-semibold text-foreground/60">No messages yet</p>
              <p className="text-xs text-muted-foreground/40 mt-1">Messages will appear here when the conversation starts</p>
            </div>
          )}
          {/* Customer typing indicator — animated dots bubble */}
          {customerTyping && (
            <div className="flex items-end gap-2 px-1 mb-1 animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
              <div className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center shadow-sm"
                style={{ background: 'linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%)' }}>
                <span className="text-base">👤</span>
              </div>
              <div className="px-4 py-3 rounded-tl-[18px] rounded-tr-[18px] rounded-br-[18px] rounded-bl-[5px] bg-muted/80 dark:bg-white/10 border border-border/40 flex items-center gap-1">
                {[0, 1, 2].map(i => (
                  <span
                    key={i}
                    className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce"
                    style={{ animationDelay: `${i * 150}ms`, animationDuration: '0.8s' }}
                  />
                ))}
              </div>
            </div>
          )}

          <div ref={scrollEndRef} className="h-2" />
        </div>
      </div>

      {/* ── Quick Replies popup ───────────────────────────────────────────────── */}
      {showQuickReplies && (
        <div className="flex-shrink-0 border-t border-border/40 bg-background/95 backdrop-blur-sm px-3 py-3 animate-in slide-in-from-bottom-2 duration-150">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Quick Replies</span>
              <button onClick={() => setShowQuickReplies(false)} className="p-0.5 text-muted-foreground hover:text-foreground"><X size={13} /></button>
            </div>
            <div className="flex flex-wrap gap-2">
              {QUICK_REPLIES.map((qr, i) => (
                <button key={i} onClick={() => { setReplyText(qr); setShowQuickReplies(false); inputRef.current?.focus(); }}
                  className="text-xs bg-muted border border-border/40 rounded-full px-3.5 py-1.5 hover:bg-primary/5 hover:border-primary/40 hover:text-primary transition-all duration-100">
                  {qr}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Emoji popup ───────────────────────────────────────────────────────── */}
      {showEmoji && (
        <div className="flex-shrink-0 border-t border-border/40 bg-background/95 backdrop-blur-sm px-3 py-3 animate-in slide-in-from-bottom-2 duration-150">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Emoji</span>
              <button onClick={() => setShowEmoji(false)} className="p-0.5 text-muted-foreground hover:text-foreground"><X size={13} /></button>
            </div>
            <div className="flex flex-wrap gap-0.5">
              {EMOJI_LIST.map((emoji, i) => (
                <button key={i} onClick={() => { setReplyText(p => p + emoji); setShowEmoji(false); inputRef.current?.focus(); }}
                  className="text-xl hover:bg-muted rounded-lg p-1.5 transition-colors duration-100">
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Input bar — Messenger style ───────────────────────────────────────── */}
      <div className="flex-shrink-0 bg-background/95 backdrop-blur-sm border-t border-border/30">
        <div className="max-w-3xl mx-auto px-2 py-2.5">

          {/* Reply-to preview */}
          {replyingTo && (
            <div className="flex items-center gap-2 mb-2 px-3 py-2 rounded-xl bg-primary/5 border border-primary/20 animate-in slide-in-from-bottom-1 duration-150">
              <div className="w-0.5 h-8 bg-primary rounded-full flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-bold text-primary">
                  {replyingTo.sender === 'User' ? '👤 Customer' : replyingTo.sender === 'Agent' ? `🧑‍💼 ${agentName}` : '🤖 AI'}
                </p>
                <p className="text-[11px] text-muted-foreground truncate">{replyingTo.message_text.slice(0, 60)}</p>
              </div>
              <button onClick={() => setReplyingTo(null)} className="text-muted-foreground hover:text-foreground p-0.5 flex-shrink-0"><X size={13} /></button>
            </div>
          )}

          {/* Staged media thumbnails (images & videos) */}
          {pendingPreviews.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap mb-2 px-0.5 animate-in slide-in-from-bottom-1 duration-150">
              {pendingPreviews.map((src, i) => {
                const isVid = pendingFiles[i]?.type.startsWith('video/');
                return (
                  <div key={i} className="relative w-[60px] h-[60px] rounded-xl overflow-hidden border border-border/60 group flex-shrink-0 bg-muted">
                    {isVid ? (
                      <>
                        <video src={src} className="w-full h-full object-cover" muted playsInline preload="metadata" />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                          <Play size={18} className="text-white fill-white" />
                        </div>
                      </>
                    ) : (
                      <img src={src} alt="" className="w-full h-full object-cover" />
                    )}
                    <button
                      onClick={() => removePendingFile(i)}
                      className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X size={10} />
                    </button>
                  </div>
                );
              })}
              {/* Add more media button */}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-[60px] h-[60px] rounded-xl border-2 border-dashed border-border/60 flex items-center justify-center text-muted-foreground hover:border-primary/40 hover:text-primary transition-colors flex-shrink-0"
              >
                <Plus size={20} />
              </button>
            </div>
          )}

          {recording ? (
            /* Recording UI */
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-2 flex-1 px-4 py-2.5 bg-red-500/10 border border-red-400/30 rounded-full">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse flex-shrink-0" />
                <span className="text-sm font-bold text-red-500 tabular-nums">{fmtSec(recordingSeconds)}</span>
                <span className="text-xs text-muted-foreground">Recording…</span>
              </div>
              <button onClick={cancelRecording}
                className="h-10 w-10 rounded-full bg-muted hover:bg-muted/80 text-muted-foreground flex items-center justify-center flex-shrink-0">
                <X size={17} />
              </button>
              <button onClick={stopAndSendVoice}
                className="h-10 w-10 rounded-full text-white flex items-center justify-center flex-shrink-0"
                style={{ background: 'linear-gradient(135deg,#ef4444,#dc2626)' }}>
                <Square size={17} fill="currentColor" />
              </button>
            </div>
          ) : canReply ? (
            /* Messenger-style one-row input */
            <div className="relative flex items-end gap-1.5">

              {/* Left icon group */}
              <div className="flex items-center gap-0.5 flex-shrink-0 pb-1">
                {supportsVoice && (
                  <button
                    onClick={startRecording}
                    title="Voice message"
                    className="w-9 h-9 rounded-full flex items-center justify-center text-primary hover:bg-primary/10 transition-colors">
                    <Mic size={20} />
                  </button>
                )}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  title="Send image / video"
                  className="w-9 h-9 rounded-full flex items-center justify-center text-primary hover:bg-primary/10 transition-colors">
                  <ImageIcon size={20} />
                </button>
                <button
                  onClick={() => docInputRef.current?.click()}
                  title="Send document"
                  className="w-9 h-9 rounded-full flex items-center justify-center text-primary hover:bg-primary/10 transition-colors">
                  <Paperclip size={20} />
                </button>
              </div>

              {/* Text input */}
              <div className="flex-1">
                <textarea
                  ref={inputRef}
                  placeholder={pendingFiles.length > 0 ? 'Add a caption…' : 'Aa'}
                  value={replyText}
                  onChange={e => { setReplyText(e.target.value); if (e.target.value) handleTyping(); }}
                  onBlur={() => stopTypingIndicator()}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                  rows={1}
                  className="w-full bg-muted/60 dark:bg-white/5 border border-border/40 rounded-[22px] px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/30 transition-all resize-none leading-relaxed"
                  style={{ minHeight: 42, maxHeight: 120 }}
                  onInput={e => {
                    const el = e.target as HTMLTextAreaElement;
                    el.style.height = 'auto';
                    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
                  }}
                />
              </div>

              {/* Typing active indicator */}
              {typingActive && (
                <div className="absolute -top-5 left-16 flex items-center gap-1 text-[10px] text-muted-foreground/50">
                  <Keyboard size={10} />
                  <span>Sending typing…</span>
                </div>
              )}

              {/* Right: emoji + send */}
              <div className="flex items-center gap-0.5 flex-shrink-0 pb-1">
                {!replyText.trim() && !pendingFiles.length && (
                  <button
                    onClick={() => { setShowEmoji(v => !v); setShowQuickReplies(false); }}
                    className={cn('w-9 h-9 rounded-full flex items-center justify-center transition-colors',
                      showEmoji ? 'bg-primary/15 text-primary' : 'text-primary hover:bg-primary/10'
                    )}>
                    <Smile size={20} />
                  </button>
                )}
                <button
                  onClick={handleSend}
                  disabled={!replyText.trim() && !pendingFiles.length}
                  className={cn(
                    'w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 transition-all duration-150',
                    (replyText.trim() || pendingFiles.length)
                      ? 'text-white hover:scale-105 active:scale-95 shadow-md'
                      : 'bg-muted text-muted-foreground/30 cursor-not-allowed'
                  )}
                  style={(replyText.trim() || pendingFiles.length) ? { background: 'linear-gradient(135deg,#7c3aed,#6d28d9)' } : {}}>
                  <Send size={17} />
                </button>
              </div>
            </div>
          ) : (
            <div className="py-2 text-center">
              <p className="text-xs text-muted-foreground/50">
                {!recipient ? 'Recipient ID not found' : 'Add WhatsApp or Facebook in Settings → Platform Connections'}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Fullscreen media viewer */}
      {mediaViewer && (
        <MediaViewer
          url={mediaViewer.url}
          type={mediaViewer.type}
          allImages={mediaViewer.allImages}
          onClose={() => setMediaViewer(null)}
          onNavigate={url => setMediaViewer(v => v ? { ...v, url } : null)}
        />
      )}
    </div>
  );
};

export default Conversation;
