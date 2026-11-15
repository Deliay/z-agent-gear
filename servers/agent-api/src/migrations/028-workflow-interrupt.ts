import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'migration/028-workflow-interrupt' });

export const name = '028-workflow-interrupt';

/**
 * 工作流支持打断：无数据模型变更。
 *
 * `failInfo.source` 为自由文本 String，新增值 `'MANUAL_INTERRUPT'` 无需回填存量；
 * `fail` 转移 `from` 扩展 `RETRY_FAILED` 是引擎状态机逻辑，不落库。
 * 本迁移仅登记编号占位，确保迁移 runner 顺序一致（与 027 编号衔接）。
 *
 * 幂等 no-op：重复调用不抛错、不改动数据。
 */
export async function run(): Promise<void> {
  log.info('workflow interrupt migration: no-op (no data model change)');
}
