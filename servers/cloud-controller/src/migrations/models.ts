import mongoose from 'mongoose';

/**
 * cloud-controller 迁移账本（独立集合 `cloud_controller_migrations`）。
 *
 * 与 agent-api 的默认 `migrations`、admin-api 的 `admin_migrations` 隔离：三个服务共用同一
 * MongoDB，但迁移集合与语义互不相关，共用账本会导致「一个服务记录执行、另一个服务误跳过」。
 * 字段与 admin-api `src/migrations/models.ts` 对齐：`name` unique sparse、`executedAt`、
 * `_lock`/`acquired`/`expiresAt` 承载迁移锁，`owner` 记录锁归属（只允许持有者释放）。
 */
const migrationsSchema = new mongoose.Schema(
  {
    name: { type: String, unique: true, sparse: true },
    executedAt: { type: Date },
    _lock: { type: String, unique: true, sparse: true },
    /** 锁归属：只有持有者本人可以释放，避免超时接管后误删他人锁。 */
    owner: { type: String, default: null },
    acquired: { type: Date },
    expiresAt: { type: Date },
  },
  { collection: 'cloud_controller_migrations' },
);

export const Migrations = mongoose.model('CloudControllerMigrations', migrationsSchema);
