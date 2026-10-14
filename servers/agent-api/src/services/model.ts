import { Model, type IModel } from '../models/model.js';
import mongoose from 'mongoose';

const GLOBAL_WRITE_FORBIDDEN = '全局配置请在管理后台修改';

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

export class ModelService {
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

  async createCustom(input: { providerId: string; name: string }) {
    const maxSort = await Model.findOne({ providerId: input.providerId })
      .sort({ sortOrder: -1 })
      .select('sortOrder')
      .lean();

    const model = await Model.create({
      providerId: new mongoose.Types.ObjectId(input.providerId),
      name: input.name,
      isCustom: true,
      isEnabled: true,
      sortOrder: (maxSort?.sortOrder ?? -1) + 1,
      scope: 'user',
    });

    return this.mapModel(model.toObject());
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

    const provider = await mongoose.model('Provider').findById(model.providerId).lean() as { isEnabled: boolean } | null;
    if (!provider || !provider.isEnabled) {
      return null;
    }

    model.isEnabled = !model.isEnabled;
    await model.save();

    return this.mapModel(model.toObject());
  }

  async updateSortOrder(ids: string[]) {
    // 仅排序用户自己的模型（scope != global，兼容无 scope 字段的存量数据），不触碰全局模型
    const userOnly: mongoose.QueryFilter<IModel> = { scope: { $ne: 'global' } };
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
      createdAt: (model.createdAt as Date).toISOString(),
      updatedAt: (model.updatedAt as Date).toISOString(),
    };
  }
}

export const modelService = new ModelService();
