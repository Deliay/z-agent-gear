export const harnessConfigTypeDefs = `#graphql
  # Harness 类型（与 contracts/cloud-host.graphql 的 HarnessType 同枚举值）
  enum HarnessType {
    OPENCODE
    KIMI_CODE
    DEEPSEEK_HARNESS
  }

  # Harness 平台配置（harnessconfigs 集合，admin-api 唯一写方，agent-api 只读镜像）
  # - 三种 Harness 固定存在；未配置行以默认 /compact 归一返回
  # - compactCommand：trim 后 1~64 字符且以 / 开头，非法返回 invalid compact command
  type HarnessConfig {
    harnessType: HarnessType!
    compactCommand: String!
    updatedAt: String!
  }

  extend type Query {
    # 全量 Harness 配置（未配置的 Harness 以默认 /compact 归一返回）
    adminHarnessConfigs: [HarnessConfig!]!
  }

  extend type Mutation {
    # 按 harnessType upsert；compactCommand 校验失败返回 invalid compact command
    upsertHarnessConfig(harnessType: HarnessType!, compactCommand: String!): HarnessConfig!
  }
`;
