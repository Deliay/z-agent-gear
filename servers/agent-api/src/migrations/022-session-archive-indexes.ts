import mongoose from 'mongoose';
import { logger } from '../observability/logger.js';
import { ensureIndex } from './index-utils.js';

const log = logger.child({ component: 'migration/022-session-archive-indexes' });

export const name = '022-session-archive-indexes';

type Collection = ReturnType<typeof mongoose.connection.collection>;

/**
 * `sessions` 归档/连带匹配索引（与 `models/session.ts` 声明逐条一致）。
 *
 * 生产环境 `autoIndex=false` 时由本迁移显式兜底创建；`ensureIndex` 幂等，
 * 并兼容 Mongoose 默认名抢先建出的同键索引。迁移只建索引、不回填存量
 * （`archivedAt` 缺省即未归档、`controllerWorkspaceId` 为 null 的旧数据走回退匹配）。
 */
export const SESSION_ARCHIVE_INDEXES = [
  {
    keys: { userId: 1, archivedAt: 1, createdAt: -1 },
    options: { name: 'session_user_archived_created' },
  },
  {
    keys: { controllerId: 1, controllerWorkspaceId: 1 },
    options: { name: 'session_controller_workspace' },
  },
] as const;

export async function createSessionArchiveIndexes(): Promise<void> {
  const collection = mongoose.connection.collection('sessions') as Collection;
  for (const entry of SESSION_ARCHIVE_INDEXES) {
    await ensureIndex(collection, entry.keys, entry.options as never);
  }
}

export async function run(): Promise<void> {
  await createSessionArchiveIndexes();
  const collection = mongoose.connection.collection('sessions') as Collection;
  const indexes = await collection.indexes().catch(() => []);
  log.info({ indexes: indexes.map((index) => index.name) }, 'migration completed');
}
