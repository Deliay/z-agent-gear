import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Kind, parse, print } from 'graphql';
import { modelTypeDefs } from './model.js';

/**
 * 契约双写守卫（实现计划 Phase 0 / checklist 10.1）：
 * `contracts/llm.graphql` 与 `graphql/schemas/model.ts` 的模型下发相关定义必须逐字段一致，
 * 漏改任一侧即运行期 `Cannot query field` 或静默字段漂移。
 */

const CONTRACT = readFileSync(resolve(process.cwd(), '../../contracts/llm.graphql'), 'utf-8');

const COMPARED_DEFINITIONS = ['CustomModelInput', 'ProviderModelOption'] as const;

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

describe('model schema 模型下发契约双写守卫', () => {
  it('契约与手写 schema 均可解析（SDL 语法有效）', () => {
    expect(() => parse(CONTRACT)).not.toThrow();
    expect(() => parse(modelTypeDefs)).not.toThrow();
  });

  it.each(COMPARED_DEFINITIONS)('%s 与契约逐字段一致', (name) => {
    expect(definitionPrint(modelTypeDefs, name)).toBe(definitionPrint(CONTRACT, name));
  });

  it('CustomModelInput.contextLength 双写（缺省/ null = 未设置）', () => {
    for (const source of [CONTRACT, modelTypeDefs]) {
      expect(source).toContain('contextLength: Int');
      expect(source).toContain('input CustomModelInput');
    }
  });

  it('ProviderModelOption.name / contextLength 双写', () => {
    for (const source of [CONTRACT, modelTypeDefs]) {
      const match = source.match(/type ProviderModelOption\s*\{([\s\S]*?)\n\s*\}/);
      expect(match, 'ProviderModelOption 应存在于两份 schema').not.toBeNull();
      expect(match![1]).toMatch(/name:\s*String!/);
      expect(match![1]).toMatch(/contextLength:\s*Int/);
    }
  });

  it('Query.providerModelOptions 与 Mutation.updateModelContextLength 双写', () => {
    for (const source of [CONTRACT, modelTypeDefs]) {
      expect(source).toContain('providerModelOptions(providerId: ID!): [ProviderModelOption!]!');
      expect(source).toContain(
        'updateModelContextLength(modelId: ID!, contextLength: Int): Model!',
      );
    }
  });

  it('Model.contextLength 可空（null = 未设置）且注明用户侧可编辑', () => {
    for (const source of [CONTRACT, modelTypeDefs]) {
      expect(source).toContain('contextLength: Int');
      expect(source).toContain('updateModelContextLength');
    }
  });
});
