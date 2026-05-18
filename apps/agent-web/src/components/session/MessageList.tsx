import { useRef } from 'react';
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
}

export default function MessageList({ messages }: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Scroll to bottom when messages change
  if (messages.length > 0) {
    scrollToBottom();
  }

  return (
    <div
      ref={listRef}
      className="flex-1 overflow-y-auto bg-gray-50 p-4"
    >
      {messages.length === 0 ? (
        <div className="flex h-full items-center justify-center text-gray-500">
          No messages yet. Start a conversation!
        </div>
      ) : (
        <div className="space-y-4">
          {messages.map((message) => (
            <MessageItem key={message.id} message={message} />
          ))}
          <div ref={messagesEndRef} />
        </div>
      )}
    </div>
  );
}