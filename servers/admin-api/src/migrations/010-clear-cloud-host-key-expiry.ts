import { BillingApiKey } from '../models/billing-api-key.js';

/**
 * 010-clear-cloud-host-key-expiry：清空云电脑运行专用 Key 的固定有效期。
 *
 * 背景：云电脑 Key 曾按容器 TTL 铸造（默认 24h），但容器本身已无最长运行时间限制，
 * 导致容器仍在运行时模型调用先被 401。本期改为随容器回收（宿主非 RUNNING/删除/缺失即撤销），
 * 新 Key 不再写 `expiresAt`；本迁移把升级前仍在使用的 active Key 一并清空，避免旧到期值继续生效。
 *
 * 只清理 `status=active` 的 `scope=cloud_host` Key；已撤销记录无需处理。
 */
export const name = '010-clear-cloud-host-key-expiry';

export async function run(): Promise<void> {
  const result = await BillingApiKey.updateMany(
    { scope: 'cloud_host', status: 'active', expiresAt: { $ne: null } },
    { $set: { expiresAt: null } },
  );
  console.log(
    `[Migration 010] cleared cloud_host key expiry: ${result.modifiedCount ?? 0} key(s)`,
  );
}
