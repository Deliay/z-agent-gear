import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Kind, parse, print } from 'graphql';
import { customToolTypeDefs } from './custom-tool.js';

/**
 * 契约 ↔ 实现逐字段对齐（无 mock）：
 * `contracts/custom-tool.graphql` 与 `graphql/schemas/custom-tool.ts` 的 enum/类型/入参/
 * Query/Mutation 定义必须逐字一致（漏改即运行时字段漂移）。
 */

const CONTRACT_PATH = resolve(process.cwd(), '../../contracts/custom-tool.graphql');

const COMPARED_DEFINITIONS = [
  'CustomToolType',
  'FragmentType',
  'FragmentFormat',
  'CustomToolBodyType',
  'CustomToolFormFieldType',
  'Fragment',
  'CustomToolArg',
  'CustomToolFormField',
  'CustomToolKeyValue',
  'CustomToolHttpConfig',
  'CustomTool',
  'FragmentInput',
  'CustomToolArgInput',
  'CustomToolFormFieldInput',
  'CustomToolKeyValueInput',
  'CustomToolHttpConfigInput',
  'CreateCustomToolInput',
  'UpdateCustomToolInput',
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
      `${name} not found in ${documentSource === customToolTypeDefs ? 'schema' : 'contract'}`,
    );
  }
  return print(definition);
}

describe('custom-tool schema 契约对齐', () => {
  it.each(COMPARED_DEFINITIONS)('%s 与契约逐字段一致', (name) => {
    const contract = readFileSync(CONTRACT_PATH, 'utf-8');
    expect(definitionPrint(customToolTypeDefs, name)).toBe(definitionPrint(contract, name));
  });

  it('CustomTool 出参无任何 Valut 明文/取值字段（安全红线）', () => {
    const document = parse(customToolTypeDefs);
    const tool = document.definitions.find(
      (definition) =>
        definition.kind === Kind.OBJECT_TYPE_DEFINITION && definition.name.value === 'CustomTool',
    );
    const fields = (tool as { fields?: Array<{ name: { value: string } }> }).fields ?? [];
    const names = fields.map((field) => field.name.value);
    expect(names).not.toContain('value');
    expect(names).not.toContain('secret');
    expect(names).not.toContain('resolved');
  });
});
