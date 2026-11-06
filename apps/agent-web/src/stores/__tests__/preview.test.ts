// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  reduceTabs,
  emptyPreviewState,
  getPreviewStore,
  destroyPreviewStore,
  type PreviewState,
} from '../preview.js';
import { getPromptComposer, destroyPromptComposer } from '../prompt-composer.js';

function open(state: PreviewState, filePath: string, pinned: boolean, extra: Record<string, unknown> = {}): PreviewState {
  return reduceTabs(state, { type: 'openFile', input: { filePath, pinned, ...extra } });
}

describe('reduceTabs（T-TABS1~6）', () => {
  it('T-TABS1 读→替换共享 tab（至多一个非 pinned file tab）', () => {
    let state = open(emptyPreviewState, 'a.ts', false);
    state = open(state, 'b.ts', false);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({ kind: 'file', filePath: 'b.ts', pinned: false });
    expect(state.activeTabId).toBe(state.tabs[0].id);
  });

  it('T-TABS2 写→常开就地更新（同 filePath 不新开）', () => {
    let state = open(emptyPreviewState, 'a.ts', true, { diff: { oldText: null, newText: 'x' } });
    state = open(state, 'a.ts', true, { diff: { oldText: 'x', newText: 'y' }, focusLine: 3 });
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({ pinned: true, focusLine: 3, diff: { oldText: 'x', newText: 'y' } });
  });

  it('T-TABS3 读后写并存 / T-TABS4 写后读并存', () => {
    let state = open(emptyPreviewState, 'a.ts', false);
    state = open(state, 'b.ts', true);
    expect(state.tabs.map((tab) => (tab.kind === 'file' ? tab.filePath : ''))).toEqual(['a.ts', 'b.ts']);

    let state2 = open(emptyPreviewState, 'c.ts', true);
    state2 = open(state2, 'd.ts', false);
    expect(state2.tabs.map((tab) => (tab.kind === 'file' ? `${tab.filePath}:${tab.pinned}` : ''))).toEqual([
      'c.ts:true',
      'd.ts:false',
    ]);
  });

  it('T-TABS5 关闭激活回退邻近 tab', () => {
    let state = open(emptyPreviewState, 'a.ts', true);
    state = open(state, 'b.ts', true);
    state = open(state, 'c.ts', true);
    const midId = state.tabs[1].id;
    state = reduceTabs(state, { type: 'setActive', id: midId });
    state = reduceTabs(state, { type: 'closeTab', id: midId });
    // 右侧邻近优先
    expect(state.activeTabId).toBe(state.tabs[1].id);

    state = reduceTabs(state, { type: 'closeTab', id: state.tabs[1].id });
    expect(state.activeTabId).toBe(state.tabs[0].id);

    state = reduceTabs(state, { type: 'closeTab', id: state.tabs[0].id });
    expect(state.activeTabId).toBeNull();
    expect(state.tabs).toHaveLength(0);
  });

  it('T-TABS6 review 幂等打开', () => {
    let state = reduceTabs(emptyPreviewState, { type: 'openReview', reviewId: 'rev-1' });
    state = reduceTabs(state, { type: 'openReview', reviewId: 'rev-1' });
    expect(state.tabs).toHaveLength(1);
    state = reduceTabs(state, { type: 'openReview', reviewId: 'rev-2' });
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe(state.tabs[1].id);
    // 关闭激活 review tab 回退
    state = reduceTabs(state, { type: 'closeTab', id: state.tabs[1].id });
    expect(state.activeTabId).toBe(state.tabs[0].id);
  });
});

describe('preview store 工厂（裁决 1）', () => {
  beforeEach(() => {
    destroyPreviewStore('sess-1');
    destroyPromptComposer('sess-1');
  });

  it('按 sessionId 隔离 + destroy 清理', () => {
    const storeA = getPreviewStore('sess-a');
    const storeB = getPreviewStore('sess-b');
    expect(storeA).not.toBe(storeB);
    storeA.openFile({ filePath: 'a.ts', pinned: true });
    expect(storeB.getSnapshot().tabs).toHaveLength(0);

    destroyPreviewStore('sess-a');
    expect(getPreviewStore('sess-a').getSnapshot().tabs).toHaveLength(0);
  });

  it('prompt-composer：appendPart/removePart/clear（origin 标注）', () => {
    const composer = getPromptComposer('sess-1');
    composer.appendPart({ id: 'p1', type: 'text', text: 'hi', origin: { target: { source: 'code' }, comments: [] } });
    composer.appendPart({ id: 'p2', type: 'image', data: 'IMG', mimeType: 'image/png' });
    expect(composer.getSnapshot().parts).toHaveLength(2);
    composer.removePart('p1');
    expect(composer.getSnapshot().parts.map((part) => part.id)).toEqual(['p2']);
    composer.clear();
    expect(composer.getSnapshot().parts).toHaveLength(0);
    destroyPromptComposer('sess-1');
    expect(getPromptComposer('sess-1').getSnapshot().parts).toHaveLength(0);
  });
});
