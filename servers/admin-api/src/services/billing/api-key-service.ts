import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { BillingApiKey } from '../../models/billing-api-key.js';
import { documentId } from './id.js';
import { cloudHostKeyMutex } from './keyed-mutex.js';

export const API_KEY_PREFIX = 'zag_sk_';
export const API_KEY_PREFIX_LENGTH = 16; // zag_sk_ (7) + 9 hex
const SALT_ROUNDS = 10;

export type BillingApiKeyScope = 'account' | 'cloud_host';

export interface BillingApiKeyDTO {
  id: string;
  name: string;
  keyPrefix: string;
  status: string;
  scope: BillingApiKeyScope;
  cloudHostId: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface VerifiedApiKey {
  id: string;
  accountId: string;
  ownerType: 'front_user' | 'admin_user';
  ownerId: string;
  name: string;
  scope: BillingApiKeyScope;
  cloudHostId: string | null;
  expiresAt: Date | null;
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
    scope?: string | null;
    cloudHostId?: unknown;
    expiresAt?: Date | null;
    lastUsedAt?: Date | null;
    createdAt?: Date;
  };
  return {
    id: documentId(doc),
    name: d.name,
    keyPrefix: d.keyPrefix,
    status: d.status,
    scope: d.scope === 'cloud_host' ? 'cloud_host' : 'account',
    cloudHostId: d.cloudHostId ? String(d.cloudHostId) : null,
    expiresAt: d.expiresAt ?? null,
    lastUsedAt: d.lastUsedAt ?? null,
    createdAt: d.createdAt ?? new Date(),
  };
}

function normalizeScope(scope: unknown): BillingApiKeyScope {
  return scope === 'cloud_host' ? 'cloud_host' : 'account';
}

/** API Key：生成（明文仅一次）、校验（前缀索引 + bcrypt）、吊销、归属校验。 */
export class ApiKeyService {
  async create(input: {
    accountId: string;
    ownerType: 'front_user' | 'admin_user';
    ownerId: string;
    name: string;
    scope?: BillingApiKeyScope;
    cloudHostId?: string | null;
  }): Promise<{ apiKey: BillingApiKeyDTO; secret: string }> {
    const name = input.name.trim();
    if (!name) throw new Error('API Key 名称不能为空');
    const scope = normalizeScope(input.scope);

    let cloudHostId: string | null = null;
    if (scope === 'cloud_host') {
      if (!input.cloudHostId || !mongoose.isValidObjectId(input.cloudHostId)) {
        throw new Error('云电脑 ID 非法');
      }
      cloudHostId = input.cloudHostId;
    }

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
      scope,
      cloudHostId,
      // 云电脑 Key 随容器生命周期回收（stop/terminal/delete + 对账兜底），不再写固定有效期。
      expiresAt: null,
    });
    return { apiKey: toDTO(doc), secret };
  }

  /**
   * 云电脑运行专用 Key：
   * - **先铸造成功再撤销同宿主旧 active Key**，避免铸造失败导致旧 Key 提前失效；
   * - B-4：同一 `cloudHostId` 的「铸造 + 撤销」由 `cloudHostKeyMutex` 串行化，避免并发轮换时
   *   两次铸造互相撤销导致全部失效；
   * - **无固定有效期**：Key 随容器回收（宿主非 `RUNNING`/删除/缺失由网关实时拒绝并与对账撤销），
   *   不再使用容器 TTL 作为到期时间。
   */
  async createCloudHostScopedKey(input: {
    accountId: string;
    ownerType: 'front_user' | 'admin_user';
    ownerId: string;
    name: string;
    cloudHostId: string;
  }): Promise<{ apiKey: BillingApiKeyDTO; secret: string }> {
    if (!mongoose.isValidObjectId(input.cloudHostId)) throw new Error('云电脑 ID 非法');
    return cloudHostKeyMutex.runExclusive(`cloudHost:${input.cloudHostId}`, async () => {
      const created = await this.create({
        ...input,
        scope: 'cloud_host',
        cloudHostId: input.cloudHostId,
      });
      await BillingApiKey.updateMany(
        {
          scope: 'cloud_host',
          cloudHostId: input.cloudHostId,
          status: 'active',
          _id: { $ne: new mongoose.Types.ObjectId(created.apiKey.id) },
        },
        { $set: { status: 'revoked' } },
      );
      return created;
    });
  }

  /** 校验完整 Key：前缀索引定位 + bcrypt 比对；成功后更新 lastUsedAt。过期 Key 视为无效。 */
  async verify(secret: string): Promise<VerifiedApiKey | null> {
    if (!secret.startsWith(API_KEY_PREFIX) || secret.length < API_KEY_PREFIX_LENGTH) return null;
    const keyPrefix = secret.slice(0, API_KEY_PREFIX_LENGTH);
    const candidates = await BillingApiKey.find({ keyPrefix, status: 'active' }).limit(5);
    for (const candidate of candidates) {
      if (!(await bcrypt.compare(secret, candidate.keyHash))) continue;
      const expiresAt = (candidate as unknown as { expiresAt?: Date | null }).expiresAt ?? null;
      if (expiresAt && expiresAt.getTime() <= Date.now()) continue;
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
        scope: normalizeScope((candidate as unknown as { scope?: string }).scope),
        cloudHostId: (candidate as unknown as { cloudHostId?: unknown }).cloudHostId
          ? String((candidate as unknown as { cloudHostId?: unknown }).cloudHostId)
          : null,
        expiresAt,
      };
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

  /** 内部撤销（不要求 owner）：幂等；未知 id 抛 ApiKeyNotFoundError 供上层映射 404。 */
  async revokeById(id: string): Promise<BillingApiKeyDTO> {
    if (!mongoose.isValidObjectId(id)) throw new ApiKeyNotFoundError();
    const doc = await BillingApiKey.findOneAndUpdate(
      { _id: id },
      { $set: { status: 'revoked' } },
      { new: true },
    );
    if (!doc) throw new ApiKeyNotFoundError();
    return toDTO(doc);
  }

  /** 按云电脑撤销全部 active Key（停止/删除/终态兜底）：幂等，返回本次实际撤销数量。 */
  async revokeByCloudHost(cloudHostId: string): Promise<number> {
    if (!mongoose.isValidObjectId(cloudHostId)) return 0;
    const result = await BillingApiKey.updateMany(
      { scope: 'cloud_host', cloudHostId, status: 'active' },
      { $set: { status: 'revoked' } },
    );
    return result.modifiedCount ?? 0;
  }
}

export const apiKeyService = new ApiKeyService();
