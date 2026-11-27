import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type ObjectTypeDefinitionNode } from 'graphql';
import { homeTypeDefs } from './home.js';

const CONTRACT = readFileSync(resolve(process.cwd(), '../../contracts/home.graphql'), 'utf-8');

function fieldsOf(source: string, typeName: string): string[] {
  const doc = parse(source);
  const type = doc.definitions.find(
    (definition): definition is ObjectTypeDefinitionNode =>
      definition.kind === 'ObjectTypeDefinition' && definition.name.value === typeName,
  );
  return type?.fields?.map((field) => field.name.value) ?? [];
}

describe('home schema 契约双写守卫（T-SCHEMA3）', () => {
  it('契约与手写 schema 均可解析（SDL 语法有效）', () => {
    expect(() => parse(CONTRACT)).not.toThrow();
    expect(() => parse(homeTypeDefs)).not.toThrow();
  });

  it('HomeOverview 字段集与顺序双写一致，且已移除归档分支、新增三分支', () => {
    const contractFields = fieldsOf(CONTRACT, 'HomeOverview');
    expect(fieldsOf(homeTypeDefs, 'HomeOverview')).toEqual(contractFields);

    expect(contractFields).not.toContain('archivedSessions');
    expect(contractFields).not.toContain('archivedWorkflowInstances');
    expect(contractFields).toEqual(
      expect.arrayContaining(['configuredWorkflows', 'workflowTemplates', 'workspaceContext']),
    );
    expect(contractFields).toContain('sessionTotalCount');
  });

  it('WorkspaceContext 包络双写一致', () => {
    const contractFields = fieldsOf(CONTRACT, 'WorkspaceContext');
    expect(contractFields).toEqual(['myWorkspaces', 'myTenants']);
    expect(fieldsOf(homeTypeDefs, 'WorkspaceContext')).toEqual(contractFields);
  });
});
