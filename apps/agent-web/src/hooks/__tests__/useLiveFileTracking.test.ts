// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { extractLiveEvents, firstAddedLine, useLiveFileTracking } from '../useLiveFileTracking';
import type { MergedToolCall } from '../../components/session/tool-call-state';
import { getPreviewStore, destroyPreviewStore } from '../../stores/preview';
import type { AcpMessage } from '../../components/session/group-messages';

function toolCallMessage(id: string, kind: string, extra: Record<string, unknown>): AcpMessage {
  return {
    id,
    sessionId: 'sess-1',
    direction: 'output',
    type: 'tool_call',
    content: {
      sessionUpdate: 'tool_call',
      toolCallId: id,
      kind,
      status: 'completed',
      ...extra,
    },
    metadata: null,
    messageId: null,
    createdAt: new Date().toISOString(),
  } as unknown as AcpMessage;
}

describe('useLiveFileTracking 提取器（T-LIVE）', () => {
  it('edit/diff → pinned + diff + focusLine 首个 added 行', () => {
    const call = {
      toolCallId: 'tc-1',
      kind: 'edit',
      status: 'completed',
      content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a\n', newText: 'a\nb\n' }],
    } as unknown as MergedToolCall;
    const events = extractLiveEvents(call);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ filePath: 'src/a.ts', pinned: true, diff: { oldText: 'a\n', newText: 'a\nb\n' } });
    expect(events[0].focusLine).toBe(firstAddedLine('a\n', 'a\nb\n'));
    expect(firstAddedLine('a\n', 'a\nb\n')).toBe(2);
  });

  it('read + locations[0] → 共享预览 tab + focusLine', () => {
    const call = {
      toolCallId: 'tc-2',
      kind: 'read',
      status: 'completed',
      locations: [{ path: 'src/b.ts', line: 7 }],
    } as unknown as MergedToolCall;
    expect(extractLiveEvents(call)).toEqual([{ filePath: 'src/b.ts', pinned: false, focusLine: 7 }]);
  });

  it('edit 无 diff 退化为内容拉取（pinned=false）；非 edit/read 忽略', () => {
    const edit = {
      toolCallId: 'tc-3',
      kind: 'edit',
      status: 'completed',
      locations: [{ path: 'src/c.ts', line: 3 }],
    } as unknown as MergedToolCall;
    expect(extractLiveEvents(edit)).toEqual([{ filePath: 'src/c.ts', pinned: false, focusLine: 3 }]);

    const think = { toolCallId: 'tc-4', kind: 'think', status: 'completed' } as unknown as MergedToolCall;
    expect(extractLiveEvents(think)).toEqual([]);
  });

  it('A3：开启实况不回放历史，仅驱动开启后到达的调用；指纹去重', () => {
    destroyPreviewStore('live-sess');
    const store = getPreviewStore('live-sess');
    const openFile = vi.spyOn(store, 'openFile');

    const history = [toolCallMessage('tc-old', 'read', { locations: [{ path: 'old.ts', line: 1 }] })];
    // 开启时已存在 history：不驱动
    const { rerender } = renderHook(
      ({ messages, live }: { messages: AcpMessage[]; live: boolean }) =>
        useLiveFileTracking({ sessionId: 'live-sess', messages, live, store }),
      { initialProps: { messages: history, live: true } },
    );
    expect(openFile).not.toHaveBeenCalled();

    // 开启后到达的 read：驱动一次
    const fresh = toolCallMessage('tc-new', 'read', { locations: [{ path: 'new.ts', line: 2 }] });
    rerender({ messages: [...history, fresh], live: true });
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ filePath: 'new.ts', pinned: false }));

    // 同一调用（指纹相同）再次渲染不重复驱动
    rerender({ messages: [...history, fresh, { ...fresh, id: 'dup' } as AcpMessage], live: true });
    expect(openFile).toHaveBeenCalledTimes(1);

    // 关闭实况零副作用
    const more = toolCallMessage('tc-off', 'read', { locations: [{ path: 'off.ts', line: 1 }] });
    rerender({ messages: [...history, fresh, more], live: false });
    expect(openFile).toHaveBeenCalledTimes(1);

    destroyPreviewStore('live-sess');
  });
});
