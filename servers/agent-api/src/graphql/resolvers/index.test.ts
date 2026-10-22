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
});
