import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GraphQLObjectType, parse, print } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { authTypeDefs } from './auth.js';
import { authResolvers } from '../resolvers/auth.js';

const CONTRACT = readFileSync(resolve(process.cwd(), '../../contracts/auth.graphql'), 'utf-8');
const base = `#graphql
  type Query
  type Mutation
  type User { id: ID! }
`;
const schema = makeExecutableSchema({
  typeDefs: [base, authTypeDefs],
  resolvers: authResolvers,
});

function printType(source: string, name: string): string {
  const doc = parse(source);
  const def = doc.definitions.find(
    (d) =>
      (d.kind === 'ObjectTypeDefinition' ||
        d.kind === 'ObjectTypeExtension' ||
        d.kind === 'EnumTypeDefinition') &&
      d.name.value === name,
  );
  if (!def) throw new Error(`${name} not found`);
  return print(def).replace(/^extend /, '');
}

function fieldNames(source: string, name: string): string[] {
  const doc = parse(source);
  const def = doc.definitions.find(
    (d) =>
      (d.kind === 'ObjectTypeDefinition' || d.kind === 'ObjectTypeExtension') &&
      d.name.value === name,
  ) as { fields?: Array<{ name: { value: string } }> } | undefined;
  return (def?.fields ?? []).map((f) => f.name.value);
}

describe('agent auth.graphql 契约双写一致性', () => {
  it('AuthProviderType / AuthProviderInfo 与契约逐字段一致', () => {
    for (const name of ['AuthProviderType', 'AuthProviderInfo']) {
      expect(printType(authTypeDefs, name)).toBe(printType(CONTRACT, name));
    }
  });

  it('authProviders / exchangeLoginTicket 已暴露（免登录口径）', () => {
    expect(fieldNames(authTypeDefs, 'Query')).toContain('authProviders');
    expect(fieldNames(authTypeDefs, 'Mutation')).toContain('exchangeLoginTicket');
    const type = schema.getType('AuthProviderInfo') as GraphQLObjectType;
    expect(Object.keys(type.getFields())).toEqual(['id', 'type', 'displayName']);
  });
});
