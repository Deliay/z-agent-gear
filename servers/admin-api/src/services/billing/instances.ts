import { cloudControllerClient } from '../cloud-controller-client.js';
import { BillingService } from './billing-service.js';
import { ReconciliationService } from './reconciliation.js';
import { reservationService } from './reservation.js';

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
  listContainers: async () => {
    const containers = await cloudControllerClient.list();
    return containers.map((container) => ({
      id: container.id,
      status: container.status.toLowerCase(),
    }));
  },
});
