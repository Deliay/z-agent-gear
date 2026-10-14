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

export class ProviderService {
  async findAll() {
    const providers = await Provider.find(USER_SCOPE_FILTER).sort({ createdAt: -1 }).lean();
    return providers.map(this.mapProvider.bind(this));
  }

  async findById(id: string) {
    const provider = await Provider.findById(id).lean();
    if (!provider) return null;
    return this.mapProvider(provider);
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

    if (credentialChanged || typeChanged || endpointChanged) {
      const models = await llmApiService.fetchModels(input.type, input.endpoint, effectiveApiKey);

      await Model.deleteMany({ providerId: id });

      if (models.length > 0) {
        const modelDocs = models.map((name, i) => ({
          providerId: new mongoose.Types.ObjectId(id),
          name,
          isCustom: false,
          isEnabled: true,
          sortOrder: i,
          scope: 'user',
        }));
        await Model.insertMany(modelDocs);
      }
    }

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

    return this.mapProvider(provider);
  }

  async delete(id: string) {
    const existing = await Provider.findById(id).lean() as { scope?: string } | null;
    if (!existing) return false;
    if (normalizeScope(existing.scope) !== 'user') {
      throw new Error(GLOBAL_WRITE_FORBIDDEN);
    }

    await Model.deleteMany({ providerId: id });
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
      { providerId: id },
      { isEnabled: provider.isEnabled },
    );

    return this.mapProvider(provider.toObject());
  }

  async batchEnable(ids: string[]) {
    await this.assertNoGlobalProviders(ids);

    const result = await Provider.updateMany(
      { _id: { $in: ids }, ...USER_SCOPE_FILTER },
      { isEnabled: true },
    );

    await Model.updateMany(
      { providerId: { $in: ids }, scope: { $ne: 'global' } },
      { isEnabled: true },
    );

    return { successCount: result.modifiedCount };
  }

  async batchDisable(ids: string[]) {
    await this.assertNoGlobalProviders(ids);

    const result = await Provider.updateMany(
      { _id: { $in: ids }, ...USER_SCOPE_FILTER },
      { isEnabled: false },
    );

    await Model.updateMany(
      { providerId: { $in: ids }, scope: { $ne: 'global' } },
      { isEnabled: false },
    );

    return { successCount: result.modifiedCount };
  }

  async batchDelete(ids: string[]) {
    await this.assertNoGlobalProviders(ids);

    await Model.deleteMany({ providerId: { $in: ids }, scope: { $ne: 'global' } });
    const result = await Provider.deleteMany({ _id: { $in: ids }, ...USER_SCOPE_FILTER });
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

  private maskCredential(value: string): string {
    if (!value) return '';
    // 短凭据整体掩码，避免 first3+last4 泄露（近似）完整原值
    if (value.length <= 8) return '****';
    return value.slice(0, 3) + '****' + value.slice(-4);
  }
}

export const providerService = new ProviderService();
