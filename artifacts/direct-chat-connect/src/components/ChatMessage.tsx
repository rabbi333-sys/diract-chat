import { useState, useRef, useEffect } from 'react';
import { ChatMessage as ChatMessageType } from '@/hooks/useChatHistory';
import { cn } from '@/lib/utils';
import { Reply, ExternalLink, Clock, Check, CheckCheck, Mic, ImageIcon, Video, Play, Pause, Download, FileText, File, FileSpreadsheet } from 'lucide-react';

// ─── Reaction emojis ───────────────────────────────────────────────────────────
export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '😡'] as const;

// ─── URL / text parsers ────────────────────────────────────────────────────────
const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp|bmp|avif|svg)(\?.*)?$/i;
const AUDIO_EXT = /\.(mp3|ogg|wav|m4a|aac|opus|flac|oga)(\?.*)?$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|avi|mkv|m4v)(\?.*)?$/i;
const URL_REGEX = /(https?:\/\/[^\s<>"']+)/g;

type Segment =
  | { type: 'image'; url: string }
  | { type: 'audio'; url: string }
  | { type: 'video'; url: string }
  | { type: 'link'; url: string }
  | { type: 'text'; text: string }
  | { type: 'voice-placeholder' }
  | { type: 'image-placeholder' }
  | { type: 'video-placeholder' }
  | { type: 'document'; url: string; name: string; size?: number };

export function parseSegments(text: string): Segment[] {
  const trimmed = text.trim();

  if (trimmed.startsWith('blob-image:')) return [{ type: 'image', url: trimmed.slice('blob-image:'.length) }];
  if (trimmed.startsWith('blob-video:')) return [{ type: 'video', url: trimmed.slice('blob-video:'.length) }];
  if (trimmed.startsWith('blob-audio:')) return [{ type: 'audio', url: trimmed.slice('blob-audio:'.length) }];

  if (trimmed.startsWith('blob-doc:')) {
    const rest  = trimmed.slice('blob-doc:'.length);
    const parts = rest.split('|||');
    const name  = parts[0] || 'Document';
    const size  = parts.length >= 3 ? parseInt(parts[1], 10) : undefined;
    const url   = parts.length >= 3 ? parts.slice(2).join('|||') : (parts[1] || '');
    return [{ type: 'document', url, name, size: size && isFinite(size) ? size : undefined }];
  }

  if (trimmed.startsWith('doc-data:')) {
    const rest  = trimmed.slice('doc-data:'.length);
    const parts = rest.split('|||');
    const name  = parts[0] || 'Document';
    const size  = parts.length >= 3 ? parseInt(parts[1], 10) : undefined;
    const url   = parts.length >= 3 ? parts.slice(2).join('|||') : (parts[1] || '');
    return [{ type: 'document', url, name, size: size && isFinite(size) ? size : undefined }];
  }

  if (trimmed.startsWith('blob:')) return [{ type: 'audio', url: trimmed }];

  if (trimmed.startsWith('data:image/'))       return [{ type: 'image', url: trimmed }];
  if (trimmed.startsWith('data:video/'))       return [{ type: 'video', url: trimmed }];
  if (trimmed.startsWith('data:audio/'))       return [{ type: 'audio', url: trimmed }];
  if (trimmed.startsWith('data:application/')) return [{ type: 'document', url: trimmed, name: 'Document' }];

  if (/^\[voice message\]$/i.test(trimmed)) return [{ type: 'voice-placeholder' }];
  if (/^\[image\]$/i.test(trimmed))         return [{ type: 'image-placeholder' }];
  if (/^\[video\]$/i.test(trimmed))         return [{ type: 'video-placeholder' }];
  if (/^\[document\]$/i.test(trimmed))      return [{ type: 'document', url: '', name: 'Document' }];

  const parts = text.split(URL_REGEX);
  const result: Segment[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('http://') || part.startsWith('https://')) {
      if (IMAGE_EXT.test(part))      result.push({ type: 'image', url: part });
      else if (AUDIO_EXT.test(part)) result.push({ type: 'audio', url: part });
      else if (VIDEO_EXT.test(part)) result.push({ type: 'video', url: part });
      else                           result.push({ type: 'link',  url: part });
    } else {
      const t = part.trim();
      if (t) result.push({ type: 'text', text: t });
    }
  }
  return result;
}

const SPEEDS = [1, 1.5, 2] as const;
type Speed = typeof SPEEDS[number];

// ─── Mini audio player ─────────────────────────────────────────────────────────
const AudioPlayer = ({ url, isRight }: { url: string; isRight: boolean }) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState<Speed>(1);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => {
      const d = el.duration;
      setProgress((d && isFinite(d)) ? (el.currentTime / d) * 100 : 0);
    };
    const onDur = () => {
      const d = el.duration;
      setDuration((d && isFinite(d)) ? d : 0);
    };
    const onEnd = () => { setPlaying(false); setProgress(0); };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onDur);
    el.addEventListener('durationchange', onDur);
    el.addEventListener('ended', onEnd);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onDur);
      el.removeEventListener('durationchange', onDur);
      el.removeEventListener('ended', onEnd);
    };
  }, []);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) { el.pause(); setPlaying(false); }
    else { el.play(); setPlaying(true); }
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (!el || !el.duration || !isFinite(el.duration)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    el.currentTime = ((e.clientX - rect.left) / rect.width) * el.duration;
  };

  const cycleSpeed = () => {
    const el = audioRef.current;
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (el) el.playbackRate = next;
  };

  const fmtTime = (s: number) =>
    (!isFinite(s) || isNaN(s)) ? '0:00' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  const trackColor = isRight ? 'bg-white/30' : 'bg-foreground/15';
  const fillColor  = isRight ? 'bg-white'     : 'bg-primary';
  const iconColor  = isRight ? 'text-white'   : 'text-foreground';
  const timeColor  = isRight ? 'text-white/60' : 'text-muted-foreground';
  const speedColor = isRight ? 'text-white/70 hover:text-white border-white/30' : 'text-muted-foreground hover:text-foreground border-border';

  return (
    <div className="flex items-center gap-2 py-1 min-w-[210px] max-w-[270px]">
      <audio ref={audioRef} src={url} preload="metadata" className="hidden" />
      <button
        onClick={toggle}
        className={cn('w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 transition-all',
          isRight ? 'bg-white/20 hover:bg-white/30' : 'bg-primary/10 hover:bg-primary/20')}
      >
        {playing
          ? <Pause size={15} className={iconColor} />
          : <Play  size={15} className={cn(iconColor, 'ml-0.5')} />}
      </button>

      <div className="flex-1 flex flex-col gap-1.5 min-w-0">
        <div className={cn('w-full h-1.5 rounded-full cursor-pointer', trackColor)} onClick={seek}>
          <div className={cn('h-full rounded-full transition-all', fillColor)} style={{ width: `${progress}%` }} />
        </div>
        <div className="flex items-center justify-between gap-1">
          <span className={cn('text-[10px] font-medium tabular-nums', timeColor)}>
            {duration > 0 && isFinite(duration) ? fmtTime(playing ? (audioRef.current?.currentTime ?? 0) : duration) : '0:00'}
          </span>
          <button
            onClick={cycleSpeed}
            title="Playback speed"
            className={cn('text-[9px] font-bold border rounded px-1 py-0.5 leading-none transition-colors flex-shrink-0', speedColor)}
          >
            {speed}×
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── File/document card ───────────────────────────────────────────────────────
const fmtSize = (bytes: number) => {
  if (bytes < 1024)           return `${bytes} B`;
  if (bytes < 1024 * 1024)    return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const FileCard = ({ url, name, size, isRight }: { url: string; name: string; size?: number; isRight: boolean }) => {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const isPdf   = ext === 'pdf';
  const isWord  = ['doc', 'docx'].includes(ext);
  const isExcel = ['xls', 'xlsx', 'csv'].includes(ext);
  const iconBg  = isPdf ? 'bg-red-500' : isWord ? 'bg-blue-500' : isExcel ? 'bg-emerald-600' : 'bg-slate-500';
  const Icon    = isExcel ? FileSpreadsheet : (isPdf || isWord) ? FileText : File;
  const canDownload = !!(url && (url.startsWith('data:') || url.startsWith('blob:')));
  const meta = [ext.toUpperCase() || 'FILE', size ? fmtSize(size) : null].filter(Boolean).join(' · ');
  return (
    <div className="flex items-center gap-2.5 py-1.5 min-w-[200px] max-w-[260px]">
      <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0', iconBg)}>
        <Icon size={20} className="text-white" />
      </div>
      <div className="flex-1 min-w-0">
        <p className={cn('text-xs font-semibold truncate', isRight ? 'text-white' : 'text-foreground')}>{name}</p>
        <p className={cn('text-[10px] font-medium tracking-wide', isRight ? 'text-white/60' : 'text-muted-foreground')}>{meta}</p>
      </div>
      {canDownload && (
        <a href={url} download={name} title="Download"
          className={cn('flex-shrink-0 p-1.5 rounded-full transition-colors',
            isRight ? 'text-white/70 hover:text-white hover:bg-white/20' : 'text-muted-foreground hover:text-foreground hover:bg-muted')}
          onClick={e => e.stopPropagation()}>
          <Download size={15} />
        </a>
      )}
    </div>
  );
};

// ─── Video thumbnail ──────────────────────────────────────────────────────────
const VideoThumbnail = ({ url, onClick }: { url: string; onClick: () => void }) => (
  <div
    className="relative my-0.5 rounded-xl overflow-hidden max-w-[260px] cursor-pointer group"
    onClick={onClick}
  >
    <video src={url} preload="metadata" muted className="max-w-full block" style={{ maxHeight: 200 }} />
    <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
      <div className="w-12 h-12 rounded-full bg-white/90 flex items-center justify-center shadow-lg">
        <Play size={20} className="text-gray-800 ml-1" />
      </div>
    </div>
  </div>
);

// ─── Placeholder cards ─────────────────────────────────────────────────────────
const VoicePlaceholder = ({ isRight }: { isRight: boolean }) => (
  <div className={cn('flex items-center gap-2.5 py-1.5 min-w-[180px]')}>
    <div className={cn('w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0',
      isRight ? 'bg-white/20' : 'bg-primary/10')}>
      <Mic size={15} className={isRight ? 'text-white' : 'text-primary'} />
    </div>
    <div className="flex-1">
      <div className="flex items-end gap-[3px] h-6">
        {[3,5,8,6,10,7,4,9,6,5,8,4].map((h, i) => (
          <div key={i}
            className={cn('w-[3px] rounded-full opacity-60', isRight ? 'bg-white' : 'bg-primary')}
            style={{ height: `${h * 2.2}px` }} />
        ))}
      </div>
      <p className={cn('text-[10px] mt-0.5', isRight ? 'text-white/60' : 'text-muted-foreground')}>Voice message</p>
    </div>
  </div>
);

const ImagePlaceholder = ({ isRight }: { isRight: boolean }) => (
  <div className={cn('flex flex-col items-center justify-center gap-1.5 w-[180px] h-[120px] rounded-xl border-2 border-dashed',
    isRight ? 'border-white/30 bg-white/10' : 'border-border bg-muted/40')}>
    <ImageIcon size={24} className={isRight ? 'text-white/50' : 'text-muted-foreground/50'} />
    <span className={cn('text-[10px]', isRight ? 'text-white/50' : 'text-muted-foreground/60')}>Photo</span>
  </div>
);

const VideoPlaceholder = ({ isRight }: { isRight: boolean }) => (
  <div className={cn('flex flex-col items-center justify-center gap-1.5 w-[180px] h-[120px] rounded-xl border-2 border-dashed',
    isRight ? 'border-white/30 bg-white/10' : 'border-border bg-muted/40')}>
    <Video size={24} className={isRight ? 'text-white/50' : 'text-muted-foreground/50'} />
    <span className={cn('text-[10px]', isRight ? 'text-white/50' : 'text-muted-foreground/60')}>Video</span>
  </div>
);

// ─── Reaction Picker ──────────────────────────────────────────────────────────
const ReactionPicker = ({
  isRight,
  onSelect,
}: {
  isRight: boolean;
  onSelect: (emoji: string) => void;
}) => (
  <div
    className={cn(
      'absolute bottom-full mb-1 z-20',
      'flex items-center gap-0.5 px-1.5 py-1 rounded-full shadow-xl border border-border/50',
      'bg-background/95 backdrop-blur-sm',
      'animate-in fade-in-0 zoom-in-90 duration-100',
      isRight ? 'right-0' : 'left-0',
    )}
    onClick={e => e.stopPropagation()}
  >
    {REACTION_EMOJIS.map(emoji => (
      <button
        key={emoji}
        title={emoji}
        onClick={() => onSelect(emoji)}
        className="w-8 h-8 flex items-center justify-center text-lg rounded-full hover:bg-muted hover:scale-125 transition-all duration-100 active:scale-110"
      >
        {emoji}
      </button>
    ))}
  </div>
);

// ─── Props ────────────────────────────────────────────────────────────────────
interface ChatMessageProps {
  message: ChatMessageType;
  onReply?: (msg: ChatMessageType) => void;
  onMediaClick?: (url: string, type: 'image' | 'video') => void;
  onReact?: (msg: ChatMessageType, emoji: string) => void;
  reactions?: string[];
  isFirst?: boolean;
  isLast?: boolean;
}

// ─── Status icon ──────────────────────────────────────────────────────────────
function StatusIcon({ status }: { status: 'sending' | 'sent' | 'delivered' | 'read' }) {
  if (status === 'sending')   return <Clock     size={9}  className="text-muted-foreground/40 animate-pulse flex-shrink-0" />;
  if (status === 'sent')      return <Check     size={10} className="text-violet-400/70 flex-shrink-0" />;
  if (status === 'delivered') return <CheckCheck size={10} className="text-muted-foreground/60 flex-shrink-0" />;
  if (status === 'read')      return <CheckCheck size={10} className="text-sky-400 flex-shrink-0" />;
  return null;
}

// ─── Component ────────────────────────────────────────────────────────────────
export const ChatMessage = ({
  message,
  onReply,
  onMediaClick,
  onReact,
  reactions = [],
  isFirst = true,
  isLast = true,
}: ChatMessageProps) => {
  const [imgError, setImgError] = useState<Record<string, boolean>>({});
  const [hover, setHover] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isRight = message.sender === 'Agent' || message.sender === 'AI';
  const content = message.message_text?.trim();
  if (!content) return null;

  const segments = parseSegments(content);

  const isMediaOnly = segments.every(s =>
    s.type === 'image' || s.type === 'audio' || s.type === 'video' || s.type === 'document' ||
    s.type === 'voice-placeholder' || s.type === 'image-placeholder' || s.type === 'video-placeholder'
  );

  const time = (() => {
    if (!message.timestamp || message.timestamp === '2000-01-01T00:00:00.000Z') return '';
    try {
      return new Date(message.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    } catch { return ''; }
  })();

  // Resolve display status from _status or legacy _sending
  const msgStatus: 'sending' | 'sent' | 'delivered' | 'read' | null = (() => {
    if (!isRight) return null;
    if (message._status) return message._status;
    if (message._sending === true)  return 'sending';
    if (message._sending === false) return 'sent';
    return null;
  })();

  // Messenger-style corner rounding
  const rightRadius = cn('rounded-tl-[18px]', isFirst ? 'rounded-tr-[18px]' : 'rounded-tr-[5px]', 'rounded-br-[5px] rounded-bl-[18px]');
  const leftRadius  = cn('rounded-tr-[18px]', isFirst ? 'rounded-tl-[18px]' : 'rounded-tl-[5px]', 'rounded-bl-[5px] rounded-br-[18px]');

  const bubbleStyle = isRight
    ? { background: 'linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)', boxShadow: '0 2px 12px rgba(109,40,217,0.25)' }
    : {};

  const handleLongPressStart = () => {
    longPressTimer.current = setTimeout(() => setPickerOpen(true), 500);
  };
  const handleLongPressEnd = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  };

  const handleReactSelect = (emoji: string) => {
    setPickerOpen(false);
    onReact?.(message, emoji);
  };

  return (
    <div
      className={cn(
        'flex items-end gap-2 px-1 group',
        isRight ? 'justify-end' : 'justify-start',
        isLast ? 'mb-1' : 'mb-[2px]',
        'animate-in fade-in-0 slide-in-from-bottom-1 duration-150',
      )}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setPickerOpen(false); }}
    >
      {/* Left-side avatar */}
      {!isRight && (
        <div className={cn('w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center shadow-sm self-end', !isLast && 'invisible')}>
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-base"
            style={{ background: message.sender === 'User'
              ? 'linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%)'
              : 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)' }}>
            {message.sender === 'User' ? '👤' : '🤖'}
          </div>
        </div>
      )}

      {/* Reply button — left of right-aligned bubble */}
      {onReply && hover && isRight && !pickerOpen && (
        <button
          onClick={() => onReply(message)}
          className="flex-shrink-0 mb-1 p-1.5 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-all self-center opacity-0 group-hover:opacity-100"
          title="Reply"
        >
          <Reply size={13} />
        </button>
      )}

      <div className={cn('flex flex-col gap-[2px] max-w-[72%]', isRight ? 'items-end' : 'items-start')}>

        {/* Reply-to quote */}
        {message.replyTo && (
          <div className={cn(
            'text-[11px] px-2.5 py-1.5 rounded-xl mb-0.5 max-w-full border-l-2 opacity-80',
            isRight ? 'bg-violet-900/40 border-violet-400 text-violet-200' : 'bg-muted border-border text-muted-foreground'
          )}>
            <span className="font-semibold block text-[10px] mb-0.5 opacity-70">
              {message.replyTo.sender === 'User' ? '👤 Customer' : message.replyTo.sender === 'Agent' ? '🧑‍💼 You' : '🤖 AI'}
            </span>
            <span className="truncate block">{message.replyTo.message_text.slice(0, 80)}{message.replyTo.message_text.length > 80 ? '…' : ''}</span>
          </div>
        )}

        {/* Main bubble — with reaction picker anchor */}
        <div className="relative">
          {/* Reaction picker (shows on hover click or long-press) */}
          {onReact && pickerOpen && (
            <ReactionPicker isRight={isRight} onSelect={handleReactSelect} />
          )}

          <div
            data-testid={`bubble-${isRight ? 'agent' : 'ai'}-${message.id}`}
            className={cn(
              'relative overflow-hidden cursor-default select-none',
              isMediaOnly
                ? 'rounded-2xl p-2 bg-transparent border-0 shadow-none'
                : cn(
                    'px-3.5 py-2 text-sm leading-relaxed',
                    isRight ? rightRadius : leftRadius,
                    !isRight && 'bg-muted/80 dark:bg-white/10 border border-border/40',
                  )
            )}
            style={isMediaOnly ? {} : (isRight ? bubbleStyle : {})}
            onMouseEnter={() => onReact && hover && setPickerOpen(true)}
            onMouseLeave={() => setPickerOpen(false)}
            onTouchStart={onReact ? handleLongPressStart : undefined}
            onTouchEnd={onReact ? handleLongPressEnd : undefined}
            onTouchMove={onReact ? handleLongPressEnd : undefined}
          >
            {isMediaOnly && isRight && (
              <div className="rounded-2xl p-2.5" style={bubbleStyle}>
                {segments.map((seg, i) => renderSegment(seg, i, isRight, imgError, setImgError, onMediaClick))}
              </div>
            )}
            {isMediaOnly && !isRight && (
              <div className="rounded-2xl p-2.5 bg-muted/80 dark:bg-white/10 border border-border/40">
                {segments.map((seg, i) => renderSegment(seg, i, isRight, imgError, setImgError, onMediaClick))}
              </div>
            )}
            {!isMediaOnly && segments.map((seg, i) => renderSegment(seg, i, isRight, imgError, setImgError, onMediaClick))}
          </div>

          {/* Reaction badge — shows below the bubble */}
          {reactions.length > 0 && (
            <div
              className={cn(
                'flex items-center gap-0.5 mt-0.5',
                isRight ? 'justify-end' : 'justify-start',
              )}
            >
              <div className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-background border border-border/50 shadow-sm text-sm leading-none">
                {[...new Set(reactions)].map((emoji, i) => (
                  <span key={i}>{emoji}</span>
                ))}
                {reactions.length > 1 && (
                  <span className="text-[10px] text-muted-foreground font-medium ml-0.5">{reactions.length}</span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Timestamp + send status */}
        {isLast && (
          <div className={cn('flex items-center gap-1 px-1 mt-0.5', isRight ? 'flex-row-reverse' : 'flex-row')}>
            {time && <span className="text-[10px] text-muted-foreground/40 font-medium">{time}</span>}
            {msgStatus && <StatusIcon status={msgStatus} />}
          </div>
        )}
      </div>

      {/* Reply button — right of left-aligned bubble */}
      {onReply && hover && !isRight && !pickerOpen && (
        <button
          onClick={() => onReply(message)}
          className="flex-shrink-0 mb-1 p-1.5 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-all self-center opacity-0 group-hover:opacity-100"
          title="Reply"
        >
          <Reply size={13} />
        </button>
      )}
    </div>
  );
};

// ─── Segment renderer (extracted to keep JSX clean) ───────────────────────────
function renderSegment(
  seg: Segment,
  i: number,
  isRight: boolean,
  imgError: Record<string, boolean>,
  setImgError: React.Dispatch<React.SetStateAction<Record<string, boolean>>>,
  onMediaClick?: (url: string, type: 'image' | 'video') => void,
) {
  switch (seg.type) {
    case 'audio':
      return <AudioPlayer key={i} url={seg.url} isRight={isRight} />;

    case 'voice-placeholder':
      return <VoicePlaceholder key={i} isRight={isRight} />;

    case 'document':
      return <FileCard key={i} url={seg.url} name={seg.name} size={seg.size} isRight={isRight} />;

    case 'image':
      return imgError[seg.url] ? (
        <a key={i} href={seg.url} target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs text-primary hover:underline my-0.5 break-all">
          <ExternalLink size={12} /> {seg.url.split('/').pop()}
        </a>
      ) : (
        <div key={i} className="my-0.5 rounded-xl overflow-hidden max-w-[260px] cursor-pointer"
          onClick={() => onMediaClick?.(seg.url, 'image')}>
          <img src={seg.url} alt="image" className="max-w-full rounded-xl object-cover block hover:opacity-90 transition-opacity"
            style={{ maxHeight: 260 }}
            onError={() => setImgError(prev => ({ ...prev, [seg.url]: true }))} />
        </div>
      );

    case 'image-placeholder':
      return <ImagePlaceholder key={i} isRight={isRight} />;

    case 'video':
      return (
        <VideoThumbnail key={i} url={seg.url} onClick={() => onMediaClick?.(seg.url, 'video')} />
      );

    case 'video-placeholder':
      return <VideoPlaceholder key={i} isRight={isRight} />;

    case 'link':
      return (
        <a key={i} href={seg.url} target="_blank" rel="noopener noreferrer"
          className={cn('text-sm underline break-all', isRight ? 'text-violet-200' : 'text-primary')}>
          {seg.url}
        </a>
      );

    default:
      return (
        <p key={i} className={cn('whitespace-pre-wrap break-words', isRight ? 'text-white' : 'text-foreground')}>
          {(seg as { text: string }).text}
        </p>
      );
  }
}
