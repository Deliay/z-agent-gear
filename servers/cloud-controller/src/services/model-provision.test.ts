import { describe, expect, it } from 'vitest';
import {
  parseModelProvisionPayload,
  projectModelProvision,
  type ModelProvision,
} from './model-provision.js';

/**
 * A.2.15 载荷结构校验与旧字段投影（cloud-controller 侧唯一口径）。
 * 只校验结构，不做业务语义（`zag` 首位 / vendor 归属由 agent-api 保证）。
 */
describe('parseModelProvisionPayload', () => {
  it('合法载荷原样通过（contextLength 缺省不出现该键）', () => {
    const parsed = parseModelProvisionPayload({
      providers: [
        {
          vendorId: 'zag',
          displayName: 'Agent Gear',
          models: [{ id: 'model-a', contextLength: 128000 }, { id: 'model-b' }],
        },
        { vendorId: '65f0a1b2c3d4e5f60718293a', displayName: '我的 OpenAI', models: [] },
      ],
    });

    expect(parsed).toEqual({
      providers: [
        {
          vendorId: 'zag',
          displayName: 'Agent Gear',
          models: [{ id: 'model-a', contextLength: 128000 }, { id: 'model-b' }],
        },
        { vendorId: '65f0a1b2c3d4e5f60718293a', displayName: '我的 OpenAI', models: [] },
      ],
    });
    expect('contextLength' in parsed!.providers[0]!.models[1]!).toBe(false);
  });

  it('providers 允许空数组', () => {
    expect(parseModelProvisionPayload({ providers: [] })).toEqual({ providers: [] });
  });

  it('结构非法一律返回 null', () => {
    const cases: Array<[string, unknown]> = [
      ['非对象', 'provision'],
      ['null', null],
      ['数组', []],
      ['缺 providers', {}],
      ['providers 非数组', { providers: {} }],
      ['provider 非对象', { providers: ['zag'] }],
      ['vendorId 空串', { providers: [{ vendorId: '', displayName: 'x', models: [] }] }],
      ['displayName 非字符串', { providers: [{ vendorId: 'zag', displayName: 1, models: [] }] }],
      ['models 非数组', { providers: [{ vendorId: 'zag', displayName: 'x', models: {} }] }],
      ['model 非对象', { providers: [{ vendorId: 'zag', displayName: 'x', models: ['a'] }] }],
      ['id 空串', { providers: [{ vendorId: 'zag', displayName: 'x', models: [{ id: '' }] }] }],
      [
        'contextLength 0',
        { providers: [{ vendorId: 'zag', displayName: 'x', models: [{ id: 'a', contextLength: 0 }] }] },
      ],
      [
        'contextLength 负数',
        { providers: [{ vendorId: 'zag', displayName: 'x', models: [{ id: 'a', contextLength: -1 }] }] },
      ],
      [
        'contextLength 小数',
        { providers: [{ vendorId: 'zag', displayName: 'x', models: [{ id: 'a', contextLength: 1.5 }] }] },
      ],
      [
        'contextLength 字符串',
        { providers: [{ vendorId: 'zag', displayName: 'x', models: [{ id: 'a', contextLength: '1' }] }] },
      ],
    ];

    for (const [label, raw] of cases) {
      expect(parseModelProvisionPayload(raw), label).toBeNull();
    }
  });
});

describe('projectModelProvision', () => {
  it('modelIds 按组序展开去重；modelContextLengths 仅正整数且同 id 取首个', () => {
    const provision: ModelProvision = {
      providers: [
        {
          vendorId: 'zag',
          displayName: 'Agent Gear',
          models: [{ id: 'model-a', contextLength: 128000 }, { id: 'model-b' }],
        },
        {
          vendorId: 'p1',
          displayName: '我的 OpenAI',
          models: [{ id: 'model-a', contextLength: 64000 }, { id: 'model-c', contextLength: 200000 }],
        },
      ],
    };

    expect(projectModelProvision(provision)).toEqual({
      modelIds: ['model-a', 'model-b', 'model-c'],
      modelContextLengths: { 'model-a': 128000, 'model-c': 200000 },
    });
  });

  it('空载荷投影为空集合（旧字段仍可安全下发）', () => {
    expect(projectModelProvision({ providers: [] })).toEqual({
      modelIds: [],
      modelContextLengths: {},
    });
  });
});
