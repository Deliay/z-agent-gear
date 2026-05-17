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
    createdAt: String!
    updatedAt: String!
  }

  input CreateKeyInput {
    name: String!
    type: ControllerType! = local
  }

  input RenameInput {
    id: ID!
    name: String!
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
    revokeControllerKey(id: ID!): Boolean!
    renameController(input: RenameInput!): Controller!
    unbindController(id: ID!): Boolean!
  }
`;
