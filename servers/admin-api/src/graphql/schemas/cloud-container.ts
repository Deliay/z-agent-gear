// 与 contracts/admin-cloud-container.graphql 逐字段一致。
// 鉴权：所有 Query/Mutation 需 admin JWT；未认证 UNAUTHENTICATED（由 resolver 守卫抛出）。
export const cloudContainerTypeDefs = `#graphql
  type CloudContainer {
    id: ID!
    name: String!
    status: CloudContainerStatus!
    purpose: CloudContainerPurpose!
    refId: String
    createdAt: String!
    connectedAt: String
    exitedAt: String
    exitReason: String
  }

  type CloudContainerControlPlane {
    online: Boolean!
    message: String
  }

  enum CloudContainerStatus {
    CREATING
    CONNECTING
    ONLINE
    EXITED
    DESTROYING
    FAILED
  }

  enum CloudContainerPurpose {
    IDLE
    ADMIN_TASK
    WORKFLOW
    SESSION
  }

  extend type Query {
    adminCloudContainers: [CloudContainer!]!
    adminCloudContainerControlPlane: CloudContainerControlPlane!
  }

  extend type Mutation {
    adminStartCloudContainer(purpose: CloudContainerPurpose!): CloudContainer!
    adminDestroyCloudContainer(id: ID!): Boolean!
  }
`;
