// 严格对齐 contracts/cloud-storage.graphql（含 cloud-host 的 CloudStorageSummary）
export const cloudStorageTypeDefs = `#graphql
  enum CloudStorageStatus {
    CREATING
    IDLE
    ATTACHING
    ATTACHED
    ARCHIVING
    ARCHIVED
    DESTROYING
    DESTROYED
    CREATE_FAILED
  }

  enum CloudStorageArchiveStatus {
    PENDING
    RUNNING
    SUCCEEDED
    FAILED
  }

  type CloudStorageArchive {
    id: ID!
    fileName: String!
    status: CloudStorageArchiveStatus!
    cloudHostId: ID
    cloudHostName: String
    usageBytes: Float
    startedAt: String
    finishedAt: String
    failureReason: String
    sourcePvcReleased: Boolean
  }

  type CloudStorageCreator {
    id: ID!
    name: String!
  }

  type CloudStorageArchiveSpace {
    capacityGi: Int!
    usedGi: Float
  }

  type CloudStorage {
    id: ID!
    name: String!
    sizeGi: Int!
    status: CloudStorageStatus!
    usageBytes: Float
    usageUpdatedAt: String
    hourlyCredits: Float!
    hourlyCreditsFull: Float!
    hourlyCreditsArchived: Float!
    createdBy: CloudStorageCreator!
    createdAt: String!
    attachedCloudHostId: ID
    attachedCloudHostName: String
    attachedAt: String
    currentArchive: CloudStorageArchive
    archiveSpace: CloudStorageArchiveSpace!
    failureReason: String
    destroyedAt: String
  }

  # 云电脑挂载的云存储摘要（见 contracts/cloud-host.graphql）
  type CloudStorageSummary {
    id: ID!
    name: String!
    sizeGi: Int!
    status: CloudStorageStatus!
    usageBytes: Float
    hourlyCredits: Float!
  }

  type CloudStoragePriceTier {
    label: String!
    amountCredits: Float!
  }

  type CloudStorageRateQuote {
    hourlyCredits: Float!
    tiers: [CloudStoragePriceTier!]!
  }

  type CloudStorageBillingQuote {
    sizeGi: Int!
    full: CloudStorageRateQuote!
    archived: CloudStorageRateQuote!
    availableBalance: Float
  }

  # 能力开关（CLOUD_STORAGE_ENABLED）；false 时前端隐藏入口，服务端仍为权威拦截
  type CloudStorageCapabilities {
    enabled: Boolean!
  }

  input CreateCloudStorageInput {
    # trim 后 1~64；同一工作区唯一（已销毁/创建失败释放名称）
    name: String!
    # 1~30（Gi）
    sizeGi: Int!
  }

  extend type Query {
    cloudStorages(onlyAttachable: Boolean = false, includeDestroyed: Boolean = false): [CloudStorage!]!
    cloudStorage(id: ID!): CloudStorage
    # 不传 sizeGi 时按默认 10Gi 报价
    cloudStorageBillingQuote(sizeGi: Int): CloudStorageBillingQuote!
    cloudStorageCapabilities: CloudStorageCapabilities!
  }

  extend type Mutation {
    createCloudStorage(input: CreateCloudStorageInput!): CloudStorage!
    destroyCloudStorage(id: ID!): CloudStorage!
    retryCloudStorageArchive(id: ID!): CloudStorage!
    refreshCloudStorageUsage(id: ID!): CloudStorage!
  }
`;
