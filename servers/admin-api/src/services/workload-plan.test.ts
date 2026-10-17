import { describe, it, expect } from 'vitest';
import {
  resolveWorkloadPlan,
  normalizeWorkloadParams,
  normalizeParamValue,
  MAX_EXPANDED_WORKLOADS,
  type WorkloadDefinitionSnapshot,
} from './workload-plan';

function def(
  id: string,
  dependsOnWorkloadIds: string[] = [],
  paramSchema: WorkloadDefinitionSnapshot['paramSchema'] = [],
): WorkloadDefinitionSnapshot {
  return { id, dependsOnWorkloadIds, paramSchema };
}

// Docker/.NET 无参数；Node.js 两种参数；Aspire 依赖 Docker → .NET
const docker = def('docker');
const dotnet = def('dotnet');
const node = def('node', [], [
  { key: 'version', label: '版本', type: 'text', options: [], defaultValue: '22' },
  {
    key: 'package_manager',
    label: '包管理器',
    type: 'multi_select',
    options: ['npm', 'pnpm', 'bun', 'yarn'],
    defaultValue: ['npm'],
  },
]);
const aspire = def('aspire', ['docker', 'dotnet']);

describe('resolveWorkloadPlan', () => {
  it('T-WP1: outputs dependencies before the dependant, in configured order', () => {
    const app = def('app', ['db', 'cache']);
    const db = def('db');
    const cache = def('cache');

    const plan = resolveWorkloadPlan([{ workloadId: 'app' }], [app, db, cache]);

    expect(plan.map((item) => item.workloadId)).toEqual(['db', 'cache', 'app']);
    expect(plan.map((item) => item.implicit)).toEqual([true, true, false]);
  });

  it('T-WP2: selecting only Aspire expands Docker → .NET → Aspire with deps implicit', () => {
    const plan = resolveWorkloadPlan([{ workloadId: 'aspire' }], [docker, dotnet, aspire]);

    expect(plan).toEqual([
      { workloadId: 'docker', params: {}, implicit: true },
      { workloadId: 'dotnet', params: {}, implicit: true },
      { workloadId: 'aspire', params: {}, implicit: false },
    ]);
  });

  it('T-WP3: explicit + implicit duplicate appears once, explicit wins (implicit=false, user params)', () => {
    const dep = def('dep', [], [
      { key: 'mode', label: '模式', type: 'select', options: ['a', 'b'], defaultValue: 'a' },
    ]);
    const main = def('main', ['dep']);

    const plan = resolveWorkloadPlan(
      [
        { workloadId: 'main' },
        { workloadId: 'dep', params: { mode: 'b' } },
      ],
      [main, dep],
    );

    expect(plan).toEqual([
      { workloadId: 'dep', params: { mode: 'b' }, implicit: false },
      { workloadId: 'main', params: {}, implicit: false },
    ]);
    // 只出现一次
    expect(plan.filter((item) => item.workloadId === 'dep')).toHaveLength(1);
  });

  it('T-WP4: multiple dependency paths to the same node dedupe (topological position)', () => {
    const a = def('a', ['b', 'c']);
    const b = def('b', ['d']);
    const c = def('c', ['d']);
    const d = def('d');

    const plan = resolveWorkloadPlan([{ workloadId: 'a' }], [a, b, c, d]);

    expect(plan.map((item) => item.workloadId)).toEqual(['d', 'b', 'c', 'a']);
  });

  it('T-WP5: throws a clear error with the cycle path on a dependency cycle', () => {
    const x = def('x', ['y']);
    const y = def('y', ['x']);

    expect(() => resolveWorkloadPlan([{ workloadId: 'x' }], [x, y])).toThrow(
      'dependency cycle detected: x -> y -> x',
    );
  });

  it('T-WP5: treats a self-dependency as a cycle', () => {
    const s = def('s', ['s']);
    expect(() => resolveWorkloadPlan([{ workloadId: 's' }], [s])).toThrow('dependency cycle detected');
  });

  it('T-WP5: throws when a dependency does not exist', () => {
    const z = def('z', ['missing']);
    expect(() => resolveWorkloadPlan([{ workloadId: 'z' }], [z])).toThrow(
      'dependency workload not found: missing',
    );
  });

  it('T-WP5: throws when an explicit selection does not exist', () => {
    expect(() => resolveWorkloadPlan([{ workloadId: 'ghost' }], [docker])).toThrow('workload not found');
  });

  it('rejects duplicate explicit selections', () => {
    expect(() =>
      resolveWorkloadPlan([{ workloadId: 'docker' }, { workloadId: 'docker' }], [docker]),
    ).toThrow('duplicate workload selection');
  });

  it('T-WP6: throws expanded workloads exceed 10 when explicit count exceeds the limit', () => {
    const definitions = Array.from({ length: 11 }, (_v, i) => def(`w${i}`));
    const selections = definitions.map((definition) => ({ workloadId: definition.id }));

    expect(() => resolveWorkloadPlan(selections, definitions)).toThrow(
      `expanded workloads exceed ${MAX_EXPANDED_WORKLOADS}`,
    );
  });

  it('T-WP6: throws expanded workloads exceed 10 when implicit expansion exceeds the limit', () => {
    // root 依赖 10 个叶子 → 展开后 11 个
    const leaves = Array.from({ length: 10 }, (_v, i) => def(`leaf${i}`));
    const root = def('root', leaves.map((leaf) => leaf.id));

    expect(() => resolveWorkloadPlan([{ workloadId: 'root' }], [root, ...leaves])).toThrow(
      'expanded workloads exceed 10',
    );
  });

  it('returns [] for an empty explicit selection', () => {
    expect(resolveWorkloadPlan([], [docker])).toEqual([]);
  });

  it('T-WP7: fills missing fields with defaults and uses defaults for implicit deps', () => {
    const plan = resolveWorkloadPlan([{ workloadId: 'node', params: { version: '20' } }], [node]);

    expect(plan).toEqual([
      {
        workloadId: 'node',
        params: { version: '20', package_manager: ['npm'] },
        implicit: false,
      },
    ]);
  });

  it('T-WP7: rejects unknown parameters with the key in the message', () => {
    expect(() =>
      resolveWorkloadPlan([{ workloadId: 'node', params: { bogus: 'x' } }], [node]),
    ).toThrow('unknown parameter: bogus');
  });

  it('T-WP7: rejects invalid values with the parameter key in the message', () => {
    expect(() =>
      resolveWorkloadPlan([{ workloadId: 'node', params: { package_manager: ['not-installed'] } }], [node]),
    ).toThrow('invalid value for parameter package_manager');
  });

  it('T-WP7: dedupes multi-select values and validates they are a subset of options', () => {
    const plan = resolveWorkloadPlan(
      [{ workloadId: 'node', params: { package_manager: ['pnpm', 'pnpm', 'npm'] } }],
      [node],
    );
    expect(plan[0].params.package_manager).toEqual(['pnpm', 'npm']);
  });

  it('T-WP7: allows an empty multi-select array', () => {
    const plan = resolveWorkloadPlan([{ workloadId: 'node', params: { package_manager: [] } }], [node]);
    expect(plan[0].params.package_manager).toEqual([]);
  });
});

describe('normalizeWorkloadParams', () => {
  it('uses defaults for every field when no user params are given', () => {
    expect(normalizeWorkloadParams(node, {})).toEqual({
      version: '22',
      package_manager: ['npm'],
    });
  });

  it('honours boolean false and empty string (presence-based, not truthy)', () => {
    const definition = def('d', [], [
      { key: 'enabled', label: '启用', type: 'boolean', options: [], defaultValue: true },
      { key: 'note', label: '备注', type: 'text', options: [], defaultValue: 'x' },
    ]);
    expect(normalizeWorkloadParams(definition, { enabled: false, note: '' })).toEqual({
      enabled: false,
      note: '',
    });
  });
});

describe('normalizeParamValue', () => {
  it('validates select membership', () => {
    const field = { key: 'mode', type: 'select', options: ['a'] };
    expect(normalizeParamValue(field, 'a')).toBe('a');
    expect(() => normalizeParamValue(field, 'b')).toThrow('invalid value for parameter mode');
  });

  it('rejects text longer than 1024 characters', () => {
    const field = { key: 'note', type: 'text', options: [] };
    expect(() => normalizeParamValue(field, 'a'.repeat(1025))).toThrow('invalid value for parameter note');
  });
});
