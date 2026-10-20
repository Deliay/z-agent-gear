import mongoose from 'mongoose';
import { Model } from '../models/model.js';
import { Provider } from '../models/provider.js';
import { ModelRenameRecord } from '../models/model-rename-record.js';

/**
 * 005-model-name-unique-global：整理存量 `scope = 'global'` 重名模型，并建立
 * 「global 内模型名全局唯一」的部分唯一索引。
 *
 * 背景：内建 API 渠道一期允许不同供应商出现同名模型，按名路由时无法确定目标供应商；
 * 本期把 `scope = 'global'` 的模型名收敛为全局唯一，同时保留全部模型数据（只改名、不删除）。
 *
 * 口径（提案 §4.1 / 计划期裁决 2、16）：
 * - 重名组内保留「最早创建（createdAt 最小，缺失按 epoch；再以 _id 升序兜底）」的一条原名，
 *   其余依次改为 `<name>-2`、`<name>-3`…，并跳过全库已占用的名称；
 * - 每次改名先 `updateOne` 再写一条 `model_rename_records` 台账（oldName → newName、供应商名冗余）；
 * - 索引由本迁移**唯一**创建（固定名 `scope_global_name_unique`，partial 条件仅 `scope: 'global'`），
 *   schema 不声明该索引，避免 Mongoose autoIndex 在重名清理前建索引的竞态；
 * - 迁移失败直接向上抛，交由 runner 记录并在下次启动重试（不静默降级为无唯一约束）。
 */
export const name = '005-model-name-unique-global';

/** 单次整理只有一个批次，便于 API 测试断言。 */
export const BATCH_ID = '20261020-005';

export const INDEX_NAME = 'scope_global_name_unique';

interface GlobalModelDoc {
  _id: { toString(): string };
  providerId: { toString(): string };
  name: string;
  createdAt?: Date | null;
}

function createdAtValue(model: GlobalModelDoc): number {
  const value = model.createdAt ? new Date(model.createdAt).getTime() : 0;
  return Number.isFinite(value) ? value : 0;
}

/** 组内排序：createdAt 升序（缺失按 epoch），再按 _id 字符串升序，保证「最早创建」稳定。 */
function compareOldestFirst(a: GlobalModelDoc, b: GlobalModelDoc): number {
  const diff = createdAtValue(a) - createdAtValue(b);
  if (diff !== 0) return diff;
  const aid = a._id.toString();
  const bid = b._id.toString();
  return aid < bid ? -1 : aid > bid ? 1 : 0;
}

export async function run(): Promise<void> {
  const models = (await Model.find({ scope: 'global' }).lean()) as unknown as GlobalModelDoc[];

  const groups = new Map<string, GlobalModelDoc[]>();
  for (const model of models) {
    const key = String(model.name);
    const group = groups.get(key);
    if (group) {
      group.push(model);
    } else {
      groups.set(key, [model]);
    }
  }

  const used = new Set(models.map((model) => String(model.name)));
  const duplicateGroups = [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => [...group].sort(compareOldestFirst));

  const providerIds = [...new Set(duplicateGroups.flat().map((model) => String(model.providerId)))];
  const providers = providerIds.length
    ? ((await Provider.find({ _id: { $in: providerIds } }, 'name').lean()) as unknown as Array<{
        _id: { toString(): string };
        name: string;
      }>)
    : [];
  const providerNames = new Map(providers.map((p) => [String(p._id), String(p.name)]));

  let renamedCount = 0;
  for (const group of duplicateGroups) {
    // 保留 createdAt 最早、_id 最小的那条原名
    const [, ...rest] = group;
    for (const model of rest) {
      let suffix = 2;
      let newName = `${model.name}-${suffix}`;
      while (used.has(newName)) {
        suffix += 1;
        newName = `${model.name}-${suffix}`;
      }
      used.add(newName);

      await Model.updateOne(
        { _id: model._id as unknown as mongoose.Types.ObjectId, scope: 'global' },
        { $set: { name: newName } },
      );
      await ModelRenameRecord.create({
        modelId: model._id as unknown as mongoose.Types.ObjectId,
        providerId: model.providerId as unknown as mongoose.Types.ObjectId,
        providerName: providerNames.get(String(model.providerId)) ?? '未知供应商',
        oldName: model.name,
        newName,
        batchId: BATCH_ID,
        renamedAt: new Date(),
      });
      renamedCount += 1;
    }
  }

  // fresh 环境集合可能尚不存在，indexes() 会抛 NamespaceNotFound → 视为无索引
  const indexes = await Model.collection.indexes().catch(() => [] as Array<{ name?: string }>);
  if (duplicateGroups.length === 0 && indexes.some((index) => index.name === INDEX_NAME)) {
    console.log('[Migration 005] no duplicate global model names, index present, skipping');
    return;
  }

  await Model.collection.createIndex(
    { name: 1 },
    { unique: true, partialFilterExpression: { scope: 'global' }, name: INDEX_NAME },
  );

  if (renamedCount > 0) {
    console.log(`[Migration 005] renamed ${renamedCount} duplicate global models (batch ${BATCH_ID})`);
  } else {
    console.log('[Migration 005] global model name unique index ensured');
  }
}
