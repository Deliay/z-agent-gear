import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { cloudContainerResolvers } from './cloud-container';

vi.mock('../../services/cloud-controller-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/cloud-controller-client.js')>();
  return {
    ...actual,
    cloudControllerClient: { list: vi.fn(), start: vi.fn(), destroy: vi.fn(), checkHealth: vi.fn() },
  };
});

vi.mock('../../models/cloud-container.js', () => ({
  findStoredCloudContainers: vi.fn(),
}));

import {
  cloudControllerClient,
  ControlPlaneUnavailableError,
} from '../../services/cloud-controller-client.js';
import { findStoredCloudContainers } from '../../models/cloud-container.js';
import type { AdminAuthContext } from './auth.js';

const good: AdminAuthContext = { currentAdmin: { id: 'a1', username: 'admin', mustChangePassword: false } };
const locked: AdminAuthContext = { currentAdmin: { id: 'a1', username: 'admin', mustChangePassword: true } };
const anon: AdminAuthContext = { currentAdmin: null };

const Query = cloudContainerResolvers.Query as any;
const Mutation = cloudContainerResolvers.Mutation as any;

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
      await expect(Query.adminCloudContainers({}, {}, anon)).rejects.toThrow('Not authenticated');
    });

    it('rejects list access before password change', async () => {
      await expect(Query.adminCloudContainers({}, {}, locked)).rejects.toThrow('MUST_CHANGE_PASSWORD');
    });

    it('rejects anonymous start access', async () => {
      await expect(Mutation.adminStartCloudContainer({}, { purpose: 'IDLE' }, anon)).rejects.toThrow(
        'Not authenticated',
      );
    });

    it('rejects destroy access before password change', async () => {
      await expect(Mutation.adminDestroyCloudContainer({}, { id: 'c1' }, locked)).rejects.toThrow(
        'MUST_CHANGE_PASSWORD',
      );
    });
  });

  describe('adminCloudContainers (T-IA1/T-IA2)', () => {
    it('T-IA1: proxies the internal API and returns contract-shaped containers', async () => {
      (cloudControllerClient.list as any).mockResolvedValue([container]);

      await expect(Query.adminCloudContainers({}, {}, good)).resolves.toEqual([container]);
      expect(cloudControllerClient.list).toHaveBeenCalledTimes(1);
      expect(findStoredCloudContainers).not.toHaveBeenCalled();
    });

    it('T-IA2: degrades to stored Mongo state with an offline hint when the control plane is unreachable', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      (cloudControllerClient.list as any).mockRejectedValue(new ControlPlaneUnavailableError('down'));
      (findStoredCloudContainers as any).mockResolvedValue([storedDoc]);

      const result = await Query.adminCloudContainers({}, {}, good);

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
        },
      ]);
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.flat().join(' ')).toContain('控制面离线');

      warn.mockRestore();
    });

    it('does not degrade on non control-plane errors', async () => {
      (cloudControllerClient.list as any).mockRejectedValue(new Error('bad gateway'));
      await expect(Query.adminCloudContainers({}, {}, good)).rejects.toThrow('bad gateway');
      expect(findStoredCloudContainers).not.toHaveBeenCalled();
    });
  });

  describe('adminCloudContainerControlPlane (P0-2 降级提示)', () => {
    it('returns online=true on a healthy control plane', async () => {
      (cloudControllerClient.checkHealth as any).mockResolvedValue(true);
      await expect(Query.adminCloudContainerControlPlane({}, {}, good)).resolves.toEqual({
        online: true,
        message: null,
      });
    });

    it('returns online=false with the offline hint when unreachable (real degradation path)', async () => {
      (cloudControllerClient.checkHealth as any).mockRejectedValue(
        new ControlPlaneUnavailableError('down'),
      );
      await expect(Query.adminCloudContainerControlPlane({}, {}, good)).resolves.toEqual({
        online: false,
        message: '控制面离线',
      });
    });

    it('rejects anonymous access', async () => {
      await expect(Query.adminCloudContainerControlPlane({}, {}, anon)).rejects.toThrow('Not authenticated');
    });
  });

  describe('adminStartCloudContainer (T-IA3/T-IA6)', () => {
    it('T-IA3: proxies IDLE to the internal API', async () => {
      (cloudControllerClient.start as any).mockResolvedValue(container);

      await expect(Mutation.adminStartCloudContainer({}, { purpose: 'IDLE' }, good)).resolves.toEqual(container);
      expect(cloudControllerClient.start).toHaveBeenCalledWith('IDLE');
    });

    it('rejects non-IDLE purposes with a clear message and never calls the control plane', async () => {
      await expect(Mutation.adminStartCloudContainer({}, { purpose: 'WORKFLOW' }, good)).rejects.toThrow(
        '该任务类型暂未开放',
      );
      await expect(Mutation.adminStartCloudContainer({}, { purpose: 'SESSION' }, good)).rejects.toThrow(
        '该任务类型暂未开放',
      );
      expect(cloudControllerClient.start).not.toHaveBeenCalled();
    });

    it('T-IA6: maps CONTROL_PLANE_UNAVAILABLE on start', async () => {
      (cloudControllerClient.start as any).mockRejectedValue(new ControlPlaneUnavailableError('down'));

      let captured: GraphQLError | undefined;
      try {
        await Mutation.adminStartCloudContainer({}, { purpose: 'IDLE' }, good);
      } catch (err) {
        captured = err as GraphQLError;
      }
      expect(captured).toBeInstanceOf(GraphQLError);
      expect(captured?.extensions.code).toBe('CONTROL_PLANE_UNAVAILABLE');
    });

    it('propagates other start errors verbatim', async () => {
      (cloudControllerClient.start as any).mockRejectedValue(new Error('创建 Job 失败'));
      await expect(Mutation.adminStartCloudContainer({}, { purpose: 'IDLE' }, good)).rejects.toThrow('创建 Job 失败');
    });
  });

  describe('adminDestroyCloudContainer (T-IA4/T-IA6)', () => {
    it('T-IA4: proxies the destroy call and returns true', async () => {
      (cloudControllerClient.destroy as any).mockResolvedValue(true);

      await expect(Mutation.adminDestroyCloudContainer({}, { id: 'c1' }, good)).resolves.toBe(true);
      expect(cloudControllerClient.destroy).toHaveBeenCalledWith('c1');
    });

    it('T-IA6: maps CONTROL_PLANE_UNAVAILABLE on destroy', async () => {
      (cloudControllerClient.destroy as any).mockRejectedValue(new ControlPlaneUnavailableError('down'));
      await expect(Mutation.adminDestroyCloudContainer({}, { id: 'c1' }, good)).rejects.toMatchObject({
        extensions: { code: 'CONTROL_PLANE_UNAVAILABLE' },
      });
    });
  });
});
