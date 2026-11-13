import mongoose from 'mongoose';
import { logger } from '../observability/logger.js';
import { ensureIndex } from './index-utils.js';

const log = logger.child({ component: 'migration/025-session-interactions' });

export const name = '025-session-interactions';

type Collection = ReturnType<typeof mongoose.connection.collection>;

/**
 * `sessioninteractions` 索引（与 `models/session-interaction.ts` 声明一致）。
 *
 * - `interactionId` 唯一：重复触发幂等（E11000 → 回读既有记录）；
 * - 会话时间线查询、工作流 pending 聚合、url 模式 complete 匹配（sparse）。
 *
 * 只建索引、不回填（新集合无存量）；不设 TTL（过期交接需随会话留存回看）。
 * 生产 `autoIndex=false` 时由本迁移显式兜底创建；`ensureIndex` 幂等「先建后用」。
 */
export const SESSION_INTERACTION_INDEXES = [
  {
    keys: { interactionId: 1 },
    options: { unique: true, name: 'uniq_session_interaction_id' },
  },
  {
    keys: { sessionId: 1, createdAt: 1 },
    options: { name: 'session_interaction_session_created' },
  },
  {
    keys: { sessionId: 1, status: 1, expiresAt: 1 },
    options: { name: 'session_interaction_session_status_expires' },
  },
  {
    keys: { elicitationId: 1 },
    options: { sparse: true, name: 'session_interaction_elicitation' },
  },
] as const;

export async function createSessionInteractionIndexes(): Promise<void> {
  const collection = mongoose.connection.collection('sessioninteractions') as Collection;
  for (const entry of SESSION_INTERACTION_INDEXES) {
    await ensureIndex(collection, entry.keys, entry.options as never);
  }
}

export async function run(): Promise<void> {
  await createSessionInteractionIndexes();
  const collection = mongoose.connection.collection('sessioninteractions') as Collection;
  const indexes = await collection.indexes().catch(() => []);
  log.info({ indexes: indexes.map((index) => index.name) }, 'migration completed');
}
