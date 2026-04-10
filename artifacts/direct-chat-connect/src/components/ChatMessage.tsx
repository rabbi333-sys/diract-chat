import { useState, useRef, useEffect } from 'react';
import { ChatMessage as ChatMessageType } from '@/hooks/useChatHistory';
import { cn } from '@/lib/utils';
import { Reply, ExternalLink, Clock, CheckCheck, Mic, ImageIcon, Video, Play, Pause, Volume2 } from 'lucide-react';

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
  | { type: 'video-placeholder' };

function parseSegments(text: string): Segment[] {
  const trimmed = text.trim();

  // blob: URLs = optimistic voice messages recorded in-browser
  if (trimmed.startsWith('blob:')) return [{ type: 'audio', url: trimmed }];

  // Meta placeholder strings
  if (/^\[voice message\]$/i.test(trimmed)) return [{ type: 'voice-placeholder' }];
  if (/^\[image\]$/i.test(trimmed))         return [{ type: 'image-placeholder' }];
  if (/^\[video\]$/i.test(trimmed))         return [{ type: 'video-placeholder' }];

  // URL parsing
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

// ─── Mini audio player ─────────────────────────────────────────────────────────
const AudioPlayer = ({ url, isRight }: { url: string; isRight: boolean }) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setProgress(el.duration ? (el.currentTime / el.duration) * 100 : 0);
    const onDur  = () => setDuration(el.duration || 0);
    const onEnd  = () => { setPlaying(false); setProgress(0); };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onDur);
    el.addEventListener('ended', onEnd);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onDur);
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
    if (!el || !el.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    el.currentTime = pct * el.duration;
  };

  const fmtTime = (s: number) => isNaN(s) ? '0:00' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  const trackColor = isRight ? 'bg-white/30' : 'bg-foreground/15';
  const fillColor  = isRight ? 'bg-white'     : 'bg-primary';
  const iconColor  = isRight ? 'text-white'   : 'text-foreground';
  const timeColor  = isRight ? 'text-white/60' : 'text-muted-foreground';

  return (
    <div className="flex items-center gap-2.5 py-1 min-w-[200px] max-w-[260px]">
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

      <div className="flex-1 flex flex-col gap-1.5">
        {/* Waveform-style bar */}
        <div className={cn('w-full h-1.5 rounded-full cursor-pointer', trackColor)} onClick={seek}>
          <div className={cn('h-full rounded-full transition-all', fillColor)} style={{ width: `${progress}%` }} />
        </div>
        <div className="flex items-center justify-between">
          <Volume2 size={10} className={timeColor} />
          <span className={cn('text-[10px] font-medium tabular-nums', timeColor)}>
            {duration > 0 ? fmtTime(duration) : '0:00'}
          </span>
        </div>
      </div>
    </div>
  );
};

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

// ─── Props ────────────────────────────────────────────────────────────────────
interface ChatMessageProps {
  message: ChatMessageType;
  onReply?: (msg: ChatMessageType) => void;
  isFirst?: boolean;
  isLast?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────
export const ChatMessage = ({ message, onReply, isFirst = true, isLast = true }: ChatMessageProps) => {
  const [imgError, setImgError] = useState<Record<string, boolean>>({});
  const [hover, setHover] = useState(false);

  const isRight = message.sender === 'Agent' || message.sender === 'AI';
  const content = message.message_text?.trim();
  if (!content) return null;

  const segments = parseSegments(content);

  // Pure-media messages get transparent background
  const isMediaOnly = segments.every(s =>
    s.type === 'image' || s.type === 'audio' || s.type === 'video' ||
    s.type === 'voice-placeholder' || s.type === 'image-placeholder' || s.type === 'video-placeholder'
  );

  const time = message.timestamp
    ? new Date(message.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
    : '';

  // Messenger-style corner rounding
  const rightRadius = cn('rounded-tl-[18px]', isFirst ? 'rounded-tr-[18px]' : 'rounded-tr-[5px]', 'rounded-br-[5px] rounded-bl-[18px]');
  const leftRadius  = cn('rounded-tr-[18px]', isFirst ? 'rounded-tl-[18px]' : 'rounded-tl-[5px]', 'rounded-bl-[5px] rounded-br-[18px]');

  const bubbleStyle = isRight
    ? { background: 'linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)', boxShadow: '0 2px 12px rgba(109,40,217,0.25)' }
    : {};

  const isSending = isRight && message._sending === true;
  const isSent    = isRight && message._sending === false;

  return (
    <div
      className={cn(
        'flex items-end gap-2 px-1 group',
        isRight ? 'justify-end' : 'justify-start',
        isLast ? 'mb-1' : 'mb-[2px]',
        'animate-in fade-in-0 slide-in-from-bottom-1 duration-150',
      )}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
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
      {onReply && hover && isRight && (
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

        {/* Main bubble */}
        <div
          data-testid={`bubble-${isRight ? 'agent' : 'ai'}-${message.id}`}
          className={cn(
            'relative overflow-hidden',
            isMediaOnly
              ? 'rounded-2xl p-2 bg-transparent border-0 shadow-none'
              : cn(
                  'px-3.5 py-2 text-sm leading-relaxed',
                  isRight ? rightRadius : leftRadius,
                  !isRight && 'bg-muted/80 dark:bg-white/10 border border-border/40',
                )
          )}
          style={isMediaOnly ? {} : (isRight ? bubbleStyle : {})}
        >
          {/* For media-only messages, wrap with bubble style applied to inner content */}
          {isMediaOnly && isRight && (
            <div className="rounded-2xl p-2.5" style={bubbleStyle}>
              {segments.map((seg, i) => renderSegment(seg, i, isRight, imgError, setImgError))}
            </div>
          )}
          {isMediaOnly && !isRight && (
            <div className="rounded-2xl p-2.5 bg-muted/80 dark:bg-white/10 border border-border/40">
              {segments.map((seg, i) => renderSegment(seg, i, isRight, imgError, setImgError))}
            </div>
          )}
          {!isMediaOnly && segments.map((seg, i) => renderSegment(seg, i, isRight, imgError, setImgError))}
        </div>

        {/* Timestamp + send status */}
        {isLast && (
          <div className={cn('flex items-center gap-1 px-1 mt-0.5', isRight ? 'flex-row-reverse' : 'flex-row')}>
            {time && <span className="text-[10px] text-muted-foreground/40 font-medium">{time}</span>}
            {isSending && <Clock size={9} className="text-muted-foreground/40 animate-pulse flex-shrink-0" />}
            {isSent    && <CheckCheck size={10} className="text-violet-400/70 flex-shrink-0" />}
          </div>
        )}
      </div>

      {/* Reply button — right of left-aligned bubble */}
      {onReply && hover && !isRight && (
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
) {
  switch (seg.type) {
    case 'audio':
      return <AudioPlayer key={i} url={seg.url} isRight={isRight} />;

    case 'voice-placeholder':
      return <VoicePlaceholder key={i} isRight={isRight} />;

    case 'image':
      return imgError[seg.url] ? (
        <a key={i} href={seg.url} target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs text-primary hover:underline my-0.5 break-all">
          <ExternalLink size={12} /> {seg.url.split('/').pop()}
        </a>
      ) : (
        <div key={i} className="my-0.5 rounded-xl overflow-hidden max-w-[260px]">
          <img src={seg.url} alt="image" className="max-w-full rounded-xl object-cover block"
            style={{ maxHeight: 260 }}
            onError={() => setImgError(prev => ({ ...prev, [seg.url]: true }))} />
        </div>
      );

    case 'image-placeholder':
      return <ImagePlaceholder key={i} isRight={isRight} />;

    case 'video':
      return (
        <div key={i} className="my-0.5 rounded-xl overflow-hidden max-w-[260px]">
          <video controls src={seg.url} className="max-w-full rounded-xl block" style={{ maxHeight: 260 }} />
        </div>
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
