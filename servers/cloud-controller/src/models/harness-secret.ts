import mongoose from 'mongoose';

/**
 * 云电脑运行期 secret 持久化（集合 `cloudcontainersecrets`）。
 *
 * 背景（Issue #446）：secret 原先仅存于 cloud-controller 进程内存，重启/滚动发布后
 * 在线容器仍在、但 secret 丢失，运行期安装 harness 工作负载必然失败。现改为：
 * - 容器创建时随 `secretStore.put` 同步落库；
 * - cloud-controller 启动时加载到进程内 `SecretStore`；
 * - 容器进入终态（exited/failed/destroying）时删除。
 *
 * 安全约束：本集合只由 cloud-controller 读写；不得在列表/详情响应或日志中回显字段值。
 * 记录只与容器生命周期同寿，历史残留由启动加载时的对账清理。
 */
const harnessSecretSchema = new mongoose.Schema(
  {
    /** 所属容器 ID（`cloudcontainers._id` 的字符串口径），一个容器至多一条。 */
    containerId: { type: String, required: true },
    /** 标准连接（controller-api）端点。 */
    hostEndpoint: { type: String, required: true },
    /** 标准连接使用的 ControllerKey 明文。 */
    hostKey: { type: String, required: true },
    /** 运行专用模型 Key 明文。 */
    modelApiKey: { type: String, required: true },
    /** 模型网关地址。 */
    modelBaseUrl: { type: String, required: true },
    /** 模型 ID JSON 数组字符串。 */
    modelIds: { type: String, required: true },
    /** 模型 ID → 最长上下文 JSON object 字符串；无上下文信息时为 null。 */
    modelContextLengths: { type: String, default: null },
    /** 默认工作区。 */
    defaultWorkspace: { type: String, required: true },
  },
  { timestamps: true, collection: 'cloudcontainersecrets' },
);

// 一容器至多一条：索引名与迁移 004 保持一致（避免 autoIndex 与迁移重复建索引）。
harnessSecretSchema.index(
  { containerId: 1 },
  { unique: true, name: 'uniq_harness_secret_container' },
);

export const HarnessSecret = mongoose.model('HarnessSecret', harnessSecretSchema);
