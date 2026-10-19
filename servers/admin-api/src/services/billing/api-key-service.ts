import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { BillingApiKey } from '../../models/billing-api-key.js';
import { documentId } from './id.js';

export const API_KEY_PREFIX = 'zag_sk_';
export const API_KEY_PREFIX_LENGTH = 16; // zag_sk_ (7) + 9 hex
const SALT_ROUNDS = 10;

export interface BillingApiKeyDTO {
  id: string;
  name: string;
  keyPrefix: string;
  status: string;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface VerifiedApiKey {
  id: string;
  accountId: string;
  ownerType: 'front_user' | 'admin_user';
  ownerId: string;
  name: string;
}

/** API Key 不存在或无权操作（P3：类型化错误，供上层稳定映射 404，不靠中文串匹配）。 */
export class ApiKeyNotFoundError extends Error {
  constructor() {
    super('API Key 不存在或无权操作');
    this.name = 'ApiKeyNotFoundError';
  }
}

function toDTO(doc: unknown): BillingApiKeyDTO {
  const d = doc as {
    name: string;
    keyPrefix: string;
    status: string;
    lastUsedAt?: Date | null;
    createdAt?: Date;
  };
  return {
    id: documentId(doc),
    name: d.name,
    keyPrefix: d.keyPrefix,
    status: d.status,
    lastUsedAt: d.lastUsedAt ?? null,
    createdAt: d.createdAt ?? new Date(),
  };
}

/** API Key：生成（明文仅一次）、校验（前缀索引 + bcrypt）、吊销、归属校验。 */
export class ApiKeyService {
  async create(input: {
    accountId: string;
    ownerType: 'front_user' | 'admin_user';
    ownerId: string;
    name: string;
  }): Promise<{ apiKey: BillingApiKeyDTO; secret: string }> {
    const name = input.name.trim();
    if (!name) throw new Error('API Key 名称不能为空');
    const secret = `${API_KEY_PREFIX}${crypto.randomBytes(16).toString('hex')}`;
    const keyPrefix = secret.slice(0, API_KEY_PREFIX_LENGTH);
    const keyHash = await bcrypt.hash(secret, SALT_ROUNDS);
    const doc = await BillingApiKey.create({
      accountId: input.accountId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      name,
      keyPrefix,
      keyHash,
      status: 'active',
    });
    return { apiKey: toDTO(doc), secret };
  }

  /** 校验完整 Key：前缀索引定位 + bcrypt 比对；成功后更新 lastUsedAt。 */
  async verify(secret: string): Promise<VerifiedApiKey | null> {
    if (!secret.startsWith(API_KEY_PREFIX) || secret.length < API_KEY_PREFIX_LENGTH) return null;
    const keyPrefix = secret.slice(0, API_KEY_PREFIX_LENGTH);
    const candidates = await BillingApiKey.find({ keyPrefix, status: 'active' }).limit(5);
    for (const candidate of candidates) {
      if (await bcrypt.compare(secret, candidate.keyHash)) {
        await BillingApiKey.updateOne(
          { _id: candidate._id },
          { $set: { lastUsedAt: new Date() } },
        );
        return {
          id: documentId(candidate),
          accountId: String(candidate.accountId),
          ownerType: candidate.ownerType as 'front_user' | 'admin_user',
          ownerId: candidate.ownerId,
          name: candidate.name,
        };
      }
    }
    return null;
  }

  async list(ownerType: 'front_user' | 'admin_user', ownerId: string): Promise<BillingApiKeyDTO[]> {
    const docs = await BillingApiKey.find({ ownerType, ownerId }).sort({ createdAt: -1 });
    return docs.map((doc) => toDTO(doc));
  }

  async revoke(
    id: string,
    owner: { ownerType: 'front_user' | 'admin_user'; ownerId: string },
  ): Promise<BillingApiKeyDTO> {
    // A12：非法 ObjectId 直接按「不存在」处理，避免 CastError 500。
    if (!mongoose.isValidObjectId(id)) throw new ApiKeyNotFoundError();
    const doc = await BillingApiKey.findOneAndUpdate(
      { _id: id, ownerType: owner.ownerType, ownerId: owner.ownerId },
      { $set: { status: 'revoked' } },
      { new: true },
    );
    if (!doc) throw new ApiKeyNotFoundError();
    return toDTO(doc);
  }
}

export const apiKeyService = new ApiKeyService();
