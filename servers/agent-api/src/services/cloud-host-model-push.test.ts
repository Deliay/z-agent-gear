import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  cloudHostFind: vi.fn(),
  pushHarnessModels: vi.fn(),
  systemWorkspaceContext: vi.fn(),
  findAllModels: vi.fn(),
  findAllProviders: vi.fn(),
  invalidateAllAcpOptions: vi.fn(),
}));

vi.mock('../models/cloud-host.js', () => ({
  CloudHost: { find: mocks.cloudHostFind },
}));

vi.mock('./cloud-controller-client.js', () => ({
  CloudControllerUnavailableError: class CloudControllerUnavailableError extends Error {},
  CloudControllerRequestError: class CloudControllerRequestError extends Error {},
  cloudControllerClient: { pushHarnessModels: mocks.pushHarnessModels },
}));

vi.mock('./workspace-service.js', () => ({
  workspaceService: { systemWorkspaceContext: mocks.systemWorkspaceContext },
}));

vi.mock('./model.js', () => ({
  modelService: { findAll: mocks.findAllModels },
}));

vi.mock('./provider.js', () => ({
  providerService: { findAll: mocks.findAllProviders },
}));

vi.mock('./acp-options-cache.js', () => ({
  invalidateAllAcpOptions: mocks.invalidateAllAcpOptions,
}));

import {
  applyGlobalModelRefresh,
  pushModelProvisionForAllRunning,
  pushModelProvisionForTenant,
} from './cloud-host-model-push.js';
import { getWorkspaceContext } from './workspace-context.js';

function hostsChain(hosts: unknown[]) {
  return {
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(hosts),
    }),
  };
}

function contextFor(id: string, tenantId = 'tenant-1') {
  return {
    id,
    tenantId,
    type: 'normal',
    role: 'admin',
    readOnly: false,
    globalWorkspaceId: 'ws-global',
  };
}

function host(id: string, workspaceId: string | null, containerId: string | null = `container-${id}`) {
  return { _id: id, resourceWorkspaceId: workspaceId, containerId };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cloudHostFind.mockReturnValue(hostsChain([]));
  mocks.findAllModels.mockResolvedValue([]);
  mocks.findAllProviders.mockResolvedValue([]);
  mocks.pushHarnessModels.mockResolvedValue({ delivered: true });
  mocks.invalidateAllAcpOptions.mockResolvedValue(0);
});

describe('pushModelProvisionForTenant（T-CP1）', () => {
  it('only selects RUNNING non-deleted hosts of the tenant（缺失 container/workspace 的存量行由逐台 warn 跳过）', async () => {
    await pushModelProvisionForTenant('tenant-1');

    expect(mocks.cloudHostFind).toHaveBeenCalledWith({
      status: 'RUNNING',
      deletedAt: null,
      tenantId: 'tenant-1',
    });
  });

  it('recomputes the payload per host inside its own workspace context (two workspaces → two payloads)', async () => {
    mocks.cloudHostFind.mockReturnValue(hostsChain([host('h1', 'ws-1'), host('h2', 'ws-2')]));
    mocks.systemWorkspaceContext.mockImplementation(async (workspaceId: string) =>
      contextFor(workspaceId),
    );
    mocks.findAllModels.mockImplementation(async () => {
      const context = getWorkspaceContext();
      // 绝不能裸跑 findAll：每次都要有 ALS 工作区上下文（D2）
      expect(context).toBeDefined();
      if (context?.id === 'ws-1') {
        return [
          { name: 'model-ws1', isEnabled: true, scope: 'user', providerId: 'p1', contextLength: 1000 },
        ];
      }
      return [
        { name: 'model-ws2', isEnabled: true, scope: 'user', providerId: 'p1', contextLength: 2000 },
      ];
    });
    mocks.findAllProviders.mockImplementation(async () => {
      expect(getWorkspaceContext()).toBeDefined();
      return [{ id: 'p1', name: 'Provider 1', isEnabled: true, createdAt: '2026-01-01T00:00:00.000Z' }];
    });

    await pushModelProvisionForTenant('tenant-1');

    expect(mocks.systemWorkspaceContext).toHaveBeenCalledWith('ws-1');
    expect(mocks.systemWorkspaceContext).toHaveBeenCalledWith('ws-2');
    const payloads = new Map(
      mocks.pushHarnessModels.mock.calls.map(([containerId, provision]) => [containerId, provision]),
    );
    expect(payloads.get('container-h1').providers[1].models).toEqual([
      { id: 'model-ws1', contextLength: 1000 },
    ]);
    expect(payloads.get('container-h2').providers[1].models).toEqual([
      { id: 'model-ws2', contextLength: 2000 },
    ]);
  });

  it('skips hosts with missing containerId or unresolvable workspace context', async () => {
    mocks.cloudHostFind.mockReturnValue(
      hostsChain([
        host('h1', 'ws-1'),
        host('h2', null),
        host('h3', 'ws-3'),
      ]),
    );
    mocks.systemWorkspaceContext.mockImplementation(async (workspaceId: string) =>
      workspaceId === 'ws-3' ? undefined : contextFor(workspaceId),
    );

    await pushModelProvisionForTenant('tenant-1');

    expect(mocks.pushHarnessModels).toHaveBeenCalledTimes(1);
    expect(mocks.pushHarnessModels).toHaveBeenCalledWith('container-h1', expect.any(Object));
    // 上下文解析失败的 h3 与缺 workspace 的 h2 都不触发 find*
    expect(mocks.findAllModels).toHaveBeenCalledTimes(1);
  });

  it('skips a host whose containerId is empty', async () => {
    mocks.cloudHostFind.mockReturnValue(hostsChain([host('h1', 'ws-1', '')]));
    mocks.systemWorkspaceContext.mockResolvedValue(contextFor('ws-1'));

    await pushModelProvisionForTenant('tenant-1');

    expect(mocks.pushHarnessModels).not.toHaveBeenCalled();
  });

  it('returns immediately for an empty tenantId', async () => {
    await pushModelProvisionForTenant('');
    expect(mocks.cloudHostFind).not.toHaveBeenCalled();
  });
});

describe('pushModelProvisionForAllRunning（T-CP2）', () => {
  it('caps concurrency at 5', async () => {
    const hosts = Array.from({ length: 12 }, (_, index) => host(`h${index}`, `ws${index}`));
    mocks.cloudHostFind.mockReturnValue(hostsChain(hosts));
    mocks.systemWorkspaceContext.mockResolvedValue(contextFor('ws-1'));

    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.pushHarnessModels.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (inFlight === 5) release();
      await gate;
      inFlight -= 1;
      return { delivered: true };
    });

    await pushModelProvisionForAllRunning();

    expect(mocks.pushHarnessModels).toHaveBeenCalledTimes(12);
    expect(maxInFlight).toBe(5);
  });

  it('keeps pushing other hosts when one host throws (never rejects)', async () => {
    mocks.cloudHostFind.mockReturnValue(
      hostsChain([host('h1', 'ws-1'), host('h2', 'ws-2'), host('h3', 'ws-3')]),
    );
    mocks.systemWorkspaceContext.mockResolvedValue(contextFor('ws-1'));
    mocks.pushHarnessModels.mockImplementation(async (containerId: string) => {
      if (containerId === 'container-h2') throw new Error('control plane down');
      return { delivered: true };
    });

    await expect(pushModelProvisionForAllRunning()).resolves.toBeUndefined();
    expect(mocks.pushHarnessModels).toHaveBeenCalledTimes(3);
  });

  it('treats delivered:false as a warn-only outcome', async () => {
    mocks.cloudHostFind.mockReturnValue(hostsChain([host('h1', 'ws-1')]));
    mocks.systemWorkspaceContext.mockResolvedValue(contextFor('ws-1'));
    mocks.pushHarnessModels.mockResolvedValue({ delivered: false, reason: 'worker_unsupported' });

    await expect(pushModelProvisionForAllRunning()).resolves.toBeUndefined();
  });
});

describe('applyGlobalModelRefresh（T-CP3）', () => {
  it('pushes to every RUNNING host and invalidates all ACP option caches once', async () => {
    mocks.cloudHostFind.mockReturnValue(hostsChain([host('h1', 'ws-1'), host('h2', 'ws-2')]));
    mocks.systemWorkspaceContext.mockResolvedValue(contextFor('ws-1'));

    await applyGlobalModelRefresh();

    expect(mocks.pushHarnessModels).toHaveBeenCalledTimes(2);
    expect(mocks.invalidateAllAcpOptions).toHaveBeenCalledTimes(1);
  });

  it('merges concurrent triggers into a single round (single-flight)', async () => {
    mocks.cloudHostFind.mockReturnValue(hostsChain([host('h1', 'ws-1')]));
    mocks.systemWorkspaceContext.mockResolvedValue(contextFor('ws-1'));
    mocks.pushHarnessModels.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ delivered: true }), 5)),
    );

    const first = applyGlobalModelRefresh();
    const second = applyGlobalModelRefresh();
    const third = applyGlobalModelRefresh();

    await Promise.all([second, third]);
    await first;

    expect(mocks.invalidateAllAcpOptions).toHaveBeenCalledTimes(1);
    expect(mocks.pushHarnessModels).toHaveBeenCalledTimes(1);
  });

  it('runs one extra round when a new trigger arrives during a round', async () => {
    mocks.cloudHostFind.mockReturnValue(hostsChain([host('h1', 'ws-1')]));
    mocks.systemWorkspaceContext.mockResolvedValue(contextFor('ws-1'));
    let resolveFirst: (() => void) | undefined;
    mocks.pushHarnessModels.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = () => resolve({ delivered: true });
        }),
    );
    mocks.pushHarnessModels.mockResolvedValue({ delivered: true });

    const first = applyGlobalModelRefresh();
    await vi.waitFor(() => expect(mocks.pushHarnessModels).toHaveBeenCalledTimes(1));
    // 进行中新增触发 → 结束后补跑一轮
    const mid = applyGlobalModelRefresh();
    await mid;
    resolveFirst?.();
    await first;

    expect(mocks.invalidateAllAcpOptions).toHaveBeenCalledTimes(2);
    expect(mocks.pushHarnessModels).toHaveBeenCalledTimes(2);
  });
});
