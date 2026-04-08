import { useChatHistory } from '@/hooks/useChatHistory';
import { ChatMessage } from './ChatMessage';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MessageSquare } from 'lucide-react';

interface ChatViewProps {
  sessionId: string | null;
}

export const ChatView = ({ sessionId }: ChatViewProps) => {
  const { data: messages, isLoading, error } = useChatHistory(sessionId || undefined);

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

  if (isLoading) {
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
    <ScrollArea className="flex-1">
      <div className="p-6 space-y-3 max-w-4xl mx-auto">
        {messages?.map((message) => (
          <ChatMessage key={message.id} message={message} />
        ))}
      </div>
    </ScrollArea>
  );
};
