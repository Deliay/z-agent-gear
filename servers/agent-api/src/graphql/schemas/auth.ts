export const authTypeDefs = `#graphql
  type User {
    id: ID!
    username: String!
    createdAt: String!
  }

  type AuthPayload {
    token: String!
    user: User!
  }

  extend type Query {
    me: User
  }

  extend type Mutation {
    signup(username: String!, password: String!): AuthPayload!
    login(username: String!, password: String!): AuthPayload!
  }
`;
