export const authTypeDefs = `#graphql
  enum TenantType {
    personal
    team
  }

  type Tenant {
    id: ID!
    name: String!
    type: TenantType!
    memberCount: Int!
  }

  type User {
    id: ID!
    name: String!
    tenant: Tenant!
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
    login(username: String!, password: String!): AuthPayload!
  }
`;
