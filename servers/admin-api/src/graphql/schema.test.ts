import { describe, it, expect } from 'vitest';
import { makeExecutableSchema } from '@graphql-tools/schema';
import type { GraphQLObjectType, GraphQLEnumType } from 'graphql';
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
        'listGlobalProviderModels',
        'modelRenameRecords',
        'baseImages',
        'baseImage',
        'adminCloudWorkloads',
        'adminCloudContainerWorkloadLogs',
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
        'importGlobalModels',
        'deleteGlobalModel',
        'toggleGlobalModel',
        'updateGlobalModelSortOrder',
        'createBaseImage',
        'updateBaseImage',
        'deleteBaseImage',
        'adminCreateCloudWorkload',
        'adminUpdateCloudWorkload',
        'adminDeleteCloudWorkload',
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

  it('registers the type-level CloudContainer.workloads resolver (backend-rules 显性陷阱)', () => {
    expect(resolvers.CloudContainer.workloads).toBeTypeOf('function');
  });

  it('declares the JSON scalar exactly once and registers its resolver', () => {
    expect(schema.getType('JSON')).toBeTruthy();
    expect(resolvers.JSON).toBeTruthy();
  });

  it('exposes the workload param/dependency fields and the log params snapshot', () => {
    const cloudWorkload = schema.getType('CloudWorkload') as GraphQLObjectType;
    expect(Object.keys(cloudWorkload.getFields())).toEqual(
      expect.arrayContaining(['paramSchema', 'dependsOnWorkloadIds', 'isPreset']),
    );
    const paramField = schema.getType('CloudWorkloadParamField') as GraphQLObjectType;
    expect(Object.keys(paramField.getFields())).toEqual(
      expect.arrayContaining(['key', 'label', 'type', 'options', 'defaultValue']),
    );
    const paramType = schema.getType('CloudWorkloadParamType') as GraphQLEnumType;
    expect(paramType.getValues().map((value) => value.name)).toEqual([
      'SELECT',
      'MULTI_SELECT',
      'TEXT',
      'BOOLEAN',
    ]);
    const log = schema.getType('CloudWorkloadLog') as GraphQLObjectType;
    expect(Object.keys(log.getFields())).toContain('params');
  });

  it('extends adminStartCloudContainer with the workloads selection input', () => {
    const mutation = schema.getMutationType()!;
    const start = mutation.getFields().adminStartCloudContainer;
    const argNames = start.args.map((arg) => arg.name);
    expect(argNames).toEqual(expect.arrayContaining(['purpose', 'workloadIds', 'workloads']));
    expect(schema.getType('CloudWorkloadSelectionInput')).toBeTruthy();
  });

  it('exposes the INITIALIZING status and workload fields on CloudContainer', () => {
    const cloudContainer = schema.getType('CloudContainer') as GraphQLObjectType;
    expect(Object.keys(cloudContainer.getFields())).toEqual(
      expect.arrayContaining(['workloads', 'currentWorkloadName']),
    );
    const statusEnum = schema.getType('CloudContainerStatus') as GraphQLEnumType;
    expect(statusEnum.getValues().map((value) => value.name)).toContain('INITIALIZING');
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
