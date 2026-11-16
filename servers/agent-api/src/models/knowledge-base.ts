import mongoose from 'mongoose';

/**
 * 知识库（集合 `knowledgebases`，agent-api 唯一写方；需求 #495 / 提案 D2）。
 *
 * - 工作区级资源，但**有意不挂任何 scope 插件**（`applyTenantScope` / `applyWorkspaceScope`）：
 *   需求要求全局工作区的知识库对同租户其他工作区成员可见，且**读写按库自身权限模式放行**
 *   （全局工作区 developer 亦可写），与插件「写只回当前工作区 + 全局 developer 只读拦截」
 *   语义冲突；可见性/权限由 `services/knowledge-base-access.ts` 纯函数显式判定。
 * - `tenantId` / `workspaceId` 为 String，由服务层显式写入与过滤（无 userId 主维度）。
 * - `name`：trim 后 1..64，**工作区内唯一**——唯一索引 `uniq_knowledge_base_workspace_name`
 *   `{workspaceId,name}`，与迁移 028 同名同键（服务层预检 + E11000 收敛）。
 * - `permissionMode`：四档 `NONE | READ_ONLY | UPDATE_ONLY | FULL_ACCESS`，创建时按工作区类型
 *   落默认值（global → READ_ONLY、normal → NONE）。
 */
export const KNOWLEDGE_BASE_PERMISSION_MODES = [
  'NONE',
  'READ_ONLY',
  'UPDATE_ONLY',
  'FULL_ACCESS',
] as const;

export type KnowledgeBasePermissionMode = (typeof KNOWLEDGE_BASE_PERMISSION_MODES)[number];

const knowledgeBaseSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    workspaceId: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    permissionMode: {
      type: String,
      enum: KNOWLEDGE_BASE_PERMISSION_MODES,
      required: true,
    },
    createdBy: { type: String, required: true },
  },
  { collection: 'knowledgebases', timestamps: true },
);

// 工作区内名称唯一（迁移 028 同名同键；服务层预检 + E11000 兜底）
knowledgeBaseSchema.index(
  { workspaceId: 1, name: 1 },
  { unique: true, name: 'uniq_knowledge_base_workspace_name' },
);
// 列表查询：本租户 × 工作区并集（本工作区 ∪ 全局工作区）
knowledgeBaseSchema.index(
  { tenantId: 1, workspaceId: 1 },
  { name: 'knowledge_base_tenant_workspace' },
);

export const KnowledgeBase = mongoose.model('KnowledgeBase', knowledgeBaseSchema);
export type IKnowledgeBase = mongoose.InferSchemaType<typeof knowledgeBaseSchema>;
