import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { ContentChunk } from '@agentclientprotocol/sdk';
import { groupMessages, parseSessionUpdate, type AcpMessage } from './group-messages';
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
import ScrollToBottomButton from './ScrollToBottomButton';
import { mergeToolCallMessages, type MergedToolCall } from './tool-call-state';


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

const BOTTOM_THRESHOLD = 24;

function distanceToBottom(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

export default function MessageList({ messages, hasMore, onLoadMore, loadingMore, sseLoading, sseError }: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollStateRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  /** 最近一次滚动事件记录的离底距离（同步值，避免 IO 异步回调滞后，R-12） */
  const distanceRef = useRef(0);
  /** 程序化滚动/初始加载期间抑制自动 load-more（R-14） */
  const suppressLoadMoreRef = useRef(true);
  /** 平滑滚动动画期间抑制跟随状态误判（R-12） */
  const suppressFollowStateRef = useRef(false);

  // 跟随判定：同步几何（滚动事件）为主、IntersectionObserver 为辅
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const isAtBottomRef = useRef(true);
  const hasMessages = messages.length > 0;

  const programmaticScroll = useCallback((behavior: ScrollBehavior) => {
    suppressLoadMoreRef.current = true;
    isAtBottomRef.current = true;
    distanceRef.current = 0;
    setIsAtBottom(true);
    setHasNewMessages(false);
    messagesEndRef.current?.scrollIntoView({ behavior });
    const release = () => {
      suppressLoadMoreRef.current = false;
      suppressFollowStateRef.current = false;
    };
    suppressFollowStateRef.current = behavior === 'smooth';
    if (behavior === 'smooth') {
      // 平滑动画期间持续抑制状态误判；用户一旦滚轮/触摸/按键即由手势 handler 提前接管
      setTimeout(release, 400);
    } else if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(release);
    } else {
      setTimeout(release, 0);
    }
  }, []);

  /** append 是否应跟随滚底：离底距离同步判定，避免「上翻被拉底」/「动画误判丢跟随」 */
  const shouldFollow = useCallback(() => {
    const list = listRef.current;
    if (!list) return isAtBottomRef.current;
    // 无溢出（含 jsdom 零几何）时以 IO 状态为准
    if (list.scrollHeight <= list.clientHeight) return isAtBottomRef.current;
    return distanceRef.current <= BOTTOM_THRESHOLD;
  }, []);

  useEffect(() => {
    if (!hasMessages) return;
    const anchor = messagesEndRef.current;
    if (!anchor || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        const list = listRef.current;
        const geometryTrusted = Boolean(list && list.scrollHeight > list.clientHeight);
        // 内容增长/平滑动画期间 IO 可能瞬时报告离底；几何仍贴底时保持跟随
        const next = geometryTrusted
          ? entry.isIntersecting || distanceRef.current <= BOTTOM_THRESHOLD
          : entry.isIntersecting;
        isAtBottomRef.current = next;
        setIsAtBottom(next);
        if (next) setHasNewMessages(false);
      },
      { threshold: 0.9 },
    );
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [hasMessages]);

  const handleScrollToBottom = useCallback(() => {
    programmaticScroll('smooth');
  }, [programmaticScroll]);

  // Scroll to bottom when messages change (only for new messages, not initial load)
  const prevCountRef = useRef(messages.length);
  const prevFirstIdRef = useRef<string | null>(messages[0]?.id ?? null);
  useEffect(() => {
    const currentFirstId = messages[0]?.id ?? null;
    const prevFirstId = prevFirstIdRef.current;
    // 首条仍在列表中 → 真正的历史 prepend；整组替换（SSE 重放）不是 prepend
    const prepended = prevFirstId !== null
      && currentFirstId !== prevFirstId
      && messages.some((message) => message.id === prevFirstId);
    prevFirstIdRef.current = currentFirstId;

    if (messages.length > prevCountRef.current) {
      if (prepended) {
        // Prepend: restore scroll position
        const list = listRef.current;
        const savedState = scrollStateRef.current;
        if (list && savedState) {
          requestAnimationFrame(() => {
            const newScrollHeight = list.scrollHeight;
            list.scrollTop = newScrollHeight - savedState.scrollHeight + savedState.scrollTop;
            distanceRef.current = distanceToBottom(list);
            scrollStateRef.current = null;
          });
        }
      } else if (shouldFollow()) {
        // Append: 仅在底部时跟随滚底；auto 避免逐 chunk smooth 抖动
        programmaticScroll('auto');
      } else {
        setHasNewMessages(true);
        isAtBottomRef.current = false;
        setIsAtBottom(false);
      }
    } else if (messages.length === prevCountRef.current && currentFirstId !== prevFirstId) {
      // SSE 整组替换：清理可能残留的 prepend 恢复状态（M-13）
      scrollStateRef.current = null;
      if (listRef.current) distanceRef.current = distanceToBottom(listRef.current);
    }
    prevCountRef.current = messages.length;
  }, [messages, programmaticScroll, shouldFollow]);

  // Scroll to bottom on initial load (auto：平滑动画会沿途触发 load-more，R-14)
  const initialLoadDone = useRef(false);
  useEffect(() => {
    if (!initialLoadDone.current && messages.length > 0) {
      initialLoadDone.current = true;
      programmaticScroll('auto');
    }
  }, [messages.length, programmaticScroll]);

  const loadEarlier = useCallback(() => {
    const list = listRef.current;
    if (list) {
      scrollStateRef.current = {
        scrollHeight: list.scrollHeight,
        scrollTop: list.scrollTop,
      };
    }
    onLoadMore?.();
  }, [onLoadMore]);

  const handleScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;

    distanceRef.current = distanceToBottom(list);
    // 平滑动画期间不更新跟随状态
    if (suppressFollowStateRef.current) return;

    const near = list.scrollHeight <= list.clientHeight || distanceRef.current <= BOTTOM_THRESHOLD;
    if (near) setHasNewMessages(false);
    if (near !== isAtBottomRef.current) {
      isAtBottomRef.current = near;
      setIsAtBottom(near);
    }

    // 初始加载/程序化滚动期间不触发自动 load-more
    if (suppressLoadMoreRef.current) return;
    if (!hasMore || loadingMore || !onLoadMore) return;

    // Load more when scrolled near the top
    if (list.scrollTop < 100) {
      loadEarlier();
    }
  }, [hasMore, loadingMore, onLoadMore, loadEarlier]);

  /** 用户手势立即接管跟随状态，避免平滑动画的抑制窗口吞掉主动上翻 */
  const handleUserScrollIntent = useCallback(() => {
    suppressLoadMoreRef.current = false;
    suppressFollowStateRef.current = false;
  }, []);

  const groups = useMemo(() => groupMessages(messages), [messages]);

  // 工具调用视图模型合并：同一 toolCallId 的全部消息合并后统一传给四个卡片
  const mergedToolCalls = useMemo(() => {
    const map = new Map<string, MergedToolCall>();
    for (const group of groups) {
      if (group.type === 'tool_call' || group.type === 'read' || group.type === 'fetch' || group.type === 'sub_agent') {
        const key = group.messages[0]?.id || 'unknown';
        map.set(key, mergeToolCallMessages(group.messages));
      }
    }
    return map;
  }, [groups]);

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
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={listRef}
        onScroll={handleScroll}
        onWheel={handleUserScrollIntent}
        onTouchMove={handleUserScrollIntent}
        onKeyDown={handleUserScrollIntent}
        data-testid="message-scroll-container"
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
                  onClick={loadEarlier}
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
                    toolCall={mergedToolCalls.get(groupKey)!}
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
                    toolCall={mergedToolCalls.get(groupKey)!}
                    expanded={expanded}
                    onExpandedChange={handleExpandedChange}
                  />
                );
              case 'read':
                return (
                  <ReadCard
                    key={groupKey}
                    toolCall={mergedToolCalls.get(groupKey)!}
                    expanded={expanded}
                    onExpandedChange={handleExpandedChange}
                  />
                );
              case 'fetch':
                return (
                  <FetchCard
                    key={groupKey}
                    toolCall={mergedToolCalls.get(groupKey)!}
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
      <ScrollToBottomButton
        visible={!isAtBottom}
        hasNewMessages={hasNewMessages}
        onClick={handleScrollToBottom}
      />
    </div>
  );
}
