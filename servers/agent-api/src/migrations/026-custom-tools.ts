import mongoose from 'mongoose';
import { logger } from '../observability/logger.js';
import { ensureIndex } from './index-utils.js';

const log = logger.child({ component: 'migration/026-custom-tools' });

export const name = '026-custom-tools';

type Collection = ReturnType<typeof mongoose.connection.collection>;

/**
 * `customtools` 索引（与 `models/custom-tool.ts` 声明一致，需求 #449）。
 *
 * - `workspaceId + name` 唯一：工作区内自定义工具名称唯一（服务层预检 + E11000 兜底）；
 * - `tenantId` 普通索引：租户维度查询/清扫。
 *
 * 只建索引、不回填（新集合无存量）；生产 `autoIndex=false` 时由本迁移显式兜底创建；
 * `ensureIndex` 幂等「先建后用」（可重跑零变更）。
 */
export const CUSTOM_TOOL_INDEXES = [
  {
    keys: { workspaceId: 1, name: 1 },
    options: { unique: true, name: 'uniq_custom_tool_workspace_name' },
  },
  {
    keys: { tenantId: 1 },
    options: { name: 'custom_tool_tenant' },
  },
] as const;

export async function createCustomToolIndexes(): Promise<void> {
  const collection = mongoose.connection.collection('customtools') as Collection;
  for (const entry of CUSTOM_TOOL_INDEXES) {
    await ensureIndex(collection, entry.keys, entry.options as never);
  }
}

export async function run(): Promise<void> {
  await createCustomToolIndexes();
  const collection = mongoose.connection.collection('customtools') as Collection;
  const indexes = await collection.indexes().catch(() => []);
  log.info({ indexes: indexes.map((index) => index.name) }, 'migration completed');
}
