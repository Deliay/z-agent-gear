import { authResolvers } from './auth.js';
import { providerResolvers } from './provider.js';
import { modelResolvers } from './model.js';

export const resolvers = {
  Query: {
    ...authResolvers.Query,
    ...providerResolvers.Query,
    ...modelResolvers.Query,
  },
  Mutation: {
    ...authResolvers.Mutation,
    ...providerResolvers.Mutation,
    ...modelResolvers.Mutation,
  },
  Provider: {
    ...providerResolvers.Provider,
  },
  Model: {
    ...modelResolvers.Model,
  },
};
