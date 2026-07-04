export const mcpServerTypeDefs = `#graphql
  enum McpServerTransport {
    registered_proxy
  }

  enum McpServerStatus {
    active
    offline
    disabled
  }

  type McpServer {
    id: ID!
    name: String!
    transport: McpServerTransport!
    command: String!
    status: McpServerStatus!
    lastHeartbeatAt: String
    createdAt: String!
    updatedAt: String!
  }

  extend type Query {
    mcpServers: [McpServer!]!
    mcpServer(id: ID!): McpServer
  }
`;
