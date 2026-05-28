import GraphQLJSON from 'graphql-type-json';
import { authResolvers } from './auth.js';
import { providerResolvers } from './provider.js';
import { modelResolvers } from './model.js';
import { controllerResolvers } from './controller.js';
import { controllerWorkspaceResolvers } from './controller-workspace.js';
import { sessionResolvers } from './session.js';
import { portForwardResolvers } from './port-forward.js';

export const resolvers = {
  JSON: GraphQLJSON,
  Query: {
    ...authResolvers.Query,
    ...providerResolvers.Query,
    ...modelResolvers.Query,
    ...controllerResolvers.Query,
    ...controllerWorkspaceResolvers.Query,
    ...sessionResolvers.Query,
    ...portForwardResolvers.Query,
  },
  Mutation: {
    ...authResolvers.Mutation,
    ...providerResolvers.Mutation,
    ...modelResolvers.Mutation,
    ...controllerResolvers.Mutation,
    ...controllerWorkspaceResolvers.Mutation,
    ...sessionResolvers.Mutation,
    ...portForwardResolvers.Mutation,
  },
  Provider: {
    ...providerResolvers.Provider,
  },
  Model: {
    ...modelResolvers.Model,
  },
};
