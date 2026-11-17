import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Kind, parse, print } from 'graphql';
import { modelTypeDefs } from './model.js';

/**
 * 契约双写守卫（实现计划 Phase 0 / checklist 10.1）：
 * `contracts/admin-llm.graphql` 与 `graphql/schemas/model.ts` 的上下文元数据相关定义必须逐字段一致。
 */

const CONTRACT = readFileSync(resolve(process.cwd(), '../../contracts/admin-llm.graphql'), 'utf-8');

const COMPARED_DEFINITIONS = ['ProviderModelOption', 'CustomModelInput'] as const;

function definitionPrint(documentSource: string, name: string): string {
  const document = parse(documentSource);
  const definition = document.definitions.find(
    (entry) =>
      (entry.kind === Kind.OBJECT_TYPE_DEFINITION ||
        entry.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION ||
        entry.kind === Kind.ENUM_TYPE_DEFINITION) &&
      entry.name.value === name,
  );
  if (!definition) {
    throw new Error(
      `${name} not found in ${documentSource === modelTypeDefs ? 'schema' : 'contract'}`,
    );
  }
  return print(definition);
}

describe('admin model schema 上下文契约双写守卫', () => {
  it('契约与手写 schema 均可解析（SDL 语法有效）', () => {
    expect(() => parse(CONTRACT)).not.toThrow();
    expect(() => parse(modelTypeDefs)).not.toThrow();
  });

  it.each(COMPARED_DEFINITIONS)('%s 与契约逐字段一致', (name) => {
    expect(definitionPrint(modelTypeDefs, name)).toBe(definitionPrint(CONTRACT, name));
  });

  it('ProviderModelOption.contextLength 双写（上游未提供为 null）', () => {
    for (const source of [CONTRACT, modelTypeDefs]) {
      expect(source).toContain('contextLength: Int');
      expect(source).toContain('type ProviderModelOption');
    }
  });

  it('导入与上下文变更字段双写', () => {
    for (const source of [CONTRACT, modelTypeDefs]) {
      expect(source).toContain('importGlobalModels(providerId: ID!, names: [String!]!): [Model!]!');
      expect(source).toContain(
        'updateModelContextLength(modelId: ID!, contextLength: Int): Model!',
      );
    }
  });
});
