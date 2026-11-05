// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  filterParts,
  mergeText,
  stripDataPrefix,
  checkPartSizes,
  serializeDraft,
  deserializeDraft,
  buildSendParts,
  MAX_IMAGE_BYTES,
  DRAFT_PERSIST_LIMIT,
  type PromptPart,
} from '../prompt-parts.js';

function text(text: string): PromptPart {
  return { id: `t-${text}`, type: 'text', text };
}

function image(data: string, name = 'a.png'): PromptPart {
  return { id: `i-${name}`, type: 'image', data, mimeType: 'image/png', name };
}

describe('prompt-parts（T-PP1~8）', () => {
  it('T-PP1 组装顺序：buildSendParts 保序、trim 空输入不产生片段', () => {
    const parts = [text('a'), image('IMG')];
    expect(buildSendParts(parts, '  hello  ')).toEqual([
      text('a'),
      image('IMG'),
      expect.objectContaining({ type: 'text', text: 'hello' }),
    ]);
    expect(buildSendParts(parts, '   ')).toHaveLength(2);
  });

  it('T-PP2 trim 过滤：空文本片段被滤、无 data 图片被滤', () => {
    const parts: PromptPart[] = [text('  '), { id: 'x', type: 'text', text: '' }, { id: 'y', type: 'image' }, text('ok')];
    expect(filterParts(parts)).toEqual([text('ok')]);
  });

  it('T-PP3 5MB 单文件上限', () => {
    expect(checkPartSizes([image('x'.repeat(MAX_IMAGE_BYTES))]).ok).toBe(true);
    expect(checkPartSizes([image('x'.repeat(MAX_IMAGE_BYTES + 1))])).toEqual({ ok: false, reason: 'image-too-large' });
  });

  it('T-PP4 10MB 合计上限', () => {
    const chunk = 'x'.repeat(4 * 1024 * 1024);
    expect(checkPartSizes([image(chunk, 'a'), image(chunk, 'b')]).ok).toBe(true);
    expect(checkPartSizes([image(chunk, 'a'), image(chunk, 'b'), image(chunk, 'c')])).toEqual({
      ok: false,
      reason: 'total-too-large',
    });
  });

  it('T-PP5 草稿序列化 2MB 阈值：超过不持久化，origin 不落草稿', () => {
    const small = [text('hello')];
    const serialized = serializeDraft(small);
    expect(serialized).toBeTruthy();
    expect(deserializeDraft(serialized!)).toEqual([{ id: 't-hello', type: 'text', text: 'hello' }]);

    const big = [image('x'.repeat(DRAFT_PERSIST_LIMIT))];
    expect(serializeDraft(big)).toBeNull();

    const withOrigin = [{ ...text('hi'), origin: { target: { source: 'code' as const }, comments: [] } }];
    expect(serializeDraft(withOrigin)).not.toContain('origin');
  });

  it('T-PP6 合并文本：非空文本以 \\n\\n 连接', () => {
    expect(mergeText([text('a'), image('IMG'), text('  '), text('b')])).toBe('a\n\nb');
    expect(mergeText([image('IMG')])).toBe('');
  });

  it('T-PP7 base64 去 data: 前缀', () => {
    expect(stripDataPrefix('data:image/png;base64,AAAA')).toBe('AAAA');
    expect(stripDataPrefix('AAAA')).toBe('AAAA');
  });

  it('T-PP8 空数组与损坏草稿', () => {
    expect(filterParts([])).toEqual([]);
    expect(buildSendParts([], '')).toEqual([]);
    expect(deserializeDraft(null)).toEqual([]);
    expect(deserializeDraft('not-json')).toEqual([]);
    expect(deserializeDraft('{"a":1}')).toEqual([]);
  });
});
