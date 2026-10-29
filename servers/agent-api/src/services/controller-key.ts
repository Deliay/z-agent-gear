import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { ControllerKey } from '../models/controller-key.js';
import { Controller } from '../models/controller.js';
import { cacheKey, evictKeyById, getRawKeyById } from './key-cache.js';
import { actorFilter } from './workspace-context.js';
import { commandService } from './command.js';

const KEY_FORMAT_VERSION = 1;
const BCRYPT_ROUNDS = 10;

export class ControllerKeyService {
  async create(userId: string, input: { name: string; type: string }): Promise<{ key: Record<string, unknown>; rawKey: string }> {
    if (!input.name || input.name.trim().length === 0) {
      throw new Error('Key name is required');
    }

    // Delete any existing unbound key (only one unbound key allowed at a time)
    // 裁决：未绑定 key 的复用/清理按创建者 {userId}（密钥属主语义；机械改 actorFilter 会误删他人未绑定 key）
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
    const keys = await ControllerKey.find({ ...actorFilter(userId), boundControllerId: null }).sort({ createdAt: -1 }).lean();
    const results = await Promise.all(keys.map(async (key) => {
      const id = (key._id as mongoose.Types.ObjectId).toString();
      const rawKey = await getRawKeyById(id);
      return this.mapKey(key, rawKey);
    }));
    return results;
  }

  /**
   * 为云电脑创建标准连接 Key（`type=cloud`，直接绑定预生成的 controllerId）。
   *
   * **不复用 `create`**：`create` 会删除用户现有的未绑定 Key，而云电脑创建不得影响
   * 设置页的本地 Key；该 Key 已绑定控制器，不会出现在「未绑定 Key」列表。
   */
  async createForCloudHost(
    userId: string,
    controllerId: string,
    name: string,
  ): Promise<{ key: Record<string, unknown>; rawKey: string }> {
    const randomBytes = crypto.randomBytes(24);
    const rawKey = `zag_k_${KEY_FORMAT_VERSION}_${randomBytes.toString('hex')}`;
    const keyHash = await bcrypt.hash(rawKey, BCRYPT_ROUNDS);
    const keyPrefix = rawKey.slice(0, 8);

    const keyDoc = await ControllerKey.create({
      userId: new mongoose.Types.ObjectId(userId),
      name: name || 'Cloud Host',
      type: 'cloud',
      keyHash,
      keyPrefix,
      status: 'active',
      boundControllerId: new mongoose.Types.ObjectId(controllerId),
    });

    await cacheKey(rawKey, {
      keyId: keyDoc._id.toString(),
      keyHash,
      userId,
      status: 'active',
      type: 'cloud',
    });

    return { key: this.mapKey(keyDoc.toObject()), rawKey };
  }

  async rename(id: string, userId: string, name: string): Promise<Record<string, unknown> | null> {
    const key = await ControllerKey.findOneAndUpdate(
      { _id: id, ...actorFilter(userId) },
      { name },
      { returnDocument: 'after' },
    ).lean();
    if (!key) return null;
    return this.mapKey(key);
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const result = await ControllerKey.findOneAndDelete({ _id: id, ...actorFilter(userId) });
    if (result) {
      await evictKeyById(id);
    }
    return result !== null;
  }

  async regenerate(controllerId: string, userId: string): Promise<{ key: Record<string, unknown>; rawKey: string } | null> {
    // Find the controller and verify ownership
    const controller = await Controller.findOne({ _id: controllerId, ...actorFilter(userId) });
    if (!controller) return null;

    const keyId = controller.keyId.toString();

    // Find the existing key
    const existingKey = await ControllerKey.findOne({ _id: keyId, ...actorFilter(userId) }).lean();
    if (!existingKey) return null;

    // Generate new key
    const randomBytes = crypto.randomBytes(24);
    const rawKey = `zag_k_${KEY_FORMAT_VERSION}_${randomBytes.toString('hex')}`;
    const keyHash = await bcrypt.hash(rawKey, BCRYPT_ROUNDS);
    const keyPrefix = rawKey.slice(0, 8);

    // Update the key record with new hash
    const updatedKey = await ControllerKey.findOneAndUpdate(
      { _id: keyId, ...actorFilter(userId) },
      {
        keyHash,
        keyPrefix,
        lastUsedAt: new Date(),
      },
      { returnDocument: 'after' },
    ).lean();

    if (!updatedKey) return null;

    // Update controller status to unbound (needs re-registration)
    await Controller.findOneAndUpdate(
      { _id: controllerId, ...actorFilter(userId) },
      { status: 'unbound' },
    );

    // Evict old key from cache and cache new key
    const evicted = await evictKeyById(keyId);
    if (!evicted) {
      throw new Error('Failed to revoke old key from cache. The key may still be usable until cache expires.');
    }
    await cacheKey(rawKey, {
      keyId,
      keyHash,
      userId,
      status: 'active',
      type: existingKey.type,
    });

    // Send shutdown command to the controller using the old key
    // handleShutdown will check if controller is 'unbound' and won't delete it
    await commandService.sendShutdown(keyId);

    return {
      key: this.mapKey(updatedKey),
      rawKey,
    };
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
