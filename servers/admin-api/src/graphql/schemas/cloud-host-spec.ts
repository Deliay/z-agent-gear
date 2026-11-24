export const cloudHostSpecTypeDefs = `#graphql
  """容器规格（admin-api 唯一写方）"""
  type AdminCloudSpec {
    id: ID!
    name: String!
    cpu: Int!
    memoryGi: Int!
    ephemeralStorageGi: Int!
    unlimited: Boolean!
    whitelistEnabled: Boolean!
    allowedTenantIds: [ID!]!
    isPreset: Boolean!
    presetKey: String
    createdAt: String!
    updatedAt: String!
  }

  input AdminCloudSpecInput {
    name: String!
    cpu: Int!
    memoryGi: Int!
    ephemeralStorageGi: Int!
    whitelistEnabled: Boolean!
    allowedTenantIds: [ID!]!
  }

  extend type Query {
    # keyword 名称模糊检索（trim 后空 = 不过滤）；page/pageSize 分页（pageSize 上限 100，缺省 20）
    adminCloudSpecs(keyword: String, page: Int, pageSize: Int): [AdminCloudSpec!]!
    adminCloudSpec(id: ID!): AdminCloudSpec
  }

  extend type Mutation {
    adminCreateCloudSpec(input: AdminCloudSpecInput!): AdminCloudSpec!
    adminUpdateCloudSpec(id: ID!, input: AdminCloudSpecInput!): AdminCloudSpec!
    adminDeleteCloudSpec(id: ID!): Boolean!
  }
`;
