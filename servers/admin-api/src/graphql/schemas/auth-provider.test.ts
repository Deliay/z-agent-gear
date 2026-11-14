import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GraphQLObjectType, parse, print, type DocumentNode } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { authProviderTypeDefs } from './auth-provider.js';
import { authTypeDefs } from './auth.js';
import { authProviderResolvers } from '../resolvers/auth-provider.js';
import { authResolvers } from '../resolvers/auth.js';

const base = `#graphql
  type Query
  type Mutation
`;

const schema = makeExecutableSchema({
  typeDefs: [base, authTypeDefs, authProviderTypeDefs],
  resolvers: {
    Query: { ...authResolvers.Query, ...authProviderResolvers.Query },
    Mutation: { ...authResolvers.Mutation, ...authProviderResolvers.Mutation },
  },
});

const CONTRACT = readFileSync(
  resolve(process.cwd(), '../../contracts/admin-auth-provider.graphql'),
  'utf-8',
);

function printDefinition(source: string | DocumentNode, name: string): string {
  const document = typeof source === 'string' ? parse(source) : source;
  const definition = document.definitions.find(
    (entry) =>
      (entry.kind === 'ObjectTypeDefinition' ||
        entry.kind === 'InputObjectTypeDefinition' ||
        entry.kind === 'ObjectTypeExtension' ||
        entry.kind === 'InputObjectTypeExtension') &&
      entry.name.value === name,
  );
  if (!definition) throw new Error(`${name} not found`);
  return print(definition).replace(/^extend /, '');
}

describe('admin-auth-provider schema 契约对齐', () => {
  it('OidcProvider 与契约逐字段一致', () => {
    expect(printDefinition(authProviderTypeDefs, 'OidcProvider')).toBe(
      printDefinition(CONTRACT, 'OidcProvider'),
    );
  });

  it('GithubOauthConfig 与契约逐字段一致', () => {
    expect(printDefinition(authProviderTypeDefs, 'GithubOauthConfig')).toBe(
      printDefinition(CONTRACT, 'GithubOauthConfig'),
    );
  });

  it('输入类型与 Query/Mutation 字段与契约一致', () => {
    for (const name of ['OidcProviderInput', 'GithubOauthInput']) {
      expect(printDefinition(authProviderTypeDefs, name)).toBe(printDefinition(CONTRACT, name));
    }
  });

  it('OidcProvider/GithubOauthConfig 出参不含任何 secret 字段（安全红线）', () => {
    for (const name of ['OidcProvider', 'GithubOauthConfig']) {
      const type = schema.getType(name) as GraphQLObjectType;
      const fields = Object.keys(type.getFields());
      expect(fields).toContain('hasSecret');
      expect(fields).not.toContain('clientSecret');
      expect(fields).not.toContain('encryptedClientSecret');
    }
  });

  it('AuthProviderType 枚举值域为 oidc/github_oauth', () => {
    const enumType = schema.getType('AuthProviderType') as { getValues(): Array<{ name: string }> };
    expect(enumType.getValues().map((value) => value.name).sort()).toEqual([
      'github_oauth',
      'oidc',
    ]);
  });
});
