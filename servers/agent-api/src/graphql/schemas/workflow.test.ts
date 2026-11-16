import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'graphql';
import { workflowTypeDefs } from './workflow.js';

const CONTRACT = readFileSync(resolve(process.cwd(), '../../contracts/workflow.graphql'), 'utf-8');

/**
 * T-SCHEMA1：契约双写守卫。
 * `contracts/workflow.graphql` 与 `graphql/schemas/workflow.ts` 的
 * `WorkflowNodeSessionBehavior` 枚举 + 六处 4 字段必须逐字对齐。
 */
describe('workflow schema 会话行为双写守卫', () => {
  const fields = [
    'reworkSessionBehavior',
    'reworkCompactOriginalContext',
    'resumeSessionBehavior',
    'resumeCompactOriginalContext',
  ];

  function countOccurrences(source: string, needle: string): number {
    return source.split(needle).length - 1;
  }

  it('契约与手写 schema 均可解析（SDL 语法有效）', () => {
    expect(() => parse(CONTRACT)).not.toThrow();
    expect(() => parse(workflowTypeDefs)).not.toThrow();
  });

  it('枚举 WorkflowNodeSessionBehavior 双写一致', () => {
    for (const source of [CONTRACT, workflowTypeDefs]) {
      expect(source).toContain('enum WorkflowNodeSessionBehavior');
      expect(source).toMatch(/enum WorkflowNodeSessionBehavior\s*\{[^}]*NEW_SESSION[^}]*ORIGINAL_SESSION[^}]*\}/s);
    }
  });

  it('六处类型/Input 各含 4 字段（双写）', () => {
    for (const field of fields) {
      // 六处 = 3 个输出类型 + 3 个 Input
      expect(countOccurrences(CONTRACT, `${field}:`)).toBe(6);
      expect(countOccurrences(workflowTypeDefs, `${field}:`)).toBe(6);
    }
  });

  it('T-MNF-SCHEMA failNode 变更与 failInfo.source=MANUAL 注释双写一致', () => {
    for (const source of [CONTRACT, workflowTypeDefs]) {
      expect(source).toContain('failNode(instanceId: ID!, nodeId: ID!, reason: String): WorkflowNode!');
      expect(source).toContain('MANUAL（人工「立即失败」）');
    }
  });

  it('六处所在类型与契约一致', () => {
    const names = [
      'WorkflowTemplateNode',
      'ConfiguredWorkflowNode',
      'WorkflowNode',
      'WorkflowTemplateNodeInput',
      'ConfiguredWorkflowNodeInput',
      'WorkflowNodeUpdateInput',
    ];
    for (const name of names) {
      for (const source of [CONTRACT, workflowTypeDefs]) {
        const match = source.match(new RegExp(`(?:type|input) ${name} \\{([\\s\\S]*?)\\n\\s*\\}`, 'm'));
        expect(match, `${name} 应存在于两份 schema`).not.toBeNull();
        const body = match![1];
        for (const field of fields) {
          expect(body, `${name}.${field}`).toContain(`${field}:`);
        }
      }
    }
  });
});
