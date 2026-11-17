import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Kind, parse, print } from 'graphql';
import { cloudHostTypeDefs } from './cloud-host.js';

/**
 * 契约 ↔ 实现逐字段对齐（无 mock）：`contracts/cloud-host.graphql` 与
 * `graphql/schemas/cloud-host.ts` 的 CloudHost 相关类型与 Query/Mutation 必须逐字一致
 * （本需求新增 `CloudHostAgentGearVersion` / `CloudHostAgentGearUpgradeResult` 与升级变更，
 * 借机建立 cloud-host 双写守卫，计划 D11）。
 */

const CONTRACT_PATH = resolve(process.cwd(), '../../contracts/cloud-host.graphql');

const COMPARED_DEFINITIONS = [
  'CloudHostAgentGearVersion',
  'CloudHostAgentGearUpgradeResult',
  'CloudHost',
  'Query',
  'Mutation',
] as const;

const DEFINITION_KINDS: string[] = [
  Kind.OBJECT_TYPE_DEFINITION,
  Kind.INPUT_OBJECT_TYPE_DEFINITION,
  Kind.OBJECT_TYPE_EXTENSION,
  Kind.INPUT_OBJECT_TYPE_EXTENSION,
  Kind.ENUM_TYPE_DEFINITION,
];

function definitionPrint(documentSource: string, name: string): string {
  const document = parse(documentSource);
  const definition = document.definitions.find(
    (entry) =>
      DEFINITION_KINDS.includes(entry.kind) &&
      (entry as { name?: { value: string } }).name?.value === name,
  );
  if (!definition) {
    throw new Error(
      `${name} not found in ${documentSource === cloudHostTypeDefs ? 'schema' : 'contract'}`,
    );
  }
  return print(definition);
}

describe('cloud-host schema 契约对齐（T-UPG-SC1）', () => {
  it.each(COMPARED_DEFINITIONS)('%s 与契约逐字段一致', (name) => {
    const contract = readFileSync(CONTRACT_PATH, 'utf-8');
    expect(definitionPrint(cloudHostTypeDefs, name)).toBe(definitionPrint(contract, name));
  });
});
