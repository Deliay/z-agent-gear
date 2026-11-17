import { Model, type IModel } from '../models/model.js';
import { Provider } from '../models/provider.js';
import { GLOBAL_WRITE_FORBIDDEN } from './constants.js';
import { decrypt } from './crypto.js';
import { getWorkspaceContext } from './workspace-context.js';
import { llmApiService, type ProviderType } from './llm-api.js';
import mongoose from 'mongoose';

// 用户可用模型：scope=user 全量（兼容无 scope 字段的存量数据）∪ scope=global 且启用的全局模型
const AVAILABLE_MODELS_FILTER: mongoose.QueryFilter<IModel> = {
  $or: [
    { scope: 'user' },
    { scope: { $exists: false } },
    { scope: 'global', isEnabled: true },
  ],
};

function normalizeScope(value: unknown): 'user' | 'global' {
  return value === 'global' ? 'global' : 'user';
}

/**
 * 最长上下文统一校验出口（与 admin-api `assertContextLength` 同口径，D14）：
 * - `null/undefined` → `null`（未设置）
 * - 其余必须是 `>= 1` 的整数（拒绝 0/负数/小数/字符串）
 */
export function assertContextLength(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('contextLength must be a positive integer');
  }
  return value;
}

export class ModelService {
  /**
   * 平台模型库来源快照（会话内模型来源推断用）：
   * 与 AVAILABLE_MODELS_FILTER 同口径，只取 name/scope，避免 N+1 全量文档读取。
   */
  async listSourceLibrary(): Promise<Array<{ name: string; scope: 'user' | 'global' }>> {
    const models = await Model.find(AVAILABLE_MODELS_FILTER)
      .select('name scope')
      .lean();
    return models.map((model) => ({
      name: String(model.name),
      scope: normalizeScope(model.scope),
    }));
  }

  async findAll() {
    const models = await Model.find(AVAILABLE_MODELS_FILTER)
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();
    return models.map(this.mapModel.bind(this));
  }

  async findByProviderId(providerId: string) {
    const models = await Model.find({ providerId, ...AVAILABLE_MODELS_FILTER })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();
    return models.map(this.mapModel.bind(this));
  }

  async createCustom(input: { providerId: string; name: string; contextLength?: number | null }) {
    // 名称必须非空（trim 后），避免写入纯空白模型名
    const name = (input.name ?? '').trim();
    if (!name) {
      throw new Error('Model name is required');
    }
    // 显式非法值必须在任何 DB 读写之前拒绝
    let contextLength = assertContextLength(input.contextLength);

    // 校验目标供应商存在且为用户自己的（scope=user）配置，防止向全局供应商挂模型
    if (!mongoose.Types.ObjectId.isValid(input.providerId)) {
      throw new Error('Provider not found');
    }
    const provider = await Provider.findOne({ _id: input.providerId })
      .select('scope workspaceId type endpoint encryptedCredential')
      .lean() as {
        scope?: string;
        workspaceId?: unknown;
        type?: string;
        endpoint?: string;
        encryptedCredential?: { iv: string; ciphertext: string; tag: string } | null;
      } | null;
    if (!provider) {
      throw new Error('Provider not found');
    }
    if (normalizeScope(provider.scope) !== 'user') {
      throw new Error(GLOBAL_WRITE_FORBIDDEN);
    }
    const context = getWorkspaceContext();
    if (context && provider.workspaceId && String(provider.workspaceId) !== context.id) {
      // 共享读允许看到全局工作区供应商；写（挂模型）仅限当前工作区自身
      throw new Error('Provider not found');
    }

    // 缺省（undefined）才尽力补全：前端显式传 null（用户清空）时不得打上游（D15）
    if (input.contextLength === undefined) {
      contextLength = await this.resolveUpstreamContextLength(provider, name);
    }

    const maxSort = await Model.findOne({ providerId: input.providerId })
      .sort({ sortOrder: -1 })
      .select('sortOrder')
      .lean();

    const model = await Model.create({
      providerId: new mongoose.Types.ObjectId(input.providerId),
      name,
      isCustom: true,
      isEnabled: true,
      sortOrder: (maxSort?.sortOrder ?? -1) + 1,
      scope: 'user',
      contextLength,
      ...(context ? { tenantId: context.tenantId, workspaceId: context.id } : {}),
    });

    return this.mapModel(model.toObject());
  }

  /**
   * 尽力从供应商上游元数据补全同名模型的上下文长度。
   * 任何失败/超时/未命中 → null（不阻塞创建，D15）。
   */
  private async resolveUpstreamContextLength(
    provider: {
      type?: string;
      endpoint?: string;
      encryptedCredential?: { iv: string; ciphertext: string; tag: string } | null;
    },
    name: string,
  ): Promise<number | null> {
    if (!provider.encryptedCredential || !provider.type || !provider.endpoint) return null;
    try {
      const apiKey = decrypt(provider.encryptedCredential);
      const entries = await llmApiService.fetchModelCatalog(
        provider.type as ProviderType,
        provider.endpoint,
        apiKey,
      );
      const match = entries.find((entry) => entry.name === name);
      const value = match?.contextLength;
      return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * 编辑用户自有模型的上下文长度（D14）。
   *
   * `findOneAndUpdate({_id, scope:{$ne:'global'}})`：写插件（workspace-scope）会把过滤收敛到
   * 当前工作区，跨工作区/他人/global/不存在统一命中空 → `Model not found`（不泄露存在性）。
   */
  async updateContextLength(id: string, value: unknown) {
    const contextLength = assertContextLength(value);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error('Model not found');
    }
    const model = await Model.findOneAndUpdate(
      { _id: id, scope: { $ne: 'global' } },
      { $set: { contextLength } },
      { returnDocument: 'after', lean: true },
    );
    if (!model) {
      throw new Error('Model not found');
    }
    return this.mapModel(model as unknown as Record<string, unknown>);
  }

  async delete(id: string) {
    const model = await Model.findById(id);
    if (!model) return null;

    if (normalizeScope((model as { scope?: string }).scope) !== 'user') {
      throw new Error(GLOBAL_WRITE_FORBIDDEN);
    }

    if (!model.isCustom) return null;

    const mapped = this.mapModel(model.toObject());
    await Model.deleteOne({ _id: id });
    return mapped;
  }

  async toggle(id: string) {
    const model = await Model.findById(id);
    if (!model) return null;

    if (normalizeScope((model as { scope?: string }).scope) !== 'user') {
      throw new Error(GLOBAL_WRITE_FORBIDDEN);
    }

    const provider = await Provider.findOne({ _id: model.providerId }).lean() as { isEnabled: boolean } | null;
    if (!provider || !provider.isEnabled) {
      return null;
    }

    model.isEnabled = !model.isEnabled;
    await model.save();

    return this.mapModel(model.toObject());
  }

  async updateSortOrder(ids: string[]) {
    if (ids.length === 0) return [];

    // 拒绝重复 id：重复会让 bulkWrite 的最终 sortOrder 依赖写入顺序，产生歧义
    if (new Set(ids).size !== ids.length) {
      throw new Error('Duplicate model ids in sort order');
    }

    // 若包含全局模型，明确拒绝（与单条写路径文案一致），不再静默跳过
    const global = await Model.findOne({ _id: { $in: ids }, scope: 'global' })
      .select('_id')
      .lean();
    if (global) {
      throw new Error(GLOBAL_WRITE_FORBIDDEN);
    }

    // 所有 id 必须存在且为用户模型，避免对不存在 id 静默跳过造成排序错乱
    const userOnly: mongoose.QueryFilter<IModel> = { scope: { $ne: 'global' } };
    const existing = await Model.find({ _id: { $in: ids }, ...userOnly })
      .select('_id')
      .lean();
    if (existing.length !== ids.length) {
      throw new Error('One or more models not found');
    }

    const updates = ids.map((id, index) => ({
      updateOne: {
        filter: { _id: id, ...userOnly },
        update: { sortOrder: index },
      },
    }));

    await Model.bulkWrite(updates);

    const models = await Model.find({ _id: { $in: ids }, ...userOnly })
      .sort({ sortOrder: 1 })
      .lean();

    return models.map(this.mapModel.bind(this));
  }

  private mapModel(model: Record<string, unknown>) {
    return {
      id: (model._id as mongoose.Types.ObjectId).toString(),
      providerId: (model.providerId as mongoose.Types.ObjectId).toString(),
      name: model.name as string,
      isCustom: model.isCustom as boolean,
      isEnabled: model.isEnabled as boolean,
      sortOrder: model.sortOrder as number,
      scope: normalizeScope(model.scope),
      workspaceId: model.workspaceId ? String(model.workspaceId) : null,
      contextLength:
        typeof model.contextLength === 'number' && Number.isFinite(model.contextLength)
          ? model.contextLength
          : null,
      pricing: model.pricing
        ? {
            inputPerMillion: Number((model.pricing as Record<string, unknown>).inputPerMillion ?? 0) / 100,
            cachedInputPerMillion:
              Number((model.pricing as Record<string, unknown>).cachedInputPerMillion ?? 0) / 100,
            outputPerMillion: Number((model.pricing as Record<string, unknown>).outputPerMillion ?? 0) / 100,
            isBillable: (model.pricing as Record<string, unknown>).isBillable !== false,
          }
        : null,
      createdAt: (model.createdAt as Date).toISOString(),
      updatedAt: (model.updatedAt as Date).toISOString(),
    };
  }
}

export const modelService = new ModelService();
