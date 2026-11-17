// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DRAFT_DEBOUNCE_MS,
  DRAFT_KEY_PREFIX,
  clearDocumentDraft,
  documentDraftKey,
  flushDocumentDraft,
  readDocumentDraft,
  resetDraftScheduler,
  scheduleDocumentDraft,
  writeDocumentDraft,
} from '../knowledge-base-draft';

const base = { title: '标题', tags: ['a'], description: '描述', content: '# 内容' };

describe('knowledge-base-draft（T-KBD1~5）', () => {
  beforeEach(() => {
    localStorage.clear();
    resetDraftScheduler();
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetDraftScheduler();
    vi.useRealTimers();
  });

  it('T-KBD1 防抖 300ms 写入（只落最后一次）', () => {
    scheduleDocumentDraft('kb-1', '/a', { ...base, title: '第一次' });
    scheduleDocumentDraft('kb-1', '/a', { ...base, title: '第二次' });

    expect(localStorage.getItem(documentDraftKey('kb-1', '/a'))).toBeNull();
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS - 1);
    expect(localStorage.getItem(documentDraftKey('kb-1', '/a'))).toBeNull();

    vi.advanceTimersByTime(1);
    const draft = readDocumentDraft('kb-1', '/a');
    expect(draft?.title).toBe('第二次');
    expect(draft?.content).toBe('# 内容');
    expect(typeof draft?.updatedAt).toBe('string');
  });

  it('T-KBD2 保存清除：clear 移除缓存并取消在途写入', () => {
    writeDocumentDraft('kb-1', '/a', base);
    expect(readDocumentDraft('kb-1', '/a')).not.toBeNull();

    clearDocumentDraft('kb-1', '/a');
    expect(localStorage.getItem(documentDraftKey('kb-1', '/a'))).toBeNull();

    // 在途草稿被取消：clear 后推进计时器也不会复活
    scheduleDocumentDraft('kb-1', '/a', { ...base, title: '迟到草稿' });
    clearDocumentDraft('kb-1', '/a');
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS + 10);
    expect(readDocumentDraft('kb-1', '/a')).toBeNull();
  });

  it('T-KBD3 按 kbId + path 隔离', () => {
    writeDocumentDraft('kb-1', '/a', { ...base, title: 'A' });
    writeDocumentDraft('kb-1', '/b', { ...base, title: 'B' });
    writeDocumentDraft('kb-2', '/a', { ...base, title: 'C' });

    expect(readDocumentDraft('kb-1', '/a')?.title).toBe('A');
    expect(readDocumentDraft('kb-1', '/b')?.title).toBe('B');
    expect(readDocumentDraft('kb-2', '/a')?.title).toBe('C');
    expect(readDocumentDraft('kb-2', '/b')).toBeNull();
    expect(localStorage.getItem(documentDraftKey('kb-1', '/a'))).toBe(
      localStorage.getItem(`${DRAFT_KEY_PREFIX}:kb-1:/a`),
    );
  });

  it('T-KBD4 损坏 JSON 与非法形状按无缓存', () => {
    const key = documentDraftKey('kb-1', '/a');
    localStorage.setItem(key, '{not json');
    expect(readDocumentDraft('kb-1', '/a')).toBeNull();

    localStorage.setItem(key, JSON.stringify({ title: 1, tags: 'a' }));
    expect(readDocumentDraft('kb-1', '/a')).toBeNull();

    localStorage.setItem(
      key,
      JSON.stringify({ title: 't', tags: ['a', 2], description: '', content: '', updatedAt: '' }),
    );
    expect(readDocumentDraft('kb-1', '/a')).toBeNull();

    localStorage.setItem(
      key,
      JSON.stringify({ title: 't', tags: ['a'], description: '', content: '' }),
    );
    expect(readDocumentDraft('kb-1', '/a')).toBeNull();
  });

  it('T-KBD-M1 形状扩展：editedPath 写入/读取/缺省兼容', () => {
    writeDocumentDraft('kb-1', '/a', { ...base, editedPath: '/b' });
    expect(readDocumentDraft('kb-1', '/a')?.editedPath).toBe('/b');

    // 旧草稿（无该字段）读取为 undefined，isDraft 放行
    writeDocumentDraft('kb-1', '/legacy', base);
    const legacy = readDocumentDraft('kb-1', '/legacy');
    expect(legacy).not.toBeNull();
    expect(legacy?.editedPath).toBeUndefined();

    // 类型非法 → 按无缓存
    localStorage.setItem(
      documentDraftKey('kb-1', '/bad'),
      JSON.stringify({ ...base, editedPath: 1, updatedAt: new Date().toISOString() }),
    );
    expect(readDocumentDraft('kb-1', '/bad')).toBeNull();
  });

  it('T-KBD5 恢复读取与 flush 立即落盘', () => {
    const written = writeDocumentDraft('kb-1', '/a', base);
    expect(written?.title).toBe(base.title);
    const restored = readDocumentDraft('kb-1', '/a');
    expect(restored).toEqual({ ...base, updatedAt: written!.updatedAt });
    // 返回值是副本，修改不影响存储
    restored!.tags.push('mutated');
    expect(readDocumentDraft('kb-1', '/a')?.tags).toEqual(['a']);

    scheduleDocumentDraft('kb-1', '/b', { ...base, title: '待 flush' });
    flushDocumentDraft('kb-1', '/b');
    expect(readDocumentDraft('kb-1', '/b')?.title).toBe('待 flush');
  });
});
