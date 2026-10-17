// 与 contracts/admin-cloud-workload.graphql 逐字段一致。
// 鉴权：所有 Query/Mutation 需 admin JWT；未认证 UNAUTHENTICATED（由 resolver 守卫抛出）。
// 校验：name trim 后 1~64 且唯一；initScript/postScript 各自 ≤16 KiB 且至少其一非空。
export const cloudWorkloadTypeDefs = `#graphql
  type CloudWorkload {
    id: ID!
    name: String!
    initScript: String
    postScript: String
    createdAt: String!
    updatedAt: String!
  }

  input CreateCloudWorkloadInput {
    name: String!
    initScript: String
    postScript: String
  }

  input UpdateCloudWorkloadInput {
    name: String
    initScript: String
    postScript: String
  }

  enum CloudWorkloadLogPhase {
    INIT
    POST
  }

  enum CloudWorkloadLogStatus {
    PENDING
    RUNNING
    SUCCESS
    FAILED
    TIMEOUT
  }

  type CloudWorkloadLog {
    id: ID!
    containerId: ID!
    workloadId: ID!
    workloadName: String!
    phase: CloudWorkloadLogPhase!
    status: CloudWorkloadLogStatus!
    script: String!
    exitCode: Int
    log: String!
    startedAt: String
    finishedAt: String
  }

  extend type Query {
    adminCloudWorkloads: [CloudWorkload!]!
    adminCloudContainerWorkloadLogs(containerId: ID!): [CloudWorkloadLog!]!
  }

  extend type Mutation {
    adminCreateCloudWorkload(input: CreateCloudWorkloadInput!): CloudWorkload!
    adminUpdateCloudWorkload(id: ID!, input: UpdateCloudWorkloadInput!): CloudWorkload!
    adminDeleteCloudWorkload(id: ID!): Boolean!
  }
`;
