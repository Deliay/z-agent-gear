import { useRef, useEffect, useCallback } from 'react';
import MessageItem from './MessageItem';

interface AcpMessage {
  id: string;
  sessionId: string;
  direction: string;
  type: string;
  content: string;
  metadata: string | null;
  createdAt: string;
}

interface MessageListProps {
  messages: AcpMessage[];
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
}

export default function MessageList({ messages, hasMore, onLoadMore, loadingMore }: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Scroll to bottom when messages change (only for new messages, not initial load)
  const prevCountRef = useRef(messages.length);
  useEffect(() => {
    if (messages.length > prevCountRef.current) {
      scrollToBottom();
    }
    prevCountRef.current = messages.length;
  }, [messages.length, scrollToBottom]);

  // Scroll to bottom on initial load
  const initialLoadDone = useRef(false);
  useEffect(() => {
    if (!initialLoadDone.current && messages.length > 0) {
      scrollToBottom();
      initialLoadDone.current = true;
    }
  }, [messages.length, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const list = listRef.current;
    if (!list || !hasMore || loadingMore || !onLoadMore) return;

    // Load more when scrolled near the top
    if (list.scrollTop < 100) {
      onLoadMore();
    }
  }, [hasMore, loadingMore, onLoadMore]);

  return (
    <div
      ref={listRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto bg-gray-50 p-4"
    >
      {messages.length === 0 ? (
        <div className="flex h-full items-center justify-center text-gray-500">
          No messages yet. Start a conversation!
        </div>
      ) : (
        <div className="space-y-4">
          {hasMore && (
            <div className="py-2 text-center">
              {loadingMore ? (
                <div className="flex items-center justify-center gap-2 text-sm text-gray-500">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
                  Loading earlier messages...
                </div>
              ) : (
                <button
                  type="button"
                  onClick={onLoadMore}
                  className="text-sm text-blue-600 hover:text-blue-800"
                >
                  Load earlier messages
                </button>
              )}
            </div>
          )}
          {messages.map((message) => (
            <MessageItem key={message.id} message={message} />
          ))}
          <div ref={messagesEndRef} />
        </div>
      )}
    </div>
  );
}
