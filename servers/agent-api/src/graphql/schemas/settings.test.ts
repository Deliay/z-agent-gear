import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type ObjectTypeDefinitionNode } from 'graphql';
import { settingsTypeDefs } from './settings.js';

const CONTRACT = readFileSync(resolve(process.cwd(), '../../contracts/settings.graphql'), 'utf-8');

function fieldsOf(source: string, typeName: string): string[] {
  const doc = parse(source);
  const type = doc.definitions.find(
    (definition): definition is ObjectTypeDefinitionNode =>
      definition.kind === 'ObjectTypeDefinition' && definition.name.value === typeName,
  );
  return type?.fields?.map((field) => field.name.value) ?? [];
}

describe('settings schema 契约双写守卫（T-SCHEMA2）', () => {
  it('契约与手写 schema 均可解析（SDL 语法有效）', () => {
    expect(() => parse(CONTRACT)).not.toThrow();
    expect(() => parse(settingsTypeDefs)).not.toThrow();
  });

  it('SettingsOverview 14 个只读分支与契约逐字段一致', () => {
    const contractFields = fieldsOf(CONTRACT, 'SettingsOverview');
    expect(contractFields).toHaveLength(14);
    expect(fieldsOf(settingsTypeDefs, 'SettingsOverview')).toEqual(contractFields);
  });

  it('settingsOverview 查询双写存在', () => {
    for (const source of [CONTRACT, settingsTypeDefs]) {
      expect(source).toContain('settingsOverview: SettingsOverview!');
    }
  });
});
