import { describe, it, expect, vi } from 'vitest';
import {
  applyFormat,
  renderFragments,
  validateFragments,
  FRAGMENT_ELEMENT_MAX_COUNT,
  FRAGMENT_RENDER_MAX_LENGTH,
  FRAGMENT_VALUE_MAX_LENGTH,
  type Fragment,
  type RenderContext,
  type ValutResolver,
} from './fragment-render.js';

const context: RenderContext = {
  userId: 'u1',
  tenantId: 't1',
  workspaceId: 'ws1',
  params: { city: '北京', month: '2026-11' },
};

const resolveValut: ValutResolver = async (key) => (key === 'TOKEN' ? 'abc/def ghi' : null);

function frag(type: Fragment['type'], value: string, format: Fragment['format']): Fragment {
  return { type, value, format };
}

describe('fragment-render（T-FR）', () => {
  it('T-FR1：三类型 × 三格式渲染矩阵', async () => {
    // Plain 恒 Generic（format 无意义）
    for (const format of ['Generic', 'Json', 'Uri'] as const) {
      await expect(renderFragments([frag('Plain', 'a/b', format)], context, resolveValut)).resolves.toBe(
        'a/b',
      );
    }

    // Parameter
    await expect(
      renderFragments([frag('Parameter', 'city', 'Generic')], context, resolveValut),
    ).resolves.toBe('北京');
    await expect(
      renderFragments([frag('Parameter', 'city', 'Json')], context, resolveValut),
    ).resolves.toBe('"北京"');
    await expect(
      renderFragments([frag('Parameter', 'city', 'Uri')], context, resolveValut),
    ).resolves.toBe(encodeURIComponent('北京'));

    // Valut（明文只在内存，格式管线只编码一次）
    await expect(
      renderFragments([frag('Valut', 'TOKEN', 'Generic')], context, resolveValut),
    ).resolves.toBe('abc/def ghi');
    await expect(
      renderFragments([frag('Valut', 'TOKEN', 'Json')], context, resolveValut),
    ).resolves.toBe('"abc/def ghi"');
    await expect(
      renderFragments([frag('Valut', 'TOKEN', 'Uri')], context, resolveValut),
    ).resolves.toBe(encodeURIComponent('abc/def ghi'));
  });

  it('T-FR1：Json 输出为合法 JSON 字符串字面量；拼接顺序保持', async () => {
    const out = await renderFragments(
      [
        frag('Plain', '{"city":', 'Generic'),
        frag('Parameter', 'city', 'Json'),
        frag('Plain', ',"month":', 'Generic'),
        frag('Parameter', 'month', 'Json'),
        frag('Plain', '}', 'Generic'),
      ],
      context,
      resolveValut,
    );
    expect(JSON.parse(out)).toEqual({ city: '北京', month: '2026-11' });
  });

  it('T-FR1：空 Plain 省略', async () => {
    await expect(
      renderFragments(
        [frag('Plain', '', 'Generic'), frag('Parameter', 'city', 'Generic'), frag('Plain', '', 'Generic')],
        context,
        resolveValut,
      ),
    ).resolves.toBe('北京');
  });

  it('T-FR2：Valut 取不到 → valut key not found: <key>', async () => {
    await expect(
      renderFragments([frag('Valut', 'MISSING', 'Generic')], context, resolveValut),
    ).rejects.toThrow('valut key not found: MISSING');
  });

  it('T-FR2：Parameter 缺失 → missing parameter: <key>', async () => {
    await expect(
      renderFragments([frag('Parameter', 'nope', 'Generic')], context, resolveValut),
    ).rejects.toThrow('missing parameter: nope');
  });

  it('T-FR2：数量 / 单值 / 总长三档超限 → fragment template too large', async () => {
    const tooMany = Array.from({ length: FRAGMENT_ELEMENT_MAX_COUNT + 1 }, () =>
      frag('Plain', 'x', 'Generic'),
    );
    await expect(renderFragments(tooMany, context, resolveValut)).rejects.toThrow(
      'fragment template too large',
    );

    const tooLongValue = [frag('Plain', 'x'.repeat(FRAGMENT_VALUE_MAX_LENGTH + 1), 'Generic')];
    await expect(renderFragments(tooLongValue, context, resolveValut)).rejects.toThrow(
      'fragment template too large',
    );

    // 单值都合法但渲染总长超限（200 × 4096 > 65536）
    const manyLong = Array.from({ length: 20 }, () =>
      frag('Plain', 'y'.repeat(4000), 'Generic'),
    );
    await expect(renderFragments(manyLong, context, resolveValut)).rejects.toThrow(
      'fragment template too large',
    );
    expect(FRAGMENT_RENDER_MAX_LENGTH).toBe(65536);
  });

  it('T-FR3：依赖注入——resolveValut 返回 null → Valut 错误；不读取 Mongoose', async () => {
    const resolver = vi.fn(async () => null);
    await expect(
      renderFragments([frag('Valut', 'K', 'Generic')], context, resolver),
    ).rejects.toThrow('valut key not found: K');
    expect(resolver).toHaveBeenCalledWith('K', { workspaceId: 'ws1' });

    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./fragment-render.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toMatch(/from ['"].*models\//);
    expect(source).not.toMatch(/mongoose/);
  });

  it('validateFragments：结构/枚举非法 → invalid fragment template', () => {
    expect(() => validateFragments(null)).toThrow('invalid fragment template');
    expect(() => validateFragments([{ type: 'Nope', value: 'x', format: 'Generic' }])).toThrow(
      'invalid fragment template',
    );
    expect(() => validateFragments([{ type: 'Plain', value: 1, format: 'Generic' }])).toThrow(
      'invalid fragment template',
    );
    expect(() => validateFragments([frag('Plain', 'x', 'Generic')])).not.toThrow();
  });

  it('applyFormat：Generic 恒等 / Json 带引号 / Uri 编码', () => {
    expect(applyFormat('a b', 'Generic')).toBe('a b');
    expect(applyFormat('a b', 'Json')).toBe('"a b"');
    expect(applyFormat('a b', 'Uri')).toBe('a%20b');
  });
});
