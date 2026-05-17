import { Model } from '../models/model.js';
import mongoose from 'mongoose';

export class ModelService {
  async findAll() {
    const models = await Model.find().sort({ sortOrder: 1, createdAt: 1 }).lean();
    return models.map(this.mapModel.bind(this));
  }

  async findByProviderId(providerId: string) {
    const models = await Model.find({ providerId })
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
    });

    return this.mapModel(model.toObject());
  }

  async toggle(id: string) {
    const model = await Model.findById(id);
    if (!model) return null;

    const provider = await mongoose.model('Provider').findById(model.providerId).lean() as { isEnabled: boolean } | null;
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
        filter: { _id: id },
        update: { sortOrder: index },
      },
    }));

    await Model.bulkWrite(updates);

    const models = await Model.find({ _id: { $in: ids } })
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
      createdAt: (model.createdAt as Date).toISOString(),
      updatedAt: (model.updatedAt as Date).toISOString(),
    };
  }
}

export const modelService = new ModelService();
