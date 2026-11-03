import type { BillingOwnerType } from '../../models/billing-account.js';

export interface CloudHostOwnershipFields {
  userId?: unknown;
  tenantId?: unknown;
}

/**
 * 云电脑 Key 的属主校验（铸造与网关使用同一口径）。
 *
 * - `tenant`：前台默认归属，ownerId 是租户 ID，优先比较 `host.tenantId`；
 *   历史行缺 `tenantId` 时回退 `userId`（个人租户下 tenantId === userId）。
 * - `front_user`：已废弃枚举，ownerId 是用户 ID，仍按 `userId` 比较。
 * - `admin_user`：后台代运行场景保留管理豁免。
 */
export function isCloudHostOwnedBy(
  host: CloudHostOwnershipFields | null | undefined,
  ownerType: BillingOwnerType,
  ownerId: string,
): boolean {
  if (!host) return false;
  if (ownerType === 'admin_user') return true;

  const userId = host.userId !== undefined && host.userId !== null ? String(host.userId) : '';
  if (ownerType === 'front_user') return userId === ownerId;

  const tenantId =
    host.tenantId !== undefined && host.tenantId !== null ? String(host.tenantId) : '';
  return tenantId ? tenantId === ownerId : userId === ownerId;
}
