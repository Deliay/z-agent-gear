import { Model } from '../models/model.js';
import { Provider } from '../models/provider.js';
import { llmApiService } from './llm-api.js';
import { providerService, PROVIDER_CONNECTIVITY_ERROR } from './provider.js';
import mongoose from 'mongoose';

/** admin-api 全链路强制操作全局（scope=global）配置 */
const GLOBAL_SCOPE: 'global' = 'global';

export interface ProviderModelOption {
  name: string;
  isImported: boolean;
  isDuplicate: boolean;
}

export interface MappedModel {
  id: string;
  providerId: string;
  name: string;
  isCustom: boolean;
  isEnabled: boolean;
  sortOrder: number;
  scope: string;
  pricing: {
    inputPerMillion: number;
    cachedInputPerMillion: number;
    outputPerMillion: number;
    isBillable: boolean;
  } | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 规范化上游返回的模型名：trim、剔除空名、按首次出现顺序去重。
 * 上游网关/代理可能返回重复名或空名，直接写入会触发唯一索引 E11000。
 */
function dedupeModelNames(models: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of models) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

export class ModelService {
  async findAll() {
    const models = await Model.find({ scope: GLOBAL_SCOPE }).sort({ sortOrder: 1, createdAt: 1 }).lean();
    return models.map(this.mapModel.bind(this));
  }

  async findByProviderId(providerId: string) {
    if (!mongoose.Types.ObjectId.isValid(providerId)) return [];
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
    // 名称 trim + 拒空（建议 I，与 agent 侧校验对齐）：避免写入空名自定义模型
    const name = (input.name ?? '').trim();
    if (name.length === 0) {
      throw new Error('Model name is required');
    }
    const provider = await Provider.findOne({ _id: input.providerId, scope: GLOBAL_SCOPE }).lean();
    if (!provider) {
      throw new Error('Provider not found');
    }

    // 全局唯一：跨供应商同名一律拒绝（与迁移 005 的 partial unique index 口径一致）
    await this.assertNamesAvailable([name]);

    const maxSort = await Model.findOne({ providerId: input.providerId, scope: GLOBAL_SCOPE })
      .sort({ sortOrder: -1 })
      .select('sortOrder')
      .lean();

    const model = await Model.create({
      providerId: new mongoose.Types.ObjectId(input.providerId),
      name,
      isCustom: true,
      isEnabled: true,
      sortOrder: (maxSort?.sortOrder ?? -1) + 1,
      scope: GLOBAL_SCOPE,
    });

    return this.mapModel(model.toObject());
  }

  /**
   * 校验 `scope=global` 内模型名未被占用（跨供应商）。
   * 用户侧（scope=user）允许跨 scope 同名，故不纳入检查。
   */
  async assertNamesAvailable(names: string[]): Promise<void> {
    if (names.length === 0) return;
    const conflicts = await Model.find({ scope: GLOBAL_SCOPE, name: { $in: names } }, 'name').lean();
    if (conflicts.length > 0) {
      const unique = [...new Set(conflicts.map((m) => String((m as { name: unknown }).name)))];
      throw new Error(`Model name already exists: ${unique.join(', ')}`);
    }
  }

  /**
   * 拉取指定供应商的上游模型清单（导入弹窗数据源）。
   * - 供应商不存在/解密失败 → `Provider not found`
   * - 上游不可用 → `PROVIDER_CONNECTIVITY_ERROR`
   * - 结果按上游顺序返回，并标记「该供应商已导入」与「已被其他供应商占用」
   */
  async listProviderModels(providerId: string): Promise<ProviderModelOption[]> {
    const connection = await this.getConnectionOrThrow(providerId);

    let fetched: string[];
    try {
      fetched = await llmApiService.fetchModels(connection.type, connection.endpoint, connection.apiKey);
    } catch {
      throw new Error(PROVIDER_CONNECTIVITY_ERROR);
    }
    const names = dedupeModelNames(fetched);

    const existing = await Model.find(
      { scope: GLOBAL_SCOPE, name: { $in: names } },
      'providerId name',
    ).lean();
    const importedNames = new Set(
      existing
        .filter((m) => String((m as { providerId: unknown }).providerId) === providerId)
        .map((m) => String((m as { name: unknown }).name)),
    );
    const occupiedByOthers = new Set(
      existing
        .filter((m) => String((m as { providerId: unknown }).providerId) !== providerId)
        .map((m) => String((m as { name: unknown }).name)),
    );

    return names.map((name) => ({
      name,
      isImported: importedNames.has(name),
      isDuplicate: occupiedByOthers.has(name),
    }));
  }

  /**
   * 手动导入上游模型（幂等）：
   * 1) 剔除该供应商下已存在的名字（重复导入直接跳过，不报错）；
   * 2) 剩余为空时直接返回 `[]`，不访问上游；
   * 3) 反之上游连通性门禁失败 → `PROVIDER_CONNECTIVITY_ERROR`；
   * 4) 全局重名 → `Model name already exists: <names>`；
   * 5) `insertMany(ordered: false)` 写入，并发冲突由唯一索引兜底并映射为同一文案。
   */
  async importModels(providerId: string, rawNames: string[]): Promise<MappedModel[]> {
    const provider = await this.findGlobalProvider(providerId);
    if (!provider) {
      throw new Error('Provider not found');
    }

    const names = (rawNames ?? []).map((raw) => (typeof raw === 'string' ? raw.trim() : ''));
    if (names.length === 0 || names.some((name) => name.length === 0)) {
      throw new Error('Model name is invalid');
    }

    const requested = [...new Set(names)];
    const existing = await Model.find(
      { providerId: new mongoose.Types.ObjectId(providerId), scope: GLOBAL_SCOPE, name: { $in: requested } },
      'name',
    ).lean();
    const importedNames = new Set(existing.map((m) => String((m as { name: unknown }).name)));
    const toCreate = requested.filter((name) => !importedNames.has(name));
    if (toCreate.length === 0) return [];

    const connection = await providerService.getDecryptedConnection(providerId);
    if (!connection) {
      throw new Error('Provider not found');
    }
    try {
      await llmApiService.fetchModels(connection.type, connection.endpoint, connection.apiKey);
    } catch {
      throw new Error(PROVIDER_CONNECTIVITY_ERROR);
    }

    await this.assertNamesAvailable(toCreate);

    const maxSort = await Model.findOne({ providerId, scope: GLOBAL_SCOPE })
      .sort({ sortOrder: -1 })
      .select('sortOrder')
      .lean();
    let nextSort = ((maxSort as { sortOrder?: number } | null)?.sortOrder ?? -1) + 1;

    const docs = toCreate.map((name) => ({
      providerId: new mongoose.Types.ObjectId(providerId),
      name,
      isCustom: false,
      isEnabled: true,
      sortOrder: nextSort++,
      scope: GLOBAL_SCOPE,
    }));

    let created: Array<Record<string, unknown>>;
    try {
      created = (await Model.insertMany(docs, { ordered: false })) as unknown as Array<Record<string, unknown>>;
    } catch (err) {
      const message = (err as Error)?.message ?? '';
      // 并发重名：唯一索引兜底。冲突前已写入的条目保留，重试幂等。
      if (message.includes('E11000')) {
        throw new Error('Model name already exists');
      }
      throw err;
    }

    return created.map((doc) => this.mapModel(this.toPlain(doc)));
  }

  async delete(id: string) {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const model = await Model.findById(id);
    if (!model) return null;
    if (model.scope !== GLOBAL_SCOPE) return null;

    const mapped = this.mapModel(model.toObject());
    await Model.deleteOne({ _id: id });
    return mapped;
  }

  async toggle(id: string) {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
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
    // 非法 ObjectId 直接剔除，避免 bulkWrite CastError（问题 27）
    const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
    const updates = validIds.map((id, index) => ({
      updateOne: {
        filter: { _id: id, scope: GLOBAL_SCOPE },
        update: { sortOrder: index },
      },
    }));

    if (updates.length > 0) {
      await Model.bulkWrite(updates);
    }

    const models = await Model.find({ _id: { $in: validIds }, scope: GLOBAL_SCOPE })
      .sort({ sortOrder: 1 })
      .lean();

    return models.map(this.mapModel.bind(this));
  }

  /** 校验并返回全局供应商（不存在/非法 id → null）。 */
  private async findGlobalProvider(providerId: string) {
    if (!mongoose.Types.ObjectId.isValid(providerId)) return null;
    return Provider.findOne({ _id: providerId, scope: GLOBAL_SCOPE }).lean();
  }

  private async getConnectionOrThrow(providerId: string) {
    const provider = await this.findGlobalProvider(providerId);
    if (!provider) {
      throw new Error('Provider not found');
    }
    const connection = await providerService.getDecryptedConnection(providerId);
    if (!connection) {
      throw new Error('Provider not found');
    }
    return connection;
  }

  /** mongoose 文档/lean 对象统一转为普通对象，供 mapModel 使用。 */
  private toPlain(doc: Record<string, unknown>): Record<string, unknown> {
    const withToObject = doc as { toObject?: () => Record<string, unknown> };
    return typeof withToObject.toObject === 'function' ? withToObject.toObject() : doc;
  }

  private mapModel(model: Record<string, unknown>): MappedModel {
    return {
      id: (model._id as mongoose.Types.ObjectId).toString(),
      providerId: (model.providerId as mongoose.Types.ObjectId).toString(),
      name: model.name as string,
      isCustom: model.isCustom as boolean,
      isEnabled: model.isEnabled as boolean,
      sortOrder: model.sortOrder as number,
      scope: model.scope as string,
      pricing: model.pricing
        ? {
            inputPerMillion: Number((model.pricing as Record<string, unknown>).inputPerMillion ?? 0) / 100,
            cachedInputPerMillion:
              Number((model.pricing as Record<string, unknown>).cachedInputPerMillion ?? 0) / 100,
            outputPerMillion: Number((model.pricing as Record<string, unknown>).outputPerMillion ?? 0) / 100,
            isBillable: (model.pricing as Record<string, unknown>).isBillable !== false,
          }
        : null,
      createdAt: (model.createdAt as Date).toISOString(),
      updatedAt: (model.updatedAt as Date).toISOString(),
    };
  }
}

export const modelService = new ModelService();
