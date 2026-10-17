import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { cloudContainerResolvers } from './cloud-container';

vi.mock('../../services/cloud-controller-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/cloud-controller-client.js')>();
  return {
    ...actual,
    cloudControllerClient: { list: vi.fn(), start: vi.fn(), destroy: vi.fn() },
  };
});

vi.mock('../../models/cloud-container.js', () => ({
  findStoredCloudContainers: vi.fn(),
}));

vi.mock('../../services/cloud-workload.js', () => ({
  cloudWorkloadService: { getByIds: vi.fn() },
}));

import {
  cloudControllerClient,
  ControlPlaneUnavailableError,
} from '../../services/cloud-controller-client.js';
import { findStoredCloudContainers } from '../../models/cloud-container.js';
import { cloudWorkloadService } from '../../services/cloud-workload.js';
import type { AdminAuthContext } from './auth.js';

// 每次调用返回全新 context：loadContainers 在 context 上做请求级 memo，
// 复用同一对象会使缓存跨用例泄漏（也正因如此，列表与 controlPlane 必须同 context 断言）。
function good(): AdminAuthContext {
  return { currentAdmin: { id: 'a1', username: 'admin', mustChangePassword: false } };
}
function locked(): AdminAuthContext {
  return { currentAdmin: { id: 'a1', username: 'admin', mustChangePassword: true } };
}
function anon(): AdminAuthContext {
  return { currentAdmin: null };
}

const Query = cloudContainerResolvers.Query as any;
const Mutation = cloudContainerResolvers.Mutation as any;
const CloudContainer = cloudContainerResolvers.CloudContainer as any;

const container = {
  id: 'c1',
  name: 'zag-worker-abc123',
  status: 'ONLINE',
  purpose: 'IDLE',
  refId: null,
  createdAt: '2026-10-14T00:00:00.000Z',
  connectedAt: '2026-10-14T00:01:00.000Z',
  exitedAt: null,
  exitReason: null,
  workloadIds: [],
  currentWorkloadName: null,
};

const storedDoc = {
  _id: { toString: () => 'c9' },
  name: 'zag-worker-old',
  status: 'online',
  purpose: 'idle',
  refId: null,
  createdAt: new Date('2026-10-13T00:00:00.000Z'),
  connectedAt: null,
  exitedAt: null,
  exitReason: null,
};

describe('cloudContainerResolvers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('guard (T-IA5)', () => {
    it('rejects anonymous list access', async () => {
      await expect(Query.adminCloudContainers({}, {}, anon())).rejects.toThrow('Not authenticated');
    });

    it('rejects list access before password change', async () => {
      await expect(Query.adminCloudContainers({}, {}, locked())).rejects.toThrow('MUST_CHANGE_PASSWORD');
    });

    it('rejects anonymous start access', async () => {
      await expect(Mutation.adminStartCloudContainer({}, { purpose: 'IDLE' }, anon())).rejects.toThrow(
        'Not authenticated',
      );
    });

    it('rejects destroy access before password change', async () => {
      await expect(Mutation.adminDestroyCloudContainer({}, { id: 'c1' }, locked())).rejects.toThrow(
        'MUST_CHANGE_PASSWORD',
      );
    });
  });

  describe('adminCloudContainers (T-IA1/T-IA2)', () => {
    it('T-IA1: proxies the internal API and returns contract-shaped containers', async () => {
      (cloudControllerClient.list as any).mockResolvedValue([container]);

      await expect(Query.adminCloudContainers({}, {}, good())).resolves.toEqual([container]);
      expect(cloudControllerClient.list).toHaveBeenCalledTimes(1);
      expect(findStoredCloudContainers).not.toHaveBeenCalled();
    });

    it('T-IA2: degrades to stored Mongo state when the control plane is unreachable', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      (cloudControllerClient.list as any).mockRejectedValue(new ControlPlaneUnavailableError('down'));
      (findStoredCloudContainers as any).mockResolvedValue([storedDoc]);

      const result = await Query.adminCloudContainers({}, {}, good());

      expect(findStoredCloudContainers).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        {
          id: 'c9',
          name: 'zag-worker-old',
          status: 'ONLINE',
          purpose: 'IDLE',
          refId: null,
          createdAt: '2026-10-13T00:00:00.000Z',
          connectedAt: null,
          exitedAt: null,
          exitReason: null,
          workloadIds: [],
          currentWorkloadName: null,
        },
      ]);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('does not degrade on non control-plane errors', async () => {
      (cloudControllerClient.list as any).mockRejectedValue(new Error('bad gateway'));
      await expect(Query.adminCloudContainers({}, {}, good())).rejects.toThrow('bad gateway');
      expect(findStoredCloudContainers).not.toHaveBeenCalled();
    });
  });

  describe('adminCloudContainerControlPlane 与降级事件硬耦合 (P1)', () => {
    it('online=true when the list is served by the control plane', async () => {
      (cloudControllerClient.list as any).mockResolvedValue([container]);
      const context = good();

      await expect(Query.adminCloudContainers({}, {}, context)).resolves.toEqual([container]);
      await expect(Query.adminCloudContainerControlPlane({}, {}, context)).resolves.toEqual({
        online: true,
        message: null,
      });
      // 同一次查询共享一次加载
      expect(cloudControllerClient.list).toHaveBeenCalledTimes(1);
    });

    it('online=false with the offline hint whenever THIS list degraded (same context)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // 模拟控制面「可达但变慢」：list 触发超时降级
      (cloudControllerClient.list as any).mockRejectedValue(new ControlPlaneUnavailableError('timeout'));
      (findStoredCloudContainers as any).mockResolvedValue([storedDoc]);

      const context = good();
      const containers = await Query.adminCloudContainers({}, {}, context);
      const controlPlane = await Query.adminCloudContainerControlPlane({}, {}, context);

      expect(containers).toHaveLength(1);
      expect(controlPlane).toEqual({ online: false, message: '控制面离线' });
      // 共享同一次加载：list 与降级读各只发生一次，不存在两套状态
      expect(cloudControllerClient.list).toHaveBeenCalledTimes(1);
      expect(findStoredCloudContainers).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('online=false even if controlPlane is resolved before the list field', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      (cloudControllerClient.list as any).mockRejectedValue(new ControlPlaneUnavailableError('timeout'));
      (findStoredCloudContainers as any).mockResolvedValue([storedDoc]);

      const context = good();
      // 字段执行顺序不保证：controlPlane 先执行也应得到 online=false
      await expect(Query.adminCloudContainerControlPlane({}, {}, context)).resolves.toEqual({
        online: false,
        message: '控制面离线',
      });
      await expect(Query.adminCloudContainers({}, {}, context)).resolves.toHaveLength(1);
      warn.mockRestore();
    });

    it('rejects anonymous control-plane access', async () => {
      await expect(Query.adminCloudContainerControlPlane({}, {}, anon())).rejects.toThrow('Not authenticated');
    });
  });

  describe('adminStartCloudContainer (T-IA3/T-IA6)', () => {
    it('T-IA3: proxies IDLE to the internal API', async () => {
      (cloudControllerClient.start as any).mockResolvedValue(container);

      await expect(Mutation.adminStartCloudContainer({}, { purpose: 'IDLE' }, good())).resolves.toEqual(container);
      expect(cloudControllerClient.start).toHaveBeenCalledWith('IDLE', []);
    });

    it('T-W7: passes the selected workloadIds through to the internal API', async () => {
      (cloudControllerClient.start as any).mockResolvedValue(container);

      await Mutation.adminStartCloudContainer({}, { purpose: 'IDLE', workloadIds: ['w2', 'w1'] }, good());

      expect(cloudControllerClient.start).toHaveBeenCalledWith('IDLE', ['w2', 'w1']);
    });

    it('rejects non-IDLE purposes with a clear message and never calls the control plane', async () => {
      await expect(Mutation.adminStartCloudContainer({}, { purpose: 'WORKFLOW' }, good())).rejects.toThrow(
        '该任务类型暂未开放',
      );
      await expect(Mutation.adminStartCloudContainer({}, { purpose: 'SESSION' }, good())).rejects.toThrow(
        '该任务类型暂未开放',
      );
      expect(cloudControllerClient.start).not.toHaveBeenCalled();
    });

    it('T-IA6: maps CONTROL_PLANE_UNAVAILABLE on start', async () => {
      (cloudControllerClient.start as any).mockRejectedValue(new ControlPlaneUnavailableError('down'));

      let captured: GraphQLError | undefined;
      try {
        await Mutation.adminStartCloudContainer({}, { purpose: 'IDLE' }, good());
      } catch (err) {
        captured = err as GraphQLError;
      }
      expect(captured).toBeInstanceOf(GraphQLError);
      expect(captured?.extensions.code).toBe('CONTROL_PLANE_UNAVAILABLE');
    });

    it('propagates other start errors verbatim', async () => {
      (cloudControllerClient.start as any).mockRejectedValue(new Error('创建 Job 失败'));
      await expect(Mutation.adminStartCloudContainer({}, { purpose: 'IDLE' }, good())).rejects.toThrow('创建 Job 失败');
    });
  });

  describe('adminDestroyCloudContainer (T-IA4/T-IA6)', () => {
    it('T-IA4: proxies the destroy call and returns true', async () => {
      (cloudControllerClient.destroy as any).mockResolvedValue(true);

      await expect(Mutation.adminDestroyCloudContainer({}, { id: 'c1' }, good())).resolves.toBe(true);
      expect(cloudControllerClient.destroy).toHaveBeenCalledWith('c1');
    });

    it('T-IA6: maps CONTROL_PLANE_UNAVAILABLE on destroy', async () => {
      (cloudControllerClient.destroy as any).mockRejectedValue(new ControlPlaneUnavailableError('down'));
      await expect(Mutation.adminDestroyCloudContainer({}, { id: 'c1' }, good())).rejects.toMatchObject({
        extensions: { code: 'CONTROL_PLANE_UNAVAILABLE' },
      });
    });
  });

  describe('CloudContainer.workloads (T-W6)', () => {
    it('resolves mounted workloads in workloadIds order, omits deleted ones and queries the DB once per request', async () => {
      const c1 = { ...container, id: 'c1', workloadIds: ['w2', 'w1'] };
      const c2 = { ...container, id: 'c2', workloadIds: ['w3', 'w1'] };
      (cloudControllerClient.list as any).mockResolvedValue([c1, c2]);
      // w3 已被删除（不在返回结果中）
      (cloudWorkloadService.getByIds as any).mockResolvedValue([
        { id: 'w1', name: 'one' },
        { id: 'w2', name: 'two' },
      ]);

      const context = good();
      await Query.adminCloudContainers({}, {}, context);
      const r1 = await CloudContainer.workloads(c1, {}, context);
      const r2 = await CloudContainer.workloads(c2, {}, context);

      expect(r1.map((w: { id: string }) => w.id)).toEqual(['w2', 'w1']);
      expect(r2.map((w: { id: string }) => w.id)).toEqual(['w1']);
      // 跨容器批量：整条请求只查一次库（无 N+1）
      expect(cloudWorkloadService.getByIds).toHaveBeenCalledTimes(1);
    });

    it('returns an empty list without querying when no workloads are mounted', async () => {
      const context = good();
      await expect(CloudContainer.workloads({ ...container, workloadIds: [] }, {}, context)).resolves.toEqual([]);
      expect(cloudWorkloadService.getByIds).not.toHaveBeenCalled();
    });

    it('tolerates a legacy container without workloadIds', async () => {
      const context = good();
      await expect(CloudContainer.workloads({ ...container, workloadIds: undefined }, {}, context)).resolves.toEqual(
        [],
      );
    });
  });
});
