import { Provider, type IProvider } from '../models/provider.js';
import { Model } from '../models/model.js';
import { encrypt, decrypt } from './crypto.js';
import { llmApiService, ProviderType } from './llm-api.js';
import { GLOBAL_WRITE_FORBIDDEN } from './constants.js';
import mongoose from 'mongoose';

// 查询条件：仅 user scope，兼容无 scope 字段的存量数据
const USER_SCOPE_FILTER: mongoose.QueryFilter<IProvider> = {
  $or: [{ scope: 'user' }, { scope: { $exists: false } }],
};

function normalizeScope(value: unknown): 'user' | 'global' {
  return value === 'global' ? 'global' : 'user';
}

/**
 * 过滤非法 ObjectId，避免原始 id 直入 `$in` 触发 CastError（建议 E，与 admin-api 问题 27 一致）。
 * 批量写不存在的合法 ObjectId 由 Mongo 自然匹配为空，无需额外处理。
 */
function validObjectIds(ids: string[]): string[] {
  return ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
}

export class ProviderService {
  async findAll() {
    const providers = await Provider.find(USER_SCOPE_FILTER).sort({ createdAt: -1 }).lean();
    return providers.map(this.mapProvider.bind(this));
  }

  /**
   * `Model.provider` 专用：返回不含凭据/内部地址的供应商摘要。
   * 通过 `select('-encryptedCredential')` 避免密文进入内存；返回结构不含
   * endpoint / credentialType / credentialValue，用户侧不可见全局供应商内部细节。
   */
  async findSummaryById(id: string) {
    const provider = await Provider.findById(id).select('-encryptedCredential').lean();
    if (!provider) return null;
    return this.mapProviderSummary(provider);
  }

  async create(input: {
    name: string;
    type: ProviderType;
    endpoint: string;
    credentialType: string;
    credentialValue: string;
  }) {
    if (!input.name || input.name.trim().length === 0) {
      throw new Error('Provider name is required');
    }

    const encrypted = encrypt(input.credentialValue);

    const models = await llmApiService.fetchModels(input.type, input.endpoint, input.credentialValue);

    const provider = await Provider.create({
      name: input.name,
      type: input.type,
      endpoint: input.endpoint,
      credentialType: (input.credentialType || 'api_key') as 'api_key',
      encryptedCredential: encrypted,
      scope: 'user',
    });

    if (models.length > 0) {
      const modelDocs = models.map((name, i) => ({
        providerId: provider._id,
        name,
        isCustom: false,
        isEnabled: true,
        sortOrder: i,
        scope: 'user',
      }));
      await Model.insertMany(modelDocs);
    }

    return this.mapProvider(provider.toObject());
  }

  async update(id: string, input: {
    name: string;
    type: ProviderType;
    endpoint: string;
    credentialType: string;
    credentialValue: string;
  }) {
    const existingProvider = await Provider.findById(id).lean() as { encryptedCredential: { iv: string; ciphertext: string; tag: string }; type: string; endpoint: string; scope?: string } | null;
    if (!existingProvider) return null;

    // 用户侧只允许修改自己的（user scope）配置，全局配置需在管理后台修改
    if (normalizeScope(existingProvider.scope) !== 'user') {
      throw new Error(GLOBAL_WRITE_FORBIDDEN);
    }

    const hasNewCredential = input.credentialValue.trim().length > 0;
    const encrypted = hasNewCredential
      ? encrypt(input.credentialValue)
      : existingProvider.encryptedCredential;

    const effectiveApiKey = hasNewCredential ? input.credentialValue : decrypt(existingProvider.encryptedCredential);

    const credentialChanged = hasNewCredential;
    const typeChanged = input.type !== existingProvider.type;
    const endpointChanged = input.endpoint !== existingProvider.endpoint;
    const needsResync = credentialChanged || typeChanged || endpointChanged;

    // 先取远端模型列表（连通性/网络错误在落库前抛出，供应商与模型均保持原状）
    const fetchedModels = needsResync
      ? await llmApiService.fetchModels(input.type, input.endpoint, effectiveApiKey)
      : null;

    // 先写供应商：供应商写入失败（如改名撞唯一键）时不触碰模型，避免模型被先删后失败导致丢数据（问题 48）。
    const provider = await Provider.findByIdAndUpdate(
      id,
      {
        name: input.name,
        type: input.type,
        endpoint: input.endpoint,
        credentialType: (input.credentialType || 'api_key') as 'api_key',
        encryptedCredential: encrypted,
      },
      { new: true, lean: true },
    );
    if (!provider) return null;

    // 供应商落库成功后再重同步模型（standalone Mongo 无事务，尽力而为；失败不影响 provider 写入）。
    if (fetchedModels) {
      await this.syncSyncedModels(id, fetchedModels);
    }

    return this.mapProvider(provider);
  }

  /**
   * 重同步 API 自动同步模型（问题 48）：
   * - 保留用户自定义模型（isCustom: true）；与自定义模型**同名**的 API 模型跳过，
   *   避免 `(providerId, name)` 唯一索引冲突（该索引不含 isCustom 维度）导致 E11000；
   * - 以 `(providerId, name)` 为键 **upsert**，替代 delete+insert，重同步幂等且无「先删后失败」的丢数据窗口；
   * - 仅删除「不在期望集合内」的自动同步模型，保留自定义模型与全局模型（scope 过滤与 batch* 对齐）。
   */
  private async syncSyncedModels(providerId: string, fetchedNames: string[]) {
    const customModels = await Model.find({
      providerId,
      isCustom: true,
      scope: { $ne: 'global' },
    })
      .select('name')
      .lean();
    const customNames = new Set(customModels.map((m) => (m as { name: string }).name));

    // 去重：同名重复会让同一 bulkWrite 批次产生冲突的 upsert
    const desired = [...new Set(fetchedNames)].filter((name) => !customNames.has(name));
    const objectId = new mongoose.Types.ObjectId(providerId);

    if (desired.length > 0) {
      const ops = desired.map((name, sortOrder) => ({
        updateOne: {
          filter: { providerId: objectId, name },
          update: {
            $set: { isCustom: false, isEnabled: true, sortOrder, scope: 'user' as const },
          },
          upsert: true,
        },
      }));
      await Model.bulkWrite(ops);
    }

    await Model.deleteMany({
      providerId,
      isCustom: false,
      scope: { $ne: 'global' },
      name: { $nin: desired },
    });
  }

  async delete(id: string) {
    const existing = await Provider.findById(id).lean() as { scope?: string } | null;
    if (!existing) return false;
    if (normalizeScope(existing.scope) !== 'user') {
      throw new Error(GLOBAL_WRITE_FORBIDDEN);
    }

    // 级联删除用户模型；scope 过滤与 batch* 对齐，避免误删全局模型。
    await Model.deleteMany({ providerId: id, scope: { $ne: 'global' } });
    const result = await Provider.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }

  async toggle(id: string) {
    const provider = await Provider.findById(id);
    if (!provider) return null;

    if (normalizeScope((provider as { scope?: string }).scope) !== 'user') {
      throw new Error(GLOBAL_WRITE_FORBIDDEN);
    }

    provider.isEnabled = !provider.isEnabled;
    await provider.save();

    await Model.updateMany(
      { providerId: id, scope: { $ne: 'global' } },
      { isEnabled: provider.isEnabled },
    );

    return this.mapProvider(provider.toObject());
  }

  async batchEnable(ids: string[]) {
    const validIds = validObjectIds(ids);
    if (validIds.length === 0) return { successCount: 0 };

    await this.assertNoGlobalProviders(validIds);

    const result = await Provider.updateMany(
      { _id: { $in: validIds }, ...USER_SCOPE_FILTER },
      { isEnabled: true },
    );

    await Model.updateMany(
      { providerId: { $in: validIds }, scope: { $ne: 'global' } },
      { isEnabled: true },
    );

    return { successCount: result.modifiedCount };
  }

  async batchDisable(ids: string[]) {
    const validIds = validObjectIds(ids);
    if (validIds.length === 0) return { successCount: 0 };

    await this.assertNoGlobalProviders(validIds);

    const result = await Provider.updateMany(
      { _id: { $in: validIds }, ...USER_SCOPE_FILTER },
      { isEnabled: false },
    );

    await Model.updateMany(
      { providerId: { $in: validIds }, scope: { $ne: 'global' } },
      { isEnabled: false },
    );

    return { successCount: result.modifiedCount };
  }

  async batchDelete(ids: string[]) {
    const validIds = validObjectIds(ids);
    if (validIds.length === 0) return { successCount: 0 };

    await this.assertNoGlobalProviders(validIds);

    await Model.deleteMany({ providerId: { $in: validIds }, scope: { $ne: 'global' } });
    const result = await Provider.deleteMany({ _id: { $in: validIds }, ...USER_SCOPE_FILTER });
    return { successCount: result.deletedCount };
  }

  /** 批量写路径若包含全局供应商，明确拒绝（与单条 update/delete/toggle 行为一致） */
  private async assertNoGlobalProviders(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const global = await Provider.findOne({ _id: { $in: ids }, scope: 'global' })
      .select('_id')
      .lean();
    if (global) {
      throw new Error(GLOBAL_WRITE_FORBIDDEN);
    }
  }

  private mapProvider(provider: Record<string, unknown>) {
    const id = (provider._id as mongoose.Types.ObjectId).toString();
    const encrypted = provider.encryptedCredential as { iv: string; ciphertext: string; tag: string };
    const plaintext = decrypt(encrypted);
    const masked = this.maskCredential(plaintext);

    return {
      id,
      name: provider.name as string,
      type: provider.type as string,
      endpoint: provider.endpoint as string,
      credentialType: provider.credentialType as string,
      credentialValue: masked,
      isEnabled: provider.isEnabled as boolean,
      scope: normalizeScope(provider.scope),
      createdAt: (provider.createdAt as Date).toISOString(),
      updatedAt: (provider.updatedAt as Date).toISOString(),
    };
  }

  private mapProviderSummary(provider: Record<string, unknown>) {
    return {
      id: (provider._id as mongoose.Types.ObjectId).toString(),
      name: provider.name as string,
      type: provider.type as string,
      isEnabled: provider.isEnabled as boolean,
      scope: normalizeScope(provider.scope),
    };
  }

  private maskCredential(value: string): string {
    if (!value) return '';
    // 短凭据整体掩码，避免 first3+last4 泄露（近似）完整原值
    if (value.length <= 8) return '****';
    return value.slice(0, 3) + '****' + value.slice(-4);
  }
}

export const providerService = new ProviderService();
