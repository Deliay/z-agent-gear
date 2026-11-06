import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Kind, parse, print } from 'graphql';
import { customMcpTypeDefs } from './custom-mcp.js';

/**
 * 契约 ↔ 实现逐字段对齐（无 mock）：
 * `contracts/custom-mcp.graphql` 与 `graphql/schemas/custom-mcp.ts` 的 enum/类型/入参/
 * Query/Mutation 定义必须逐字一致（漏改即运行时字段漂移）。
 */

const CONTRACT_PATH = resolve(process.cwd(), '../../contracts/custom-mcp.graphql');

const COMPARED_DEFINITIONS = [
  'CustomMcpAuthType',
  'CustomMcpHeader',
  'CustomMcpServer',
  'CustomMcpHeaderInput',
  'CustomMcpAuthInput',
  'CreateCustomMcpServerInput',
  'UpdateCustomMcpServerInput',
  'Query',
  'Mutation',
] as const;

function definitionPrint(documentSource: string, name: string): string {
  const document = parse(documentSource);
  const definition = document.definitions.find(
    (entry) =>
      (entry.kind === Kind.OBJECT_TYPE_DEFINITION ||
        entry.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION ||
        entry.kind === Kind.OBJECT_TYPE_EXTENSION ||
        entry.kind === Kind.INPUT_OBJECT_TYPE_EXTENSION ||
        entry.kind === Kind.ENUM_TYPE_DEFINITION) &&
      entry.name.value === name,
  );
  if (!definition) {
    throw new Error(
      `${name} not found in ${documentSource === customMcpTypeDefs ? 'schema' : 'contract'}`,
    );
  }
  return print(definition);
}

describe('custom-mcp schema 契约对齐', () => {
  it.each(COMPARED_DEFINITIONS)('%s 与契约逐字段一致', (name) => {
    const contract = readFileSync(CONTRACT_PATH, 'utf-8');
    expect(definitionPrint(customMcpTypeDefs, name)).toBe(definitionPrint(contract, name));
  });

  it('CustomMcpServer 出参无 token/value 明文字段（安全红线）', () => {
    const document = parse(customMcpTypeDefs);
    const server = document.definitions.find(
      (definition) =>
        definition.kind === Kind.OBJECT_TYPE_DEFINITION && definition.name.value === 'CustomMcpServer',
    );
    const fields = (server as { fields?: Array<{ name: { value: string } }> }).fields ?? [];
    const names = fields.map((field) => field.name.value);
    expect(names).not.toContain('value');
    expect(names).not.toContain('valueEncrypted');
    expect(names).not.toContain('token');
    expect(names).not.toContain('newToken');
    expect(names).toEqual([
      'id',
      'name',
      'description',
      'endpoint',
      'authType',
      'customHeaders',
      'bearerEntryId',
      'bearerEntryManaged',
      'workspaceId',
      'createdBy',
      'createdAt',
      'updatedAt',
    ]);
  });

  it('CustomMcpAuthInput 仅入参携带 newToken/existingEntryId（永不回显）', () => {
    const document = parse(customMcpTypeDefs);
    const input = document.definitions.find(
      (definition) =>
        definition.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION &&
        definition.name.value === 'CustomMcpAuthInput',
    );
    const fields = ((input as { fields?: Array<{ name: { value: string } }> }).fields ?? []).map(
      (field) => field.name.value,
    );
    expect(fields).toEqual(['type', 'newToken', 'existingEntryId']);
  });

  it('契约错误口径注释锚点齐全（契约头注释存在）', () => {
    const contract = readFileSync(CONTRACT_PATH, 'utf-8');
    expect(contract).toContain('custom mcp server not found');
    expect(contract).toContain('invalid mcp name');
    expect(contract).toContain('invalid mcp endpoint');
    expect(contract).toContain('invalid custom headers');
    expect(contract).toContain('bearer token is required');
    expect(contract).toContain('bearer entry must be manual namespace');
    expect(contract).toContain('bearer entry not editable in place');
  });
});
