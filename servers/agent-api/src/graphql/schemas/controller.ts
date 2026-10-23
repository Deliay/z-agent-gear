export const controllerTypeDefs = `#graphql
  enum ControllerType {
    local
    cloud
    github
  }

  enum ControllerStatus {
    online
    offline
    registering
    unbound
  }

  enum ControllerKeyStatus {
    active
    revoked
    expired
  }

  type ControllerKey {
    id: ID!
    name: String!
    type: ControllerType!
    keyPrefix: String!
    status: ControllerKeyStatus!
    rawKey: String
    lastUsedAt: String
    createdAt: String!
    updatedAt: String!
  }

  type Controller {
    id: ID!
    name: String!
    hostname: String!
    type: ControllerType!
    status: ControllerStatus!
    keyId: ID!
    version: String!
    lastHeartbeatAt: String
    worktreeDir: String
    createdAt: String!
    updatedAt: String!
    defaultMcp: ControllerDefaultMcp!
  }

  # 新建会话默认注入的 MCP（存量控制器缺失时归一为 { useAllEnabled: true, serverIds: [] }）
  type ControllerDefaultMcp {
    useAllEnabled: Boolean!
    serverIds: [ID!]!
  }

  input CreateKeyInput {
    name: String!
    type: ControllerType! = local
  }

  input RenameInput {
    id: ID!
    name: String!
  }

  input RegenerateControllerKeyInput {
    controllerId: ID!
  }

  type CreateKeyPayload {
    key: ControllerKey!
    rawKey: String!
  }

  extend type Query {
    controllerKeys: [ControllerKey!]!
    controllers: [Controller!]!
    controller(id: ID!): Controller
  }

  extend type Mutation {
    createControllerKey(input: CreateKeyInput!): CreateKeyPayload!
    renameControllerKey(input: RenameInput!): ControllerKey!
    renameController(input: RenameInput!): Controller!
    unbindController(id: ID!): Boolean!
    setControllerWorktreeDir(controllerId: ID!, worktreeDir: String!): Controller!
    setControllerDefaultMcp(controllerId: ID!, useAllEnabled: Boolean!, serverIds: [ID!] = []): Controller!
    regenerateControllerKey(input: RegenerateControllerKeyInput!): CreateKeyPayload!
  }
`;
