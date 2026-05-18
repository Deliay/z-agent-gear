import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { ControllerKey } from '../models/controller-key.js';
import { cacheKey, evictKeyById } from './key-cache.js';

const KEY_FORMAT_VERSION = 1;
const BCRYPT_ROUNDS = 10;

export class ControllerKeyService {
  async create(userId: string, input: { name: string; type: string }): Promise<{ key: Record<string, unknown>; rawKey: string }> {
    const randomBytes = crypto.randomBytes(24);
    const rawKey = `zag_k_${KEY_FORMAT_VERSION}_${randomBytes.toString('hex')}`;
    const keyHash = await bcrypt.hash(rawKey, BCRYPT_ROUNDS);
    const keyPrefix = rawKey.slice(0, 8);

    const keyDoc = await ControllerKey.create({
      userId: new mongoose.Types.ObjectId(userId),
      name: input.name,
      type: input.type,
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
    const keys = await ControllerKey.find({ userId }).sort({ createdAt: -1 }).lean();
    return keys.map(this.mapKey.bind(this));
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

  async revoke(id: string, userId: string): Promise<boolean> {
    const result = await ControllerKey.findOneAndUpdate(
      { _id: id, userId, status: 'active' },
      { status: 'revoked' },
    );
    if (result) {
      await evictKeyById(id);
    }
    return result !== null;
  }

  private mapKey(key: Record<string, unknown>): Record<string, unknown> {
    return {
      id: (key._id as mongoose.Types.ObjectId).toString(),
      name: key.name,
      type: key.type,
      keyPrefix: key.keyPrefix,
      status: key.status,
      lastUsedAt: key.lastUsedAt ? (key.lastUsedAt as Date).toISOString() : null,
      createdAt: (key.createdAt as Date).toISOString(),
      updatedAt: (key.updatedAt as Date).toISOString(),
    };
  }
}

export const controllerKeyService = new ControllerKeyService();
