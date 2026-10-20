// 严格对齐 contracts/cloud-host.graphql
export const cloudHostTypeDefs = `#graphql
  enum HarnessType {
    OPENCODE
  }

  enum CloudHostStatus {
    STARTING
    RUNNING
    STOPPING
    STOPPED
    FAILED
  }

  type CloudHost {
    id: ID!
    name: String!
    controllerId: ID!
    status: CloudHostStatus!
    harnessTypes: [HarnessType!]!
    defaultSessionId: ID
    activeSessionCount: Int!
    containerId: String
    createdAt: String!
    readyAt: String
    stoppedAt: String
    failureReason: String
    deletedAt: String
  }

  type CloudHostSessionSummary {
    id: ID!
    title: String!
    status: String!
    acpServerType: String!
  }

  type CloudHostStopImpact {
    activeSessionCount: Int!
    sessionsWillBeLost: Boolean!
    sessions: [CloudHostSessionSummary!]!
  }

  type CloudHostCapabilities {
    enabled: Boolean!
    supportedHarnesses: [HarnessType!]!
  }

  input CreateCloudHostInput {
    name: String!
    harnessTypes: [HarnessType!]!
  }

  extend type Query {
    cloudHostCapabilities: CloudHostCapabilities!
    myCloudHosts: [CloudHost!]!
    cloudHostStopImpact(id: ID!): CloudHostStopImpact!
  }

  extend type Mutation {
    createCloudHost(input: CreateCloudHostInput!): CloudHost!
    stopCloudHost(id: ID!, force: Boolean): CloudHost!
    deleteCloudHost(id: ID!): Boolean!
  }

  extend type Controller {
    cloudHost: CloudHost
  }
`;
