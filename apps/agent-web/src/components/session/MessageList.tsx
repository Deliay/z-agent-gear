import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { SessionUpdate, ContentChunk } from '@agentclientprotocol/sdk';
import MessageItem from './MessageItem';
import ThoughtBlock from './ThoughtBlock';
import ToolCallCard from './ToolCallCard';
import PlanCard from './PlanCard';
import AvailableCommandsCard from './AvailableCommandsCard';
import UsageCard from './UsageCard';
import ConfigOptionCard from './ConfigOptionCard';
import CurrentModeCard from './CurrentModeCard';
import SubAgentCard from './SubAgentCard';
import ReadCard from './ReadCard';
import FetchCard from './FetchCard';
import PlanFloatingCard from './PlanFloatingCard';

interface AcpMessage {
  id: string;
  sessionId: string;
  messageId?: string | null;
  direction: string;
  type: string;
  content: string | Record<string, unknown>;
  metadata: string | null;
  createdAt: string;
}

interface MessageGroup {
  type: 'user_message' | 'agent_message' | 'thought' | 'plan' | 'tool_call' | 'available_commands' | 'usage' | 'config_option_update' | 'current_mode_update' | 'sub_agent' | 'read' | 'fetch' | 'unknown';
  messages: AcpMessage[];
  parsed: SessionUpdate | null;
  messageId: string | null;
}

function parseSessionUpdate(content: string | Record<string, unknown>): SessionUpdate | null {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content) as SessionUpdate;
    } catch {
      return null;
    }
  }
  return content as unknown as SessionUpdate;
}

export function groupMessages(messages: AcpMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  const toolCallGroupMap = new Map<string, number>(); // toolCallId -> group index
  const thoughtGroupMap = new Map<string, number>();  // messageId -> group index
  const agentMessageGroupMap = new Map<string, number>(); // messageId -> group index

  for (const message of messages) {
    const parsed = parseSessionUpdate(message.content);
    const sessionUpdateType = parsed?.sessionUpdate;
    const raw = parsed as Record<string, unknown> | null;
    const chunkMessageId = raw?.messageId as string | undefined;
    const toolCallId = raw?.toolCallId as string | undefined;

    let groupType: MessageGroup['type'];

    if (sessionUpdateType === 'user_message_chunk') {
      groupType = 'user_message';
    } else if (sessionUpdateType === 'agent_message_chunk') {
      groupType = 'agent_message';
    } else if (sessionUpdateType === 'agent_thought_chunk') {
      groupType = 'thought';
    } else if (sessionUpdateType === 'tool_call' || sessionUpdateType === 'tool_call_update') {
      const p = parsed as Record<string, unknown>;
      const kind = p.kind as string | undefined;
      const rawInput = p.rawInput;
      if (kind === 'read') {
        groupType = 'read';
      } else if (kind === 'fetch') {
        groupType = 'fetch';
      } else if (kind === 'other' && rawInput) {
        const rawInputObj = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
        if ((rawInputObj as Record<string, unknown>).subagent_type) {
          groupType = 'sub_agent';
        } else {
          groupType = 'tool_call';
        }
      } else {
        groupType = 'tool_call';
      }
    } else if (sessionUpdateType === 'plan') {
      groupType = 'plan';
    } else if (sessionUpdateType === 'available_commands_update') {
      groupType = 'available_commands';
    } else if (sessionUpdateType === 'usage_update') {
      groupType = 'usage';
    } else if (sessionUpdateType === 'config_option_update') {
      groupType = 'config_option_update';
    } else if (sessionUpdateType === 'current_mode_update') {
      groupType = 'current_mode_update';
    } else {
      // For 'other' kind, check rawInput for subagent_type, kind=read, kind=fetch
      if (parsed) {
        const p = parsed as Record<string, unknown>;
        const kind = p.kind as string | undefined;
        const rawInput = p.rawInput;
        if (kind === 'read') {
          groupType = 'read';
        } else if (kind === 'fetch') {
          groupType = 'fetch';
        } else if (kind === 'other' && rawInput && typeof rawInput === 'object' && (rawInput as Record<string, unknown>).subagent_type) {
          groupType = 'sub_agent';
        } else {
          groupType = 'unknown';
        }
      } else {
        groupType = 'unknown';
      }
    }

    let groupIndex: number;

    if ((groupType === 'tool_call' || groupType === 'sub_agent' || groupType === 'read' || groupType === 'fetch') && toolCallId) {
      // Tool calls and specialized types: group by toolCallId across the entire message list
      if (toolCallGroupMap.has(toolCallId)) {
        groupIndex = toolCallGroupMap.get(toolCallId)!;
        // Upgrade group type if the new message has a more specific type
        const existing = groups[groupIndex];
        if (existing.type === 'tool_call' && groupType !== 'tool_call') {
          existing.type = groupType;
        }
      } else {
        groupIndex = groups.length;
        toolCallGroupMap.set(toolCallId, groupIndex);
        groups.push({ type: groupType, messages: [], parsed, messageId: null });
      }
    } else if (groupType === 'thought' && chunkMessageId) {
      // Thought chunks: group by messageId across the entire list
      if (thoughtGroupMap.has(chunkMessageId)) {
        groupIndex = thoughtGroupMap.get(chunkMessageId)!;
      } else {
        groupIndex = groups.length;
        thoughtGroupMap.set(chunkMessageId, groupIndex);
        groups.push({ type: groupType, messages: [], parsed, messageId: chunkMessageId });
      }
    } else if (groupType === 'agent_message' && chunkMessageId) {
      // Agent message chunks with messageId: group by messageId across the entire list
      if (agentMessageGroupMap.has(chunkMessageId)) {
        groupIndex = agentMessageGroupMap.get(chunkMessageId)!;
      } else {
        groupIndex = groups.length;
        agentMessageGroupMap.set(chunkMessageId, groupIndex);
        groups.push({ type: groupType, messages: [], parsed, messageId: chunkMessageId });
      }
    } else if (groupType === 'user_message') {
      // Bug fix: each user message should be its own group, never merge consecutive
      groupIndex = groups.length;
      groups.push({ type: groupType, messages: [], parsed, messageId: null });
    } else {
      // Consecutive grouping for all other types (agent_message, available_commands, usage, etc.)
      const lastIndex = groups.length - 1;
      if (lastIndex >= 0 && groups[lastIndex].type === groupType) {
        groupIndex = lastIndex;
      } else {
        groupIndex = groups.length;
        groups.push({ type: groupType, messages: [], parsed, messageId: null });
      }
    }

    groups[groupIndex].messages.push(message);
  }

  return groups;
}

function mergeMessageChunks(messages: AcpMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const parsed = parseSessionUpdate(msg.content);
    if (
      parsed &&
      'sessionUpdate' in parsed &&
      (parsed.sessionUpdate === 'agent_message_chunk' || parsed.sessionUpdate === 'user_message_chunk') &&
      'content' in parsed &&
      parsed.content &&
      typeof parsed.content === 'object' &&
      'type' in parsed.content &&
      (parsed.content as { type: string }).type === 'text'
    ) {
      parts.push((parsed.content as { text: string }).text || '');
    }
  }
  if (parts.length === 0) {
    const lastContent = messages[messages.length - 1]?.content;
    if (typeof lastContent === 'string') return lastContent || '';
    return JSON.stringify(lastContent) || '';
  }

  const last = parseSessionUpdate(messages[messages.length - 1].content);
  if (last && 'sessionUpdate' in last) {
    return JSON.stringify({
      ...last,
      content: { type: 'text', text: parts.join('') },
    });
  }
  const lastContent = messages[messages.length - 1]?.content;
  if (typeof lastContent === 'string') return lastContent || '';
  return JSON.stringify(lastContent) || '';
}

interface MessageListProps {
  messages: AcpMessage[];
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  sseLoading?: boolean;
  sseError?: boolean;
}

export default function MessageList({ messages, hasMore, onLoadMore, loadingMore, sseLoading, sseError }: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isPrependRef = useRef(false);
  const scrollStateRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Scroll to bottom when messages change (only for new messages, not initial load)
  const prevCountRef = useRef(messages.length);
  const prevFirstIdRef = useRef<string | null>(null);
  useEffect(() => {
    const currentFirstId = messages[0]?.id || null;
    
    // Detect prepend: first message ID changed means history was prepended
    if (prevFirstIdRef.current !== null && currentFirstId !== prevFirstIdRef.current) {
      isPrependRef.current = true;
    }
    prevFirstIdRef.current = currentFirstId;

    if (messages.length > prevCountRef.current) {
      if (isPrependRef.current) {
        // Prepend: restore scroll position
        isPrependRef.current = false;
        const list = listRef.current;
        const savedState = scrollStateRef.current;
        if (list && savedState) {
          // Use requestAnimationFrame to ensure DOM has updated
          requestAnimationFrame(() => {
            const newScrollHeight = list.scrollHeight;
            list.scrollTop = newScrollHeight - savedState.scrollHeight + savedState.scrollTop;
            scrollStateRef.current = null;
          });
        }
      } else {
        // Append: scroll to bottom for new messages
        scrollToBottom();
      }
    }
    prevCountRef.current = messages.length;
  }, [messages, scrollToBottom]);

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
      // Save scroll state before loading
      scrollStateRef.current = {
        scrollHeight: list.scrollHeight,
        scrollTop: list.scrollTop,
      };
      onLoadMore();
    }
  }, [hasMore, loadingMore, onLoadMore]);

  const groups = useMemo(() => groupMessages(messages), [messages]);

  // Extract the last plan group for floating display
  const lastPlanMessages = useMemo(() => {
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groups[i].type === 'plan') {
        return groups[i].messages;
      }
    }
    return null;
  }, [groups]);

  // Auto-expand logic: expand the last expandable group, allow user override
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({});
  const prevLastExpandableRef = useRef<string | null>(null);

  const lastExpandableGroup = useMemo(() => {
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groups[i].type === 'thought' || groups[i].type === 'tool_call' || groups[i].type === 'sub_agent' || groups[i].type === 'read' || groups[i].type === 'fetch') {
        return groups[i];
      }
    }
    return null;
  }, [groups]);

  const lastExpandableKey = lastExpandableGroup?.messages[0]?.id || null;

  // When the last expandable group changes (new message arrived), reset overrides
  useEffect(() => {
    if (lastExpandableKey !== prevLastExpandableRef.current) {
      prevLastExpandableRef.current = lastExpandableKey;
      setExpandedOverrides({});
    }
  }, [lastExpandableKey]);

  const isExpanded = (groupKey: string) => {
    if (groupKey in expandedOverrides) {
      return expandedOverrides[groupKey];
    }
    return groupKey === lastExpandableKey;
  };

  return (
    <div
      ref={listRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto bg-background p-4"
    >
      {messages.length === 0 ? (
        sseLoading ? (
          <div className="flex h-full items-center justify-center">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
              Loading messages...
            </div>
          </div>
        ) : sseError ? (
          <div className="flex h-full items-center justify-center text-sm text-red-500">
            Failed to load messages. Connection error.
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            No messages yet. Start a conversation!
          </div>
        )
      ) : (
        <div className="space-y-4">
          {lastPlanMessages && (
            <PlanFloatingCard messages={lastPlanMessages.map(m => ({ content: m.content, createdAt: m.createdAt }))} />
          )}
          {hasMore ? (
            <div className="py-2 text-center">
              {loadingMore ? (
                <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary" />
                  Loading earlier messages...
                </div>
              ) : (
                <button
                  type="button"
                  onClick={onLoadMore}
                  className="text-sm text-primary hover:text-primary/80"
                >
                  Load earlier messages
                </button>
              )}
            </div>
          ) : messages.length > 0 ? (
            <div className="py-2 text-center text-sm text-muted-foreground">
              已加载全部历史
            </div>
          ) : null}
          {groups.map((group) => {
            const groupKey = group.messages[0]?.id || 'unknown';
            const expanded = isExpanded(groupKey);
            const handleExpandedChange = (next: boolean) => {
              setExpandedOverrides((prev) => ({ ...prev, [groupKey]: next }));
            };
            switch (group.type) {
              case 'thought':
                return (
                  <ThoughtBlock
                    key={groupKey}
                    chunks={group.messages.map((m) => parseSessionUpdate(m.content)).filter((p): p is ContentChunk & { sessionUpdate: 'agent_thought_chunk' } => p !== null && p.sessionUpdate === 'agent_thought_chunk')}
                    createdAt={group.messages[0]?.createdAt}
                    expanded={expanded}
                    onExpandedChange={handleExpandedChange}
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
              case 'config_option_update':
                return (
                  <ConfigOptionCard
                    key={groupKey}
                    messages={group.messages}
                  />
                );
              case 'current_mode_update':
                return (
                  <CurrentModeCard
                    key={groupKey}
                    messages={group.messages}
                  />
                );
              case 'plan':
                return (
                  <PlanCard
                    key={groupKey}
                    messages={group.messages.map((m) => ({ content: m.content, createdAt: m.createdAt }))}
                  />
                );
              case 'tool_call':
                return (
                  <ToolCallCard
                    key={groupKey}
                    messages={group.messages.map((m) => ({ content: m.content, createdAt: m.createdAt }))}
                    expanded={expanded}
                    onExpandedChange={handleExpandedChange}
                  />
                );
              case 'user_message':
              case 'agent_message':
                return (
                  <MessageItem
                    key={group.messages[0].id}
                    message={{
                      ...group.messages[0],
                      content: mergeMessageChunks(group.messages),
                    }}
                  />
                );
              case 'sub_agent':
                return (
                  <SubAgentCard
                    key={groupKey}
                    messages={group.messages.map((m) => ({ content: m.content, createdAt: m.createdAt }))}
                    expanded={expanded}
                    onExpandedChange={handleExpandedChange}
                  />
                );
              case 'read':
                return (
                  <ReadCard
                    key={groupKey}
                    messages={group.messages.map((m) => ({ content: m.content, createdAt: m.createdAt }))}
                    expanded={expanded}
                    onExpandedChange={handleExpandedChange}
                  />
                );
              case 'fetch':
                return (
                  <FetchCard
                    key={groupKey}
                    messages={group.messages.map((m) => ({ content: m.content, createdAt: m.createdAt }))}
                    expanded={expanded}
                    onExpandedChange={handleExpandedChange}
                  />
                );
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
