// 本 schema 与 servers/admin-api/src/models/provider.ts 同步演进
import mongoose from 'mongoose';
import { applyWorkspaceScope } from '../services/workspace-scope.js';

const encryptedCredentialSchema = new mongoose.Schema({
  iv: { type: String, required: true },
  ciphertext: { type: String, required: true },
  tag: { type: String, required: true },
}, { _id: false });

const providerSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  type: { type: String, required: true, enum: ['OpenAI', 'Anthropic'] },
  endpoint: { type: String, required: true },
  credentialType: { type: String, default: 'api_key', enum: ['api_key'] },
  encryptedCredential: { type: encryptedCredentialSchema, required: true },
  isEnabled: { type: Boolean, default: true },
  scope: { type: String, enum: ['user', 'global'], default: 'user', index: true },
  // 多租户二期：scope=user 行归属租户工作区；scope=global 平台内置行恒 null
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null, index: true },
}, { timestamps: true });

// 多租户二期（F3）：user 域唯一性切 `{tenantId,workspaceId,name}`；global 域保留全局同名唯一。
// 旧 `{scope,name}` 唯一索引由迁移 015 删除（先建新 → 再删旧 → 复制）。
providerSchema.index(
  { tenantId: 1, workspaceId: 1, name: 1 },
  { unique: true, name: 'uniq_provider_tenant_workspace_name', partialFilterExpression: { scope: 'user' } },
);
providerSchema.index(
  { name: 1 },
  { unique: true, name: 'uniq_provider_global_name', partialFilterExpression: { scope: 'global' } },
);

// 共享型资源：读 = 当前工作区 ∪ 本租户全局（并放行 scope=global 平台内置行）；写仅当前工作区
applyWorkspaceScope(providerSchema, { shared: true, globalScopeVisible: true });

export const Provider = mongoose.model('Provider', providerSchema);
export type IProvider = mongoose.InferSchemaType<typeof providerSchema>;
