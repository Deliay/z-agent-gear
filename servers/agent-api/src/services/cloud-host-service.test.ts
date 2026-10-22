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
  HARNESS_TYPES: ['OPENCODE'],
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

import { CloudHostService } from './cloud-host-service.js';
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
    { name: 'model-a', isEnabled: true },
    { name: 'model-a', isEnabled: true },
    { name: 'model-b', isEnabled: true },
    { name: 'disabled', isEnabled: false },
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
  vi.mocked(CloudHost.findByIdAndUpdate).mockReturnValue(
    chain(hostDoc({ containerId: 'container-1' })) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.config.harnessEnabled = true;
  vi.mocked(CloudHost.findByIdAndUpdate).mockReset();
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
    it('returns OPENCODE when enabled and preset exists', async () => {
      vi.mocked(cloudWorkloadReader.findHarnessPreset).mockResolvedValue({} as never);
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
    it('creates controller/key/workspace/host and starts harness container', async () => {
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
      expect(controllerWorkspaceService.ensureCloudHostWorkspace).toHaveBeenCalledWith(
        expect.any(String),
        'user-1',
        '/root/workspace',
      );
      expect(CloudHost.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'STARTING', harnessTypes: ['OPENCODE'] }),
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
        defaultWorkspace: '/root/workspace',
      });
    });

    it('rolls back and maps control plane failure', async () => {
      setupCreateSuccess();
      vi.mocked(cloudControllerClient.startHarness).mockRejectedValue(new Error('boom'));

      await expect(
        service.create('user-1', { name: 'my-cloud', harnessTypes: ['OPENCODE'] }),
      ).rejects.toThrow('control plane unavailable');

      expect(billingClient.revokeApiKeysByHost).toHaveBeenCalled();
      expect(ControllerWorkspace.deleteOne).toHaveBeenCalled();
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
    it('ready transitions to RUNNING and creates default session for single harness', async () => {
      const starting = hostDoc({ status: 'STARTING' });
      const running = hostDoc({ status: 'RUNNING' });
      const refreshed = hostDoc({ status: 'RUNNING', defaultSessionId: oid('sess-1') });
      vi.mocked(CloudHost.findOne)
        .mockReturnValueOnce(chain(starting) as never)
        .mockReturnValueOnce(chain(refreshed) as never);
      vi.mocked(CloudHost.findOneAndUpdate).mockReturnValue(chain(running) as never);
      vi.mocked(sessionService.create).mockResolvedValue({ id: 'sess-1' } as never);
      vi.mocked(Session.countDocuments).mockResolvedValue(1 as never);

      const result = await service.handleReady(HOST_ID);

      expect(sessionService.create).toHaveBeenCalledWith('user-1', {
        controllerId: CONTROLLER_ID,
        workspaceId: WORKSPACE_ID,
        acpServerType: 'opencode',
      });
      expect(CloudHost.updateOne).toHaveBeenCalledWith(
        { _id: HOST_ID, defaultSessionId: null },
        { $set: { defaultSessionId: 'sess-1' } },
      );
      expect(result).toMatchObject({ status: 'RUNNING', defaultSessionId: 'sess-1' });
    });

    it('ready keeps RUNNING when default session creation fails', async () => {
      const starting = hostDoc({ status: 'STARTING' });
      const running = hostDoc({ status: 'RUNNING' });
      vi.mocked(CloudHost.findOne)
        .mockReturnValueOnce(chain(starting) as never)
        .mockReturnValueOnce(chain(running) as never);
      vi.mocked(CloudHost.findOneAndUpdate).mockReturnValue(chain(running) as never);
      vi.mocked(sessionService.create).mockRejectedValue(new Error('agent offline'));
      vi.mocked(Session.countDocuments).mockResolvedValue(0 as never);

      await expect(service.handleReady(HOST_ID)).resolves.toMatchObject({
        status: 'RUNNING',
        defaultSessionId: null,
      });
    });

    it('does not create a default session when multiple harness types are selected', async () => {
      const starting = hostDoc({ status: 'STARTING', harnessTypes: ['OPENCODE', 'CODEX'] });
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

    it('terminal ends sessions and revokes model key', async () => {
      vi.mocked(CloudHost.findOne).mockReturnValue(chain(hostDoc({ status: 'RUNNING' })) as never);
      vi.mocked(CloudHost.findOneAndUpdate).mockReturnValue(
        chain(hostDoc({ status: 'STOPPED' })) as never,
      );
      vi.mocked(sessionService.endByController).mockResolvedValue(2 as never);

      await expect(
        service.handleTerminal(HOST_ID, { status: 'stopped' }),
      ).resolves.toMatchObject({ status: 'STOPPED' });
      expect(sessionService.endByController).toHaveBeenCalledWith(CONTROLLER_ID, 'user-1');
      expect(billingClient.revokeApiKeysByHost).toHaveBeenCalledWith(HOST_ID);
    });

    it('terminal maps failed status with reason', async () => {
      vi.mocked(CloudHost.findOne).mockReturnValue(chain(hostDoc({ status: 'STARTING' })) as never);
      vi.mocked(CloudHost.findOneAndUpdate).mockReturnValue(
        chain(hostDoc({ status: 'FAILED', failureReason: 'job failed' })) as never,
      );
      vi.mocked(sessionService.endByController).mockResolvedValue(0 as never);

      const result = await service.handleTerminal(HOST_ID, {
        status: 'failed',
        reason: 'job failed',
      });
      expect(result).toMatchObject({ status: 'FAILED', failureReason: 'job failed' });
    });

    it('repeated terminal callback is idempotent', async () => {
      vi.mocked(CloudHost.findOne).mockReturnValue(chain(hostDoc({ status: 'STOPPED' })) as never);

      await expect(
        service.handleTerminal(HOST_ID, { status: 'stopped' }),
      ).resolves.toMatchObject({ status: 'STOPPED' });
      expect(CloudHost.findOneAndUpdate).not.toHaveBeenCalled();
      expect(sessionService.endByController).not.toHaveBeenCalled();
      expect(billingClient.revokeApiKeysByHost).not.toHaveBeenCalled();
    });
  });
});
