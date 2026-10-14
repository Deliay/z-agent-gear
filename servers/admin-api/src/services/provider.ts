import { Provider } from '../models/provider.js';
import { Model } from '../models/model.js';
import { encrypt, decrypt } from './crypto.js';
import { llmApiService, ProviderType } from './llm-api.js';
import mongoose from 'mongoose';

/** admin-api 全链路强制操作全局（scope=global）配置 */
const GLOBAL_SCOPE = 'global';

/**
 * 供应商连通性校验失败对外统一文案。
 * openai/@anthropic SDK 的失败形态多样（"Connection error."、"Request timed out."、401 等），
 * 因此不做错误串匹配，任何 fetchModels 抛错都归一化为本文案（PRD 3.5）。
 */
export const PROVIDER_CONNECTIVITY_ERROR = '供应商连通性测试失败，请检查 API 地址和凭据是否正确';

export class ProviderService {
  async findAll() {
    const providers = await Provider.find({ scope: GLOBAL_SCOPE }).sort({ createdAt: -1 }).lean();
    return providers.map(this.mapProvider.bind(this));
  }

  async findById(id: string) {
    const provider = await Provider.findOne({ _id: id, scope: GLOBAL_SCOPE }).lean();
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

    // 连通性校验：任何失败（地址/凭据/超时/网络）统一归一化，失败则不落库
    let models: string[] = [];
    try {
      models = await llmApiService.fetchModels(input.type, input.endpoint, input.credentialValue);
    } catch {
      throw new Error(PROVIDER_CONNECTIVITY_ERROR);
    }

    const encrypted = encrypt(input.credentialValue);

    const provider = await Provider.create({
      name: input.name,
      type: input.type,
      endpoint: input.endpoint,
      credentialType: (input.credentialType || 'api_key') as 'api_key',
      encryptedCredential: encrypted,
      scope: GLOBAL_SCOPE,
    });

    if (models.length > 0) {
      const modelDocs = models.map((name, i) => ({
        providerId: provider._id,
        name,
        isCustom: false,
        isEnabled: true,
        sortOrder: i,
        scope: GLOBAL_SCOPE,
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
    const existingProvider = await Provider.findOne({ _id: id, scope: GLOBAL_SCOPE }).lean() as {
      encryptedCredential: { iv: string; ciphertext: string; tag: string };
      type: string;
      endpoint: string;
    } | null;
    if (!existingProvider) return null;

    const hasNewCredential = input.credentialValue.trim().length > 0;
    const encrypted = hasNewCredential
      ? encrypt(input.credentialValue)
      : existingProvider.encryptedCredential;

    const effectiveApiKey = hasNewCredential ? input.credentialValue : decrypt(existingProvider.encryptedCredential);

    const credentialChanged = hasNewCredential;
    const typeChanged = input.type !== existingProvider.type;
    const endpointChanged = input.endpoint !== existingProvider.endpoint;
    const needsResync = credentialChanged || typeChanged || endpointChanged;

    // 连通性校验先于任何写入，失败则整体不落库
    let models: string[] = [];
    if (needsResync) {
      try {
        models = await llmApiService.fetchModels(input.type, input.endpoint, effectiveApiKey);
      } catch {
        throw new Error(PROVIDER_CONNECTIVITY_ERROR);
      }
    }

    // 先更新供应商：唯一索引冲突（改名撞名）在此抛出，此时模型尚未改动，状态保持一致
    const provider = await Provider.findOneAndUpdate(
      { _id: id, scope: GLOBAL_SCOPE },
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

    // 再级联重同步模型
    if (needsResync) {
      await Model.deleteMany({ providerId: id, scope: GLOBAL_SCOPE });
      if (models.length > 0) {
        const modelDocs = models.map((name, i) => ({
          providerId: new mongoose.Types.ObjectId(id),
          name,
          isCustom: false,
          isEnabled: true,
          sortOrder: i,
          scope: GLOBAL_SCOPE,
        }));
        await Model.insertMany(modelDocs);
      }
    }

    return this.mapProvider(provider);
  }

  async delete(id: string) {
    await Model.deleteMany({ providerId: id, scope: GLOBAL_SCOPE });
    const result = await Provider.deleteOne({ _id: id, scope: GLOBAL_SCOPE });
    return result.deletedCount > 0;
  }

  async toggle(id: string) {
    const provider = await Provider.findOne({ _id: id, scope: GLOBAL_SCOPE });
    if (!provider) return null;

    provider.isEnabled = !provider.isEnabled;
    await provider.save();

    await Model.updateMany(
      { providerId: id, scope: GLOBAL_SCOPE },
      { isEnabled: provider.isEnabled },
    );

    return this.mapProvider(provider.toObject());
  }

  async batchEnable(ids: string[]) {
    const result = await Provider.updateMany(
      { _id: { $in: ids }, scope: GLOBAL_SCOPE },
      { isEnabled: true },
    );

    await Model.updateMany(
      { providerId: { $in: ids }, scope: GLOBAL_SCOPE },
      { isEnabled: true },
    );

    return { successCount: result.modifiedCount };
  }

  async batchDisable(ids: string[]) {
    const result = await Provider.updateMany(
      { _id: { $in: ids }, scope: GLOBAL_SCOPE },
      { isEnabled: false },
    );

    await Model.updateMany(
      { providerId: { $in: ids }, scope: GLOBAL_SCOPE },
      { isEnabled: false },
    );

    return { successCount: result.modifiedCount };
  }

  async batchDelete(ids: string[]) {
    await Model.deleteMany({ providerId: { $in: ids }, scope: GLOBAL_SCOPE });
    const result = await Provider.deleteMany({ _id: { $in: ids }, scope: GLOBAL_SCOPE });
    return { successCount: result.deletedCount };
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
      scope: provider.scope as string,
      createdAt: (provider.createdAt as Date).toISOString(),
      updatedAt: (provider.updatedAt as Date).toISOString(),
    };
  }

  private maskCredential(value: string): string {
    if (!value) return '';
    // 短凭据直接整体掩码，避免 first3+last4 拼出（近似）完整原值
    if (value.length <= 8) return '****';
    return value.slice(0, 3) + '****' + value.slice(-4);
  }
}

export const providerService = new ProviderService();
