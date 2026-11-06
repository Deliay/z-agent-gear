import mongoose from 'mongoose';
import { logger } from '../observability/logger.js';
import { ensureIndex } from './index-utils.js';

const log = logger.child({ component: 'migration/023-session-reviews' });

export const name = '023-session-reviews';

type Collection = ReturnType<typeof mongoose.connection.collection>;

/**
 * `sessionreviews` 查询索引（与 `models/session-review.ts` 声明一致）。
 *
 * 生产 `autoIndex=false` 时由本迁移显式兜底创建；`ensureIndex` 幂等「先建后用」。
 * 迁移只建索引、不回填（新集合无存量；回滚无需反向迁移）。
 */
export const SESSION_REVIEW_INDEXES = [
  {
    keys: { userId: 1, status: 1, createdAt: -1 },
    options: { name: 'session_review_user_status_created' },
  },
  {
    keys: { sessionId: 1, status: 1 },
    options: { name: 'session_review_session_status' },
  },
] as const;

export async function createSessionReviewIndexes(): Promise<void> {
  const collection = mongoose.connection.collection('sessionreviews') as Collection;
  for (const entry of SESSION_REVIEW_INDEXES) {
    await ensureIndex(collection, entry.keys, entry.options as never);
  }
}

export async function run(): Promise<void> {
  await createSessionReviewIndexes();
  const collection = mongoose.connection.collection('sessionreviews') as Collection;
  const indexes = await collection.indexes().catch(() => []);
  log.info({ indexes: indexes.map((index) => index.name) }, 'migration completed');
}
