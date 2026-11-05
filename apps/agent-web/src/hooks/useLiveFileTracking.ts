import { useEffect, useRef } from 'react';
import { mergeToolCallMessages, type MergedToolCall } from '../components/session/tool-call-state';
import { groupMessages, type AcpMessage } from '../components/session/group-messages';
import { computeDiff } from '../lib/diff';
import type { PreviewStoreApi } from '../stores/preview';

/**
 * 实况跟随（提案 §5.2 实现点 7，裁决 3）。
 *
 * 消费 SessionView 消息流，经 `group-messages` + `mergeToolCallMessages` 复用
 * 合并口径（禁止另写解析）。`live=true` 时仅跟踪开启后到达的调用：
 * - edit/diff → `openFile({pinned:true, diff, focusLine:首个 added 行})`
 * - read + `locations[0]` → 共享预览 tab（内容由 PreviewPane 拉取），`focusLine=locations[0].line`
 * - 无 diff 的 edit 退化为文件内容拉取 + focusLine
 * 以「toolCallId + 内容指纹」去重；关闭/切换会话清理。
 */

interface DiffContent {
  type: 'diff';
  path?: string;
  oldText?: string | null;
  newText?: string;
}

function diffContents(call: MergedToolCall): DiffContent[] {
  const items = (call.content ?? []) as unknown as Array<{ type?: string; path?: string; oldText?: string | null; newText?: string }>;
  return items.filter((item): item is DiffContent => item?.type === 'diff' && typeof item.newText === 'string');
}

/** 从 diff 提取首个 added 行（复用 lib/diff computeDiff） */
export function firstAddedLine(oldText: string | null, newText: string): number | undefined {
  const lines = computeDiff(oldText ?? '', newText);
  const added = lines.find((line) => line.type === 'added' && line.newLineNumber !== undefined);
  return added?.newLineNumber;
}

/** 提取器（纯函数，可单测）：MergedToolCall → 标签页驱动事件 */
export function extractLiveEvents(call: MergedToolCall): Array<{ filePath: string; pinned: boolean; focusLine?: number; diff?: { oldText: string | null; newText: string } }> {
  const events: Array<{ filePath: string; pinned: boolean; focusLine?: number; diff?: { oldText: string | null; newText: string } }> = [];
  const diffs = diffContents(call);
  if (diffs.length > 0) {
    for (const diff of diffs) {
      if (!diff.path) continue;
      events.push({
        filePath: diff.path,
        pinned: true,
        diff: { oldText: diff.oldText ?? null, newText: diff.newText ?? '' },
        focusLine: firstAddedLine(diff.oldText ?? null, diff.newText ?? ''),
      });
    }
    return events;
  }
  // edit 无 diff / read：退化为文件内容拉取（共享预览 tab）
  const kind = call.kind;
  if (kind !== 'edit' && kind !== 'read') return events;
  const location = call.locations?.[0];
  const path = location?.path;
  if (!path) return events;
  events.push({ filePath: path, pinned: false, focusLine: location?.line ?? undefined });
  return events;
}

function fingerprint(call: MergedToolCall): string {
  return JSON.stringify({
    kind: call.kind,
    locations: call.locations ?? [],
    content: (call.content ?? []).map((item) => (item as unknown as { type?: string; path?: string; newText?: string }).newText ?? (item as unknown as { type?: string; path?: string }).path ?? ''),
  });
}

export interface LiveTrackingOptions {
  sessionId: string;
  messages: AcpMessage[];
  live: boolean;
  store: PreviewStoreApi;
}

export function useLiveFileTracking({ sessionId, messages, live, store }: LiveTrackingOptions): void {
  const consumedRef = useRef(new Set<string>());

  // A3：开启实况时刻已存在的工具调用视为历史，全部预标记为已消费（进页面不回放历史）——
  // 仅跟踪开启之后到达/更新的调用；切会话/关闭实况清空
  useEffect(() => {
    const consumed = consumedRef.current;
    consumed.clear();
    if (!live) return;
    for (const call of groupMessages(messages).map((group) => mergeToolCallMessages(group.messages))) {
      if (call.toolCallId) consumed.add(`${call.toolCallId}:${fingerprint(call)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, live]);

  useEffect(() => {
    if (!live) return;
    // 合并口径复用（裁决 3）：groupMessages 分组 + 每组 mergeToolCallMessages
    const calls = groupMessages(messages).map((group) => mergeToolCallMessages(group.messages));
    for (const call of calls) {
      if (!call.toolCallId) continue;
      const key = `${call.toolCallId}:${fingerprint(call)}`;
      if (consumedRef.current.has(key)) continue;
      consumedRef.current.add(key);
      for (const event of extractLiveEvents(call)) {
        store.openFile({
          filePath: event.filePath,
          pinned: event.pinned,
          focusLine: event.focusLine,
          diff: event.diff,
        });
      }
    }
  }, [messages, live, store]);
}
