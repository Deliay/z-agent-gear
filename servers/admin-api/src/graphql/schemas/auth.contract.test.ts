import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, print } from 'graphql';
import { createYoga } from 'graphql-yoga';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { authTypeDefs } from './auth.js';
import { authResolvers } from '../resolvers/auth.js';

const CONTRACT = readFileSync(resolve(process.cwd(), '../../contracts/admin-auth.graphql'), 'utf-8');
const base = `#graphql
  type Query
  type Mutation
`;

makeExecutableSchema({
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

describe('admin auth.graphql 契约双写一致性', () => {
  it('AdminAuthProviderInfo / AdminExternalLogin / AuthProviderType 与契约一致', () => {
    for (const name of ['AdminAuthProviderInfo', 'AdminExternalLogin', 'AuthProviderType']) {
      expect(printType(authTypeDefs, name)).toBe(printType(CONTRACT, name));
    }
  });

  it('免登录 adminAuthProviders/adminExchangeLoginTicket 与受保护绑定 mutation 均暴露', () => {
    const query = fieldNames(authTypeDefs, 'Query');
    const mutation = fieldNames(authTypeDefs, 'Mutation');
    expect(query).toEqual(expect.arrayContaining(['adminAuthProviders', 'adminExternalLogins']));
    expect(mutation).toEqual(
      expect.arrayContaining([
        'adminExchangeLoginTicket',
        'createAdminBindTicket',
        'unbindAdminExternalLogin',
      ]),
    );
  });

  it('authProviders 与 adminAuthProviders 的枚举值域一致', () => {
    const contract = parse(CONTRACT);
    const enumDef = contract.definitions.find(
      (d) => d.kind === 'EnumTypeDefinition' && d.name.value === 'AuthProviderType',
    ) as { values?: Array<{ name: { value: string } }> } | undefined;
    expect(enumDef?.values?.map((v) => v.name.value).sort()).toEqual(['github_oauth', 'oidc']);
  });
});
