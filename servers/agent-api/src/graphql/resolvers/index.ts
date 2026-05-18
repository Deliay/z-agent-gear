import { authResolvers } from './auth.js';
import { providerResolvers } from './provider.js';
import { modelResolvers } from './model.js';
import { controllerResolvers } from './controller.js';
import { sessionResolvers } from './session.js';

export const resolvers = {
  Query: {
    ...authResolvers.Query,
    ...providerResolvers.Query,
    ...modelResolvers.Query,
    ...controllerResolvers.Query,
    ...sessionResolvers.Query,
  },
  Mutation: {
    ...authResolvers.Mutation,
    ...providerResolvers.Mutation,
    ...modelResolvers.Mutation,
    ...controllerResolvers.Mutation,
    ...sessionResolvers.Mutation,
  },
  Provider: {
    ...providerResolvers.Provider,
  },
  Model: {
    ...modelResolvers.Model,
  },
};
