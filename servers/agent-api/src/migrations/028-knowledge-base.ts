import mongoose from 'mongoose';
import { logger } from '../observability/logger.js';
import { ensureIndex } from './index-utils.js';

const log = logger.child({ component: 'migration/028-knowledge-base' });

export const name = '028-knowledge-base';

type Collection = ReturnType<typeof mongoose.connection.collection>;

/**
 * 知识库三集合索引（与模型声明同名同键，需求 #495）。
 *
 * - `knowledgebases`：`workspaceId + name` 唯一（工作区内库名唯一）、`tenantId + workspaceId`
 *   （列表可见集查询：本工作区 ∪ 本租户全局工作区）；
 * - `knowledgebasedocuments`：`knowledgeBaseId + path` 唯一（库内路径唯一，亦支撑前缀查询）；
 * - `knowledgebaseevents`：`knowledgeBaseId + createdAt(-1)`（全库历史）、
 *   `knowledgeBaseId + path + createdAt(-1)`（单路径历史）。
 *
 * 只建索引、不回填（新集合无存量）；生产 `autoIndex=false` 时由本迁移显式兜底创建；
 * `ensureIndex` 幂等「先建后用」（可重跑零变更）。
 */
export const KNOWLEDGE_BASE_INDEXES = [
  {
    collection: 'knowledgebases',
    keys: { workspaceId: 1, name: 1 },
    options: { unique: true, name: 'uniq_knowledge_base_workspace_name' },
  },
  {
    collection: 'knowledgebases',
    keys: { tenantId: 1, workspaceId: 1 },
    options: { name: 'knowledge_base_tenant_workspace' },
  },
  {
    collection: 'knowledgebasedocuments',
    keys: { knowledgeBaseId: 1, path: 1 },
    options: { unique: true, name: 'uniq_knowledge_base_doc_path' },
  },
  {
    collection: 'knowledgebaseevents',
    keys: { knowledgeBaseId: 1, createdAt: -1 },
    options: { name: 'knowledge_base_event_recent' },
  },
  {
    collection: 'knowledgebaseevents',
    keys: { knowledgeBaseId: 1, path: 1, createdAt: -1 },
    options: { name: 'knowledge_base_event_path_recent' },
  },
] as const;

export async function createKnowledgeBaseIndexes(): Promise<void> {
  for (const entry of KNOWLEDGE_BASE_INDEXES) {
    const collection = mongoose.connection.collection(entry.collection) as Collection;
    await ensureIndex(collection, entry.keys as never, entry.options as never);
  }
}

export async function run(): Promise<void> {
  await createKnowledgeBaseIndexes();
  for (const collectionName of ['knowledgebases', 'knowledgebasedocuments', 'knowledgebaseevents']) {
    const collection = mongoose.connection.collection(collectionName) as Collection;
    const indexes = await collection.indexes().catch(() => []);
    log.info(
      { collection: collectionName, indexes: indexes.map((index) => index.name) },
      'migration completed',
    );
  }
}
