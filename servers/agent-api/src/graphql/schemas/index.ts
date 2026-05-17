import { authTypeDefs } from './auth.js';

const baseTypeDefs = `#graphql
  type Query

  type Mutation
`;

export const typeDefs = [baseTypeDefs, authTypeDefs];
