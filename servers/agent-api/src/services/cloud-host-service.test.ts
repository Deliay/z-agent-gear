import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  config: {
    harnessEnabled: true,
    cloudHostMaxPerUser: 1,
    harnessContainerTtlSeconds: 86400,
    cloudControllerUrl: 'http://cc:10004',
    internalApiToken: 'internal-token',
    controllerApiPublicEndpoint: 'wss://controller-api',
    cloudHostModelBaseUrl: 'http://admin-api:8002/v1',
    cloudHostDefaultWorkspace: '/root/workspace',
  },
}));

vi.mock('../config/index.js', () => ({ config: h.config }));

vi.mock('../models/cloud-host.js', () => ({
  HARNESS_TYPES: ['OPENCODE', 'KIMI_CODE'],
  CloudHost: {
    countDocuments: vi.fn(),
    create: vi.fn(),
    deleteOne: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
    findById: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
  },
}));

vi.mock('../models/controller.js', () => ({
  Controller: { deleteOne: vi.fn() },
}));

vi.mock('../models/controller-key.js', () => ({
  ControllerKey: { deleteOne: vi.fn() },
}));

vi.mock('../models/controller-workspace.js', () => ({
  ControllerWorkspace: { deleteOne: vi.fn() },
}));

vi.mock('../models/session.js', () => ({
  Session: { countDocuments: vi.fn(), find: vi.fn() },
}));

vi.mock('./billing-client.js', () => ({
  BillingServiceUnavailableError: class BillingServiceUnavailableError extends Error {},
  billingClient: {
    getAccount: vi.fn(),
    createCloudHostApiKey: vi.fn(),
    revokeApiKeysByHost: vi.fn(),
  },
}));

vi.mock('./cloud-controller-client.js', () => ({
  CloudControllerUnavailableError: class extends Error {},
  CloudControllerClient: class {},
  cloudControllerClient: {
    startHarness: vi.fn(),
    destroyContainer: vi.fn(),
    listContainers: vi.fn(),
  },
}));

vi.mock('./cloud-workload-reader.js', () => ({
  harnessSlug: (type: string) => type.toLowerCase(),
  cloudWorkloadReader: { findHarnessPreset: vi.fn() },
}));

vi.mock('./key-cache.js', () => ({ evictKeyById: vi.fn() }));

vi.mock('./model.js', () => ({ modelService: { findAll: vi.fn() } }));

vi.mock('./session.js', () => ({
  sessionService: { create: vi.fn(), endByController: vi.fn() },
}));

vi.mock('./controller-key.js', () => ({
  controllerKeyService: { createForCloudHost: vi.fn() },
}));

vi.mock('./controller.js', () => ({
  controllerService: {
    createCloudHostController: vi.fn(),
    markCloudHostOffline: vi.fn(),
  },
}));

vi.mock('./controller-workspace.js', () => ({
  controllerWorkspaceService: { ensureCloudHostWorkspace: vi.fn() },
}));

const catalogMock = vi.hoisted(() => ({
  listStandard: vi.fn(),
  findById: vi.fn(),
  findByPresetKey: vi.fn(),
  findGithubPreset: vi.fn(),
}));

vi.mock('./cloud-workload-catalog.js', () => ({ cloudWorkloadCatalog: catalogMock }));

import { CloudHostService, toCloudHostGraphQLError } from './cloud-host-service.js';
import { CloudHost } from '../models/cloud-host.js';
import { Controller } from '../models/controller.js';
import { ControllerKey } from '../models/controller-key.js';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { Session } from '../models/session.js';
import { billingClient, BillingServiceUnavailableError } from './billing-client.js';
import { cloudControllerClient } from './cloud-controller-client.js';
import { cloudWorkloadReader } from './cloud-workload-reader.js';
import { evictKeyById } from './key-cache.js';
import { modelService } from './model.js';
import { sessionService } from './session.js';
import { controllerKeyService } from './controller-key.js';
import { controllerService } from './controller.js';
import { controllerWorkspaceService } from './controller-workspace.js';

const HOST_ID = '507f1f77bcf86cd799439011';
const CONTROLLER_ID = '507f1f77bcf86cd799439012';
const WORKSPACE_ID = '507f1f77bcf86cd799439013';

function oid(id: string) {
  return { toString: () => id };
}

function chain(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value) } as never;
}

function hostDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: oid(HOST_ID),
    userId: oid('user-1'),
    name: 'my-cloud',
    harnessTypes: ['OPENCODE'],
    status: 'STARTING',
    controllerId: oid(CONTROLLER_ID),
    keyId: oid('key-1'),
    workspaceId: oid(WORKSPACE_ID),
    containerId: 'container-1',
    defaultSessionId: null,
    createdAt: new Date('2026-10-20T00:00:00.000Z'),
    readyAt: null,
    stoppedAt: null,
    failureReason: null,
    deletedAt: null,
    ...overrides,
  };
}

function setupCreateSuccess() {
  vi.mocked(CloudHost.countDocuments).mockResolvedValue(0 as never);
  vi.mocked(billingClient.getAccount).mockResolvedValue({ id: 'account-1' } as never);
  vi.mocked(controllerKeyService.createForCloudHost).mockResolvedValue({
    key: { id: 'key-1' },
    rawKey: 'zag_k_1_raw',
  } as never);
  vi.mocked(controllerService.createCloudHostController).mockResolvedValue({} as never);
  vi.mocked(controllerWorkspaceService.ensureCloudHostWorkspace).mockResolvedValue({
    id: WORKSPACE_ID,
  } as never);
  vi.mocked(CloudHost.create).mockResolvedValue({} as never);
  vi.mocked(modelService.findAll).mockResolvedValue([
    { name: 'model-a', isEnabled: true, contextLength: 128000 },
    { name: 'model-a', isEnabled: true, contextLength: 64000 },
    { name: 'model-b', isEnabled: true, contextLength: null },
    { name: 'disabled', isEnabled: false, contextLength: 1000 },
  ] as never);
  vi.mocked(billingClient.createCloudHostApiKey).mockResolvedValue({
    apiKey: { id: 'model-key-1' },
    secret: 'zag_sk_secret',
  } as never);
  vi.mocked(cloudWorkloadReader.findHarnessPreset).mockResolvedValue({
    id: 'preset-1',
    name: 'OpenCode（Harness）',
    initScript: 'echo',
    postScript: null,
    harnessType: 'OPENCODE',
  } as never);
  vi.mocked(cloudControllerClient.startHarness).mockResolvedValue({
    id: 'container-1',
    status: 'creating',
  } as never);
  vi.mocked(CloudHost.findOneAndUpdate).mockReturnValue(
    chain(hostDoc({ containerId: 'container-1' })) as never,
  );
  vi.mocked(CloudHost.findById).mockReturnValue(
    chain(hostDoc({ containerId: 'container-1' })) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.config.harnessEnabled = true;
  vi.mocked(CloudHost.findByIdAndUpdate).mockReset();
  vi.mocked(CloudHost.findOneAndUpdate).mockReset();
  vi.mocked(CloudHost.findById).mockReset();
  vi.mocked(billingClient.revokeApiKeysByHost).mockResolvedValue(undefined as never);
  vi.mocked(evictKeyById).mockResolvedValue(undefined as never);
  vi.mocked(ControllerWorkspace.deleteOne).mockResolvedValue(undefined as never);
  vi.mocked(Controller.deleteOne).mockResolvedValue(undefined as never);
  vi.mocked(ControllerKey.deleteOne).mockResolvedValue(undefined as never);
  vi.mocked(CloudHost.deleteOne).mockResolvedValue(undefined as never);
  vi.mocked(CloudHost.updateOne).mockResolvedValue(undefined as never);
});

describe('CloudHostService', () => {
  const service = new CloudHostService();

  describe('capabilities', () => {
    it('returns every harness whose preset exists', async () => {
      vi.mocked(cloudWorkloadReader.findHarnessPreset).mockResolvedValue({} as never);
      await expect(service.getCapabilities()).resolves.toEqual({
        enabled: true,
        supportedHarnesses: ['OPENCODE', 'KIMI_CODE'],
      });
    });

    it('T-HL-API10: skips harnesses whose preset is missing', async () => {
      vi.mocked(cloudWorkloadReader.findHarnessPreset).mockImplementation((async (type: string) => {
        if (type === 'OPENCODE') return {};
        throw new Error('missing');
      }) as never);
      await expect(service.getCapabilities()).resolves.toEqual({
        enabled: true,
        supportedHarnesses: ['OPENCODE'],
      });
    });

    it('returns disabled when harness feature is off', async () => {
      h.config.harnessEnabled = false;
      await expect(service.getCapabilities()).resolves.toEqual({
        enabled: false,
        supportedHarnesses: [],
      });
    });

    it('returns empty list when preset is missing', async () => {
      vi.mocked(cloudWorkloadReader.findHarnessPreset).mockRejectedValue(new Error('missing'));
      await expect(service.getCapabilities()).resolves.toEqual({
        enabled: true,
        supportedHarnesses: [],
      });
    });
  });

  describe('create validation', () => {
    it('rejects when feature disabled', async () => {
      h.config.harnessEnabled = false;
      await expect(
        service.create('user-1', { name: 'x', harnessTypes: ['OPENCODE'] }),
      ).rejects.toThrow('harness feature is disabled');
    });

    it('rejects missing configuration without writing records', async () => {
      h.config.cloudHostModelBaseUrl = '';
      await expect(
        service.create('user-1', { name: 'x', harnessTypes: ['OPENCODE'] }),
      ).rejects.toThrow('cloud host is not configured');
      expect(CloudHost.create).not.toHaveBeenCalled();
      h.config.cloudHostModelBaseUrl = 'http://admin-api:8002/v1';
    });

    it.each([
      ['   ', 'name is required'],
      ['x'.repeat(65), 'name is too long'],
    ])('validates name %s', async (name, message) => {
      await expect(service.create('user-1', { name, harnessTypes: ['OPENCODE'] })).rejects.toThrow(
        message,
      );
    });

    it('validates harness types', async () => {
      await expect(service.create('user-1', { name: 'x', harnessTypes: [] })).rejects.toThrow(
        'at least one harness type is required',
      );
      await expect(
        service.create('user-1', { name: 'x', harnessTypes: ['UNKNOWN'] }),
      ).rejects.toThrow('unsupported harness type: UNKNOWN');
    });

    it('enforces one active host per user', async () => {
      vi.mocked(CloudHost.countDocuments).mockResolvedValue(1 as never);
      vi.mocked(cloudWorkloadReader.findHarnessPreset).mockResolvedValue({} as never);
      await expect(
        service.create('user-1', { name: 'x', harnessTypes: ['OPENCODE'] }),
      ).rejects.toThrow('too many cloud hosts');
      expect(CloudHost.create).not.toHaveBeenCalled();
    });
  });

  describe('create orchestration', () => {
    it('creates controller/key/host and starts harness container (no default workspace)', async () => {
      setupCreateSuccess();
      const result = await service.create('user-1', {
        name: ' my-cloud ',
        harnessTypes: ['OPENCODE'],
      });

      expect(result.name).toBe('my-cloud');
      expect(controllerKeyService.createForCloudHost).toHaveBeenCalled();
      expect(controllerService.createCloudHostController).toHaveBeenCalledWith(
        'user-1',
        expect.any(String),
        'my-cloud',
        'key-1',
      );
      expect(controllerWorkspaceService.ensureCloudHostWorkspace).not.toHaveBeenCalled();
      expect(CloudHost.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'STARTING', harnessTypes: ['OPENCODE'], workspaceId: null }),
      );
      const payload = vi.mocked(cloudControllerClient.startHarness).mock.calls[0][0];
      expect(payload).toMatchObject({
        hostId: expect.any(String),
        controllerKeyId: 'key-1',
        containerApiKeyId: 'model-key-1',
        hostName: 'my-cloud',
        harnessTypes: ['opencode'],
        billingAccountId: 'account-1',
        agentGearMinVersion: '2.6.0',
      });
      expect(payload.workloadPlan).toEqual([
        { workloadId: 'preset-1', params: {}, implicit: false, required: true },
      ]);
      expect(payload.secrets).toMatchObject({
        hostKey: 'zag_k_1_raw',
        modelApiKey: 'zag_sk_secret',
        modelIds: '["model-a","model-b"]',
        // 同名保留首个有效值；contextLength=null 与禁用模型不出现
        modelContextLengths: '{"model-a":128000}',
        defaultWorkspace: '/root/workspace',
      });
    });

    it('T-HL-API9: 仅 KIMI_CODE 时 agentGearMinVersion=2.8.0', async () => {
      setupCreateSuccess();
      await service.create('user-1', { name: 'kimi-cloud', harnessTypes: ['KIMI_CODE'] });

      const payload = vi.mocked(cloudControllerClient.startHarness).mock.calls[0][0];
      expect(payload.harnessTypes).toEqual(['kimi_code']);
      expect(payload.agentGearMinVersion).toBe('2.8.0');
    });

    it('T-HL-API9b: 多选取按类型最大值（opencode+kimi_code → 2.8.0）', async () => {
      setupCreateSuccess();
      await service.create('user-1', { name: 'multi', harnessTypes: ['OPENCODE', 'KIMI_CODE'] });

      const payload = vi.mocked(cloudControllerClient.startHarness).mock.calls[0][0];
      expect(payload.agentGearMinVersion).toBe('2.8.0');
    });

    it('T-CW1: never creates a default workspace at create time', async () => {
      setupCreateSuccess();
      await service.create('user-1', { name: 'my-cloud', harnessTypes: ['OPENCODE'] });

      // 默认工作区只在「Git 项目设置」初始化 Github 项目时按 targetPath 创建
      expect(controllerWorkspaceService.ensureCloudHostWorkspace).not.toHaveBeenCalled();
      expect(CloudHost.create).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: null }),
      );
    });

    it('T-CW2: ready without a default workspace skips default session creation', async () => {
      const starting = hostDoc({ status: 'STARTING', workspaceId: null });
      const running = hostDoc({ status: 'RUNNING', workspaceId: null });
      vi.mocked(CloudHost.findOne).mockReturnValueOnce(chain(starting) as never);
      vi.mocked(CloudHost.findOneAndUpdate).mockReturnValue(chain(running) as never);
      vi.mocked(Session.countDocuments).mockResolvedValue(0 as never);

      await expect(service.handleReady(HOST_ID)).resolves.toMatchObject({
        status: 'RUNNING',
        defaultSessionId: null,
        hasDefaultWorkspace: false,
      });
      expect(sessionService.create).not.toHaveBeenCalled();
    });

    it('persists createDefaultSession=false so ready skips the default session (D1)', async () => {
      setupCreateSuccess();
      await service.create('user-1', {
        name: 'with-project',
        harnessTypes: ['OPENCODE'],
        createDefaultSession: false,
      });

      expect(CloudHost.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'STARTING', createDefaultSession: false }),
      );
    });

    it('defaults createDefaultSession to true when omitted', async () => {
      setupCreateSuccess();
      await service.create('user-1', { name: 'legacy-shape', harnessTypes: ['OPENCODE'] });

      expect(CloudHost.create).toHaveBeenCalledWith(
        expect.objectContaining({ createDefaultSession: true }),
      );
    });

    it('rolls back and maps control plane failure', async () => {
      setupCreateSuccess();      vi.mocked(cloudControllerClient.startHarness).mockRejectedValue(new Error('boom'));

      await expect(
        service.create('user-1', { name: 'my-cloud', harnessTypes: ['OPENCODE'] }),
      ).rejects.toThrow('control plane unavailable');

      expect(billingClient.revokeApiKeysByHost).toHaveBeenCalled();
      expect(controllerWorkspaceService.ensureCloudHostWorkspace).not.toHaveBeenCalled();
      expect(ControllerWorkspace.deleteOne).not.toHaveBeenCalled();
      expect(Controller.deleteOne).toHaveBeenCalled();
      expect(evictKeyById).toHaveBeenCalledWith('key-1');
      expect(ControllerKey.deleteOne).toHaveBeenCalled();
      expect(CloudHost.deleteOne).toHaveBeenCalled();
      expect(CloudHost.create).toHaveBeenCalled();
    });

    it('maps model key mint failure to billing service unavailable', async () => {
      setupCreateSuccess();
      vi.mocked(billingClient.createCloudHostApiKey).mockRejectedValue(
        new BillingServiceUnavailableError('down'),
      );

      await expect(
        service.create('user-1', { name: 'my-cloud', harnessTypes: ['OPENCODE'] }),
      ).rejects.toThrow('billing service unavailable');
      expect(cloudControllerClient.startHarness).not.toHaveBeenCalled();
      expect(CloudHost.deleteOne).toHaveBeenCalled();
    });

    it('A-1 reclaims the started container when a concurrent stop wins the CAS', async () => {
      setupCreateSuccess();
      // stop 抢先 CAS 成功；创建侧回写未命中。
      vi.mocked(CloudHost.findOneAndUpdate).mockReturnValue(chain(null) as never);
      vi.mocked(CloudHost.findById).mockReturnValue(
        chain(hostDoc({ status: 'STOPPED', containerId: null })) as never,
      );

      const result = await service.create('user-1', {
        name: 'my-cloud',
        harnessTypes: ['OPENCODE'],
      });

      expect(cloudControllerClient.destroyContainer).toHaveBeenCalledWith('container-1');
      expect(billingClient.revokeApiKeysByHost).toHaveBeenCalled();
      expect(result.status).toBe('STOPPED');
      expect(result.containerId).toBeNull();
    });

    it('R2-18 maps only cloud-host active unique-index conflicts to too many cloud hosts', async () => {
      setupCreateSuccess();
      vi.mocked(CloudHost.create).mockRejectedValue(
        Object.assign(new Error('E11000 duplicate key error ... uniq_active_cloud_host_per_user'), {
          code: 11000,
        }),
      );
      await expect(
        service.create('user-1', { name: 'my-cloud', harnessTypes: ['OPENCODE'] }),
      ).rejects.toThrow('too many cloud hosts');
    });

    it('R2-18 rethrows unrelated unique-key conflicts', async () => {
      setupCreateSuccess();
      vi.mocked(CloudHost.create).mockRejectedValue(
        Object.assign(new Error('E11000 duplicate key error ... controllerkeys.keyHash_1'), {
          code: 11000,
        }),
      );
      await expect(
        service.create('user-1', { name: 'my-cloud', harnessTypes: ['OPENCODE'] }),
      ).rejects.toThrow('controllerkeys.keyHash_1');
    });

    it('serializes concurrent creates so only one host can start', async () => {
      setupCreateSuccess();
      vi.mocked(CloudHost.countDocuments)
        .mockResolvedValueOnce(0 as never)
        .mockResolvedValue(1 as never);

      const results = await Promise.allSettled([
        service.create('user-1', { name: 'first', harnessTypes: ['OPENCODE'] }),
        service.create('user-1', { name: 'second', harnessTypes: ['OPENCODE'] }),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect(String(rejected.reason)).toContain('too many cloud hosts');
      expect(cloudControllerClient.startHarness).toHaveBeenCalledTimes(1);
    });
  });

  describe('create with workloadIds (T-CH-C1..C5)', () => {
    const DOCKER_ID = '507f1f77bcf86cd7994390a1';
    const DOTNET_ID = '507f1f77bcf86cd7994390a2';
    const ASPIRE_ID = '507f1f77bcf86cd7994390a3';
    const HARNESS_ID = '507f1f77bcf86cd7994390a4';

    function catalogItem(overrides: Record<string, unknown>) {
      return {
        name: 'w',
        paramSchema: [],
        dependsOnWorkloadIds: [],
        isPreset: false,
        workloadKind: 'standard',
        initScript: 'echo',
        ...overrides,
      };
    }

    const DOCKER = catalogItem({ id: DOCKER_ID, name: 'Docker' });
    const DOTNET = catalogItem({ id: DOTNET_ID, name: '.NET' });
    const ASPIRE = catalogItem({
      id: ASPIRE_ID,
      name: 'Aspire',
      dependsOnWorkloadIds: [DOCKER_ID, DOTNET_ID],
    });

    beforeEach(() => {
      catalogMock.listStandard.mockResolvedValue([DOCKER, DOTNET, ASPIRE]);
      catalogMock.findById.mockImplementation((id: string) =>
        Promise.resolve(
          id === HARNESS_ID ? catalogItem({ id: HARNESS_ID, name: 'OpenCode', workloadKind: 'harness' }) : null,
        ),
      );
    });

    it('T-CH-C1: 不带 workloadIds 时 plan 与今天一致', async () => {
      setupCreateSuccess();

      await service.create('user-1', { name: 'my-cloud', harnessTypes: ['OPENCODE'] });

      const payload = vi.mocked(cloudControllerClient.startHarness).mock.calls[0][0];
      expect(payload.workloadPlan).toEqual([
        { workloadId: 'preset-1', params: {}, implicit: false, required: true },
      ]);
      expect(catalogMock.listStandard).not.toHaveBeenCalled();
    });

    it('T-CH-C2: 带 Docker 时 plan 含 harness + Docker（standard 非必须）', async () => {
      setupCreateSuccess();

      await service.create('user-1', {
        name: 'my-cloud',
        harnessTypes: ['OPENCODE'],
        workloadIds: [DOCKER_ID],
      });

      const payload = vi.mocked(cloudControllerClient.startHarness).mock.calls[0][0];
      expect(payload.workloadPlan).toEqual([
        { workloadId: 'preset-1', params: {}, implicit: false, required: true },
        { workloadId: DOCKER_ID, params: {}, implicit: false, required: false },
      ]);
    });

    it('T-CH-C3: 带 Aspire 时依赖先行（Docker → .NET → Aspire）', async () => {
      setupCreateSuccess();

      await service.create('user-1', {
        name: 'my-cloud',
        harnessTypes: ['OPENCODE'],
        workloadIds: [ASPIRE_ID],
      });

      const payload = vi.mocked(cloudControllerClient.startHarness).mock.calls[0][0];
      expect(payload.workloadPlan?.map((entry) => entry.workloadId)).toEqual([
        'preset-1',
        DOCKER_ID,
        DOTNET_ID,
        ASPIRE_ID,
      ]);
      expect(payload.workloadPlan?.[1]).toMatchObject({ implicit: true, required: false });
      expect(payload.workloadPlan?.[3]).toMatchObject({ implicit: false, required: false });
    });

    it('T-CH-C4: harness ID / 不存在 / 超量在落库前报错且不启动容器', async () => {
      setupCreateSuccess();

      await expect(
        service.create('user-1', {
          name: 'my-cloud',
          harnessTypes: ['OPENCODE'],
          workloadIds: [HARNESS_ID],
        }),
      ).rejects.toThrow('workload is not installable: OpenCode');

      await expect(
        service.create('user-1', {
          name: 'my-cloud',
          harnessTypes: ['OPENCODE'],
          workloadIds: ['507f1f77bcf86cd7994390ff'],
        }),
      ).rejects.toThrow('invalid workload: 507f1f77bcf86cd7994390ff');

      await expect(
        service.create('user-1', {
          name: 'my-cloud',
          harnessTypes: ['OPENCODE'],
          workloadIds: ['a', 'b', 'c', 'd', 'e', 'f'],
        }),
      ).rejects.toThrow('too many workloads (max 5)');

      expect(CloudHost.create).not.toHaveBeenCalled();
      expect(cloudControllerClient.startHarness).not.toHaveBeenCalled();
    });

    it('T-CH-C5: 重复 ID 去重后只出现一次', async () => {
      setupCreateSuccess();

      await service.create('user-1', {
        name: 'my-cloud',
        harnessTypes: ['OPENCODE'],
        workloadIds: [DOCKER_ID, DOCKER_ID],
      });

      const payload = vi.mocked(cloudControllerClient.startHarness).mock.calls[0][0];
      expect(payload.workloadPlan?.filter((entry) => entry.workloadId === DOCKER_ID)).toHaveLength(1);
    });
  });

  describe('list and stop impact', () => {
    it('maps hosts with active session counts and excludes soft-deleted hosts', async () => {
      vi.mocked(CloudHost.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            hostDoc({ status: 'RUNNING' }),
            hostDoc({ _id: oid('507f1f77bcf86cd799439099'), status: 'STOPPED' }),
          ]),
        }),
      } as never);
      vi.mocked(Session.countDocuments)
        .mockResolvedValueOnce(2 as never)
        .mockResolvedValueOnce(0 as never);

      const result = await service.list('user-1');

      expect(CloudHost.find).toHaveBeenCalledWith({ userId: 'user-1', deletedAt: null });
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ status: 'RUNNING', activeSessionCount: 2 });
      expect(result[1]).toMatchObject({ status: 'STOPPED', activeSessionCount: 0 });
    });

    it('returns stop impact session summaries', async () => {
      vi.mocked(CloudHost.findOne).mockReturnValue(chain(hostDoc({ status: 'RUNNING' })) as never);
      vi.mocked(Session.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            { _id: oid('sess-1'), title: 'working', status: 'idling', acpServerType: 'opencode' },
          ]),
        }),
      } as never);

      const impact = await service.stopImpact(HOST_ID, 'user-1');

      expect(impact).toEqual({
        activeSessionCount: 1,
        sessionsWillBeLost: true,
        sessions: [
          { id: 'sess-1', title: 'working', status: 'idling', acpServerType: 'opencode' },
        ],
      });
    });
  });

  describe('stop', () => {
    it('rejects when active sessions exist and force is false', async () => {
      vi.mocked(CloudHost.findOne).mockReturnValue(chain(hostDoc({ status: 'RUNNING' })) as never);
      vi.mocked(CloudHost.findOneAndUpdate).mockReturnValueOnce(
        chain(hostDoc({ status: 'STOPPING' })) as never,
      );
      vi.mocked(Session.countDocuments).mockResolvedValue(2 as never);

      await expect(service.stop(HOST_ID, 'user-1', false)).rejects.toThrow(
        'stopping this cloud host will permanently lose all active sessions',
      );
      expect(cloudControllerClient.destroyContainer).not.toHaveBeenCalled();
    });

    it('ends sessions, destroys container, revokes keys and stops host', async () => {
      vi.mocked(CloudHost.findOne).mockReturnValue(chain(hostDoc({ status: 'RUNNING' })) as never);
      vi.mocked(Session.countDocuments).mockResolvedValue(1 as never);
      vi.mocked(CloudHost.findOneAndUpdate)
        .mockReturnValueOnce(chain(hostDoc({ status: 'STOPPING' })) as never)
        .mockReturnValueOnce(chain(hostDoc({ status: 'STOPPED', containerId: null })) as never);
      vi.mocked(sessionService.endByController).mockResolvedValue(1 as never);
      vi.mocked(cloudControllerClient.destroyContainer).mockResolvedValue(undefined as never);

      const result = await service.stop(HOST_ID, 'user-1', true);

      expect(Session.countDocuments).toHaveBeenCalled();
      expect(sessionService.endByController).toHaveBeenCalledWith(CONTROLLER_ID, 'user-1');
      expect(cloudControllerClient.destroyContainer).toHaveBeenCalledWith('container-1');
      expect(billingClient.revokeApiKeysByHost).toHaveBeenCalledWith(HOST_ID);
      expect(result.status).toBe('STOPPED');
      expect(result.containerId).toBeNull();
    });

    it('A-1 destroys the containerId observed after the STOPPING CAS', async () => {
      // 停止前快照 containerId=null；CAS 后并发创建回写 containerId → 必须按最新快照销毁。
      vi.mocked(CloudHost.findOne).mockReturnValue(
        chain(hostDoc({ status: 'STARTING', containerId: null })) as never,
      );
      vi.mocked(Session.countDocuments).mockResolvedValue(0 as never);
      vi.mocked(CloudHost.findOneAndUpdate)
        .mockReturnValueOnce(
          chain(hostDoc({ status: 'STOPPING', containerId: 'container-late' })) as never,
        )
        .mockReturnValueOnce(chain(hostDoc({ status: 'STOPPED', containerId: null })) as never);
      vi.mocked(sessionService.endByController).mockResolvedValue(0 as never);
      vi.mocked(cloudControllerClient.destroyContainer).mockResolvedValue(undefined as never);

      const result = await service.stop(HOST_ID, 'user-1', false);

      expect(cloudControllerClient.destroyContainer).toHaveBeenCalledWith('container-late');
      expect(result.status).toBe('STOPPED');
    });

    it('A-9 reverts to the previous status when new active sessions appear before stop', async () => {
      vi.mocked(CloudHost.findOne).mockReturnValue(chain(hostDoc({ status: 'RUNNING' })) as never);
      vi.mocked(Session.countDocuments).mockResolvedValue(1 as never);
      vi.mocked(CloudHost.findOneAndUpdate).mockReturnValueOnce(
        chain(hostDoc({ status: 'STOPPING' })) as never,
      );

      await expect(service.stop(HOST_ID, 'user-1', false)).rejects.toThrow(
        'stopping this cloud host will permanently lose all active sessions',
      );
      expect(CloudHost.updateOne).toHaveBeenCalledWith(
        { _id: HOST_ID, userId: 'user-1', status: 'STOPPING' },
        { $set: { status: 'RUNNING' } },
      );
      expect(cloudControllerClient.destroyContainer).not.toHaveBeenCalled();
    });

    it('keeps STOPPING when control plane is unavailable', async () => {
      vi.mocked(CloudHost.findOne).mockReturnValue(chain(hostDoc({ status: 'RUNNING' })) as never);
      vi.mocked(Session.countDocuments).mockResolvedValue(0 as never);
      vi.mocked(CloudHost.findOneAndUpdate).mockReturnValue(
        chain(hostDoc({ status: 'STOPPING' })) as never,
      );
      vi.mocked(sessionService.endByController).mockResolvedValue(0 as never);
      vi.mocked(cloudControllerClient.destroyContainer).mockRejectedValue(new Error('down'));

      await expect(service.stop(HOST_ID, 'user-1', false)).rejects.toThrow(
        'control plane unavailable',
      );
      expect(CloudHost.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('is idempotent for terminal hosts', async () => {
      vi.mocked(CloudHost.findOne).mockReturnValue(chain(hostDoc({ status: 'STOPPED' })) as never);
      vi.mocked(Session.countDocuments).mockResolvedValue(0 as never);
      await expect(service.stop(HOST_ID, 'user-1')).resolves.toMatchObject({ status: 'STOPPED' });
      expect(cloudControllerClient.destroyContainer).not.toHaveBeenCalled();
    });

    it('does not leak existence to non-owner', async () => {
      vi.mocked(CloudHost.findOne).mockReturnValue(chain(null) as never);
      await expect(service.stop(HOST_ID, 'other')).rejects.toThrow('Cloud host not found');
    });
  });

  describe('delete', () => {
    it('rejects running hosts', async () => {
      vi.mocked(CloudHost.findOne).mockReturnValue(chain(hostDoc({ status: 'RUNNING' })) as never);
      await expect(service.delete(HOST_ID, 'user-1')).rejects.toThrow(
        'stop the cloud host before deleting',
      );
    });

    it('soft deletes, revokes key and keeps controller row', async () => {
      vi.mocked(CloudHost.findOne).mockReturnValue(chain(hostDoc({ status: 'STOPPED' })) as never);
      await expect(service.delete(HOST_ID, 'user-1')).resolves.toBe(true);
      expect(billingClient.revokeApiKeysByHost).toHaveBeenCalledWith(HOST_ID);
      expect(evictKeyById).toHaveBeenCalledWith('key-1');
      expect(ControllerKey.deleteOne).toHaveBeenCalled();
      expect(controllerService.markCloudHostOffline).toHaveBeenCalledWith(
        CONTROLLER_ID,
        'user-1',
      );
      expect(CloudHost.updateOne).toHaveBeenCalledWith(
        { _id: HOST_ID },
        { $set: { deletedAt: expect.any(Date) } },
      );
      expect(Controller.deleteOne).not.toHaveBeenCalled();
    });

    it('is idempotent for already soft-deleted hosts', async () => {
      vi.mocked(CloudHost.findOne).mockReturnValue(
        chain(hostDoc({ status: 'STOPPED', deletedAt: new Date() })) as never,
      );
      await expect(service.delete(HOST_ID, 'user-1')).resolves.toBe(true);
      expect(CloudHost.updateOne).not.toHaveBeenCalled();
      expect(ControllerKey.deleteOne).not.toHaveBeenCalled();
    });
  });

  describe('callbacks', () => {
    it('ready atomically creates default session and transitions to RUNNING (R2-5)', async () => {
      const starting = hostDoc({ status: 'STARTING' });
      const running = hostDoc({ status: 'RUNNING', defaultSessionId: oid('sess-1') });
      vi.mocked(CloudHost.findOne).mockReturnValueOnce(chain(starting) as never);
      vi.mocked(CloudHost.findOneAndUpdate).mockReturnValue(chain(running) as never);
      vi.mocked(sessionService.create).mockResolvedValue({ id: 'sess-1' } as never);
      vi.mocked(Session.countDocuments).mockResolvedValue(1 as never);

      const result = await service.handleReady(HOST_ID);

      expect(sessionService.create).toHaveBeenCalledWith('user-1', {
        controllerId: CONTROLLER_ID,
        workspaceId: WORKSPACE_ID,
        acpServerType: 'opencode',
        allowStartingCloudHost: true,
      });
      // 状态与会话 id 合并为一次 CAS 落库，避免 RUNNING+null 中间态
      expect(CloudHost.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: HOST_ID, deletedAt: null, status: 'STARTING' },
        {
          $set: {
            status: 'RUNNING',
            readyAt: expect.any(Date),
            defaultSessionId: 'sess-1',
          },
        },
        { new: true },
      );
      expect(result).toMatchObject({ status: 'RUNNING', defaultSessionId: 'sess-1' });
    });

    it('ready keeps RUNNING (without session id) when default session creation fails', async () => {
      const starting = hostDoc({ status: 'STARTING' });
      const running = hostDoc({ status: 'RUNNING' });
      vi.mocked(CloudHost.findOne).mockReturnValueOnce(chain(starting) as never);
      vi.mocked(CloudHost.findOneAndUpdate).mockReturnValue(chain(running) as never);
      vi.mocked(sessionService.create).mockRejectedValue(new Error('agent offline'));
      vi.mocked(Session.countDocuments).mockResolvedValue(0 as never);

      await expect(service.handleReady(HOST_ID)).resolves.toMatchObject({
        status: 'RUNNING',
        defaultSessionId: null,
      });
      expect(CloudHost.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: HOST_ID, deletedAt: null, status: 'STARTING' },
        { $set: { status: 'RUNNING', readyAt: expect.any(Date) } },
        { new: true },
      );
    });

    it('does not create a default session when createDefaultSession=false', async () => {
      const starting = hostDoc({ status: 'STARTING', createDefaultSession: false });
      const running = hostDoc({ status: 'RUNNING', createDefaultSession: false });
      vi.mocked(CloudHost.findOne).mockReturnValueOnce(chain(starting) as never);
      vi.mocked(CloudHost.findOneAndUpdate).mockReturnValue(chain(running) as never);
      vi.mocked(Session.countDocuments).mockResolvedValue(0 as never);

      await expect(service.handleReady(HOST_ID)).resolves.toMatchObject({
        status: 'RUNNING',
        defaultSessionId: null,
      });
      expect(sessionService.create).not.toHaveBeenCalled();
      expect(CloudHost.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: HOST_ID, deletedAt: null, status: 'STARTING' },
        { $set: { status: 'RUNNING', readyAt: expect.any(Date) } },
        { new: true },
      );
    });

    it('does not create a default session when multiple harness types are selected', async () => {      const starting = hostDoc({ status: 'STARTING', harnessTypes: ['OPENCODE', 'CODEX'] });
      const running = hostDoc({ status: 'RUNNING', harnessTypes: ['OPENCODE', 'CODEX'] });
      vi.mocked(CloudHost.findOne)
        .mockReturnValueOnce(chain(starting) as never)
        .mockReturnValueOnce(chain(running) as never);
      vi.mocked(CloudHost.findOneAndUpdate).mockReturnValue(chain(running) as never);
      vi.mocked(Session.countDocuments).mockResolvedValue(0 as never);

      await expect(service.handleReady(HOST_ID)).resolves.toMatchObject({
        defaultSessionId: null,
      });
      expect(sessionService.create).not.toHaveBeenCalled();
    });

    it('repeated ready on RUNNING host does not create a duplicate session', async () => {
      const running = hostDoc({ status: 'RUNNING', defaultSessionId: oid('sess-existing') });
      vi.mocked(CloudHost.findOne).mockReturnValue(chain(running) as never);
      vi.mocked(Session.countDocuments).mockResolvedValue(1 as never);

      await expect(service.handleReady(HOST_ID)).resolves.toMatchObject({
        status: 'RUNNING',
        defaultSessionId: 'sess-existing',
      });
      expect(sessionService.create).not.toHaveBeenCalled();
      expect(CloudHost.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('repeated ready without a default workspace does not backfill a session', async () => {
      const running = hostDoc({ status: 'RUNNING', workspaceId: null, defaultSessionId: null });
      vi.mocked(CloudHost.findOne).mockReturnValue(chain(running) as never);
      vi.mocked(Session.countDocuments).mockResolvedValue(0 as never);

      await expect(service.handleReady(HOST_ID)).resolves.toMatchObject({
        status: 'RUNNING',
        defaultSessionId: null,
        hasDefaultWorkspace: false,
      });
      expect(sessionService.create).not.toHaveBeenCalled();
      expect(CloudHost.updateOne).not.toHaveBeenCalledWith(
        { _id: HOST_ID, defaultSessionId: null },
        expect.anything(),
      );
    });

    it('terminal ends sessions and revokes model key', async () => {
      vi.mocked(CloudHost.findOne).mockReturnValue(chain(hostDoc({ status: 'RUNNING' })) as never);
      vi.mocked(CloudHost.findOneAndUpdate).mockReturnValue(
        chain(hostDoc({ status: 'STOPPED' })) as never,
      );
      vi.mocked(sessionService.endByController).mockResolvedValue(2 as never);

      await expect(
        service.handleTerminal(HOST_ID, { status: 'stopped' }),
      ).resolves.toMatchObject({ status: 'STOPPED' });
      expect(CloudHost.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: HOST_ID, status: { $in: ['STARTING', 'RUNNING', 'STOPPING'] } },
        {
          $set: {
            status: 'STOPPED',
            stoppedAt: expect.any(Date),
            containerId: null,
            failureReason: null,
          },
        },
        { new: true },
      );
      expect(sessionService.endByController).toHaveBeenCalledWith(CONTROLLER_ID, 'user-1');
      expect(billingClient.revokeApiKeysByHost).toHaveBeenCalledWith(HOST_ID);
    });

    it('terminal maps failed status with reason (asserts persisted $set, R2-4)', async () => {
      vi.mocked(CloudHost.findOne).mockReturnValue(chain(hostDoc({ status: 'STARTING' })) as never);
      vi.mocked(CloudHost.findOneAndUpdate).mockReturnValue(
        chain(hostDoc({ status: 'FAILED', failureReason: 'job failed' })) as never,
      );
      vi.mocked(sessionService.endByController).mockResolvedValue(0 as never);

      const result = await service.handleTerminal(HOST_ID, {
        status: 'failed',
        reason: 'job failed',
      });
      expect(CloudHost.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: HOST_ID, status: { $in: ['STARTING', 'RUNNING', 'STOPPING'] } },
        {
          $set: {
            status: 'FAILED',
            stoppedAt: expect.any(Date),
            containerId: null,
            failureReason: 'job failed',
          },
        },
        { new: true },
      );
      expect(result).toMatchObject({ status: 'FAILED', failureReason: 'job failed' });
    });

    it('repeated terminal callback is idempotent and replays side effects', async () => {
      vi.mocked(CloudHost.findOne).mockReturnValue(chain(hostDoc({ status: 'STOPPED' })) as never);

      await expect(
        service.handleTerminal(HOST_ID, { status: 'stopped' }),
      ).resolves.toMatchObject({ status: 'STOPPED' });
      expect(CloudHost.findOneAndUpdate).not.toHaveBeenCalled();
      expect(sessionService.endByController).toHaveBeenCalledWith(CONTROLLER_ID, 'user-1');
      expect(billingClient.revokeApiKeysByHost).toHaveBeenCalledWith(HOST_ID);
    });
  });

  describe('graphql error mapping', () => {
    it('A-6 passes whitelisted contract messages through', () => {
      expect(() => toCloudHostGraphQLError(new Error('too many cloud hosts'))).toThrow(
        'too many cloud hosts',
      );
      expect(() =>
        toCloudHostGraphQLError(new Error('unsupported harness type: CODEX')),
      ).toThrow('unsupported harness type: CODEX');
    });

    it('T-CH-C6: 创建期负载错误文案原样透传（含依赖成环）', () => {
      const messages = [
        'too many workloads (max 5)',
        'invalid workload: 507f1f77bcf86cd799439011',
        'workload is not installable: OpenCode',
        'invalid workload parameter: mode',
        'dependency workload not found: ghost',
        'dependency cycle detected',
        'workloads exceed 10',
      ];
      for (const message of messages) {
        expect(() => toCloudHostGraphQLError(new Error(message))).toThrow(message);
      }
    });

    it('A-6 hides unexpected internal errors', () => {
      expect(() =>
        toCloudHostGraphQLError(new Error('MongoServerError: duplicate key')),
      ).toThrow('internal error');
    });
  });
});
