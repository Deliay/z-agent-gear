import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Kind, parse, print } from 'graphql';
import { sessionTypeDefs } from './session.js';
import { Session } from '../../models/session.js';

/**
 * 契约 ↔ 实现枚举对齐（无 mock）：
 *
 * DeepSeek Harness 会话曾漏扩展 agent-api 的 GraphQL / Mongoose 枚举，
 * 单测全 mock 时无法拦截；这里直接解析契约、GraphQL schema 与 Mongoose schema，
 * 任一侧缺失 `deepseek_harness` 都会失败。
 */
function contractAcpServerTypes(): string[] {
  const contract = readFileSync(
    resolve(process.cwd(), '../../contracts/agent-session.graphql'),
    'utf-8',
  );
  const match = contract.match(/enum\s+AcpServerType\s*\{([^}]*)\}/);
  if (!match) throw new Error('enum AcpServerType not found in contracts/agent-session.graphql');
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

describe('AcpServerType 枚举契约对齐', () => {
  it('contracts/agent-session.graphql 含 deepseek_harness', () => {
    expect(contractAcpServerTypes()).toContain('deepseek_harness');
  });

  it('agent-api GraphQL schema 的 AcpServerType 与契约逐项一致', () => {
    const document = parse(sessionTypeDefs);
    const enumDefinition = document.definitions.find(
      (definition) =>
        definition.kind === Kind.ENUM_TYPE_DEFINITION &&
        definition.name.value === 'AcpServerType',
    );
    expect(enumDefinition).toBeDefined();
    const values = (enumDefinition as { values?: Array<{ name: { value: string } }> }).values ?? [];
    const names = values.map((value) => value.name.value);
    expect(names).toContain('deepseek_harness');
    expect(names).toEqual(contractAcpServerTypes());
  });

  it('agent-api Mongoose Session.acpServerType 与契约逐项一致', () => {
    const path = Session.schema.path('acpServerType') as unknown as { enumValues: string[] };
    expect(path.enumValues).toContain('deepseek_harness');
    expect([...path.enumValues].sort()).toEqual([...contractAcpServerTypes()].sort());
  });
});

describe('CreateSessionInput.customMcpServerIds 契约对齐（Phase 3 / T-CF1）', () => {
  it('契约与 agent-api GraphQL schema 均声明 customMcpServerIds: [ID!]', () => {
    const contract = readFileSync(
      resolve(process.cwd(), '../../contracts/agent-session.graphql'),
      'utf-8',
    );
    // 契约注释里含 `}`：先剔除注释行再切 input 块，避免块被注释截断
    const withoutComments = contract
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    const contractInput = withoutComments.match(/input\s+CreateSessionInput\s*\{([^}]*)\}/);
    expect(contractInput).not.toBeNull();
    expect(contractInput![1]).toMatch(/^\s*customMcpServerIds:\s*\[ID!\]/m);

    const document = parse(sessionTypeDefs);
    const inputDefinition = document.definitions.find(
      (definition) =>
        definition.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION &&
        definition.name.value === 'CreateSessionInput',
    );
    expect(inputDefinition).toBeDefined();
    const fields =
      (inputDefinition as { fields?: Array<{ name: { value: string }; type: unknown }> }).fields ??
      [];
    const field = fields.find((entry) => entry.name.value === 'customMcpServerIds');
    expect(field).toBeDefined();
    expect(print(field!.type as never)).toBe('[ID!]');
  });
});
