import { describe, it, expect } from 'vitest';
import { makeExecutableSchema } from '@graphql-tools/schema';
import type { GraphQLObjectType } from 'graphql';
import { typeDefs } from './schemas/index.js';
import { resolvers } from './resolvers/index.js';

describe('GraphQL schema', () => {
  const schema = makeExecutableSchema({ typeDefs, resolvers });

  it('compiles successfully (no duplicate types, resolvers match schema)', () => {
    expect(schema.getQueryType()).toBeTruthy();
    expect(schema.getMutationType()).toBeTruthy();
  });

  it('exposes every admin query', () => {
    const fields = Object.keys(schema.getQueryType()!.getFields());
    expect(fields).toEqual(
      expect.arrayContaining([
        'adminMe',
        'adminProviders',
        'adminModels',
        'adminModelsByProvider',
        'baseImages',
        'baseImage',
      ]),
    );
  });

  it('exposes every admin mutation', () => {
    const fields = Object.keys(schema.getMutationType()!.getFields());
    expect(fields).toEqual(
      expect.arrayContaining([
        'adminLogin',
        'changeAdminPassword',
        'createGlobalProvider',
        'updateGlobalProvider',
        'deleteGlobalProvider',
        'toggleGlobalProvider',
        'batchEnableGlobalProviders',
        'batchDisableGlobalProviders',
        'batchDeleteGlobalProviders',
        'createGlobalCustomModel',
        'deleteGlobalCustomModel',
        'toggleGlobalModel',
        'updateGlobalModelSortOrder',
        'createBaseImage',
        'updateBaseImage',
        'deleteBaseImage',
      ]),
    );
  });

  it('has no registration mutation', () => {
    const fields = Object.keys(schema.getMutationType()!.getFields());
    expect(fields).not.toContain('signup');
    expect(fields).not.toContain('register');
    expect(fields).not.toContain('createAdmin');
  });

  it('exposes scope on Provider and Model', () => {
    const provider = schema.getType('Provider') as GraphQLObjectType;
    const model = schema.getType('Model') as GraphQLObjectType;
    expect(Object.keys(provider.getFields())).toContain('scope');
    expect(Object.keys(model.getFields())).toContain('scope');
  });

  it('registers type-level Provider.models and Model.provider resolvers', () => {
    expect(resolvers.Provider.models).toBeTypeOf('function');
    expect(resolvers.Model.provider).toBeTypeOf('function');
  });

  it('registers every Query/Mutation resolver declared in the schema', () => {
    const queryFields = Object.keys(schema.getQueryType()!.getFields());
    const mutationFields = Object.keys(schema.getMutationType()!.getFields());
    for (const field of queryFields) {
      expect((resolvers.Query as Record<string, unknown>)[field], `missing Query.${field}`).toBeTypeOf('function');
    }
    for (const field of mutationFields) {
      expect((resolvers.Mutation as Record<string, unknown>)[field], `missing Mutation.${field}`).toBeTypeOf('function');
    }
  });
});
