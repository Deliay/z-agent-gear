import { describe, it, expect } from 'vitest';
import {
  resolveCreateWorkloadPlan,
  MAX_CREATE_WORKLOADS,
} from './cloud-host-workload-plan.js';
import type { CloudWorkloadCatalogItem } from './cloud-workload-catalog.js';

function item(overrides: Partial<CloudWorkloadCatalogItem> & { id: string }): CloudWorkloadCatalogItem {
  return {
    name: overrides.id,
    paramSchema: [],
    dependsOnWorkloadIds: [],
    isPreset: false,
    workloadKind: 'standard',
    initScript: 'echo',
    ...overrides,
  };
}

const DOCKER = item({ id: 'docker', name: 'Docker' });
const DOTNET = item({ id: 'dotnet', name: '.NET' });
const ASPIRE = item({
  id: 'aspire',
  name: 'Aspire',
  dependsOnWorkloadIds: ['docker', 'dotnet'],
});
const NODE = item({ id: 'node', name: 'Node' });
const CATALOG = [DOCKER, DOTNET, ASPIRE, NODE];

const HARNESS = [{ id: 'harness-opencode' }];

describe('resolveCreateWorkloadPlan', () => {
  it('T-WP1: 仅 harness 时保持 required=true、implicit=false', () => {
    const plan = resolveCreateWorkloadPlan({
      harnessPresets: HARNESS,
      selectedIds: [],
      standardCatalog: CATALOG,
    });

    expect(plan).toEqual([
      { workloadId: 'harness-opencode', params: {}, implicit: false, required: true },
    ]);
  });

  it('T-WP2: 选中 Aspire 时依赖先行，standard 项 required=false', () => {
    const plan = resolveCreateWorkloadPlan({
      harnessPresets: HARNESS,
      selectedIds: ['aspire'],
      standardCatalog: CATALOG,
    });

    expect(plan.map((entry) => entry.workloadId)).toEqual([
      'harness-opencode',
      'docker',
      'dotnet',
      'aspire',
    ]);
    expect(plan[0]).toMatchObject({ required: true, implicit: false });
    expect(plan[1]).toMatchObject({ required: false, implicit: true });
    expect(plan[3]).toMatchObject({ required: false, implicit: false });
  });

  it('T-WP3: 同时选中 Docker + Aspire 时依赖去重且顺序稳定', () => {
    const plan = resolveCreateWorkloadPlan({
      harnessPresets: HARNESS,
      selectedIds: ['docker', 'aspire'],
      standardCatalog: CATALOG,
    });

    expect(plan.map((entry) => entry.workloadId)).toEqual([
      'harness-opencode',
      'docker',
      'dotnet',
      'aspire',
    ]);
    const docker = plan.filter((entry) => entry.workloadId === 'docker');
    expect(docker).toHaveLength(1);
    expect(docker[0]).toMatchObject({ implicit: false });
  });

  it('T-WP3b: 反序勾选 [Aspire, Docker] 时显式项仍 implicit=false（显式优先于隐式）', () => {
    const reversed = resolveCreateWorkloadPlan({
      harnessPresets: HARNESS,
      selectedIds: ['aspire', 'docker'],
      standardCatalog: CATALOG,
    });

    const forward = resolveCreateWorkloadPlan({
      harnessPresets: HARNESS,
      selectedIds: ['docker', 'aspire'],
      standardCatalog: CATALOG,
    });

    // 同一组选择不因勾选顺序改变 implicit 语义
    expect(reversed).toEqual(forward);
    expect(reversed.filter((entry) => entry.workloadId === 'docker')[0]).toMatchObject({
      implicit: false,
    });
    expect(reversed.filter((entry) => entry.workloadId === 'dotnet')[0]).toMatchObject({
      implicit: true,
    });
  });

  it('T-WP4: 显式选择超过 5 个抛错', () => {
    const catalog = Array.from({ length: 6 }, (_, index) =>
      item({ id: `w${index}`, name: `w${index}` }),
    );
    expect(() =>
      resolveCreateWorkloadPlan({
        harnessPresets: HARNESS,
        selectedIds: catalog.map((entry) => entry.id),
        standardCatalog: catalog,
      }),
    ).toThrow('too many workloads (max 5)');
    expect(MAX_CREATE_WORKLOADS).toBe(5);
  });

  it('T-WP4: 重复 ID 先去重再判断上限', () => {
    const catalog = Array.from({ length: 5 }, (_, index) =>
      item({ id: `w${index}`, name: `w${index}` }),
    );
    const plan = resolveCreateWorkloadPlan({
      harnessPresets: HARNESS,
      selectedIds: ['w0', 'w0', 'w1', 'w2', 'w3', 'w4', 'w4'],
      standardCatalog: catalog,
    });
    expect(plan.filter((entry) => entry.workloadId.startsWith('w'))).toHaveLength(5);
  });

  it('T-WP5: 不存在的 ID 抛 invalid workload', () => {
    expect(() =>
      resolveCreateWorkloadPlan({
        harnessPresets: HARNESS,
        selectedIds: ['missing'],
        standardCatalog: CATALOG,
      }),
    ).toThrow('invalid workload: missing');
  });

  it('T-WP5: harness 负载 ID 不在 standard 目录 → invalid workload', () => {
    expect(() =>
      resolveCreateWorkloadPlan({
        harnessPresets: HARNESS,
        selectedIds: ['harness-opencode'],
        standardCatalog: CATALOG,
      }),
    ).toThrow('invalid workload: harness-opencode');
  });

  it('T-WP6: 依赖缺失抛错', () => {
    const orphan = item({ id: 'orphan', name: 'Orphan', dependsOnWorkloadIds: ['ghost'] });
    expect(() =>
      resolveCreateWorkloadPlan({
        harnessPresets: HARNESS,
        selectedIds: ['orphan'],
        standardCatalog: [orphan],
      }),
    ).toThrow('dependency workload not found: ghost');
  });

  it('T-WP6: 依赖环抛错', () => {
    const a = item({ id: 'a', name: 'A', dependsOnWorkloadIds: ['b'] });
    const b = item({ id: 'b', name: 'B', dependsOnWorkloadIds: ['a'] });
    expect(() =>
      resolveCreateWorkloadPlan({
        harnessPresets: HARNESS,
        selectedIds: ['a'],
        standardCatalog: [a, b],
      }),
    ).toThrow('dependency cycle detected');
  });

  it('T-WP7: 参数取 paramSchema 默认值并按类型归一', () => {
    const withParams = item({
      id: 'with-params',
      name: 'WithParams',
      paramSchema: [
        { key: 'text', label: 'Text', type: 'text', options: [], defaultValue: 'v' },
        { key: 'select', label: 'Select', type: 'SELECT', options: ['a', 'b'], defaultValue: 'a' },
        {
          key: 'multi',
          label: 'Multi',
          type: 'multi_select',
          options: ['a', 'b'],
          defaultValue: ['a'],
        },
        { key: 'flag', label: 'Flag', type: 'boolean', options: [], defaultValue: true },
      ],
    });

    const plan = resolveCreateWorkloadPlan({
      harnessPresets: [],
      selectedIds: ['with-params'],
      standardCatalog: [withParams],
    });

    expect(plan[0].params).toEqual({
      text: 'v',
      select: 'a',
      multi: ['a'],
      flag: true,
    });
  });

  it('T-WP7: 非法默认值抛 invalid workload parameter', () => {
    const bad = item({
      id: 'bad',
      name: 'Bad',
      paramSchema: [
        { key: 'flag', label: 'Flag', type: 'boolean', options: [], defaultValue: 'yes' },
      ],
    });
    expect(() =>
      resolveCreateWorkloadPlan({
        harnessPresets: [],
        selectedIds: ['bad'],
        standardCatalog: [bad],
      }),
    ).toThrow('invalid workload parameter: flag');
  });

  it('T-WP7: SELECT 默认值不在 options 时抛错', () => {
    const bad = item({
      id: 'bad',
      name: 'Bad',
      paramSchema: [
        { key: 'mode', label: 'Mode', type: 'select', options: ['a'], defaultValue: 'z' },
      ],
    });
    expect(() =>
      resolveCreateWorkloadPlan({
        harnessPresets: [],
        selectedIds: ['bad'],
        standardCatalog: [bad],
      }),
    ).toThrow('invalid workload parameter: mode');
  });

  it('T-WP7b: MULTI_SELECT 默认值重复项去重保留首序（与 cloud-controller 同口径）', () => {
    const multi = item({
      id: 'multi',
      name: 'Multi',
      paramSchema: [
        {
          key: 'list',
          label: 'List',
          type: 'multi_select',
          options: ['a', 'b'],
          defaultValue: ['b', 'a', 'b'],
        },
      ],
    });

    const plan = resolveCreateWorkloadPlan({
      harnessPresets: [],
      selectedIds: ['multi'],
      standardCatalog: [multi],
    });

    expect(plan[0].params).toEqual({ list: ['b', 'a'] });
  });

  it('T-WP7b: TEXT 默认值超过 1024 字符抛错', () => {
    const long = item({
      id: 'long',
      name: 'Long',
      paramSchema: [
        { key: 'text', label: 'Text', type: 'text', options: [], defaultValue: 'x'.repeat(1025) },
      ],
    });
    expect(() =>
      resolveCreateWorkloadPlan({
        harnessPresets: [],
        selectedIds: ['long'],
        standardCatalog: [long],
      }),
    ).toThrow('invalid workload parameter: text');
  });

  it('T-WP7b: 未知参数类型抛错（不静默按 TEXT 处理）', () => {
    const unknown = item({
      id: 'unknown',
      name: 'Unknown',
      paramSchema: [
        { key: 'weird', label: 'Weird', type: 'json', options: [], defaultValue: 'v' },
      ],
    });
    expect(() =>
      resolveCreateWorkloadPlan({
        harnessPresets: [],
        selectedIds: ['unknown'],
        standardCatalog: [unknown],
      }),
    ).toThrow('invalid workload parameter: weird');
  });

  it('展开后总条数超过 10 抛 workloads exceed 10', () => {
    const deps = Array.from({ length: 9 }, (_, index) => item({ id: `d${index}`, name: `d${index}` }));
    const root = item({ id: 'root', name: 'root', dependsOnWorkloadIds: deps.map((dep) => dep.id) });
    expect(() =>
      resolveCreateWorkloadPlan({
        harnessPresets: HARNESS,
        selectedIds: ['root'],
        standardCatalog: [...deps, root],
      }),
    ).toThrow('workloads exceed 10');
  });

  it('harness 与 standard 显式 ID 重复时按已出现去重', () => {
    const plan = resolveCreateWorkloadPlan({
      harnessPresets: [{ id: 'docker' }],
      selectedIds: ['docker'],
      standardCatalog: CATALOG,
    });
    expect(plan.map((entry) => entry.workloadId)).toEqual(['docker']);
    expect(plan[0]).toMatchObject({ required: true, implicit: false });
  });
});
