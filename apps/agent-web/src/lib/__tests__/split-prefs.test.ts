// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { getSplitMode, setSplitMode, SPLIT_MODE_KEY_PREFIX } from '../split-prefs.js';

describe('split-prefs（T-SPLIT1~4）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('T-SPLIT1 读写', () => {
    setSplitMode('sess-1', 'horizontal');
    expect(getSplitMode('sess-1')).toBe('horizontal');
    setSplitMode('sess-1', 'vertical');
    expect(getSplitMode('sess-1')).toBe('vertical');
  });

  it('T-SPLIT2 非法值回退 chat（写入被忽略、存储不动）', () => {
    localStorage.setItem(SPLIT_MODE_KEY_PREFIX + 'sess-2', 'diagonal');
    expect(getSplitMode('sess-2')).toBe('chat');
    setSplitMode('sess-2', 'diagonal' as never);
    expect(localStorage.getItem(SPLIT_MODE_KEY_PREFIX + 'sess-2')).toBe('diagonal');
  });

  it('T-SPLIT3 按 sessionId 隔离', () => {
    setSplitMode('sess-a', 'horizontal');
    setSplitMode('sess-b', 'vertical');
    expect(getSplitMode('sess-a')).toBe('horizontal');
    expect(getSplitMode('sess-b')).toBe('vertical');
    expect(getSplitMode('sess-c')).toBe('chat');
  });

  it('T-SPLIT4 缺省 chat', () => {
    expect(getSplitMode('unknown')).toBe('chat');
  });
});
