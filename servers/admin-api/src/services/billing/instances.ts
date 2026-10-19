import { cloudControllerClient } from '../cloud-controller-client.js';
import { BillingService } from './billing-service.js';
import { ReconciliationService } from './reconciliation.js';
import { reservationService } from './reservation.js';

/** 控制面容器视图（计费对账/存活探测共用）。 */
export async function listCloudContainers(): Promise<
  Array<{
    id: string;
    status: string;
    billingAccountId: string | null;
    billingStartedAt: string | null;
    exitedAt: string | null;
  }>
> {
  const containers = await cloudControllerClient.list();
  return containers.map((container) => ({
    id: container.id,
    status: container.status.toLowerCase(),
    billingAccountId: container.billingAccountId,
    billingStartedAt: container.billingStartedAt,
    exitedAt: container.exitedAt,
  }));
}

/** A-3：容器是否仍存活（stale 终结前必须复核）。 */
export async function isCloudContainerAlive(resourceId: string): Promise<boolean> {
  const containers = await listCloudContainers();
  const container = containers.find((item) => item.id === resourceId);
  if (!container) return false;
  return ['creating', 'connecting', 'initializing', 'online', 'destroying'].includes(container.status);
}

/**
 * 计费域运行时单例：把强拆动作接到 cloud-controller（带原因），供消费者/调度/GraphQL 复用。
 * 拆出独立文件避免 billing-service 反向依赖控制面客户端。
 */
export const billingRuntime = new BillingService({
  destroyContainer: async (resourceId, reason) => {
    await cloudControllerClient.destroy(resourceId, reason);
  },
});

export const reconciliationRuntime = new ReconciliationService(billingRuntime, reservationService, {
  listContainers: listCloudContainers,
});
