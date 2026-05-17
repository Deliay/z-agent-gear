import type { IResolvers } from '@graphql-tools/schema';

export const resolvers: IResolvers = {
  Query: {
    hello: () => 'Hello from Agent Gear API!',
  },
  Mutation: {
    ping: () => 'pong',
  },
};
