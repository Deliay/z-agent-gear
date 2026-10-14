import { authTypeDefs } from './auth.js';
import { providerTypeDefs } from './provider.js';
import { modelTypeDefs } from './model.js';
import { baseImageTypeDefs } from './base-image.js';
import { cloudContainerTypeDefs } from './cloud-container.js';

const baseTypeDefs = `#graphql
  type Query

  type Mutation
`;

export const typeDefs = [baseTypeDefs, authTypeDefs, providerTypeDefs, modelTypeDefs, baseImageTypeDefs, cloudContainerTypeDefs];
