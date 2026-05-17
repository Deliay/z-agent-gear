import { authTypeDefs } from './auth.js';
import { providerTypeDefs } from './provider.js';
import { modelTypeDefs } from './model.js';

const baseTypeDefs = `#graphql
  type Query

  type Mutation
`;

export const typeDefs = [baseTypeDefs, authTypeDefs, providerTypeDefs, modelTypeDefs];
