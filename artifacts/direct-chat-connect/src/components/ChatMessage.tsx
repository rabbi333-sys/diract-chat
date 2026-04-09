import { useState } from 'react';
import { ChatMessage as ChatMessageType } from '@/hooks/useChatHistory';
import { cn } from '@/lib/utils';
import { Reply, ExternalLink, Clock, CheckCheck } from 'lucide-react';

// ─── URL parsers ───────────────────────────────────────────────────────────────
const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp|bmp|avif|svg)(\?.*)?$/i;
const AUDIO_EXT = /\.(mp3|ogg|wav|m4a|aac|opus|flac|oga)(\?.*)?$/i;
const URL_REGEX = /(https?:\/\/[^\s<>"']+)/g;

type Segment =
  | { type: 'image'; url: string }
  | { type: 'audio'; url: string }
  | { type: 'link'; url: string }
  | { type: 'text'; text: string };

function parseSegments(text: string): Segment[] {
  const parts = text.split(URL_REGEX);
  const result: Segment[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('http://') || part.startsWith('https://')) {
      if (IMAGE_EXT.test(part)) result.push({ type: 'image', url: part });
      else if (AUDIO_EXT.test(part)) result.push({ type: 'audio', url: part });
      else result.push({ type: 'link', url: part });
    } else {
      const trimmed = part.trim();
      if (trimmed) result.push({ type: 'text', text: trimmed });
    }
  }
  return result;
}

// ─── Props ────────────────────────────────────────────────────────────────────
interface ChatMessageProps {
  message: ChatMessageType;
  onReply?: (msg: ChatMessageType) => void;
  isFirst?: boolean;   // first in a consecutive sender group
  isLast?: boolean;    // last in a consecutive sender group — shows avatar + time
}

// ─── Component ────────────────────────────────────────────────────────────────
export const ChatMessage = ({ message, onReply, isFirst = true, isLast = true }: ChatMessageProps) => {
  const [imgError, setImgError] = useState<Record<string, boolean>>({});
  const [hover, setHover] = useState(false);

  const isRight = message.sender === 'Agent' || message.sender === 'AI';
  const content = message.message_text?.trim();
  if (!content) return null;

  const segments = parseSegments(content);
  const hasOnlyMedia = segments.every(s => s.type === 'image' || s.type === 'audio');

  const time = message.timestamp
    ? new Date(message.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
    : '';

  // Messenger-style corner rounding
  // Right (user/agent): top-left always round, top-right round if first, bottom-right round if last
  const rightRadius = cn(
    'rounded-tl-[18px]',
    isFirst ? 'rounded-tr-[18px]' : 'rounded-tr-[5px]',
    isLast  ? 'rounded-br-[5px]'  : 'rounded-br-[5px]',
    'rounded-bl-[18px]',
  );
  // Left (AI): top-right always round, top-left round if first, bottom-left round if last
  const leftRadius = cn(
    'rounded-tr-[18px]',
    isFirst ? 'rounded-tl-[18px]' : 'rounded-tl-[5px]',
    isLast  ? 'rounded-bl-[5px]'  : 'rounded-bl-[5px]',
    'rounded-br-[18px]',
  );

  const bubbleStyle = isRight
    ? { background: 'linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)', boxShadow: '0 2px 12px rgba(109,40,217,0.25)' }
    : {};

  const isSending = isRight && message._sending === true;
  const isSent = isRight && message._sending === false;

  return (
    <div
      className={cn(
        'flex items-end gap-2 px-1 group',
        isRight ? 'justify-end' : 'justify-start',
        isLast ? 'mb-1' : 'mb-[2px]',
        // Messenger-like slide-in animation for new messages
        'animate-in fade-in-0 slide-in-from-bottom-1 duration-150',
      )}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* Left-side avatar — only on last message of group */}
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

        {/* ── Reply-to quote ──────────────────────────────────────────────── */}
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

        {/* ── Main bubble ─────────────────────────────────────────────────── */}
        <div
          data-testid={`bubble-${isRight ? 'agent' : 'ai'}-${message.id}`}
          className={cn(
            'relative overflow-hidden',
            hasOnlyMedia
              ? 'rounded-2xl p-1 bg-transparent border-0 shadow-none'
              : cn(
                  'px-3.5 py-2 text-sm leading-relaxed',
                  isRight ? rightRadius : leftRadius,
                  !isRight && 'bg-muted/80 dark:bg-white/10 border border-border/40',
                )
          )}
          style={hasOnlyMedia ? {} : (isRight ? bubbleStyle : {})}
        >
          {segments.map((seg, i) => {
            if (seg.type === 'image') {
              return imgError[seg.url] ? (
                <a key={i} href={seg.url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs text-primary hover:underline my-0.5 break-all">
                  <ExternalLink size={12} /> {seg.url.split('/').pop()}
                </a>
              ) : (
                <div key={i} className="my-1 rounded-xl overflow-hidden max-w-[260px]">
                  <img src={seg.url} alt="image" className="max-w-full rounded-xl object-cover block"
                    style={{ maxHeight: 260 }}
                    onError={() => setImgError(prev => ({ ...prev, [seg.url]: true }))} />
                </div>
              );
            }
            if (seg.type === 'audio') {
              return (
                <div key={i} className="my-1.5">
                  <audio controls src={seg.url} className="w-full max-w-[260px] h-9 rounded-full"
                    style={{ accentColor: '#7c3aed' }} />
                </div>
              );
            }
            if (seg.type === 'link') {
              return (
                <a key={i} href={seg.url} target="_blank" rel="noopener noreferrer"
                  className={cn('text-sm underline break-all', isRight ? 'text-violet-200' : 'text-primary')}>
                  {seg.url}
                </a>
              );
            }
            return (
              <p key={i} className={cn('whitespace-pre-wrap break-words', isRight ? 'text-white' : 'text-foreground')}>
                {seg.text}
              </p>
            );
          })}
        </div>

        {/* Timestamp + send status — only on last of group */}
        {isLast && (
          <div className={cn('flex items-center gap-1 px-1 mt-0.5', isRight ? 'flex-row-reverse' : 'flex-row')}>
            {time && (
              <span className="text-[10px] text-muted-foreground/40 font-medium">{time}</span>
            )}
            {isSending && (
              <Clock size={9} className="text-muted-foreground/40 animate-pulse flex-shrink-0" />
            )}
            {isSent && (
              <CheckCheck size={10} className="text-violet-400/70 flex-shrink-0" />
            )}
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
