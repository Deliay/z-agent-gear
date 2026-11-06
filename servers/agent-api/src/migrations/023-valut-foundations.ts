import mongoose from 'mongoose';
import { logger } from '../observability/logger.js';
import { ensureIndex } from './index-utils.js';

const log = logger.child({ component: 'migration/023-valut-foundations' });

export const name = '023-valut-foundations';

type Collection = ReturnType<typeof mongoose.connection.collection>;

/**
 * 023-valut-foundations：Valut 底座（MCP+Valut 功能迭代 / 计划 D12）。
 *
 * 1. 幂等播种 `manual` namespace（展示名「自定义密钥」，managed=false，`$setOnInsert`
 *    不覆盖存量行）——由本迁移成为唯一写方，服务层不播种 manual；
 * 2. 四集合索引 `ensureIndex` 幂等（可重跑零变更）：
 *    - `valutnamespaces.name` 全局唯一（跨租户）；
 *    - `valutentries {workspaceId,namespace,key}` 唯一；
 *    - `valutrefs {feature,refId}` 唯一 + `{valutEntryId}` 普通；
 *    - `custommcpservers {workspaceId,name}` 唯一（Phase 2 模型同名声明，索引先行）。
 *
 * 全部与模型声明同名同键；索引名：`uniq_valut_namespace_name` /
 * `uniq_valut_entry_workspace_namespace_key` / `uniq_valut_ref_feature_refid` /
 * `valut_ref_entry` / `uniq_custom_mcp_workspace_name`。
 */
export async function run(): Promise<void> {
  const namespaces = mongoose.connection.collection('valutnamespaces');
  const entries = mongoose.connection.collection('valutentries');
  const refs = mongoose.connection.collection('valutrefs');
  const customMcps = mongoose.connection.collection('custommcpservers');

  // 1) 播种 manual（幂等：已存在则零改动）
  const now = new Date();
  await namespaces.updateOne(
    { name: 'manual' },
    {
      $setOnInsert: {
        name: 'manual',
        displayName: '自定义密钥',
        managed: false,
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true },
  );

  // 2) 四集合索引（幂等）
  await ensureIndex(namespaces as Collection, { name: 1 }, {
    unique: true,
    name: 'uniq_valut_namespace_name',
  } as never);
  await ensureIndex(
    entries as Collection,
    { workspaceId: 1, namespace: 1, key: 1 },
    { unique: true, name: 'uniq_valut_entry_workspace_namespace_key' } as never,
  );
  await ensureIndex(refs as Collection, { feature: 1, refId: 1 }, {
    unique: true,
    name: 'uniq_valut_ref_feature_refid',
  } as never);
  await ensureIndex(refs as Collection, { valutEntryId: 1 }, {
    name: 'valut_ref_entry',
  } as never);
  await ensureIndex(customMcps as Collection, { workspaceId: 1, name: 1 }, {
    unique: true,
    name: 'uniq_custom_mcp_workspace_name',
  } as never);

  const indexes = await namespaces.indexes().catch(() => []);
  log.info(
    { namespaces: indexes.map((index) => index.name) },
    'migration completed',
  );
}
