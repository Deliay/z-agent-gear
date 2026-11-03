import { BaseImage } from '../models/base-image.js';

export class BaseImageService {
  async list() {
    const images = await BaseImage.find().sort({ updatedAt: -1 }).lean();
    return images.map(this.mapImage.bind(this));
  }

  async get(id: string) {
    const image = await BaseImage.findById(id).lean();
    if (!image) return null;
    return this.mapImage(image);
  }

  async create(input: { name: string; description?: string; dockerfile: string }) {
    if (!input.name || input.name.trim().length === 0) {
      throw new Error('Base image name is required');
    }

    // 重名由 E11000 唯一索引错误抛出，resolver 统一映射
    const image = await BaseImage.create({
      name: input.name,
      description: input.description,
      dockerfile: input.dockerfile,
    });

    return this.mapImage(image.toObject());
  }

  async update(id: string, input: { name: string; description?: string; dockerfile: string }) {
    if (!input.name || input.name.trim().length === 0) {
      throw new Error('Base image name is required');
    }

    const image = await BaseImage.findByIdAndUpdate(
      id,
      {
        name: input.name,
        description: input.description,
        dockerfile: input.dockerfile,
      },
      { returnDocument: 'after', lean: true },
    );
    if (!image) return null;

    return this.mapImage(image);
  }

  async delete(id: string) {
    const result = await BaseImage.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }

  private mapImage(image: Record<string, unknown>) {
    return {
      id: (image._id as { toString(): string }).toString(),
      name: image.name as string,
      description: (image.description as string | undefined) ?? null,
      dockerfile: image.dockerfile as string,
      createdAt: (image.createdAt as Date).toISOString(),
      updatedAt: (image.updatedAt as Date).toISOString(),
    };
  }
}

export const baseImageService = new BaseImageService();
