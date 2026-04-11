import { useState, useRef, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useChatHistory, useSessions, useRecipientNames, useAutoResolveNames, fetchNameFromMeta, ChatMessage as ChatMessageType } from '@/hooks/useChatHistory';
import { getStoredConnection, insertMessageToExternalDb } from '@/lib/externalDb';
import { ChatMessage } from '@/components/ChatMessage';
import { ArrowLeft, Send, Loader2, Smile, X, Mic, Square, Info, ImageIcon, BotOff, Bot, RefreshCw } from 'lucide-react';
import { useAiControl } from '@/hooks/useAiControl';
import { useTeamRole } from '@/hooks/useTeamRole';
import { Button } from '@/components/ui/button';
import { usePlatformConnections, PlatformConnection } from '@/hooks/usePlatformConnections';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

// ─── Constants ────────────────────────────────────────────────────────────────
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
async function fbUploadFile(conn: PlatformConnection, file: File, mediaType: 'image' | 'audio' | 'video'): Promise<string> {
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

// ─── Pending message tracker (for optimistic revert) ─────────────────────────
let _msgCounter = Date.now();
const nextId = () => ++_msgCounter;

// ─── Component ────────────────────────────────────────────────────────────────
const Conversation = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { data: messages, isLoading, error } = useChatHistory(sessionId);
  const { data: sessions } = useSessions();
  const isSessionActive = sessions?.find(s => s.session_id === sessionId)?.is_active ?? false;
  const { data: recipientNames } = useRecipientNames();
  const { data: platformConns = [] } = usePlatformConnections();
  const { displayName: agentName } = useTeamRole();

  const [replyText, setReplyText] = useState('');
  const [localMessages, setLocalMessages] = useState<ChatMessageType[]>([]);
  const [replyingTo, setReplyingTo] = useState<ChatMessageType | null>(null);

  // Panel toggles
  const [showEmoji, setShowEmoji] = useState(false);
  const [showQuickReplies, setShowQuickReplies] = useState(false);

  // Upload state
  const [uploadingId, setUploadingId] = useState<number | null>(null);

  // Voice recording
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Refs
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollEndRef = useRef<HTMLDivElement>(null);

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
  const activeConn = waConn || fbConn || igConn;
  const canReply = !!activeConn && !!recipient;

  const { aiEnabled, toggle: toggleAi, isPending: aiTogglePending } = useAiControl(sessionId);

  // ── When arriving from HandoffPanel with ?disable_ai=1, immediately turn AI off ──
  const disableAiOnOpen = searchParams.get('disable_ai') === '1';
  useEffect(() => {
    if (!disableAiOnOpen || !sessionId) return;
    // Optimistic: show AI as OFF in the UI right away (no waiting for DB round-trip)
    queryClient.setQueryData(['ai-control', sessionId], false);
    // Persist: direct upsert bypasses auth check (ai_control uses "Allow all" RLS)
    supabase.from('ai_control').upsert(
      { session_id: sessionId, ai_enabled: false, updated_at: new Date().toISOString() },
      { onConflict: 'session_id' }
    ).then(({ error }) => {
      if (error) {
        // Revert optimistic if write failed
        queryClient.invalidateQueries({ queryKey: ['ai-control', sessionId] });
      }
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
  // (agent messages matched by text — safety net in case DB refetches before revertOptimistic)
  const dbAgentTexts = new Set(
    (messages || []).filter(m => m.sender === 'Agent').map(m => m.message_text)
  );
  const dedupedLocal = localMessages.filter(m => !dbAgentTexts.has(m.message_text));

  // When agent sends voice/image/video, local keeps the blob URL for playback.
  // The DB stores a placeholder text like [voice message]/[image]/[video].
  // Hide DB placeholder entries that are superseded by local blob messages.
  const MEDIA_PLACEHOLDERS = new Set(['[voice message]', '[image]', '[video]', '[audio]']);
  const localBlobCount = localMessages.filter(m => m.message_text.startsWith('blob:')).length;
  let blobSlotsLeft = localBlobCount;
  const filteredDbMessages = (messages || []).filter(m => {
    if (m.sender !== 'Agent') return true;
    if (!MEDIA_PLACEHOLDERS.has(m.message_text.trim())) return true;
    if (blobSlotsLeft > 0) { blobSlotsLeft--; return false; }
    return true;
  });

  const allMessages = [...filteredDbMessages, ...dedupedLocal];

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [allMessages.length]);

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

  const markSent = (id: number) => {
    setLocalMessages(prev => prev.map(m => m.id === id ? { ...m, _sending: false } : m));
  };

  // ── Send text ──────────────────────────────────────────────────────────────
  const handleSendText = () => {
    const text = replyText.trim();
    if (!text || !activeConn) {
      if (!activeConn) toast.error('Add a connection in Settings first');
      return;
    }
    const id = nextId();
    const rt = replyingTo;
    // INSTANT: add to UI immediately (shows as "sending")
    addOptimistic(id, text, rt);
    setReplyText('');
    setReplyingTo(null);
    setShowEmoji(false);
    setShowQuickReplies(false);
    inputRef.current?.focus();
    (async () => {
      // Fire DB write in parallel (don't await — non-blocking)
      insertMessageToExternalDb(getStoredConnection(), {
        session_id: sessionId || '',
        sender: 'Agent',
        message_text: text,
        timestamp: new Date().toISOString(),
        recipient,
      });
      try {
        if (waConn) await waPost(waConn, recipient, { type: 'text', text: { body: text } });
        else if (fbConn) await fbPost(fbConn, recipient, { text });
        else if (igConn) await fbPost(igConn, recipient, { text });
        // Mark sent (tick indicator) then refetch DB
        markSent(id);
        await queryClient.invalidateQueries({ queryKey: ['chat-history', sessionId] });
        // Remove optimistic — DB now has the real message
        revertOptimistic(id);
      } catch (err: unknown) {
        revertOptimistic(id);
        toast.error(err instanceof Error ? err.message : 'Failed to send');
      }
    })();
  };

  // ── Send image from file picker ─────────────────────────────────────────────
  const handleFileSelected = useCallback(async (file: File) => {
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
      // Fire DB write immediately (parallel with upload — no await)
      const mediaLabel = isImage ? '[image]' : isVideo ? '[video]' : '[audio]';
      insertMessageToExternalDb(getStoredConnection(), {
        session_id: sessionId || '',
        sender: 'Agent',
        message_text: mediaLabel,
        timestamp: new Date().toISOString(),
        recipient,
      });
      if (waConn) {
        const mediaId = await waUploadFile(waConn, file, file.name, file.type);
        const waType = isImage ? 'image' : isAudio ? 'audio' : 'video';
        await waPost(waConn, recipient, { type: waType, [waType]: { id: mediaId } });
      } else if (fbConn) {
        const attachId = await fbUploadFile(fbConn, file, mediaType);
        await fbPost(fbConn, recipient, { attachment: { type: mediaType, payload: { attachment_id: attachId } } });
      }
      markSent(id);
      // Keep local blob URL — don't revert so image/video preview stays visible
      await queryClient.invalidateQueries({ queryKey: ['chat-history', sessionId] });
    } catch (err: unknown) {
      revertOptimistic(id);
      URL.revokeObjectURL(rawUrl);
      toast.error(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setUploadingId(null);
    }
  }, [activeConn, waConn, fbConn, recipient, replyingTo, sessionId]);

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
        // Fire DB write immediately (parallel with upload — no await)
        insertMessageToExternalDb(getStoredConnection(), {
          session_id: sessionId || '',
          sender: 'Agent',
          message_text: '[voice message]',
          timestamp: new Date().toISOString(),
          recipient,
        });
        if (waConn) {
          const ext = mimeType.includes('ogg') ? 'voice.ogg' : 'voice.webm';
          const uploadMime = mimeType.includes('ogg') ? 'audio/ogg' : 'audio/webm';
          const mediaId = await waUploadFile(waConn, blob, ext, uploadMime);
          await waPost(waConn, recipient, { type: 'audio', audio: { id: mediaId } });
          markSent(id);
          // Keep local blob URL — don't revert so the audio player stays visible
          await queryClient.invalidateQueries({ queryKey: ['chat-history', sessionId] });
        } else if (fbConn) {
          toast.error('Facebook does not support voice send. Use WhatsApp instead.');
          revertOptimistic(id);
          URL.revokeObjectURL(localUrl);
        }
      } catch (err: unknown) {
        revertOptimistic(id);
        URL.revokeObjectURL(localUrl);
        toast.error(err instanceof Error ? err.message : 'Failed to send voice');
      } finally {
        setUploadingId(null);
      }
    })();
  }, [recording, activeConn, waConn, fbConn, recipient, replyingTo, sessionId]);

  const cancelRecording = useCallback(() => {
    if (!mediaRecorderRef.current) return;
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    try { mediaRecorderRef.current.stop(); mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop()); } catch {}
    setRecording(false);
    setRecordingSeconds(0);
  }, []);

  const fmtSec = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  // ── Loading / Error ─────────────────────────────────────────────────────────
  if (isLoading) return (
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

  if (error) return (
    <div className="h-screen flex flex-col bg-background">
      <div className="h-14 px-4 flex items-center gap-3 border-b border-border">
        <Button variant="ghost" size="icon" onClick={() => navigate('/')}><ArrowLeft size={18} /></Button>
      </div>
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Could not load messages</div>
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

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*,audio/*"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelected(f); e.target.value = ''; }}
      />

      {/* ── Header ───────────────────────────────────────────────────────────── */}
      <header className="flex-shrink-0 border-b border-border/30 bg-background/95 backdrop-blur-sm">
        <div className="h-[60px] px-2 md:px-3 flex items-center gap-2 max-w-3xl mx-auto w-full">
          <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full hover:bg-muted flex-shrink-0" onClick={() => navigate('/')}>
            <ArrowLeft size={19} />
          </Button>

          {/* Avatar */}
          <div className="relative flex-shrink-0">
            <div className={cn('w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-bold shadow bg-gradient-to-br', grad)}>
              {initials}
            </div>
            <span className={cn('absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-background', isSessionActive ? 'bg-emerald-500' : 'bg-zinc-400')} />
          </div>

          {/* Name + status */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
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
      <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide">
        <div className="px-2 md:px-3 py-3 space-y-0 max-w-3xl mx-auto">
          {allMessages.length > 0 && (
            <div className="flex items-center gap-3 py-2 mb-1">
              <div className="flex-1 h-px bg-border/30" />
              <span className="text-[10px] text-muted-foreground/40 font-medium px-2 uppercase tracking-wider">Today</span>
              <div className="flex-1 h-px bg-border/30" />
            </div>
          )}

          {groupedMessages.map(({ msg, isFirst, isLast }) => (
            <div key={`${msg.id}`} className="relative">
              <ChatMessage
                message={msg}
                onReply={canReply ? setReplyingTo : undefined}
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
          ))}

          {allMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="w-16 h-16 rounded-2xl bg-muted/60 flex items-center justify-center mb-4">
                <span className="text-3xl">💬</span>
              </div>
              <p className="text-sm font-semibold text-foreground/60">No messages yet</p>
              <p className="text-xs text-muted-foreground/40 mt-1">Messages will appear here when the conversation starts</p>
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
            <div className="flex items-end gap-1.5">

              {/* Left icon group */}
              <div className="flex items-center gap-0.5 flex-shrink-0 pb-1">
                <button
                  onClick={startRecording}
                  title="Voice message"
                  className="w-9 h-9 rounded-full flex items-center justify-center text-primary hover:bg-primary/10 transition-colors">
                  <Mic size={20} />
                </button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  title="Send image / file"
                  className="w-9 h-9 rounded-full flex items-center justify-center text-primary hover:bg-primary/10 transition-colors">
                  <ImageIcon size={20} />
                </button>
              </div>

              {/* Text input */}
              <div className="flex-1">
                <textarea
                  ref={inputRef}
                  placeholder="Aa"
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendText(); } }}
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

              {/* Right: emoji + send */}
              <div className="flex items-center gap-0.5 flex-shrink-0 pb-1">
                {!replyText.trim() && (
                  <button
                    onClick={() => { setShowEmoji(v => !v); setShowQuickReplies(false); }}
                    className={cn('w-9 h-9 rounded-full flex items-center justify-center transition-colors',
                      showEmoji ? 'bg-primary/15 text-primary' : 'text-primary hover:bg-primary/10'
                    )}>
                    <Smile size={20} />
                  </button>
                )}
                <button
                  onClick={handleSendText}
                  disabled={!replyText.trim()}
                  className={cn(
                    'w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 transition-all duration-150',
                    replyText.trim()
                      ? 'text-white hover:scale-105 active:scale-95 shadow-md'
                      : 'bg-muted text-muted-foreground/30 cursor-not-allowed'
                  )}
                  style={replyText.trim() ? { background: 'linear-gradient(135deg,#7c3aed,#6d28d9)' } : {}}>
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
    </div>
  );
};

export default Conversation;
