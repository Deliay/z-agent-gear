import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { logger as rootLogger } from '../../observability/logger.js';
import { createTestLogger } from '../../observability/testing.js';

vi.mock('../../services/cloud-controller-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/cloud-controller-client.js')>();
  return {
    ...actual,
    cloudControllerClient: { listWorkloadLogs: vi.fn() },
  };
});

vi.mock('../../services/cloud-workload.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/cloud-workload.js')>();
  return {
    ...actual,
    cloudWorkloadService: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      listByContainerLogs: vi.fn(),
      getByIds: vi.fn(),
    },
  };
});

import {
  cloudControllerClient,
  ControlPlaneUnavailableError,
} from '../../services/cloud-controller-client.js';
import { cloudWorkloadService } from '../../services/cloud-workload.js';
import type { AdminAuthContext } from './auth.js';

/**
 * 注入 createTestLogger：在被测模块加载前拦截 `rootLogger.child(...)`，把降级告警写入
 * 内存 sink，断言 `records` 的结构化字段（`msg`/`component` 等，见 contracts/observability.md）。
 */
const testLog = createTestLogger();
const childSpy = vi
  .spyOn(rootLogger, 'child')
  .mockImplementation((bindings) => testLog.logger.child(bindings));
const { cloudWorkloadResolvers } = await import('./cloud-workload.js');
childSpy.mockRestore();

const good: AdminAuthContext = { currentAdmin: { id: 'a1', username: 'admin', mustChangePassword: false } };
const locked: AdminAuthContext = { currentAdmin: { id: 'a1', username: 'admin', mustChangePassword: true } };
const anon: AdminAuthContext = { currentAdmin: null };

const Query = cloudWorkloadResolvers.Query as any;
const Mutation = cloudWorkloadResolvers.Mutation as any;

const createInput = { name: 'setup', initScript: 'echo init' };

const internalLog = {
  id: 'l1',
  containerId: 'c1',
  workloadId: 'w1',
  workloadName: 'setup',
  phase: 'init',
  status: 'success',
  script: 'echo init',
  params: { version: '20' },
  exitCode: 0,
  log: 'init done',
  startedAt: '2026-10-17T00:00:00.000Z',
  finishedAt: '2026-10-17T00:00:05.000Z',
};

const mappedLog = {
  id: 'l1',
  containerId: 'c1',
  workloadId: 'w1',
  workloadName: 'setup',
  phase: 'INIT',
  status: 'SUCCESS',
  script: 'echo init',
  params: { version: '20' },
  required: false,
  trigger: 'START',
  source: 'ADMIN',
  exitCode: 0,
  log: 'init done',
  startedAt: '2026-10-17T00:00:00.000Z',
  finishedAt: '2026-10-17T00:00:05.000Z',
};

describe('cloudWorkloadResolvers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testLog.reset();
  });

  describe('guard (T-W5)', () => {
    it('rejects an anonymous list query', async () => {
      await expect(Query.adminCloudWorkloads({}, {}, anon)).rejects.toThrow('Not authenticated');
    });

    it('rejects a query before password change', async () => {
      await expect(Query.adminCloudWorkloads({}, {}, locked)).rejects.toThrow('MUST_CHANGE_PASSWORD');
    });

    it('rejects anonymous create', async () => {
      await expect(Mutation.adminCreateCloudWorkload({}, { input: createInput }, anon)).rejects.toThrow(
        'Not authenticated',
      );
      expect(cloudWorkloadService.create).not.toHaveBeenCalled();
    });

    it('rejects anonymous update and delete', async () => {
      await expect(Mutation.adminUpdateCloudWorkload({}, { id: 'w1', input: {} }, anon)).rejects.toThrow(
        'Not authenticated',
      );
      await expect(Mutation.adminDeleteCloudWorkload({}, { id: 'w1' }, anon)).rejects.toThrow(
        'Not authenticated',
      );
    });

    it('rejects anonymous log access', async () => {
      await expect(Query.adminCloudContainerWorkloadLogs({}, { containerId: 'c1' }, anon)).rejects.toThrow(
        'Not authenticated',
      );
    });
  });

  describe('adminCloudWorkloads', () => {
    it('delegates to the service', async () => {
      (cloudWorkloadService.list as any).mockResolvedValue([{ id: 'w1' }]);
      await expect(Query.adminCloudWorkloads({}, {}, good)).resolves.toEqual([{ id: 'w1' }]);
    });
  });

  describe('mutations (T-W3/T-W4)', () => {
    it('adminCreateCloudWorkload delegates to the service', async () => {
      (cloudWorkloadService.create as any).mockResolvedValue({ id: 'w1' });
      await expect(Mutation.adminCreateCloudWorkload({}, { input: createInput }, good)).resolves.toEqual({
        id: 'w1',
      });
      expect(cloudWorkloadService.create).toHaveBeenCalledWith(createInput);
    });

    it('T-W3: maps the duplicate key error to a friendly message (create)', async () => {
      (cloudWorkloadService.create as any).mockRejectedValue(new Error('E11000 duplicate key error'));
      await expect(
        Mutation.adminCreateCloudWorkload({}, { input: createInput }, good),
      ).rejects.toThrow('Workload name already exists');
    });

    it('propagates validation errors verbatim (create)', async () => {
      (cloudWorkloadService.create as any).mockRejectedValue(new Error('at least one script is required'));
      await expect(Mutation.adminCreateCloudWorkload({}, { input: createInput }, good)).rejects.toThrow(
        'at least one script is required',
      );
    });

    it('T-W9: passes paramSchema/dependsOnWorkloadIds through and maps param errors to GraphQL errors', async () => {
      const input = {
        name: 'setup',
        initScript: 'a',
        paramSchema: [{ key: 'mode', label: '模式', type: 'SELECT', options: ['a'], defaultValue: 'a' }],
        dependsOnWorkloadIds: ['w2'],
      };
      (cloudWorkloadService.create as any).mockResolvedValue({ id: 'w1' });
      await Mutation.adminCreateCloudWorkload({}, { input }, good);
      expect(cloudWorkloadService.create).toHaveBeenCalledWith(input);

      (cloudWorkloadService.create as any).mockRejectedValue(
        new Error('paramSchema[0].defaultValue is invalid'),
      );
      let captured: GraphQLError | undefined;
      try {
        await Mutation.adminCreateCloudWorkload({}, { input }, good);
      } catch (err) {
        captured = err as GraphQLError;
      }
      expect(captured).toBeInstanceOf(GraphQLError);
      expect(captured?.message).toBe('paramSchema[0].defaultValue is invalid');
    });

    it('T-W10: maps dependency cycle errors to GraphQL errors (update)', async () => {
      (cloudWorkloadService.update as any).mockRejectedValue(
        new Error('dependency cycle detected: w1 -> w2 -> w1'),
      );
      await expect(
        Mutation.adminUpdateCloudWorkload({}, { id: 'w1', input: { dependsOnWorkloadIds: ['w2'] } }, good),
      ).rejects.toThrow('dependency cycle detected');
    });

    it('adminUpdateCloudWorkload delegates to the service', async () => {
      (cloudWorkloadService.update as any).mockResolvedValue({ id: 'w1', name: 'renamed' });
      await expect(Mutation.adminUpdateCloudWorkload({}, { id: 'w1', input: { name: 'renamed' } }, good)).resolves.toEqual(
        { id: 'w1', name: 'renamed' },
      );
    });

    it('T-W4: update maps a missing id to a not-found error', async () => {
      (cloudWorkloadService.update as any).mockResolvedValue(null);
      await expect(Mutation.adminUpdateCloudWorkload({}, { id: 'missing', input: {} }, good)).rejects.toThrow(
        'Workload not found',
      );
    });

    it('T-W3: maps the duplicate key error on rename', async () => {
      (cloudWorkloadService.update as any).mockRejectedValue(new Error('E11000 duplicate key error'));
      await expect(Mutation.adminUpdateCloudWorkload({}, { id: 'w1', input: { name: 'taken' } }, good)).rejects.toThrow(
        'Workload name already exists',
      );
    });

    it('adminDeleteCloudWorkload delegates to the service', async () => {
      (cloudWorkloadService.delete as any).mockResolvedValue(true);
      await expect(Mutation.adminDeleteCloudWorkload({}, { id: 'w1' }, good)).resolves.toBe(true);
    });
  });

  describe('adminCloudContainerWorkloadLogs (T-W8)', () => {
    it('prefers the internal API and returns uppercase enums', async () => {
      (cloudControllerClient.listWorkloadLogs as any).mockResolvedValue([internalLog]);

      const result = await Query.adminCloudContainerWorkloadLogs({}, { containerId: 'c1' }, good);

      expect(cloudControllerClient.listWorkloadLogs).toHaveBeenCalledWith('c1');
      expect(cloudWorkloadService.listByContainerLogs).not.toHaveBeenCalled();
      expect(result).toEqual([mappedLog]);
    });

    it('degrades to a direct Mongo read when the control plane is unreachable', async () => {
      (cloudControllerClient.listWorkloadLogs as any).mockRejectedValue(
        new ControlPlaneUnavailableError('down'),
      );
      (cloudWorkloadService.listByContainerLogs as any).mockResolvedValue([mappedLog]);

      const result = await Query.adminCloudContainerWorkloadLogs({}, { containerId: 'c1' }, good);

      expect(cloudWorkloadService.listByContainerLogs).toHaveBeenCalledWith('c1');
      expect(result).toEqual([mappedLog]);
      // 断言型日志迁移：降级告警落 records（结构化字段而非拼接字符串）
      const warnRecords = testLog.records.filter((record) => record.level === 'warn');
      expect(warnRecords).toHaveLength(1);
      expect(warnRecords[0]!.component).toBe('cloud-workload');
      expect(warnRecords[0]!.msg).toContain('降级直读 Mongo 工作负载日志');
    });

    it('does not degrade on non control-plane errors', async () => {
      (cloudControllerClient.listWorkloadLogs as any).mockRejectedValue(new Error('NOT_FOUND'));

      let captured: GraphQLError | undefined;
      try {
        await Query.adminCloudContainerWorkloadLogs({}, { containerId: 'missing' }, good);
      } catch (err) {
        captured = err as GraphQLError;
      }
      expect(captured).toBeInstanceOf(GraphQLError);
      expect(captured?.message).toBe('NOT_FOUND');
      expect(cloudWorkloadService.listByContainerLogs).not.toHaveBeenCalled();
    });
  });
});
