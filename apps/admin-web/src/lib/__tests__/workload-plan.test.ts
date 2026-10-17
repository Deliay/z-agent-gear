import { describe, it, expect } from 'vitest';
import {
  previewWorkloadPlan,
  detectDependencyCycle,
  type WorkloadPlanDefinition,
} from '@/lib/workload-plan';

function def(id: string, name: string, depends: string[] = []): WorkloadPlanDefinition {
  return { id, name, dependsOnWorkloadIds: depends };
}

const docker = def('d1', 'Docker');
const dotnet = def('d2', '.NET');
const aspire = def('d3', 'Aspire', ['d1', 'd2']);
const node = def('d4', 'Node.js');
const defs = [docker, dotnet, aspire, node];

describe('previewWorkloadPlan (T-FP1)', () => {
  it('expands implicit dependencies before the dependent (Aspire → Docker/.NET/Aspire)', () => {
    const preview = previewWorkloadPlan(['d3'], defs);

    expect(preview.items.map((item) => item.name)).toEqual(['Docker', '.NET', 'Aspire']);
    expect(preview.items.map((item) => item.implicit)).toEqual([true, true, false]);
    expect(preview.implicitIds).toEqual(['d1', 'd2']);
    expect(preview.cycle).toBeNull();
    expect(preview.missingDependencyIds).toEqual([]);
  });

  it('keeps explicit selections non-implicit and dedupes (explicit + implicit same node)', () => {
    const preview = previewWorkloadPlan(['d3', 'd1'], defs);

    expect(preview.items.map((item) => item.name)).toEqual(['Docker', '.NET', 'Aspire']);
    expect(preview.items.map((item) => item.implicit)).toEqual([false, true, false]);
    expect(preview.implicitIds).toEqual(['d2']);
  });

  it('dedupes nodes reachable through multiple dependency paths', () => {
    const b = def('b', 'B', ['d']);
    const c = def('c', 'C', ['d']);
    const a = def('a', 'A', ['b', 'c']);
    const d = def('d', 'D');

    const preview = previewWorkloadPlan(['a'], [a, b, c, d]);

    expect(preview.items.map((item) => item.name)).toEqual(['D', 'B', 'C', 'A']);
    expect(preview.items.filter((item) => item.workloadId === 'd')).toHaveLength(1);
  });

  it('preserves dependency configuration order and selection order', () => {
    const preview = previewWorkloadPlan(['d3'], defs);
    // Aspire 依赖配置顺序为 [Docker, .NET]
    expect(preview.items.map((item) => item.workloadId)).toEqual(['d1', 'd2', 'd3']);
  });

  it('reports a dependency cycle instead of looping forever', () => {
    const a = def('a', 'A', ['b']);
    const b = def('b', 'B', ['a']);

    const preview = previewWorkloadPlan(['a'], [a, b]);

    expect(preview.cycle).not.toBeNull();
    expect(preview.cycle).toContain('A');
    expect(preview.cycle).toContain('B');
  });

  it('records missing dependencies without crashing', () => {
    const a = def('a', 'A', ['ghost']);
    const preview = previewWorkloadPlan(['a'], [a]);

    expect(preview.missingDependencyIds).toEqual(['ghost']);
    expect(preview.items.map((item) => item.workloadId)).toEqual(['a']);
  });

  it('returns an empty plan when nothing is selected', () => {
    const preview = previewWorkloadPlan([], defs);
    expect(preview.items).toEqual([]);
    expect(preview.implicitIds).toEqual([]);
  });
});

describe('detectDependencyCycle (T-FP1/T-FP4)', () => {
  it('detects a cycle introduced by the edited workload', () => {
    const a = def('a', 'A');
    const b = def('b', 'B', ['a']);
    // 让 A 依赖 B，而 B 已依赖 A => 环
    const cycle = detectDependencyCycle('a', ['b'], [a, b]);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain('A');
  });

  it('returns null for a valid acyclic dependency set', () => {
    expect(detectDependencyCycle('d3', ['d1', 'd2'], defs)).toBeNull();
  });

  it('returns null for a new workload (no id)', () => {
    expect(detectDependencyCycle(null, ['d1'], defs)).toBeNull();
  });
});
