export const mcpServerTypeDefs = `#graphql
  enum McpServerTransport {
    registered_proxy
    http
    platform
  }

  enum McpServerSource {
    proxy
    manual
    platform
  }

  enum McpServerStatus {
    active
    offline
    disabled
  }

  type McpServerTool {
    name: String!
    description: String
  }

  type McpServer {
    id: ID!
    name: String!
    transport: McpServerTransport!
    source: McpServerSource!
    enabled: Boolean!
    command: String
    url: String
    hostname: String
    status: McpServerStatus!
    tools: [McpServerTool!]!
    toolsSyncedAt: String
    lastHeartbeatAt: String
    createdAt: String!
    updatedAt: String!
  }

  extend type Query {
    mcpServers: [McpServer!]!
    mcpServer(id: ID!): McpServer
  }

  extend type Mutation {
    setMcpServerEnabled(id: ID!, enabled: Boolean!): McpServer!
  }
`;
