import { describe, it, expect } from 'vitest';
import { inferModelSource, SOURCE_GROUP } from './model-source.js';

describe('inferModelSource', () => {
  it('T-MS1: 命中平台内置（scope=global）', () => {
    const result = inferModelSource(
      { id: 'gpt-4o', name: 'gpt-4o' },
      [{ name: 'gpt-4o', scope: 'global' }],
    );
    expect(result).toMatchObject({
      source: 'platform',
      sourceProvider: null,
      group: SOURCE_GROUP.platform,
    });
    expect(result.basis).toContain('平台内置');
  });

  it('T-MS2: 命中自定义（scope=user）', () => {
    const result = inferModelSource(
      { id: 'my-model', name: 'my-model' },
      [{ name: 'my-model', scope: 'user' }],
    );
    expect(result).toMatchObject({
      source: 'custom',
      group: SOURCE_GROUP.custom,
    });
    expect(result.basis).toContain('自定义');
  });

  it('T-MS3: 前缀未命中库 → Agent 自带', () => {
    const result = inferModelSource(
      { id: 'opencode-go/kimi-k3', name: 'Kimi K3' },
      [],
    );
    expect(result.source).toBe('agent');
    expect(result.sourceProvider).toBe('opencode-go');
    expect(result.group).toBe(SOURCE_GROUP.agent);
    expect(result.basis).toContain('opencode-go');
  });

  it('T-MS4: 无前缀未命中库 → 来源未知', () => {
    const result = inferModelSource({ id: 'gpt-4o', name: 'GPT-4O' }, []);
    expect(result).toEqual({
      source: 'unknown',
      sourceProvider: null,
      group: SOURCE_GROUP.unknown,
      basis: '无法判定',
    });
  });

  it('T-MS5: 库命中优先于前缀', () => {
    const result = inferModelSource(
      { id: 'opencode-go/kimi-k3', name: 'opencode-go/kimi-k3' },
      [{ name: 'opencode-go/kimi-k3', scope: 'global' }],
    );
    expect(result.source).toBe('platform');
  });

  it('T-MS6: 大小写不敏感', () => {
    const result = inferModelSource(
      { id: 'GPT-4O', name: 'GPT-4O' },
      [{ name: 'gpt-4o', scope: 'global' }],
    );
    expect(result.source).toBe('platform');
  });

  it('T-MS7: 库为空/名称为空不抛错，空 id 归一为 unknown', () => {
    expect(() => inferModelSource({ id: '', name: '' }, [])).not.toThrow();
    expect(inferModelSource({ id: '', name: '' }, []).source).toBe('unknown');

    // 库内 name 与会话 id 匹配（不同 Agent 可能把模型名放在 id 侧）
    const viaId = inferModelSource(
      { id: 'my-model', name: 'My Model' },
      [{ name: 'my-model', scope: 'user' }],
    );
    expect(viaId.source).toBe('custom');
  });

  it('T-MS8: 展示名与平台库同名但 id 不同 → 不误归平台（按 id 判定）', () => {
    const result = inferModelSource(
      // Agent 自带模型展示了与平台模型相同的 display name
      { id: 'opencode-go/gpt-4o', name: 'GPT-4O' },
      [{ name: 'gpt-4o', scope: 'global' }],
    );

    expect(result.source).toBe('agent');
    expect(result.sourceProvider).toBe('opencode-go');
    expect(result.group).toBe(SOURCE_GROUP.agent);
  });

  it('T-MS9: 平台库空名条目不入比对', () => {
    const result = inferModelSource(
      { id: '', name: '' },
      [{ name: '', scope: 'global' }],
    );
    expect(result.source).toBe('unknown');
  });
});
