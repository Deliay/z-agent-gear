import { Provider } from '../models/provider.js';
import { Model } from '../models/model.js';
import { encrypt, decrypt } from './crypto.js';
import { llmApiService, ProviderType } from './llm-api.js';
import mongoose from 'mongoose';

/** admin-api 全链路强制操作全局（scope=global）配置 */
const GLOBAL_SCOPE = 'global';

/**
 * 供应商连通性校验失败对外统一文案。
 * openai/@anthropic SDK 的失败形态多样（"Connection error."、"Request timed out."、401 等），
 * 因此不做错误串匹配，任何 fetchModels 抛错都归一化为本文案（PRD 3.5）。
 */
export const PROVIDER_CONNECTIVITY_ERROR = '供应商连通性测试失败，请检查 API 地址和凭据是否正确';

/** 非法 ObjectId 视为不存在，避免 CastError 透出 GraphQL（问题 27）。 */
function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

/**
 * 过滤批量写 id 中的非法 ObjectId（问题 55，与 agent-api `validObjectIds` 对齐）。
 * 合法但不存在的 id 由 Mongo 自然匹配为空，无需额外处理。
 */
function validObjectIds(ids: string[]): string[] {
  return ids.filter((id) => isValidObjectId(id));
}

/**
 * 探测当前连接是否为支持事务的部署（副本集/分片集群）。
 * 单节点 mongod（含 Aspire 本地 Mongo 容器）不支持事务，直接走非事务路径，
 * 避免 `withTransaction` 触发 "does not support retryable writes" 报错。
 */
async function supportsTransactions(): Promise<boolean> {
  if (mongoose.connection.readyState !== 1) return false;
  const db = mongoose.connection.db;
  if (!db) return false;
  try {
    const hello = (await db.admin().command({ hello: 1 })) as {
      setName?: string;
      msg?: string;
    };
    return Boolean(hello.setName) || hello.msg === 'isdbgrid';
  } catch {
    return false;
  }
}

/** 单节点 mongod 不支持事务时驱动抛出的错误形态 */
function isTransactionUnsupportedError(err: unknown): boolean {
  const message = (err as Error)?.message ?? '';
  return /Transaction numbers are only allowed|replica set member or mongos|does not support transactions|transactions are not supported|does not support retryable writes|retryWrites=false|IllegalOperation/i.test(
    message,
  );
}

/**
 * 尽力而为的事务包裹（问题 5）：多步写（供应商 + 模型）在同一事务内提交，失败整体回滚。
 * - 未连接 Mongo（单测）：直接非事务执行；
 * - 事务不可用（单节点 mongod / 无副本集）：降级为非事务执行，行为与旧实现一致；
 * - 事务可用：以 `mongoose.startSession().withTransaction` 原子提交。
 */
async function runWithOptionalTransaction<T>(
  fn: (session: mongoose.ClientSession | undefined) => Promise<T>,
): Promise<T> {
  if (!(await supportsTransactions())) {
    return fn(undefined);
  }

  let session: mongoose.ClientSession | undefined;
  try {
    session = await mongoose.startSession();
  } catch {
    return fn(undefined);
  }

  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } catch (err) {
    if (isTransactionUnsupportedError(err)) {
      return fn(undefined);
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

export class ProviderService {
  async findAll() {
    const providers = await Provider.find({ scope: GLOBAL_SCOPE }).sort({ createdAt: -1 }).lean();
    return providers.map(this.mapProvider.bind(this));
  }

  async findById(id: string) {
    if (!isValidObjectId(id)) return null;
    const provider = await Provider.findOne({ _id: id, scope: GLOBAL_SCOPE }).lean();
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
    if (!input.name || input.name.trim().length === 0) {
      throw new Error('Provider name is required');
    }

    // 连通性校验：任何失败（地址/凭据/超时/网络）统一归一化，失败则不落库。
    // 后台不再自动导入模型：探测结果丢弃，模型由管理员通过「导入模型」手动导入。
    try {
      await llmApiService.fetchModels(input.type, input.endpoint, input.credentialValue);
    } catch {
      throw new Error(PROVIDER_CONNECTIVITY_ERROR);
    }

    const encrypted = encrypt(input.credentialValue);

    return runWithOptionalTransaction(async (session) => {
      const provider = session
        ? (await Provider.create([{
          name: input.name,
          type: input.type,
          endpoint: input.endpoint,
          credentialType: (input.credentialType || 'api_key') as 'api_key',
          encryptedCredential: encrypted,
          scope: GLOBAL_SCOPE,
        }], { session }))[0]
        : await Provider.create({
          name: input.name,
          type: input.type,
          endpoint: input.endpoint,
          credentialType: (input.credentialType || 'api_key') as 'api_key',
          encryptedCredential: encrypted,
          scope: GLOBAL_SCOPE,
        });

      return this.mapProvider(provider.toObject());
    });
  }

  async update(id: string, input: {
    name: string;
    type: ProviderType;
    endpoint: string;
    credentialType: string;
    credentialValue: string;
  }) {
    // 与 create 一致校验名称（问题 21），避免写入空名供应商
    if (!input.name || input.name.trim().length === 0) {
      throw new Error('Provider name is required');
    }
    if (!isValidObjectId(id)) return null;

    const existingProvider = await Provider.findOne({ _id: id, scope: GLOBAL_SCOPE }).lean() as {
      encryptedCredential: { iv: string; ciphertext: string; tag: string };
      type: string;
      endpoint: string;
    } | null;
    if (!existingProvider) return null;

    const hasNewCredential = input.credentialValue.trim().length > 0;
    const encrypted = hasNewCredential
      ? encrypt(input.credentialValue)
      : existingProvider.encryptedCredential;

    const effectiveApiKey = hasNewCredential ? input.credentialValue : decrypt(existingProvider.encryptedCredential);

    const credentialChanged = hasNewCredential;
    const typeChanged = input.type !== existingProvider.type;
    const endpointChanged = input.endpoint !== existingProvider.endpoint;
    // needsConnectivityCheck 仅决定是否探测连通性；后台更新供应商不再触发模型重同步
    const needsConnectivityCheck = credentialChanged || typeChanged || endpointChanged;

    // 连通性校验先于任何写入，失败则整体不落库；探测结果丢弃（后台不再自动同步模型）
    if (needsConnectivityCheck) {
      try {
        await llmApiService.fetchModels(input.type, input.endpoint, effectiveApiKey);
      } catch {
        throw new Error(PROVIDER_CONNECTIVITY_ERROR);
      }
    }

    return runWithOptionalTransaction(async (session) => {
      const provider = await Provider.findOneAndUpdate(
        { _id: id, scope: GLOBAL_SCOPE },
        {
          name: input.name,
          type: input.type,
          endpoint: input.endpoint,
          credentialType: (input.credentialType || 'api_key') as 'api_key',
          encryptedCredential: encrypted,
        },
        session ? { new: true, lean: true, session } : { new: true, lean: true },
      );
      if (!provider) return null;

      return this.mapProvider(provider);
    });
  }

  /**
   * 读取并解密全局供应商连接信息（导入/拉取上游模型清单时使用）。
   * 供应商不存在或 scope 非 global 时返回 null。
   */
  async getDecryptedConnection(id: string) {
    if (!isValidObjectId(id)) return null;
    const provider = await Provider.findOne({ _id: id, scope: GLOBAL_SCOPE }).lean() as {
      type: ProviderType;
      endpoint: string;
      encryptedCredential: { iv: string; ciphertext: string; tag: string };
    } | null;
    if (!provider) return null;
    return {
      type: provider.type,
      endpoint: provider.endpoint,
      apiKey: decrypt(provider.encryptedCredential),
    };
  }

  async delete(id: string) {
    if (!isValidObjectId(id)) return false;
    return runWithOptionalTransaction(async (session) => {
      if (session) {
        await Model.deleteMany({ providerId: id, scope: GLOBAL_SCOPE }, { session });
      } else {
        await Model.deleteMany({ providerId: id, scope: GLOBAL_SCOPE });
      }
      const result = session
        ? await Provider.deleteOne({ _id: id, scope: GLOBAL_SCOPE }, { session })
        : await Provider.deleteOne({ _id: id, scope: GLOBAL_SCOPE });
      return result.deletedCount > 0;
    });
  }

  async toggle(id: string) {
    if (!isValidObjectId(id)) return null;
    const provider = await Provider.findOne({ _id: id, scope: GLOBAL_SCOPE });
    if (!provider) return null;

    provider.isEnabled = !provider.isEnabled;
    await provider.save();

    await Model.updateMany(
      { providerId: id, scope: GLOBAL_SCOPE },
      { isEnabled: provider.isEnabled },
    );

    return this.mapProvider(provider.toObject());
  }

  async batchEnable(ids: string[]) {
    const validIds = validObjectIds(ids);
    if (validIds.length === 0) return { successCount: 0 };

    const result = await Provider.updateMany(
      { _id: { $in: validIds }, scope: GLOBAL_SCOPE },
      { isEnabled: true },
    );

    await Model.updateMany(
      { providerId: { $in: validIds }, scope: GLOBAL_SCOPE },
      { isEnabled: true },
    );

    return { successCount: result.modifiedCount };
  }

  async batchDisable(ids: string[]) {
    const validIds = validObjectIds(ids);
    if (validIds.length === 0) return { successCount: 0 };

    const result = await Provider.updateMany(
      { _id: { $in: validIds }, scope: GLOBAL_SCOPE },
      { isEnabled: false },
    );

    await Model.updateMany(
      { providerId: { $in: validIds }, scope: GLOBAL_SCOPE },
      { isEnabled: false },
    );

    return { successCount: result.modifiedCount };
  }

  async batchDelete(ids: string[]) {
    const validIds = validObjectIds(ids);
    if (validIds.length === 0) return { successCount: 0 };

    await Model.deleteMany({ providerId: { $in: validIds }, scope: GLOBAL_SCOPE });
    const result = await Provider.deleteMany({ _id: { $in: validIds }, scope: GLOBAL_SCOPE });
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
      scope: provider.scope as string,
      createdAt: (provider.createdAt as Date).toISOString(),
      updatedAt: (provider.updatedAt as Date).toISOString(),
    };
  }

  private maskCredential(value: string): string {
    if (!value) return '';
    // 短凭据直接整体掩码，避免 first3+last4 拼出（近似）完整原值
    if (value.length <= 8) return '****';
    return value.slice(0, 3) + '****' + value.slice(-4);
  }
}

export const providerService = new ProviderService();
