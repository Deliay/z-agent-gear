import { authResolvers } from './auth.js';
import { providerResolvers } from './provider.js';
import { modelResolvers } from './model.js';
import { baseImageResolvers } from './base-image.js';
import { cloudContainerResolvers } from './cloud-container.js';

// 类型级 resolver（Provider.models / Model.provider）必须显式登记，否则线上不生效
export const resolvers = {
  Query: {
    ...authResolvers.Query,
    ...providerResolvers.Query,
    ...modelResolvers.Query,
    ...baseImageResolvers.Query,
    ...cloudContainerResolvers.Query,
  },
  Mutation: {
    ...authResolvers.Mutation,
    ...providerResolvers.Mutation,
    ...modelResolvers.Mutation,
    ...baseImageResolvers.Mutation,
    ...cloudContainerResolvers.Mutation,
  },
  Provider: {
    ...providerResolvers.Provider,
  },
  Model: {
    ...modelResolvers.Model,
  },
};
