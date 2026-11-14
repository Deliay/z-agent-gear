import { describe, it, expect } from 'vitest';
import { makeExecutableSchema } from '@graphql-tools/schema';
import type { GraphQLObjectType } from 'graphql';
import { typeDefs } from '../schemas/index.js';
import { resolvers } from './index.js';

/**
 * R2-1：类型级 resolver 必须登记到 resolvers/index.ts，否则 makeExecutableSchema
 * 不会挂载、运行时字段恒走默认解析器（mapSession 不含 controllerType/cloudHost → null）。
 */
describe('graphql resolver registry', () => {
  const schema = makeExecutableSchema({ typeDefs, resolvers });
  const sessionType = schema.getType('Session') as GraphQLObjectType;

  it('registers Session.controllerType / Session.cloudHost on the executable schema', () => {
    const fields = sessionType.getFields();
    // makeExecutableSchema 会 bind resolver，故只断言已挂载可执行函数（未登记时 resolve 为 undefined）。
    expect(fields.controllerType.resolve).toEqual(expect.any(Function));
    expect(fields.cloudHost.resolve).toEqual(expect.any(Function));
  });

  it('registers Session.readOnlyReason on the executable schema（会话管理优化 spread 登记守卫）', () => {
    const fields = sessionType.getFields();
    // readOnlyReason 为字段级 resolver：漏登记 `resolvers/index.ts` 的 Session 键则线上恒 null
    expect(fields.readOnlyReason.resolve).toEqual(expect.any(Function));
    // archived 随 mapSession 透出，不设字段 resolver
    expect(fields.archived.resolve).toBeUndefined();
  });

  it('registers CloudHost.storage / storageRestoring and CloudStorage.hourlyCredits', () => {
    const hostFields = (schema.getType('CloudHost') as GraphQLObjectType).getFields();
    expect(hostFields.storage.resolve).toEqual(expect.any(Function));
    expect(hostFields.storageRestoring.resolve).toEqual(expect.any(Function));

    const storageFields = (schema.getType('CloudStorage') as GraphQLObjectType).getFields();
    expect(storageFields.hourlyCredits.resolve).toEqual(expect.any(Function));
    expect(storageFields.hourlyCreditsFull.resolve).toEqual(expect.any(Function));
    expect(storageFields.hourlyCreditsArchived.resolve).toEqual(expect.any(Function));
    expect(storageFields.archiveSpace.resolve).toEqual(expect.any(Function));

    const summaryFields = (schema.getType('CloudStorageSummary') as GraphQLObjectType).getFields();
    expect(summaryFields.hourlyCredits.resolve).toEqual(expect.any(Function));
  });

  it('registers ExternalLoginInfo provider resolvers（绑定优化 spread 登记守卫）', () => {
    const fields = (schema.getType('ExternalLoginInfo') as GraphQLObjectType).getFields();
    for (const name of ['providerType', 'providerDisplayName', 'providerEnabled']) {
      expect(fields[name].resolve).toEqual(expect.any(Function));
    }
  });
});
