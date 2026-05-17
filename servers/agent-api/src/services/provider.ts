import { Provider } from '../models/provider.js';
import { Model } from '../models/model.js';
import { encrypt, decrypt } from './crypto.js';
import { llmApiService, ProviderType } from './llm-api.js';
import mongoose from 'mongoose';

export class ProviderService {
  async findAll() {
    const providers = await Provider.find().sort({ createdAt: -1 }).lean();
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
    const encrypted = encrypt(input.credentialValue);

    const models = await llmApiService.fetchModels(input.type, input.endpoint, input.credentialValue);

    const provider = await Provider.create({
      name: input.name,
      type: input.type,
      endpoint: input.endpoint,
      credentialType: (input.credentialType || 'api_key') as 'api_key',
      encryptedCredential: encrypted,
    });

    if (models.length > 0) {
      const modelDocs = models.map((name, i) => ({
        providerId: provider._id,
        name,
        isCustom: false,
        isEnabled: true,
        sortOrder: i,
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
    const existingProvider = await Provider.findById(id).lean() as { encryptedCredential: { iv: string; ciphertext: string; tag: string }; type: string; endpoint: string } | null;
    if (!existingProvider) return null;

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
    await Model.deleteMany({ providerId: id });
    const result = await Provider.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }

  async toggle(id: string) {
    const provider = await Provider.findById(id);
    if (!provider) return null;

    provider.isEnabled = !provider.isEnabled;
    await provider.save();

    await Model.updateMany(
      { providerId: id },
      { isEnabled: provider.isEnabled },
    );

    return this.mapProvider(provider.toObject());
  }

  async batchEnable(ids: string[]) {
    const result = await Provider.updateMany(
      { _id: { $in: ids } },
      { isEnabled: true },
    );

    await Model.updateMany(
      { providerId: { $in: ids } },
      { isEnabled: true },
    );

    return { successCount: result.modifiedCount };
  }

  async batchDisable(ids: string[]) {
    const result = await Provider.updateMany(
      { _id: { $in: ids } },
      { isEnabled: false },
    );

    await Model.updateMany(
      { providerId: { $in: ids } },
      { isEnabled: false },
    );

    return { successCount: result.modifiedCount };
  }

  async batchDelete(ids: string[]) {
    await Model.deleteMany({ providerId: { $in: ids } });
    const result = await Provider.deleteMany({ _id: { $in: ids } });
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
      createdAt: (provider.createdAt as Date).toISOString(),
      updatedAt: (provider.updatedAt as Date).toISOString(),
    };
  }

  private maskCredential(value: string): string {
    if (value.length <= 7) {
      return value.slice(0, 3) + '****' + value.slice(-4);
    }
    return value.slice(0, 3) + '****' + value.slice(-4);
  }
}

export const providerService = new ProviderService();
