import { Model } from '../models/model.js';
import { Provider } from '../models/provider.js';
import mongoose from 'mongoose';

/** admin-api 全链路强制操作全局（scope=global）配置 */
const GLOBAL_SCOPE: 'global' = 'global';

export class ModelService {
  async findAll() {
    const models = await Model.find({ scope: GLOBAL_SCOPE }).sort({ sortOrder: 1, createdAt: 1 }).lean();
    return models.map(this.mapModel.bind(this));
  }

  async findByProviderId(providerId: string) {
    const models = await Model.find({ providerId, scope: GLOBAL_SCOPE })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();
    return models.map(this.mapModel.bind(this));
  }

  async createCustom(input: { providerId: string; name: string }) {
    // 校验目标供应商存在且为全局 scope，防止把 global 模型挂到 user 供应商或悬空 providerId
    if (!mongoose.Types.ObjectId.isValid(input.providerId)) {
      throw new Error('Provider not found');
    }
    const provider = await Provider.findOne({ _id: input.providerId, scope: GLOBAL_SCOPE }).lean();
    if (!provider) {
      throw new Error('Provider not found');
    }

    const maxSort = await Model.findOne({ providerId: input.providerId, scope: GLOBAL_SCOPE })
      .sort({ sortOrder: -1 })
      .select('sortOrder')
      .lean();

    const model = await Model.create({
      providerId: new mongoose.Types.ObjectId(input.providerId),
      name: input.name,
      isCustom: true,
      isEnabled: true,
      sortOrder: (maxSort?.sortOrder ?? -1) + 1,
      scope: GLOBAL_SCOPE,
    });

    return this.mapModel(model.toObject());
  }

  async delete(id: string) {
    const model = await Model.findById(id);
    if (!model) return null;
    if (model.scope !== GLOBAL_SCOPE) return null;
    if (!model.isCustom) return null;

    const mapped = this.mapModel(model.toObject());
    await Model.deleteOne({ _id: id });
    return mapped;
  }

  async toggle(id: string) {
    const model = await Model.findById(id);
    if (!model) return null;
    if (model.scope !== GLOBAL_SCOPE) return null;

    const provider = await Provider.findOne({ _id: model.providerId, scope: GLOBAL_SCOPE }).lean() as { isEnabled: boolean } | null;
    if (!provider || !provider.isEnabled) {
      return null;
    }

    model.isEnabled = !model.isEnabled;
    await model.save();

    return this.mapModel(model.toObject());
  }

  async updateSortOrder(ids: string[]) {
    const updates = ids.map((id, index) => ({
      updateOne: {
        filter: { _id: id, scope: GLOBAL_SCOPE },
        update: { sortOrder: index },
      },
    }));

    await Model.bulkWrite(updates);

    const models = await Model.find({ _id: { $in: ids }, scope: GLOBAL_SCOPE })
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
      scope: model.scope as string,
      createdAt: (model.createdAt as Date).toISOString(),
      updatedAt: (model.updatedAt as Date).toISOString(),
    };
  }
}

export const modelService = new ModelService();
