import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChatMessage as ChatMessageComponent } from './ChatMessage';
import { MessageSquare, Loader2 } from 'lucide-react';
import { fetchMessages, useDbConnectionKey, ChatMessage } from '@/hooks/useChatHistory';

const PAGE_SIZE = 30;

interface ChatViewProps {
  sessionId: string | null;
}

export const ChatView = ({ sessionId }: ChatViewProps) => {
  const dbKey = useDbConnectionKey();
  const queryClient = useQueryClient();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [initialLoading, setInitialLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevScrollHeightRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Load initial messages when session changes
  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      setOffset(0);
      setHasMore(true);
      setError(null);
      return;
    }

    sessionIdRef.current = sessionId;
    setOffset(0);
    setHasMore(true);
    setError(null);

    // Check React Query cache first (may have been pre-fetched by SessionList)
    const cached = queryClient.getQueryData<ChatMessage[]>(['chat-history', sessionId, dbKey]);
    if (cached && cached.length > 0) {
      setMessages(cached);
      setInitialLoading(false);
      requestAnimationFrame(scrollToBottom);
      return;
    }

    setMessages([]);
    setInitialLoading(true);

    fetchMessages(sessionId, PAGE_SIZE, 0)
      .then((msgs) => {
        if (sessionIdRef.current !== sessionId) return;
        setMessages(msgs);
        setHasMore(msgs.length >= PAGE_SIZE);
        setInitialLoading(false);
        requestAnimationFrame(scrollToBottom);
      })
      .catch((err) => {
        if (sessionIdRef.current !== sessionId) return;
        setError(err?.message ?? 'Failed to load messages');
        setInitialLoading(false);
      });
  }, [sessionId, dbKey]);

  // Load older messages when user scrolls near the top
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || !sessionId) return;
    const el = scrollRef.current;
    if (!el) return;

    setLoadingMore(true);
    prevScrollHeightRef.current = el.scrollHeight;

    try {
      const newOffset = offset + PAGE_SIZE;
      const older = await fetchMessages(sessionId, PAGE_SIZE, newOffset);

      if (sessionIdRef.current !== sessionId) return;

      if (older.length === 0) {
        setHasMore(false);
      } else {
        setMessages((prev) => [...older, ...prev]);
        setOffset(newOffset);
        setHasMore(older.length >= PAGE_SIZE);

        // Preserve scroll position after prepending
        requestAnimationFrame(() => {
          if (el) {
            el.scrollTop = el.scrollHeight - prevScrollHeightRef.current;
          }
        });
      }
    } catch {
      // silently ignore — user can scroll again to retry
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, sessionId, offset]);

  // Scroll listener: trigger load when within 200px of top
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop < 200 && hasMore && !loadingMore && !initialLoading) {
      loadMore();
    }
  }, [hasMore, loadingMore, initialLoading, loadMore]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  if (!sessionId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
        <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
          <MessageSquare size={28} className="text-muted-foreground" />
        </div>
        <h3 className="text-lg font-semibold text-foreground mb-1">
          Select a conversation
        </h3>
        <p className="text-sm text-muted-foreground">
          Choose a session from the left to view messages
        </p>
      </div>
    );
  }

  if (initialLoading) {
    return (
      <div className="flex-1 p-6 space-y-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className={`flex ${i % 2 === 0 ? 'justify-start' : 'justify-end'}`}>
            <div className="h-16 w-3/5 bg-muted rounded-2xl animate-pulse" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-destructive font-medium">
        Failed to load messages
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto"
      style={{ overscrollBehavior: 'contain' }}
    >
      <div className="p-6 space-y-3 max-w-4xl mx-auto">
        {/* Loading older messages indicator */}
        {loadingMore && (
          <div className="flex items-center justify-center gap-2 py-3 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            <span>Loading older messages…</span>
          </div>
        )}

        {/* All-loaded indicator */}
        {!hasMore && messages.length > PAGE_SIZE && (
          <div className="text-center py-3 text-xs text-muted-foreground/60">
            All messages loaded
          </div>
        )}

        {messages.map((message) => (
          <ChatMessageComponent key={message.id} message={message} />
        ))}

        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <MessageSquare size={24} className="mb-2 opacity-40" />
            <p className="text-sm">No messages in this conversation</p>
          </div>
        )}
      </div>
    </div>
  );
};
