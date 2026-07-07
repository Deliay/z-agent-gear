export const gatewayTypeDefs = `#graphql
  type Gateway {
    id: ID!
    controllerId: ID!
    name: String!
    port: Int!
    status: String!
    createdAt: String!
  }

  type GatewayList {
    gateways: [Gateway!]!
    total: Int!
    limit: Int!
  }

  extend type Query {
    gateways(controllerId: ID!): GatewayList!
  }

  extend type Mutation {
    createGateway(controllerId: ID!, name: String!, port: Int!): Gateway!
    deleteGateway(controllerId: ID!, name: String!): Boolean!
  }
`;
