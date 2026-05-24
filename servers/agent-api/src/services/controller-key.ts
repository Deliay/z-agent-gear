import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { ControllerKey } from '../models/controller-key.js';
import { cacheKey, evictKeyById, getRawKeyById } from './key-cache.js';

const KEY_FORMAT_VERSION = 1;
const BCRYPT_ROUNDS = 10;

export class ControllerKeyService {
  async create(userId: string, input: { name: string; type: string }): Promise<{ key: Record<string, unknown>; rawKey: string }> {
    if (!input.name || input.name.trim().length === 0) {
      throw new Error('Key name is required');
    }

    // Delete any existing unbound key (only one unbound key allowed at a time)
    const existingUnbound = await ControllerKey.findOne({ userId, boundControllerId: null });
    if (existingUnbound) {
      await evictKeyById(existingUnbound._id.toString());
      await ControllerKey.deleteOne({ _id: existingUnbound._id });
    }

    const randomBytes = crypto.randomBytes(24);
    const rawKey = `zag_k_${KEY_FORMAT_VERSION}_${randomBytes.toString('hex')}`;
    const keyHash = await bcrypt.hash(rawKey, BCRYPT_ROUNDS);
    const keyPrefix = rawKey.slice(0, 8);

    const keyDoc = await ControllerKey.create({
      userId: new mongoose.Types.ObjectId(userId),
      name: input.name,
      type: input.type as 'local' | 'cloud' | 'github',
      keyHash,
      keyPrefix,
      status: 'active',
    });

    await cacheKey(rawKey, {
      keyId: keyDoc._id.toString(),
      keyHash,
      userId,
      status: 'active',
      type: input.type,
    });

    return {
      key: this.mapKey(keyDoc.toObject()),
      rawKey,
    };
  }

  async findAllByUser(userId: string): Promise<Record<string, unknown>[]> {
    // Only return unbound keys (bound keys are represented by controllers)
    const keys = await ControllerKey.find({ userId, boundControllerId: null }).sort({ createdAt: -1 }).lean();
    const results = await Promise.all(keys.map(async (key) => {
      const id = (key._id as mongoose.Types.ObjectId).toString();
      const rawKey = await getRawKeyById(id);
      return this.mapKey(key, rawKey);
    }));
    return results;
  }

  async rename(id: string, userId: string, name: string): Promise<Record<string, unknown> | null> {
    const key = await ControllerKey.findOneAndUpdate(
      { _id: id, userId },
      { name },
      { new: true },
    ).lean();
    if (!key) return null;
    return this.mapKey(key);
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const result = await ControllerKey.findOneAndDelete({ _id: id, userId });
    if (result) {
      await evictKeyById(id);
    }
    return result !== null;
  }

  private mapKey(key: Record<string, unknown>, rawKey?: string | null): Record<string, unknown> {
    return {
      id: (key._id as mongoose.Types.ObjectId).toString(),
      name: key.name,
      type: key.type,
      keyPrefix: key.keyPrefix,
      status: key.status,
      rawKey: rawKey ?? null,
      lastUsedAt: key.lastUsedAt ? (key.lastUsedAt as Date).toISOString() : null,
      createdAt: (key.createdAt as Date).toISOString(),
      updatedAt: (key.updatedAt as Date).toISOString(),
    };
  }
}

export const controllerKeyService = new ControllerKeyService();
