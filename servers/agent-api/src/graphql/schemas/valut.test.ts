import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Kind, parse, print } from 'graphql';
import { valutTypeDefs } from './valut.js';

/**
 * 契约 ↔ 实现逐字段对齐（无 mock）：
 * `contracts/valut.graphql` 与 `graphql/schemas/valut.ts` 的类型/入参/Query/Mutation
 * 定义必须逐字一致（安全红线：ValutEntry 无 value 出参，漏改即运行时字段漂移）。
 */

const CONTRACT_PATH = resolve(process.cwd(), '../../contracts/valut.graphql');

const COMPARED_DEFINITIONS = [
  'ValutNamespace',
  'ValutRef',
  'ValutEntry',
  'ValutNamespaceGroup',
  'CreateValutEntryInput',
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
        entry.kind === Kind.INPUT_OBJECT_TYPE_EXTENSION) &&
      entry.name.value === name,
  );
  if (!definition) {
    throw new Error(`${name} not found in ${documentSource === valutTypeDefs ? 'schema' : 'contract'}`);
  }
  return print(definition);
}

describe('valut schema 契约对齐', () => {
  it.each(COMPARED_DEFINITIONS)('%s 与契约逐字段一致', (name) => {
    const contract = readFileSync(CONTRACT_PATH, 'utf-8');
    expect(definitionPrint(valutTypeDefs, name)).toBe(definitionPrint(contract, name));
  });

  it('ValutEntry 不含任何 value 出参（安全红线）', () => {
    const document = parse(valutTypeDefs);
    const entry = document.definitions.find(
      (definition) =>
        definition.kind === Kind.OBJECT_TYPE_DEFINITION && definition.name.value === 'ValutEntry',
    );
    const fields = (entry as { fields?: Array<{ name: { value: string } }> }).fields ?? [];
    const names = fields.map((field) => field.name.value);
    expect(names).not.toContain('value');
    expect(names).not.toContain('valueEncrypted');
    expect(names).toEqual([
      'id',
      'namespace',
      'namespaceDisplayName',
      'key',
      'editable',
      'deletable',
      'refs',
      'createdBy',
      'createdAt',
      'updatedAt',
    ]);
  });

  it('契约错误口径注释与白名单锚点齐全（契约头注释存在）', () => {
    const contract = readFileSync(CONTRACT_PATH, 'utf-8');
    expect(contract).toContain('valut entry not found');
    expect(contract).toContain('valut key already exists');
    expect(contract).toContain('invalid valut key');
    expect(contract).toContain('invalid valut value');
    expect(contract).toContain('valut entry is not editable');
    expect(contract).toContain('valut entry is not deletable');
    expect(contract).toContain('valut entry has refs');
  });
});
