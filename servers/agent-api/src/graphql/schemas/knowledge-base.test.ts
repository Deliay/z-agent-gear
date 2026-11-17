import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Kind, parse, print } from 'graphql';
import { knowledgeBaseTypeDefs } from './knowledge-base.js';

/**
 * 契约 ↔ 实现逐字段对齐（无 mock）：`contracts/knowledge-base.graphql` 与
 * `graphql/schemas/knowledge-base.ts` 的 enum/类型/入参/Query/Mutation 必须逐字一致。
 */

const CONTRACT_PATH = resolve(process.cwd(), '../../contracts/knowledge-base.graphql');

const COMPARED_DEFINITIONS = [
  'KnowledgeBasePermissionMode',
  'KnowledgeBaseEventOp',
  'KnowledgeBaseAccess',
  'KnowledgeBase',
  'KnowledgeBaseDocumentMeta',
  'KnowledgeBaseDocument',
  'KnowledgeBaseTreeItem',
  'KnowledgeBaseEvent',
  'KnowledgeBaseDocumentInput',
  'RepoKnowledgeBaseSource',
  'RepoKnowledgeBaseHost',
  'RepoKnowledgeBase',
  'RepoKnowledgeBaseNodeKind',
  'RepoKnowledgeBaseNode',
  'RepoKnowledgeBaseDocument',
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
      `${name} not found in ${documentSource === knowledgeBaseTypeDefs ? 'schema' : 'contract'}`,
    );
  }
  return print(definition);
}

describe('knowledge-base schema 契约对齐', () => {
  it.each(COMPARED_DEFINITIONS)('%s 与契约逐字段一致', (name) => {
    const contract = readFileSync(CONTRACT_PATH, 'utf-8');
    expect(definitionPrint(knowledgeBaseTypeDefs, name)).toBe(definitionPrint(contract, name));
  });

  it('KnowledgeBaseDocument 出参无内部字段（createdBy/updatedBy/tenantId/知识库 id）', () => {
    const document = parse(knowledgeBaseTypeDefs);
    const doc = document.definitions.find(
      (definition) =>
        definition.kind === Kind.OBJECT_TYPE_DEFINITION &&
        definition.name.value === 'KnowledgeBaseDocument',
    );
    const fields = ((doc as { fields?: Array<{ name: { value: string } }> }).fields ?? []).map(
      (field) => field.name.value,
    );
    expect(fields).toEqual([
      'path',
      'title',
      'tags',
      'description',
      'content',
      'createdByName',
      'updatedByName',
      'createdAt',
      'updatedAt',
    ]);
  });

  it('契约错误口径注释锚点齐全（14 条白名单逐字列入契约）', () => {
    const contract = readFileSync(CONTRACT_PATH, 'utf-8');
    for (const message of [
      'Not authenticated',
      'workspace not found',
      'knowledge base not found',
      'knowledge base name already exists',
      'invalid knowledge base name',
      'not a tenant admin',
      'knowledge base permission denied',
      'knowledge base document not found',
      'knowledge base document already exists',
      'invalid document path',
      'invalid document title',
      'invalid document tags',
      'invalid document description',
      'invalid document content',
    ]) {
      expect(contract).toContain(message);
    }
  });
});
