import mongoose from 'mongoose';

/**
 * admin-api 迁移账本（独立集合 `admin_migrations`，与 agent-api 的 `migrations` 隔离，
 * 避免两个服务共用同一迁移账本——§计划期裁决 1）。
 * 字段与 agent-api `src/migrations/models.ts` 对齐：`name` unique sparse、`executedAt`、
 * `_lock`/`acquired`/`expiresAt` 承载迁移锁。
 */
const migrationsSchema = new mongoose.Schema(
  {
    name: { type: String, unique: true, sparse: true },
    executedAt: { type: Date },
    _lock: { type: String, sparse: true },
    acquired: { type: Date },
    expiresAt: { type: Date },
  },
  { collection: 'admin_migrations' },
);

export const Migrations = mongoose.model('AdminMigrations', migrationsSchema);
