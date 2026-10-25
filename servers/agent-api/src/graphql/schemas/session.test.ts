import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Kind, parse } from 'graphql';
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
