import { useRef, useEffect, useCallback, useMemo } from 'react';
import type { SessionUpdate, ContentChunk } from '@agentclientprotocol/sdk';
import MessageItem from './MessageItem';
import ThoughtBlock from './ThoughtBlock';
import AvailableCommandsCard from './AvailableCommandsCard';
import UsageCard from './UsageCard';

interface AcpMessage {
  id: string;
  sessionId: string;
  direction: string;
  type: string;
  content: string;
  metadata: string | null;
  createdAt: string;
}

interface MessageGroup {
  type: 'message' | 'thought' | 'tool_call' | 'available_commands' | 'usage' | 'unknown';
  messages: AcpMessage[];
  parsed: SessionUpdate | null;
}

function parseSessionUpdate(content: string): SessionUpdate | null {
  try {
    return JSON.parse(content) as SessionUpdate;
  } catch {
    return null;
  }
}

function groupMessages(messages: AcpMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentGroup: MessageGroup | null = null;

  for (const message of messages) {
    const parsed = parseSessionUpdate(message.content);
    const sessionUpdateType = parsed?.sessionUpdate;

    let groupType: MessageGroup['type'];

    if (sessionUpdateType === 'agent_message_chunk' || sessionUpdateType === 'user_message_chunk') {
      groupType = 'message';
    } else if (sessionUpdateType === 'agent_thought_chunk') {
      groupType = 'thought';
    } else if (sessionUpdateType === 'tool_call' || sessionUpdateType === 'tool_call_update') {
      groupType = 'tool_call';
    } else if (sessionUpdateType === 'available_commands_update') {
      groupType = 'available_commands';
    } else if (sessionUpdateType === 'usage_update') {
      groupType = 'usage';
    } else {
      groupType = 'unknown';
    }

    // Check if we should continue the current group
    const shouldContinue =
      currentGroup &&
      currentGroup.type === groupType &&
      (groupType === 'message' || groupType === 'thought');

    if (shouldContinue) {
      currentGroup!.messages.push(message);
    } else {
      // Start a new group
      currentGroup = {
        type: groupType,
        messages: [message],
        parsed,
      };
      groups.push(currentGroup);
    }
  }

  return groups;
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

  const groups = useMemo(() => groupMessages(messages), [messages]);

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
          {groups.map((group) => {
            const groupKey = group.messages[0]?.id || 'unknown';
            switch (group.type) {
              case 'thought':
                return (
                  <ThoughtBlock
                    key={groupKey}
                    chunks={group.messages.map((m) => parseSessionUpdate(m.content)).filter((p): p is ContentChunk & { sessionUpdate: 'agent_thought_chunk' } => p !== null && p.sessionUpdate === 'agent_thought_chunk')}
                    createdAt={group.messages[0]?.createdAt}
                  />
                );
              case 'available_commands':
                return group.parsed?.sessionUpdate === 'available_commands_update' ? (
                  <AvailableCommandsCard
                    key={groupKey}
                    data={group.parsed}
                  />
                ) : null;
              case 'usage':
                return group.parsed?.sessionUpdate === 'usage_update' ? (
                  <UsageCard
                    key={groupKey}
                    data={group.parsed}
                  />
                ) : null;
              case 'message':
              case 'tool_call':
              case 'unknown':
              default:
                return group.messages.map((message) => (
                  <MessageItem key={message.id} message={message} />
                ));
            }
          })}
          <div ref={messagesEndRef} />
        </div>
      )}
    </div>
  );
}
