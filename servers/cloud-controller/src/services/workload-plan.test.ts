import { describe, it, expect } from 'vitest';
import type { WorkloadParamField } from '../models/cloud-workload.js';
import {
  MAX_WORKLOAD_PLAN_ENTRIES,
  WorkloadPlanError,
  collectWorkloadDefinitions,
  normalizeDefaultParams,
  normalizeProvidedParams,
  resolveFallbackWorkloadPlan,
  resolveRuntimeWorkloadPlan,
  type WorkloadPlanDefinition,
} from './workload-plan.js';

function def(
  id: string,
  opts: { deps?: string[]; schema?: WorkloadParamField[] } = {},
): WorkloadPlanDefinition {
  return {
    id,
    dependsOnWorkloadIds: opts.deps ?? [],
    paramSchema: opts.schema ?? [],
  };
}

describe('resolveFallbackWorkloadPlan - 展开顺序', () => {
  it('T-WP1: 无依赖时按显式选择顺序输出，全部 implicit=false、params 为空', () => {
    const plan = resolveFallbackWorkloadPlan(
      ['a', 'b', 'c'],
      [def('a'), def('b'), def('c')],
    );

    expect(plan).toEqual([
      { workloadId: 'a', params: {}, implicit: false, required: false },
      { workloadId: 'b', params: {}, implicit: false, required: false },
      { workloadId: 'c', params: {}, implicit: false, required: false },
    ]);
  });

  it('T-WP2: 后序 DFS——依赖先于依赖方（Aspire → Docker/.NET → Aspire）', () => {
    const plan = resolveFallbackWorkloadPlan(
      ['aspire'],
      [def('aspire', { deps: ['docker', 'dotnet'] }), def('docker'), def('dotnet')],
    );

    expect(plan.map((entry) => entry.workloadId)).toEqual(['docker', 'dotnet', 'aspire']);
    expect(plan.map((entry) => entry.implicit)).toEqual([true, true, false]);
  });

  it('T-WP3: 多条路径指向同一负载只出现一次（去重，天然满足「只初始化一次」）', () => {
    const plan = resolveFallbackWorkloadPlan(
      ['a'],
      [def('a', { deps: ['b', 'c'] }), def('b', { deps: ['c'] }), def('c')],
    );

    expect(plan.map((entry) => entry.workloadId)).toEqual(['c', 'b', 'a']);
    expect(plan.map((entry) => entry.implicit)).toEqual([true, true, false]);
  });

  it('T-WP4: 显式选择同时是他人依赖时只出现一次，且 implicit 以显式为准', () => {
    const plan = resolveFallbackWorkloadPlan(
      ['c', 'a'],
      [def('a', { deps: ['c'] }), def('c')],
    );

    expect(plan.map((entry) => entry.workloadId)).toEqual(['c', 'a']);
    expect(plan.map((entry) => entry.implicit)).toEqual([false, false]);
  });

  it('T-WP5: 显式选择入参去重且保序', () => {
    const plan = resolveFallbackWorkloadPlan(['b', 'a', 'b'], [def('a'), def('b')]);

    expect(plan.map((entry) => entry.workloadId)).toEqual(['b', 'a']);
  });
});

describe('resolveFallbackWorkloadPlan - 参数归一', () => {
  it('T-WP6: 隐式依赖取各自默认参数，显式项同样取默认（兜底无用户参数）', () => {
    const plan = resolveFallbackWorkloadPlan(
      ['app'],
      [
        def('app', { deps: ['base'] }),
        def('base', {
          schema: [{ key: 'version', label: '版本', type: 'text', options: [], defaultValue: '22' }],
        }),
      ],
    );

    const base = plan.find((entry) => entry.workloadId === 'base')!;
    expect(base.params).toEqual({ version: '22' });
    expect(base.implicit).toBe(true);
    expect(plan.find((entry) => entry.workloadId === 'app')!.params).toEqual({});
  });

  it('T-WP7: 四种类型默认值归一（多选去重、布尔保真）', () => {
    const params = normalizeDefaultParams([
      { key: 'mode', label: '模式', type: 'select', options: ['a', 'b'], defaultValue: 'b' },
      {
        key: 'pm',
        label: '包管理器',
        type: 'multi_select',
        options: ['npm', 'pnpm'],
        defaultValue: ['pnpm', 'pnpm'],
      },
      { key: 'flag', label: '开关', type: 'boolean', options: [], defaultValue: false },
      { key: 'version', label: '版本', type: 'text', options: [], defaultValue: '22' },
    ]);

    expect(params).toEqual({ mode: 'b', pm: ['pnpm'], flag: false, version: '22' });
  });

  it('T-WP12: 非法默认值抛错（与 admin-api 同口径，不静默强转）', () => {
    expect(() =>
      normalizeDefaultParams([
        { key: 'flag', label: '开关', type: 'boolean', options: [], defaultValue: 'false' },
      ]),
    ).toThrow('invalid value for parameter flag');

    expect(() =>
      normalizeDefaultParams([
        { key: 'mode', label: '模式', type: 'select', options: ['a'], defaultValue: 'z' },
      ]),
    ).toThrow('invalid value for parameter mode');

    expect(() =>
      normalizeDefaultParams([
        { key: 'pm', label: '包管理器', type: 'multi_select', options: ['a'], defaultValue: 'a' },
      ]),
    ).toThrow('invalid value for parameter pm');

    expect(() =>
      normalizeDefaultParams([
        { key: 'version', label: '版本', type: 'text', options: [], defaultValue: 22 },
      ]),
    ).toThrow('invalid value for parameter version');

    expect(() =>
      normalizeDefaultParams([
        { key: 'weird', label: '未知', type: 'unknown' as never, options: [], defaultValue: 'x' },
      ]),
    ).toThrow('invalid value for parameter weird');
  });

  it('T-WP13: 类型大小写不敏感（与 admin-api 一致）', () => {
    const params = normalizeDefaultParams([
      { key: 'flag', label: '开关', type: 'BOOLEAN' as never, options: [], defaultValue: false },
    ]);
    expect(params).toEqual({ flag: false });
  });
});

describe('resolveFallbackWorkloadPlan - 校验与兜底', () => {
  it('T-WP8: 依赖环 → WorkloadPlanError（含环路径）', () => {
    expect(() =>
      resolveFallbackWorkloadPlan(['a'], [def('a', { deps: ['b'] }), def('b', { deps: ['a'] })]),
    ).toThrow(WorkloadPlanError);
    expect(() =>
      resolveFallbackWorkloadPlan(['a'], [def('a', { deps: ['b'] }), def('b', { deps: ['a'] })]),
    ).toThrow(/cycle/i);
  });

  it('T-WP9: 展开条数超过 10 → WorkloadPlanError（文案与 admin-api 一致）', () => {
    const definitions = Array.from({ length: MAX_WORKLOAD_PLAN_ENTRIES + 1 }, (_, i) => def(`w${i}`));
    const ids = definitions.map((definition) => definition.id);

    expect(() => resolveFallbackWorkloadPlan(ids, definitions)).toThrow(
      'expanded workloads exceed 10',
    );
  });

  it('T-WP10: 显式 ID 缺失 / 依赖 ID 缺失分别报错', () => {
    expect(() => resolveFallbackWorkloadPlan(['missing'], [])).toThrow(/workload not found/);
    expect(() => resolveFallbackWorkloadPlan(['a'], [def('a', { deps: ['ghost'] })])).toThrow(
      /dependency workload not found/,
    );
  });

  it('T-WP8b: 环文案仅含环路径（与 admin-api 同口径）', () => {
    expect(() =>
      resolveFallbackWorkloadPlan(['a'], [def('a', { deps: ['b'] }), def('b', { deps: ['a'] })]),
    ).toThrow('dependency cycle detected: a -> b -> a');
  });

  it('T-WP10b: 显式缺失文案为 "workload not found"（无 id，与 admin-api 一致）', () => {
    try {
      resolveFallbackWorkloadPlan(['missing'], []);
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as Error).message).toBe('workload not found');
    }
  });
});

describe('collectWorkloadDefinitions', () => {
  it('T-WP11: BFS 传递依赖，缺失依赖不出现（交由纯函数报错）', async () => {
    const store = new Map<string, WorkloadPlanDefinition>([
      ['aspire', def('aspire', { deps: ['docker', 'dotnet'] })],
      ['docker', def('docker')],
    ]);
    const lookups: string[][] = [];

    const definitions = await collectWorkloadDefinitions(['aspire'], async (ids) => {
      lookups.push([...ids]);
      return ids
        .map((id) => store.get(id))
        .filter((value): value is WorkloadPlanDefinition => value !== undefined);
    });

    expect(definitions.map((definition) => definition.id).sort()).toEqual(['aspire', 'docker']);
    expect(lookups).toEqual([['aspire'], ['docker', 'dotnet']]);
  });
});


describe('resolveRuntimeWorkloadPlan', () => {
  const schema: WorkloadParamField[] = [
    { key: 'version', label: 'Version', type: 'text', options: [], defaultValue: '20' },
    {
      key: 'flavor',
      label: 'Flavor',
      type: 'select',
      options: ['a', 'b'],
      defaultValue: 'a',
    },
  ];

  it('T-RI4: 显式参数覆盖默认值，依赖先行且隐式', () => {
    const definitions = [
      def('docker', { schema }),
      def('aspire', { deps: ['docker'], schema }),
    ];
    const plan = resolveRuntimeWorkloadPlan({
      workloadId: 'aspire',
      params: {},
      definitions,
    });
    expect(plan.map((entry) => entry.workloadId)).toEqual(['docker', 'aspire']);
    expect(plan[0]).toMatchObject({ implicit: true, required: false });
    expect(plan[1]).toMatchObject({ implicit: false, params: {} });
  });

  it('T-RI5: 未知参数/类型不符/select 越界抛错', () => {
    const definitions = [def('w', { schema })];
    expect(() =>
      resolveRuntimeWorkloadPlan({ workloadId: 'w', params: { nope: 1 }, definitions }),
    ).toThrow(WorkloadPlanError);
    expect(() =>
      resolveRuntimeWorkloadPlan({ workloadId: 'w', params: { version: 2 }, definitions }),
    ).toThrow('invalid value for parameter version');
    expect(() =>
      resolveRuntimeWorkloadPlan({ workloadId: 'w', params: { flavor: 'c' }, definitions }),
    ).toThrow('invalid value for parameter flavor');
  });

  it('T-RI4b: 去重与依赖环检测', () => {
    const definitions = [
      def('a', { deps: ['b'] }),
      def('b', { deps: ['a'] }),
    ];
    expect(() =>
      resolveRuntimeWorkloadPlan({ workloadId: 'a', params: {}, definitions }),
    ).toThrow('dependency cycle detected');
  });

  it('T-RI5b: normalizeProvidedParams 允许合法覆盖', () => {
    expect(normalizeProvidedParams(schema, { version: '22', flavor: 'b' })).toEqual({
      version: '22',
      flavor: 'b',
    });
  });
});
