// 严格对齐 contracts/custom-mcp.graphql（见 schemas/custom-mcp.test.ts 逐字段比对）
// 安全红线：CustomMcpServer 无 token/value 出参（newToken 仅入参，永不回显）
export const customMcpTypeDefs = `#graphql
  enum CustomMcpAuthType {
    none
    bearer
  }

  type CustomMcpHeader {
    key: String!
    values: [String!]!
  }

  type CustomMcpServer {
    id: ID!
    name: String!
    description: String
    endpoint: String!
    authType: CustomMcpAuthType!
    customHeaders: [CustomMcpHeader!]!
    bearerEntryId: ID
    bearerEntryManaged: Boolean
    workspaceId: ID!
    createdBy: String!
    createdAt: String!
    updatedAt: String!
  }

  input CustomMcpHeaderInput {
    key: String!
    values: [String!]!
  }

  input CustomMcpAuthInput {
    type: CustomMcpAuthType!
    newToken: String
    existingEntryId: ID
  }

  input CreateCustomMcpServerInput {
    name: String!
    description: String
    endpoint: String!
    auth: CustomMcpAuthInput!
    customHeaders: [CustomMcpHeaderInput!]
  }

  input UpdateCustomMcpServerInput {
    name: String
    description: String
    endpoint: String
    auth: CustomMcpAuthInput
    customHeaders: [CustomMcpHeaderInput!]
  }

  extend type Query {
    customMcpServers: [CustomMcpServer!]!
    customMcpServer(id: ID!): CustomMcpServer
  }

  extend type Mutation {
    createCustomMcpServer(input: CreateCustomMcpServerInput!): CustomMcpServer!
    updateCustomMcpServer(id: ID!, input: UpdateCustomMcpServerInput!): CustomMcpServer!
    deleteCustomMcpServer(id: ID!): Boolean!
  }
`;
