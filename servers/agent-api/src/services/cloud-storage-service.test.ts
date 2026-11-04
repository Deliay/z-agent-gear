import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { runWithWorkspace, type WorkspaceContext } from './workspace-context.js';

const h = vi.hoisted(() => ({
  config: { cloudStorageEnabled: true },
  controller: {
    createStorage: vi.fn(),
    deleteStorage: vi.fn(),
    cleanupStorage: vi.fn(),
    triggerArchive: vi.fn(),
    archiveStorageOperation: vi.fn(),
    restoreStorageOperation: vi.fn(),
    getStorageOperation: vi.fn(),
    refreshUsage: vi.fn(),
    getArchive: vi.fn(),
  },
  billing: {
    getAccount: vi.fn(),
    getStorageQuote: vi.fn(),
  },
}));

vi.mock('../config/index.js', () => ({ config: h.config }));

vi.mock('../models/cloud-storage.js', () => ({
  CloudStorage: {
    create: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findById: vi.fn(),
    updateOne: vi.fn(),
  },
}));

vi.mock('../models/cloud-host.js', () => ({
  CloudHost: { find: vi.fn() },
}));

vi.mock('../models/cloud-container.js', () => ({
  CloudContainer: { findOne: vi.fn() },
}));

vi.mock('../models/user.js', () => ({
  User: { find: vi.fn() },
}));

vi.mock('./billing-client.js', () => ({
  BillingClient: class {},
  InsufficientBalanceError: class InsufficientBalanceError extends Error {
    constructor(readonly available?: number) {
      super('insufficient balance');
    }
  },
  billingClient: h.billing,
}));

vi.mock('./cloud-controller-client.js', () => ({
  CloudControllerClient: class {},
  CloudControllerRequestError: class CloudControllerRequestError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
    ) {
      super(code);
    }
  },
  cloudControllerClient: h.controller,
}));

import { CloudStorage } from '../models/cloud-storage.js';
import { CloudHost } from '../models/cloud-host.js';
import { CloudContainer } from '../models/cloud-container.js';
import { User } from '../models/user.js';
import { CloudControllerRequestError } from './cloud-controller-client.js';
import {
  CloudStorageService,
  buildArchiveFileName,
  fallbackStorageQuote,
  sanitizeArchiveName,
} from './cloud-storage-service.js';

const WS = '507f1f77bcf86cd7994390b1';
const TENANT = '507f1f77bcf86cd7994390a1';
const USER = '507f1f77bcf86cd7994390c1';
const OTHER_USER = '507f1f77bcf86cd7994390c2';
const STORAGE_ID = '507f1f77bcf86cd7994390d1';
const HOST_ID = '507f1f77bcf86cd7994390e1';

const adminContext: WorkspaceContext = {
  id: WS,
  tenantId: TENANT,
  type: 'normal',
  role: 'admin',
  readOnly: false,
  globalWorkspaceId: '507f1f77bcf86cd7994390b2',
};
const devContext: WorkspaceContext = { ...adminContext, role: 'developer' };
const readOnlyGlobal: WorkspaceContext = {
  ...adminContext,
  id: '507f1f77bcf86cd7994390b2',
  type: 'global',
  role: 'developer',
  readOnly: true,
};

function chain(value: unknown) {
  const q: Record<string, unknown> = {};
  q.lean = vi.fn().mockResolvedValue(value);
  q.select = vi.fn(() => q);
  q.sort = vi.fn(() => q);
  q.limit = vi.fn(() => q);
  q.catch = vi.fn(() => Promise.resolve());
  return q as never;
}

function storageDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: STORAGE_ID,
    name: 'my-data',
    nameKey: 'my-data',
    sizeGi: 20,
    status: 'IDLE',
    tenantId: TENANT,
    resourceWorkspaceId: WS,
    createdBy: USER,
    pvcName: `zag-storage-${STORAGE_ID}`,
    storageClass: null,
    attachedCloudHostId: null,
    attachedControllerId: null,
    attachedBy: null,
    attachedAt: null,
    attachFromStatus: null,
    lastContainerId: null,
    usageBytes: null,
    usageUpdatedAt: null,
    currentArchive: null,
    billingAccountId: 'account-1',
    billingRate: 'FULL',
    billingStartedAt: new Date('2026-11-02T00:00:00Z'),
    failureReason: null,
    destroyReason: null,
    destroyedAt: null,
    createdAt: new Date('2026-11-02T00:00:00Z'),
    updatedAt: new Date('2026-11-02T00:00:00Z'),
    ...overrides,
  };
}

const service = new CloudStorageService({
  controllerClient: h.controller as never,
  billing: h.billing as never,
});

function withWorkspace<T>(context: WorkspaceContext, fn: () => Promise<T>): Promise<T> {
  return runWithWorkspace(context, fn);
}

function setupBilling(sizeGi = 20) {
  h.billing.getAccount.mockResolvedValue({ id: 'account-1', availableBalance: 100 });
  h.billing.getStorageQuote.mockResolvedValue({
    sizeGi,
    full: { hourlyCredits: 15, items: [] },
    archived: { hourlyCredits: 7.5, items: [] },
  });
}

function setupPresent() {
  vi.mocked(CloudHost.find).mockReturnValue(chain([]) as never);
  vi.mocked(User.find).mockReturnValue(chain([]) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.config.cloudStorageEnabled = true;
  setupBilling();
  setupPresent();
  vi.mocked(CloudStorage.updateOne).mockResolvedValue({} as never);
});

describe('cloud storage creation (T-CS1..CS4)', () => {
  it('T-CS1: 名称 trim 1~64、容量 1~30；非法输入拒绝', async () => {
    await withWorkspace(adminContext, async () => {
      await expect(
        service.create(USER, { name: '   ', sizeGi: 10 }),
      ).rejects.toThrow('storage name is required');
      await expect(
        service.create(USER, { name: 'x'.repeat(65), sizeGi: 10 }),
      ).rejects.toThrow('storage name is too long');
      await expect(
        service.create(USER, { name: 'ok', sizeGi: 0 }),
      ).rejects.toThrow('storage size must be between 1 and 30 Gi');
      await expect(
        service.create(USER, { name: 'ok', sizeGi: 31 }),
      ).rejects.toThrow('storage size must be between 1 and 30 Gi');
      await expect(
        service.create(USER, { name: 'ok', sizeGi: 1.5 }),
      ).rejects.toThrow('storage size must be between 1 and 30 Gi');
    });
    expect(CloudStorage.create).not.toHaveBeenCalled();
  });

  it('T-CS2: 同工作区重名（大小写不敏感）拒绝；查询限定 destroyedAt=null', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(chain({ _id: 'existing' }) as never);
    await withWorkspace(adminContext, async () => {
      await expect(
        service.create(USER, { name: '  My-Data  ', sizeGi: 10 }),
      ).rejects.toThrow('storage name already exists');
    });
    expect(CloudStorage.findOne).toHaveBeenCalledWith({
      resourceWorkspaceId: WS,
      nameKey: 'my-data',
      destroyedAt: null,
    });
    expect(CloudStorage.create).not.toHaveBeenCalled();
  });

  it('T-CS2b: 并发唯一键冲突映射为重名', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(chain(null) as never);
    vi.mocked(CloudStorage.create).mockRejectedValue(
      Object.assign(new Error('E11000 duplicate key'), { code: 11000 }),
    );
    await withWorkspace(adminContext, async () => {
      await expect(
        service.create(USER, { name: 'my-data', sizeGi: 10 }),
      ).rejects.toThrow('storage name already exists');
    });
  });

  it('T-CS3: 全局工作区 + developer（readOnly）拒绝创建/销毁', async () => {
    await withWorkspace(readOnlyGlobal, async () => {
      await expect(
        service.create(USER, { name: 'my-data', sizeGi: 10 }),
      ).rejects.toThrow('global workspace is read-only');
      await expect(service.destroy(STORAGE_ID, USER)).rejects.toThrow(
        'global workspace is read-only',
      );
    });
  });

  it('T-CS4: PVC 成功 → IDLE + billingStartedAt + billingRate=FULL', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(chain(null) as never);
    vi.mocked(CloudStorage.create).mockResolvedValue({} as never);
    h.controller.createStorage.mockResolvedValue({
      storageId: STORAGE_ID,
      pvcName: `zag-storage-${STORAGE_ID}`,
      created: true,
    });
    const idle = storageDoc({ status: 'IDLE', billingStartedAt: new Date() });
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValue(chain(idle) as never);

    const result = await withWorkspace(adminContext, () =>
      service.create(USER, { name: 'my-data', sizeGi: 20 }),
    );

    expect(h.controller.createStorage).toHaveBeenCalledWith({
      storageId: expect.any(String),
      tenantId: TENANT,
      workspaceId: WS,
      sizeGi: 20,
    });
    const createArg = vi.mocked(CloudStorage.create).mock.calls[0][0] as Record<string, unknown>;
    expect(createArg).toMatchObject({
      name: 'my-data',
      nameKey: 'my-data',
      sizeGi: 20,
      status: 'CREATING',
      tenantId: TENANT,
      resourceWorkspaceId: WS,
      createdBy: USER,
      billingAccountId: 'account-1',
    });
    const cas = vi.mocked(CloudStorage.findOneAndUpdate).mock.calls[0];
    expect(cas[0]).toMatchObject({ status: 'CREATING' });
    expect((cas[1] as { $set: Record<string, unknown> }).$set).toMatchObject({
      status: 'IDLE',
      billingRate: 'FULL',
    });
    expect(result.status).toBe('IDLE');
  });

  it('T-CS4d: 计费服务不可用时降级放行（billingAccountId=null，不阻断创建）', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(chain(null) as never);
    vi.mocked(CloudStorage.create).mockResolvedValue({} as never);
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValue(
      chain(storageDoc({ status: 'IDLE', billingAccountId: null })) as never,
    );
    h.billing.getAccount.mockRejectedValue(new Error('billing down'));
    h.controller.createStorage.mockResolvedValue({
      storageId: STORAGE_ID,
      pvcName: `zag-storage-${STORAGE_ID}`,
      created: true,
    });

    await withWorkspace(adminContext, () =>
      service.create(USER, { name: 'my-data', sizeGi: 20 }),
    );

    const createArg = vi.mocked(CloudStorage.create).mock.calls[0][0] as Record<string, unknown>;
    expect(createArg.billingAccountId).toBeNull();
    expect(h.controller.createStorage).toHaveBeenCalled();
    h.billing.getAccount.mockResolvedValue({ id: 'account-1', availableBalance: 100 });
  });

  it('T-CS4b: PVC 失败 → CREATE_FAILED + destroyedAt + failureReason，无 billingStartedAt', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(chain(null) as never);
    vi.mocked(CloudStorage.create).mockResolvedValue({} as never);
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValue(chain(null) as never);
    h.controller.createStorage.mockRejectedValue(new Error('PVC_CREATE_FAILED'));

    await withWorkspace(adminContext, async () => {
      await expect(
        service.create(USER, { name: 'my-data', sizeGi: 20 }),
      ).rejects.toThrow('control plane unavailable');
    });

    const failure = vi.mocked(CloudStorage.findOneAndUpdate).mock.calls[0];
    expect(failure[0]).toMatchObject({ status: 'CREATING' });
    const set = (failure[1] as { $set: Record<string, unknown> }).$set;
    expect(set.status).toBe('CREATE_FAILED');
    expect(set.failureReason).toBe('PVC_CREATE_FAILED');
    expect(set.destroyedAt).toBeInstanceOf(Date);
    expect(set).not.toHaveProperty('billingStartedAt');
    // CREATE_FAILED 兜底回收可能已建 PVC（孤儿卷防护）
    expect(h.controller.deleteStorage).toHaveBeenCalled();
  });

  it('T-CS4c: 首小时余额不足拒绝（不创建记录）', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(chain(null) as never);
    h.billing.getAccount.mockResolvedValue({ id: 'account-1', availableBalance: 1 });

    await withWorkspace(adminContext, async () => {
      await expect(
        service.create(USER, { name: 'my-data', sizeGi: 20 }),
      ).rejects.toThrow('insufficient balance');
    });
    expect(CloudStorage.create).not.toHaveBeenCalled();
    expect(h.controller.createStorage).not.toHaveBeenCalled();
  });

  it('T-CS4d: 关闭 CLOUD_STORAGE_ENABLED 时创建返回 storage feature is disabled', async () => {
    h.config.cloudStorageEnabled = false;
    await withWorkspace(adminContext, async () => {
      await expect(
        service.create(USER, { name: 'my-data', sizeGi: 10 }),
      ).rejects.toThrow('storage feature is disabled');
      await expect(service.attachStorage({
        storageId: STORAGE_ID,
        cloudHostId: HOST_ID,
        userId: USER,
      })).rejects.toThrow('storage feature is disabled');
    });
    expect(service.getCapabilities()).toEqual({ enabled: false });
  });
});

describe('cloud storage list (T-CS5)', () => {
  it('T-CS5: 仅当前工作区；onlyAttachable 仅 IDLE+ARCHIVED；includeDestroyed 默认 false', async () => {
    vi.mocked(CloudStorage.find).mockReturnValue(chain([]) as never);

    await withWorkspace(adminContext, () => service.list());
    expect(CloudStorage.find).toHaveBeenLastCalledWith({ destroyedAt: null });

    await withWorkspace(adminContext, () => service.list({ onlyAttachable: true }));
    expect(CloudStorage.find).toHaveBeenLastCalledWith({
      destroyedAt: null,
      status: { $in: ['IDLE', 'ARCHIVED'] },
    });

    await withWorkspace(adminContext, () => service.list({ includeDestroyed: true }));
    expect(CloudStorage.find).toHaveBeenLastCalledWith({});
  });
});

describe('cloud storage destroy (T-CS6..CS7)', () => {
  it('T-CS6: ATTACHED 拒绝销毁', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(chain(storageDoc({ status: 'ATTACHED' })) as never);
    await withWorkspace(adminContext, async () => {
      await expect(service.destroy(STORAGE_ID, USER)).rejects.toThrow('storage is attached');
    });
  });

  it('T-CS6b: ARCHIVING 进行中拒绝；归档失败时允许', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(chain(storageDoc({ status: 'ARCHIVING' })) as never);
    await withWorkspace(adminContext, async () => {
      await expect(service.destroy(STORAGE_ID, USER)).rejects.toThrow('storage is archiving');
    });

    const failed = storageDoc({
      status: 'ARCHIVING',
      currentArchive: { archiveId: 'a1', status: 'FAILED' },
    });
    vi.mocked(CloudStorage.findOne).mockReturnValue(chain(failed) as never);
    h.controller.cleanupStorage.mockResolvedValue({ accepted: true });
    vi.mocked(CloudStorage.findOneAndUpdate)
      .mockReturnValueOnce(chain(storageDoc({ status: 'DESTROYING' })) as never)
      .mockReturnValueOnce(chain(storageDoc({ status: 'DESTROYED', destroyedAt: new Date() })) as never);
    await withWorkspace(adminContext, async () => {
      await expect(service.destroy(STORAGE_ID, USER)).resolves.toMatchObject({
        status: 'DESTROYED',
      });
    });
    expect(h.controller.cleanupStorage).toHaveBeenCalledWith(STORAGE_ID, {
      workspaceId: WS,
      deleteArchive: true,
    });
  });

  it('T-CS6c: 非创建人 / 非 admin 拒绝销毁', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(chain(storageDoc()) as never);
    // developer 角色且非创建人拒绝（admin 角色按契约允许）
    await withWorkspace(devContext, async () => {
      await expect(service.destroy(STORAGE_ID, OTHER_USER)).rejects.toThrow(
        'not allowed to destroy storage',
      );
    });
  });

  it('T-CS7: 销毁成功 → DESTROYED + destroyedAt，cleanup 删除 PVC/归档', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(chain(storageDoc({ status: 'IDLE' })) as never);
    h.controller.cleanupStorage.mockResolvedValue({ accepted: true });
    vi.mocked(CloudStorage.findOneAndUpdate)
      .mockReturnValueOnce(chain(storageDoc({ status: 'DESTROYING' })) as never)
      .mockReturnValueOnce(
        chain(storageDoc({ status: 'DESTROYED', destroyedAt: new Date() })) as never,
      );

    const result = await withWorkspace(adminContext, () => service.destroy(STORAGE_ID, USER));

    expect(result.status).toBe('DESTROYED');
    const destroyedSet = (
      vi.mocked(CloudStorage.findOneAndUpdate).mock.calls[1][1] as {
        $set: Record<string, unknown>;
      }
    ).$set;
    expect(destroyedSet.status).toBe('DESTROYED');
    expect(destroyedSet.destroyedAt).toBeInstanceOf(Date);
    expect(destroyedSet.attachedCloudHostId).toBeNull();
  });

  it('T-CS7b: cleanup 失败回滚状态，允许重试', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(chain(storageDoc({ status: 'IDLE' })) as never);
    h.controller.cleanupStorage.mockRejectedValue(new Error('boom'));
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValueOnce(
      chain(storageDoc({ status: 'DESTROYING' })) as never,
    );

    await withWorkspace(adminContext, async () => {
      await expect(service.destroy(STORAGE_ID, USER)).rejects.toThrow(
        'control plane unavailable',
      );
    });
    expect(CloudStorage.updateOne).toHaveBeenCalledWith(
      { _id: STORAGE_ID, status: 'DESTROYING' },
      { $set: { status: 'IDLE' } },
    );
  });
});

describe('attachment CAS / release (T-CS-A1..A4)', () => {
  const attachInput = {
    storageId: STORAGE_ID,
    cloudHostId: HOST_ID,
    userId: USER,
    controllerId: '507f1f77bcf86cd7994390f1',
  };

  it('T-CS-A1: IDLE/ARCHIVED CAS → ATTACHING 并写 attachFromStatus', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(chain(storageDoc({ status: 'IDLE' })) as never);
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValue(
      chain(storageDoc({ status: 'ATTACHING', attachFromStatus: 'IDLE' })) as never,
    );
    const result = await withWorkspace(adminContext, () => service.attachStorage(attachInput));
    expect(result.fromStatus).toBe('IDLE');
    const [filter, update] = vi.mocked(CloudStorage.findOneAndUpdate).mock.calls[0];
    expect(filter).toMatchObject({ _id: STORAGE_ID, status: 'IDLE', destroyedAt: null });
    expect((update as { $set: Record<string, unknown> }).$set).toMatchObject({
      status: 'ATTACHING',
      attachedCloudHostId: HOST_ID,
      attachedBy: USER,
      attachFromStatus: 'IDLE',
      // 从 ARCHIVED 恢复/新挂载均按全价计费（归档成功回调再切回 HALF）。
      billingRate: 'FULL',
    });
  });

  it('T-CS-A1b: 并发两请求只有一个 CAS 成功', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(chain(storageDoc({ status: 'IDLE' })) as never);
    vi.mocked(CloudStorage.findOneAndUpdate)
      .mockReturnValueOnce(
        chain(storageDoc({ status: 'ATTACHING', attachFromStatus: 'IDLE' })) as never,
      )
      .mockReturnValueOnce(chain(null) as never);

    const [first, second] = await withWorkspace(adminContext, () =>
      Promise.allSettled([
        service.attachStorage(attachInput),
        service.attachStorage({ ...attachInput, cloudHostId: '507f1f77bcf86cd7994390e2' }),
      ]),
    );
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    if (second.status === 'rejected') {
      expect(String(second.reason)).toContain('storage is not attachable');
    }
  });

  it('T-CS-A2: 跨工作区/不存在 → storage not found；非可挂载状态 → storage is not attachable', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(chain(null) as never);
    await withWorkspace(adminContext, async () => {
      await expect(service.attachStorage(attachInput)).rejects.toThrow('storage not found');
    });
    expect(h.billing.getAccount).not.toHaveBeenCalled();

    vi.mocked(CloudStorage.findOne).mockReturnValue(chain(storageDoc({ status: 'ATTACHED' })) as never);
    await withWorkspace(adminContext, async () => {
      await expect(service.attachStorage(attachInput)).rejects.toThrow(
        'storage is not attachable',
      );
    });
  });

  it('T-CS-A3: markAttached 幂等（CAS 未命中时返回当前记录）', async () => {
    vi.mocked(CloudStorage.findOneAndUpdate)
      .mockReturnValueOnce(chain(storageDoc({ status: 'ATTACHED' })) as never)
      .mockReturnValueOnce(chain(null) as never);
    await expect(service.markAttached(STORAGE_ID, HOST_ID)).resolves.toMatchObject({
      status: 'ATTACHED',
    });
    const [, update] = vi.mocked(CloudStorage.findOneAndUpdate).mock.calls[0];
    expect((update as { $set: Record<string, unknown> }).$set).toMatchObject({
      status: 'ATTACHED',
      billingRate: 'FULL',
    });
    vi.mocked(CloudStorage.findOne).mockReturnValue(chain(storageDoc({ status: 'ATTACHED' })) as never);
    await expect(service.markAttached(STORAGE_ID, HOST_ID)).resolves.toMatchObject({
      status: 'ATTACHED',
    });
  });

  it('T-CS-A4: releaseStorage 回 attachFromStatus、清 attached、归档不丢', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(
      chain(
        storageDoc({
          status: 'ATTACHING',
          attachFromStatus: 'ARCHIVED',
          attachedCloudHostId: HOST_ID,
          currentArchive: { archiveId: 'a1', status: 'FAILED', path: '/archive/x' },
        }),
      ) as never,
    );
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValue(
      chain(storageDoc({ status: 'ARCHIVED', attachFromStatus: null })) as never,
    );
    const result = await withWorkspace(adminContext, () =>
      service.releaseStorage(STORAGE_ID, HOST_ID),
    );
    expect(result?.status).toBe('ARCHIVED');
    const update = vi.mocked(CloudStorage.findOneAndUpdate).mock.calls[0][1] as {
      $set: Record<string, unknown>;
    };
    expect(update.$set).toMatchObject({
      status: 'ARCHIVED',
      billingRate: 'HALF',
      attachedCloudHostId: null,
      attachedBy: null,
      attachedAt: null,
      attachFromStatus: null,
    });
    expect(update.$set).not.toHaveProperty('currentArchive');
  });
});

describe('archive callbacks / retry / usage (T-CS-AR1..AR5)', () => {
  it('T-CS-AR1: markArchiving 幂等推进 ATTACHED → ARCHIVING', async () => {
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValue(
      chain(storageDoc({ status: 'ARCHIVING' })) as never,
    );
    const result = await service.markArchiving(STORAGE_ID, HOST_ID);
    expect(result?.status).toBe('ARCHIVING');
    expect(vi.mocked(CloudStorage.findOneAndUpdate).mock.calls[0][0]).toMatchObject({
      _id: STORAGE_ID,
      status: 'ATTACHED',
      attachedCloudHostId: HOST_ID,
    });
  });

  it('T-CS-AR2: 归档成功 → ARCHIVED + HALF + currentArchive/usageBytes + 清 attached', async () => {
    vi.mocked(CloudStorage.findById).mockReturnValue(
      chain(
        storageDoc({
          status: 'ARCHIVING',
          attachedCloudHostId: HOST_ID,
          attachFromStatus: 'IDLE',
          currentArchive: { archiveId: 'a1', status: 'RUNNING' },
        }),
      ) as never,
    );
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValue(
      chain(
        storageDoc({
          status: 'ARCHIVED',
          billingRate: 'HALF',
          usageBytes: 1024,
          currentArchive: { archiveId: 'a1', status: 'SUCCEEDED' },
        }),
      ) as never,
    );

    const result = await service.handleArchiveCallback(STORAGE_ID, {
      archiveId: 'a1',
      status: 'SUCCEEDED',
      usageBytes: 1024,
      fileName: 'host-20261102-000000.tar.gz2',
      path: `/archive/${WS}/${STORAGE_ID}/host.tar.gz2`,
      sourcePvcReleased: false,
    });

    expect(result?.status).toBe('ARCHIVED');
    const update = vi.mocked(CloudStorage.findOneAndUpdate).mock.calls[0][1] as {
      $set: Record<string, unknown>;
    };
    expect(update.$set).toMatchObject({
      status: 'ARCHIVED',
      billingRate: 'HALF',
      usageBytes: 1024,
      attachedCloudHostId: null,
      attachFromStatus: null,
    });
    expect(update.$set.currentArchive).toMatchObject({
      archiveId: 'a1',
      status: 'SUCCEEDED',
      usageBytes: 1024,
      sourcePvcReleased: false,
    });
  });

  it('T-CS-AR3: 归档失败保持 ARCHIVING + 失败标记，可重试生成新 archiveId', async () => {
    vi.mocked(CloudStorage.findById).mockReturnValue(
      chain(
        storageDoc({
          status: 'ARCHIVING',
          lastContainerId: 'container-1',
          attachedCloudHostId: HOST_ID,
          currentArchive: { archiveId: 'a1', status: 'RUNNING' },
        }),
      ) as never,
    );
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValueOnce(
      chain(
        storageDoc({
          status: 'ARCHIVING',
          currentArchive: { archiveId: 'a1', status: 'FAILED' },
        }),
      ) as never,
    );
    const failed = await service.handleArchiveCallback(STORAGE_ID, {
      archiveId: 'a1',
      status: 'FAILED',
      failureReason: 'compress failed',
    });
    expect(failed?.status).toBe('ARCHIVING');
    const failureSet = (
      vi.mocked(CloudStorage.findOneAndUpdate).mock.calls[0][1] as {
        $set: Record<string, unknown>;
      }
    ).$set;
    expect(failureSet.status).toBe('ARCHIVING');
    expect(failureSet.currentArchive).toMatchObject({
      archiveId: 'a1',
      status: 'FAILED',
      failureReason: 'compress failed',
    });

    // 重试：前置为失败归档 + 有历史容器（容器级以 currentArchive.containerId 判别）
    const retryDoc = storageDoc({
      status: 'ARCHIVING',
      lastContainerId: 'container-1',
      attachedCloudHostId: HOST_ID,
      currentArchive: {
        archiveId: 'a1',
        status: 'FAILED',
        containerId: 'container-1',
        cloudHostName: 'my cloud',
      },
    });
    vi.mocked(CloudStorage.findOne).mockReturnValue(chain(retryDoc) as never);
    h.controller.triggerArchive.mockResolvedValue({ accepted: true, archiveId: 'a2' });
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValueOnce(
      chain(storageDoc({ status: 'ARCHIVING' })) as never,
    );
    await withWorkspace(adminContext, () => service.retryArchive(STORAGE_ID, USER));
    const trigger = h.controller.triggerArchive.mock.calls[0] as [string, { archiveId: string; fileName: string }];
    expect(trigger[0]).toBe('container-1');
    expect(trigger[1].archiveId).not.toBe('a1');
    expect(trigger[1].fileName).toMatch(/^my-cloud-\d{8}-\d{6}\.tar\.gz2$/);
  });

  it('T-CS-AR4: SUCCEEDED 后迟到 RUNNING 被忽略（终态单调、按 archiveId 幂等）', async () => {
    const succeeded = storageDoc({
      status: 'ARCHIVED',
      currentArchive: { archiveId: 'a1', status: 'SUCCEEDED' },
    });
    vi.mocked(CloudStorage.findById).mockReturnValue(chain(succeeded) as never);

    await service.handleArchiveCallback(STORAGE_ID, { archiveId: 'a1', status: 'RUNNING' });
    expect(CloudStorage.findOneAndUpdate).not.toHaveBeenCalled();

    await service.handleArchiveCallback(STORAGE_ID, { archiveId: 'a0', status: 'RUNNING' });
    expect(CloudStorage.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('T-CS-AR9: 归档→再挂载→再归档：第二轮不被旧 SUCCEEDED 阻断并切回 HALF', async () => {
    // 第一轮成功后的旧归档仍在 currentArchive；markArchiving 以新 archiveId 重置占位。
    vi.mocked(CloudStorage.findOneAndUpdate)
      .mockReturnValueOnce(
        chain(
          storageDoc({
            status: 'ARCHIVING',
            attachedCloudHostId: HOST_ID,
            currentArchive: { archiveId: 'a1', status: 'SUCCEEDED' },
          }),
        ) as never,
      )
      .mockReturnValueOnce(
        chain(
          storageDoc({
            status: 'ARCHIVING',
            attachedCloudHostId: HOST_ID,
            currentArchive: { archiveId: 'a2', status: 'PENDING' },
          }),
        ) as never,
      );
    await expect(service.markArchiving(STORAGE_ID, HOST_ID, 'a2')).resolves.toMatchObject({
      status: 'ARCHIVING',
    });

    vi.mocked(CloudStorage.findById).mockReturnValue(
      chain(
        storageDoc({
          status: 'ARCHIVING',
          attachedCloudHostId: HOST_ID,
          currentArchive: { archiveId: 'a2', status: 'PENDING' },
        }),
      ) as never,
    );
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValueOnce(
      chain(
        storageDoc({
          status: 'ARCHIVING',
          attachedCloudHostId: HOST_ID,
          currentArchive: { archiveId: 'a2', status: 'RUNNING' },
        }),
      ) as never,
    );
    await service.handleArchiveCallback(STORAGE_ID, { archiveId: 'a2', status: 'RUNNING' });

    vi.mocked(CloudStorage.findById).mockReturnValue(
      chain(
        storageDoc({
          status: 'ARCHIVING',
          attachedCloudHostId: HOST_ID,
          attachFromStatus: 'ARCHIVED',
          billingRate: 'FULL',
          currentArchive: { archiveId: 'a2', status: 'RUNNING' },
        }),
      ) as never,
    );
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValueOnce(
      chain(
        storageDoc({
          status: 'ARCHIVED',
          billingRate: 'HALF',
          usageBytes: 4096,
          currentArchive: { archiveId: 'a2', status: 'SUCCEEDED' },
        }),
      ) as never,
    );
    const archived = await service.handleArchiveCallback(STORAGE_ID, {
      archiveId: 'a2',
      status: 'SUCCEEDED',
      usageBytes: 4096,
    });
    expect(archived?.status).toBe('ARCHIVED');
    const update = vi.mocked(CloudStorage.findOneAndUpdate).mock.calls.at(-1)![1] as {
      $set: Record<string, unknown>;
    };
    expect(update.$set).toMatchObject({ status: 'ARCHIVED', billingRate: 'HALF' });
    expect(update.$set.currentArchive).toMatchObject({ archiveId: 'a2', status: 'SUCCEEDED' });
  });

  it('T-CS-AR10: 旧周期迟到回调（archiveId 不同）不覆盖新周期', async () => {
    vi.mocked(CloudStorage.findById).mockReturnValue(
      chain(
        storageDoc({
          status: 'ARCHIVING',
          attachedCloudHostId: HOST_ID,
          currentArchive: { archiveId: 'a2', status: 'RUNNING' },
        }),
      ) as never,
    );
    vi.mocked(CloudStorage.findOneAndUpdate).mockClear();
    const result = await service.handleArchiveCallback(STORAGE_ID, {
      archiveId: 'a1',
      status: 'FAILED',
      failureReason: 'old',
    });
    expect(result?.status).toBe('ARCHIVING');
    expect(CloudStorage.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('T-CS-AR5: 无失败归档/无历史容器 → no archive to retry', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(
      chain(storageDoc({ status: 'ARCHIVING', currentArchive: { archiveId: 'a1', status: 'RUNNING' } })) as never,
    );
    await withWorkspace(adminContext, async () => {
      await expect(service.retryArchive(STORAGE_ID, USER)).rejects.toThrow(
        'no archive to retry',
      );
    });
    vi.mocked(CloudStorage.findOne).mockReturnValue(
      chain(
        storageDoc({
          status: 'ARCHIVING',
          lastContainerId: null,
          currentArchive: null,
        }),
      ) as never,
    );
    await withWorkspace(adminContext, async () => {
      await expect(service.retryArchive(STORAGE_ID, USER)).rejects.toThrow(
        'no archive to retry',
      );
    });
  });

  it('T-CS-AR6: 用量回调写 usageBytes/usageUpdatedAt', async () => {
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValue(
      chain(storageDoc({ usageBytes: 2048, usageUpdatedAt: new Date() })) as never,
    );
    await service.handleUsageCallback(STORAGE_ID, {
      usageBytes: 2048,
      measuredAt: '2026-11-02T10:00:00.000Z',
    });
    const update = vi.mocked(CloudStorage.findOneAndUpdate).mock.calls[0][1] as {
      $set: Record<string, unknown>;
    };
    expect(update.$set.usageBytes).toBe(2048);
    expect(update.$set.usageUpdatedAt).toBeInstanceOf(Date);
  });

  it('T-CS-AR7: 刷新用量仅 ATTACHED；定位最近容器并按 storageId 调用', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(
      chain(storageDoc({ status: 'ARCHIVED' })) as never,
    );
    await withWorkspace(adminContext, async () => {
      await expect(service.refreshUsage(STORAGE_ID)).rejects.toThrow('storage is not attached');
    });

    vi.mocked(CloudStorage.findOne).mockReturnValue(
      chain(storageDoc({ status: 'ATTACHED', lastContainerId: null, attachedCloudHostId: HOST_ID })) as never,
    );
    vi.mocked(CloudContainer.findOne).mockReturnValue(
      chain({ _id: 'container-9' }) as never,
    );
    h.controller.refreshUsage.mockResolvedValue({ accepted: true });
    await withWorkspace(adminContext, () => service.refreshUsage(STORAGE_ID));
    expect(h.controller.refreshUsage).toHaveBeenCalledWith(STORAGE_ID, {
      containerId: 'container-9',
    });
  });

  it('T-CS-AR8: ARCHIVING 对账补收口（查询容器归档状态）', async () => {
    vi.mocked(CloudStorage.find).mockReturnValue(
      chain([
        storageDoc({
          status: 'ARCHIVING',
          lastContainerId: 'container-1',
          currentArchive: { archiveId: 'a1', status: 'FAILED' },
          updatedAt: new Date(Date.now() - 20 * 60 * 1000),
        }),
      ]) as never,
    );
    h.controller.getArchive.mockResolvedValue({
      status: 'SUCCEEDED',
      archiveId: 'a1',
      usageBytes: 4096,
    });
    const spy = vi.spyOn(service, 'handleArchiveCallback').mockResolvedValue(null);
    await expect(service.reconcileARCHIVING()).resolves.toBe(1);
    expect(spy).toHaveBeenCalledWith(
      STORAGE_ID,
      expect.objectContaining({ archiveId: 'a1', status: 'SUCCEEDED', usageBytes: 4096 }),
    );
  });
});

describe('archive naming and fallback quote', () => {
  it('归档名 ASCII 安全化与时间戳格式（裁决 6）', () => {
    expect(sanitizeArchiveName('我的 云电脑//a__b')).toBe('a__b');
    expect(sanitizeArchiveName('---')).toBe('cloud-host');
    expect(buildArchiveFileName('我的云电脑', new Date('2026-11-02T12:34:56Z'))).toBe(
      'cloud-host-20261102-123456.tar.gz2',
    );
    expect(buildArchiveFileName('my host', new Date('2026-11-02T12:34:56Z'))).toBe(
      'my-host-20261102-123456.tar.gz2',
    );
  });

  it('本地降级阶梯与提案口径一致（1/10/11/20/25/26/30Gi）', () => {
    const credits = (sizeGi: number) => fallbackStorageQuote(sizeGi).full.hourlyCredits;
    expect([1, 10, 11, 20, 25, 26, 30].map(credits)).toEqual([5, 5, 6, 15, 20, 23, 35]);
    expect(fallbackStorageQuote(20).archived.hourlyCredits).toBe(7.5);
  });
});

describe('归档优化：手动归档 / 复原 / fork / 停止不归档（T-AR1 / T-RS1 / T-FORK）', () => {
  const successArchive = {
    archiveId: 'a-ok',
    status: 'SUCCEEDED',
    fileName: 'my-data-20261102-100000.tar.gz2',
    path: `/archive/${WS}/${STORAGE_ID}/my-data-20261102-100000.tar.gz2`,
    usageBytes: 4096,
    cloudHostId: null,
    cloudHostName: null,
  };

  it('T-AR1: 手动归档仅 IDLE；CAS → ARCHIVING 并写占位 currentArchive', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(chain(storageDoc()) as never);
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValue(
      chain(storageDoc({ status: 'ARCHIVING' })) as never,
    );
    vi.mocked(CloudStorage.findById).mockReturnValue(
      chain(storageDoc({ status: 'ARCHIVING' })) as never,
    );
    h.controller.archiveStorageOperation.mockResolvedValue({ accepted: true, operationId: 'x' });

    await withWorkspace(adminContext, () => service.archive(STORAGE_ID, USER));

    const call = h.controller.archiveStorageOperation.mock.calls[0] as [
      string,
      { operationId: string; archiveId: string; fileName: string; workspaceId: string },
    ];
    expect(call[0]).toBe(STORAGE_ID);
    expect(call[1].operationId).toMatch(/^[a-f0-9]{24}$/);
    expect(call[1].fileName).toMatch(/^my-data-\d{8}-\d{6}\.tar\.gz2$/);
    const update = vi.mocked(CloudStorage.findOneAndUpdate).mock.calls[0][1] as {
      $set: Record<string, unknown>;
    };
    expect(update.$set.status).toBe('ARCHIVING');
    expect(update.$set.currentArchive).toMatchObject({
      containerId: null,
      status: 'PENDING',
      operationId: call[1].operationId,
    });

    // 非 IDLE 拒绝
    vi.mocked(CloudStorage.findOne).mockReturnValue(
      chain(storageDoc({ status: 'ATTACHED' })) as never,
    );
    await withWorkspace(adminContext, async () => {
      await expect(service.archive(STORAGE_ID, USER)).rejects.toThrow('storage is not archivable');
    });
  });

  it('T-AR3a: 归档触发同步失败 → 回滚 IDLE 并恢复旧 currentArchive', async () => {
    const previous = { archiveId: 'old', status: 'SUCCEEDED', path: '/archive/old' };
    vi.mocked(CloudStorage.findOne).mockReturnValue(
      chain(storageDoc({ status: 'IDLE', currentArchive: previous })) as never,
    );
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValue(
      chain(storageDoc({ status: 'ARCHIVING' })) as never,
    );
    h.controller.archiveStorageOperation.mockRejectedValue(
      new CloudControllerRequestError(409, 'OPERATION_RUNNING'),
    );

    await withWorkspace(adminContext, async () => {
      await expect(service.archive(STORAGE_ID, USER)).rejects.toThrow('storage is archiving');
    });
    const rollback = vi.mocked(CloudStorage.updateOne).mock.calls.at(-1)!;
    expect(rollback[1]).toEqual({ $set: { status: 'IDLE', currentArchive: previous } });
  });

  it('T-AR3b: retryArchive 无容器来源 → 走存储级端点（新 operationId）', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(
      chain(
        storageDoc({
          status: 'ARCHIVING',
          lastContainerId: 'stale-container',
          currentArchive: { archiveId: 'a1', status: 'FAILED', containerId: null },
        }),
      ) as never,
    );
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValue(
      chain(storageDoc({ status: 'ARCHIVING' })) as never,
    );
    h.controller.archiveStorageOperation.mockResolvedValue({ accepted: true, operationId: 'x' });

    await withWorkspace(adminContext, () => service.retryArchive(STORAGE_ID, USER));

    expect(h.controller.triggerArchive).not.toHaveBeenCalled();
    expect(h.controller.archiveStorageOperation).toHaveBeenCalledWith(
      STORAGE_ID,
      expect.objectContaining({ operationId: expect.stringMatching(/^[a-f0-9]{24}$/) }),
    );
  });

  it('T-RS1: 复原门槛（IDLE + SUCCEEDED + 创建人/管理员）与无归档文案', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(
      chain(storageDoc({ status: 'IDLE', currentArchive: successArchive })) as never,
    );
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValue(
      chain(storageDoc({ status: 'RESTORING' })) as never,
    );
    vi.mocked(CloudStorage.findById).mockReturnValue(
      chain(storageDoc({ status: 'RESTORING' })) as never,
    );
    h.controller.restoreStorageOperation.mockResolvedValue({ accepted: true, operationId: 'x' });

    await withWorkspace(adminContext, () => service.restoreToArchive(STORAGE_ID, OTHER_USER));
    expect(h.controller.restoreStorageOperation).toHaveBeenCalledWith(
      STORAGE_ID,
      expect.objectContaining({
        archivePath: successArchive.path,
        sizeGi: 20,
      }),
    );

    // 非创建人 + 非管理员 → 拒绝
    await withWorkspace(devContext, async () => {
      await expect(service.restoreToArchive(STORAGE_ID, OTHER_USER)).rejects.toThrow(
        'not allowed to restore storage',
      );
    });

    // 无归档 → storage has no archive
    vi.mocked(CloudStorage.findOne).mockReturnValue(
      chain(storageDoc({ status: 'IDLE', currentArchive: null })) as never,
    );
    await withWorkspace(devContext, async () => {
      await expect(service.restoreToArchive(STORAGE_ID, USER)).rejects.toThrow(
        'storage has no archive',
      );
    });
  });

  it('T-RS2/T-RS3: 复原回调 SUCCEEDED → IDLE；FAILED 保持 RESTORING + 可重试', async () => {
    const operationId = new mongoose.Types.ObjectId().toString();
    vi.mocked(CloudStorage.findById).mockReturnValue(
      chain(
        storageDoc({
          status: 'RESTORING',
          currentArchive: successArchive,
          currentRestore: { operationId, status: 'RUNNING' },
        }),
      ) as never,
    );
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValueOnce(
      chain(
        storageDoc({
          status: 'IDLE',
          usageBytes: 4096,
          currentRestore: null,
        }),
      ) as never,
    );
    await service.handleRestoreCallback(STORAGE_ID, { operationId, status: 'SUCCEEDED' });
    const successUpdate = vi.mocked(CloudStorage.findOneAndUpdate).mock.calls[0][1] as {
      $set: Record<string, unknown>;
    };
    expect(successUpdate.$set.status).toBe('IDLE');
    expect(successUpdate.$set.currentRestore).toBeNull();
    expect(successUpdate.$set.usageBytes).toBe(4096);

    vi.mocked(CloudStorage.findById).mockReturnValue(
      chain(
        storageDoc({
          status: 'RESTORING',
          currentArchive: successArchive,
          currentRestore: { operationId, status: 'RUNNING' },
        }),
      ) as never,
    );
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValueOnce(
      chain(
        storageDoc({
          status: 'RESTORING',
          currentRestore: { operationId, status: 'FAILED', failureReason: 'tar failed' },
        }),
      ) as never,
    );
    await service.handleRestoreCallback(STORAGE_ID, {
      operationId,
      status: 'FAILED',
      failureReason: 'tar failed',
    });
    const failedUpdate = vi.mocked(CloudStorage.findOneAndUpdate).mock.calls.at(-1)![1] as {
      $set: Record<string, unknown>;
    };
    expect(failedUpdate.$set.status).toBeUndefined();
    expect(failedUpdate.$set.currentRestore).toMatchObject({ status: 'FAILED' });
  });

  it('T-FORK2: fork 创建新存储（sizeGi/来源/容量只读）并复用 restore 端点', async () => {
    const source = storageDoc({
      status: 'IDLE',
      currentArchive: successArchive,
    });
    vi.mocked(CloudStorage.findOne)
      .mockReturnValueOnce(chain(source) as never)
      .mockReturnValueOnce(chain(null) as never);
    vi.mocked(CloudStorage.create).mockResolvedValue({} as never);
    h.controller.restoreStorageOperation.mockResolvedValue({ accepted: true, operationId: 'x' });

    const newId = '507f1f77bcf86cd7994390f1';
    vi.mocked(CloudStorage.findById).mockReturnValue(
      chain(storageDoc({ _id: newId, status: 'CREATING', sizeGi: 20 })) as never,
    );
    await withWorkspace(adminContext, () =>
      service.fork(STORAGE_ID, { name: 'my-data-copy' }, USER),
    );

    const created = vi.mocked(CloudStorage.create).mock.calls[0][0] as Record<string, unknown>;
    expect(created).toMatchObject({
      name: 'my-data-copy',
      sizeGi: 20,
      status: 'CREATING',
    });
    expect(String(created.forkedFromStorageId)).toBe(STORAGE_ID);
    expect(h.controller.restoreStorageOperation).toHaveBeenCalledWith(
      String(created._id),
      expect.objectContaining({ archivePath: successArchive.path, sizeGi: 20 }),
    );
  });

  it('T-FORK3: fork 源不可用 → storage is not forkable；同步失败 → CREATE_FAILED + 删 PVC', async () => {
    vi.mocked(CloudStorage.findOne).mockReturnValue(
      chain(storageDoc({ status: 'ATTACHED', currentArchive: successArchive })) as never,
    );
    await withWorkspace(adminContext, async () => {
      await expect(
        service.fork(STORAGE_ID, { name: 'copy' }, USER),
      ).rejects.toThrow('storage is not forkable');
    });

    const source = storageDoc({ status: 'IDLE', currentArchive: successArchive });
    vi.mocked(CloudStorage.findOne)
      .mockReturnValueOnce(chain(source) as never)
      .mockReturnValueOnce(chain(null) as never);
    vi.mocked(CloudStorage.create).mockResolvedValue({} as never);
    vi.mocked(CloudStorage.findOneAndUpdate).mockResolvedValue({} as never);
    h.controller.restoreStorageOperation.mockRejectedValue(
      new CloudControllerRequestError(503, 'unavailable'),
    );
    h.controller.deleteStorage.mockResolvedValue({ deleted: true } as never);

    await withWorkspace(adminContext, async () => {
      await expect(service.fork(STORAGE_ID, { name: 'copy' }, USER)).rejects.toThrow(
        'control plane unavailable',
      );
    });
    const failed = vi.mocked(CloudStorage.findOneAndUpdate).mock.calls.at(-1)!;
    expect((failed[1] as { $set: Record<string, unknown> }).$set).toMatchObject({
      status: 'CREATE_FAILED',
    });
    expect(h.controller.deleteStorage).toHaveBeenCalled();
  });

  it('T-SKIP2a: detachToIdle CAS ATTACHED→IDLE（FULL、清 attached*）', async () => {
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValue(
      chain(storageDoc({ status: 'IDLE', billingRate: 'FULL' })) as never,
    );
    await service.detachToIdle(STORAGE_ID, HOST_ID);
    const [filter, update] = vi.mocked(CloudStorage.findOneAndUpdate).mock.calls[0];
    expect(filter).toMatchObject({ _id: STORAGE_ID, status: 'ATTACHED', attachedCloudHostId: HOST_ID });
    expect((update as { $set: Record<string, unknown> }).$set).toMatchObject({
      status: 'IDLE',
      billingRate: 'FULL',
      attachedCloudHostId: null,
      attachFromStatus: null,
    });
  });

  it('T-SKIP2c: detachToIdle 重投（非 ATTACHED）不产生第二次迁移', async () => {
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValue(chain(null) as never);
    vi.mocked(CloudStorage.findById).mockReturnValue(
      chain(storageDoc({ status: 'IDLE', billingRate: 'FULL' })) as never,
    );
    const result = await service.detachToIdle(STORAGE_ID, HOST_ID);
    expect(result?.status).toBe('IDLE');
    // CAS 仍以 ATTACHED 为前置条件；未命中时仅回读，不回写任何字段。
    const filter = vi.mocked(CloudStorage.findOneAndUpdate).mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(filter).toMatchObject({ status: 'ATTACHED', attachedCloudHostId: HOST_ID });
    expect(vi.mocked(CloudStorage.findOneAndUpdate).mock.calls).toHaveLength(1);
  });

  it('T-RS3a: RESTORING+FAILED 同 mutation 重试使用新 operationId 并成功', async () => {
    const oldOperationId = new mongoose.Types.ObjectId().toString();
    vi.mocked(CloudStorage.findOne).mockReturnValue(
      chain(
        storageDoc({
          status: 'RESTORING',
          currentArchive: successArchive,
          currentRestore: {
            operationId: oldOperationId,
            status: 'FAILED',
            failureReason: 'tar failed',
          },
        }),
      ) as never,
    );
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValue(
      chain(storageDoc({ status: 'RESTORING' })) as never,
    );
    vi.mocked(CloudStorage.findById).mockReturnValue(
      chain(storageDoc({ status: 'RESTORING' })) as never,
    );
    h.controller.restoreStorageOperation.mockResolvedValue({ accepted: true, operationId: 'x' });

    await withWorkspace(adminContext, () => service.restoreToArchive(STORAGE_ID, USER));

    const call = h.controller.restoreStorageOperation.mock.calls[0] as [
      string,
      { operationId: string },
    ];
    expect(call[1].operationId).not.toBe(oldOperationId);
    expect(call[1].operationId).toMatch(/^[a-f0-9]{24}$/);
    const filter = vi.mocked(CloudStorage.findOneAndUpdate).mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(filter).toMatchObject({ status: 'RESTORING', 'currentRestore.status': 'FAILED' });
  });

  it('T-RS3a: 复原同步失败保持 RESTORING（初始 FAILED / 重试回写旧 FAILED；OPERATION_RUNNING 不回滚）', async () => {
    // 初始路径：IDLE + SUCCEEDED，控制面网络失败 → RESTORING + FAILED（不回到 IDLE）
    vi.mocked(CloudStorage.findOne).mockReturnValue(
      chain(storageDoc({ status: 'IDLE', currentArchive: successArchive })) as never,
    );
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValue(
      chain(storageDoc({ status: 'RESTORING' })) as never,
    );
    h.controller.restoreStorageOperation.mockRejectedValue(new Error('network down'));
    await withWorkspace(adminContext, async () => {
      await expect(service.restoreToArchive(STORAGE_ID, USER)).rejects.toThrow(
        'control plane unavailable',
      );
    });
    let rollback = vi.mocked(CloudStorage.updateOne).mock.calls.at(-1)!;
    expect((rollback[1] as { $set: Record<string, unknown> }).$set).toMatchObject({
      currentRestore: { status: 'FAILED', failureReason: 'control plane unavailable' },
    });
    expect((rollback[1] as { $set: Record<string, unknown> }).$set.status).toBeUndefined();

    // 重试路径：RESTORING+FAILED，控制面失败 → 回写旧 FAILED 快照（仍保持 RESTORING）
    const oldRestore = {
      operationId: new mongoose.Types.ObjectId().toString(),
      status: 'FAILED',
      failureReason: 'tar failed',
    };
    vi.mocked(CloudStorage.findOne).mockReturnValue(
      chain(
        storageDoc({
          status: 'RESTORING',
          currentArchive: successArchive,
          currentRestore: oldRestore,
        }),
      ) as never,
    );
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValue(
      chain(storageDoc({ status: 'RESTORING' })) as never,
    );
    h.controller.restoreStorageOperation.mockRejectedValue(new Error('network down'));
    await withWorkspace(adminContext, async () => {
      await expect(service.restoreToArchive(STORAGE_ID, USER)).rejects.toThrow(
        'control plane unavailable',
      );
    });
    rollback = vi.mocked(CloudStorage.updateOne).mock.calls.at(-1)!;
    expect((rollback[1] as { $set: Record<string, unknown> }).$set).toEqual({
      currentRestore: oldRestore,
    });

    // OPERATION_RUNNING：不回滚、保持 PENDING，等待回调/对账收口
    vi.mocked(CloudStorage.findOne).mockReturnValue(
      chain(storageDoc({ status: 'IDLE', currentArchive: successArchive })) as never,
    );
    vi.mocked(CloudStorage.findOneAndUpdate).mockReturnValue(
      chain(storageDoc({ status: 'RESTORING' })) as never,
    );
    vi.mocked(CloudStorage.updateOne).mockClear();
    h.controller.restoreStorageOperation.mockRejectedValue(
      new CloudControllerRequestError(409, 'OPERATION_RUNNING'),
    );
    await withWorkspace(adminContext, async () => {
      await expect(service.restoreToArchive(STORAGE_ID, USER)).rejects.toThrow(
        'storage is restoring',
      );
    });
    expect(CloudStorage.updateOne).not.toHaveBeenCalled();
  });

  it('T-RS3b: RESTORING+FAILED 可销毁；进行中不可销毁/归档/fork/挂载', async () => {
    const failed = storageDoc({
      status: 'RESTORING',
      currentRestore: { operationId: 'op-1', status: 'FAILED' },
    });
    vi.mocked(CloudStorage.findOne).mockReturnValue(chain(failed) as never);
    h.controller.cleanupStorage.mockResolvedValue({ accepted: true });
    vi.mocked(CloudStorage.findOneAndUpdate)
      .mockReturnValueOnce(chain(storageDoc({ status: 'DESTROYING' })) as never)
      .mockReturnValueOnce(chain(storageDoc({ status: 'DESTROYED', destroyedAt: new Date() })) as never);
    await withWorkspace(adminContext, async () => {
      await expect(service.destroy(STORAGE_ID, USER)).resolves.toMatchObject({
        status: 'DESTROYED',
      });
    });
    expect(h.controller.cleanupStorage).toHaveBeenCalledWith(STORAGE_ID, {
      workspaceId: WS,
      deleteArchive: true,
    });

    const running = storageDoc({
      status: 'RESTORING',
      currentRestore: { operationId: 'op-2', status: 'RUNNING' },
    });
    vi.mocked(CloudStorage.findOne).mockReturnValue(chain(running) as never);
    await withWorkspace(adminContext, async () => {
      await expect(service.destroy(STORAGE_ID, USER)).rejects.toThrow('storage is restoring');
      await expect(service.archive(STORAGE_ID, USER)).rejects.toThrow('storage is not archivable');
      await expect(service.fork(STORAGE_ID, { name: 'copy' }, USER)).rejects.toThrow(
        'storage is not forkable',
      );
      await expect(
        service.attachStorage({ storageId: STORAGE_ID, cloudHostId: HOST_ID, userId: USER }),
      ).rejects.toThrow('storage is not attachable');
    });
  });

  it('T-FORK1: 源无归档/重名/余额不足/只读角色分别拒绝', async () => {
    // 源状态不允许（ATTACHED）
    vi.mocked(CloudStorage.findOne).mockReturnValue(
      chain(storageDoc({ status: 'ATTACHED', currentArchive: successArchive })) as never,
    );
    await withWorkspace(adminContext, async () => {
      await expect(service.fork(STORAGE_ID, { name: 'copy' }, USER)).rejects.toThrow(
        'storage is not forkable',
      );
    });

    // 重名
    const source = storageDoc({ status: 'IDLE', currentArchive: successArchive });
    vi.mocked(CloudStorage.findOne)
      .mockReturnValueOnce(chain(source) as never)
      .mockReturnValueOnce(chain({ _id: 'existing' }) as never);
    await withWorkspace(adminContext, async () => {
      await expect(service.fork(STORAGE_ID, { name: 'copy' }, USER)).rejects.toThrow(
        'storage name already exists',
      );
    });

    // 余额不足
    vi.mocked(CloudStorage.findOne)
      .mockReturnValueOnce(chain(source) as never)
      .mockReturnValueOnce(chain(null) as never);
    h.billing.getAccount.mockResolvedValue({ id: 'account-1', availableBalance: 0 });
    await withWorkspace(adminContext, async () => {
      await expect(service.fork(STORAGE_ID, { name: 'copy' }, USER)).rejects.toThrow(
        'insufficient balance',
      );
    });

    // 全局工作区只读
    await withWorkspace(readOnlyGlobal, async () => {
      await expect(service.fork(STORAGE_ID, { name: 'copy' }, USER)).rejects.toThrow(
        'global workspace is read-only',
      );
    });
  });

  it('T-OP2: reconcileRESTORING/ARCHIVING 存储级来源按 operationId 查询补齐', async () => {
    const restoreOp = new mongoose.Types.ObjectId().toString();
    const archiveOp = new mongoose.Types.ObjectId().toString();
    vi.mocked(CloudStorage.find)
      .mockReturnValueOnce(
        chain([
          storageDoc({
            status: 'RESTORING',
            currentRestore: { operationId: restoreOp, status: 'RUNNING' },
          }),
        ]) as never,
      )
      .mockReturnValueOnce(
        chain([
          storageDoc({
            status: 'ARCHIVING',
            currentArchive: {
              archiveId: 'a1',
              status: 'PENDING',
              containerId: null,
              operationId: archiveOp,
            },
          }),
        ]) as never,
      );
    h.controller.getStorageOperation.mockImplementation(async (_storageId, operationId) => ({
      operationId,
      type: operationId === restoreOp ? 'restore' : 'archive',
      status: 'succeeded',
      usageBytes: 1024,
      startedAt: '2026-11-02T10:00:00.000Z',
      finishedAt: '2026-11-02T10:10:00.000Z',
      failureReason: null,
    }));
    const restoreSpy = vi.spyOn(service, 'handleRestoreCallback').mockResolvedValue({});
    const archiveSpy = vi.spyOn(service, 'handleArchiveCallback').mockResolvedValue({});

    await service.reconcileRESTORING({ olderThanMs: 0 });
    expect(h.controller.getStorageOperation).toHaveBeenCalledWith(STORAGE_ID, restoreOp);
    expect(restoreSpy).toHaveBeenCalledWith(
      STORAGE_ID,
      expect.objectContaining({ operationId: restoreOp, status: 'SUCCEEDED' }),
    );

    await service.reconcileARCHIVING({ olderThanMs: 0 });
    expect(h.controller.getStorageOperation).toHaveBeenCalledWith(STORAGE_ID, archiveOp);
    expect(archiveSpy).toHaveBeenCalledWith(
      STORAGE_ID,
      expect.objectContaining({ operationId: archiveOp, status: 'SUCCEEDED' }),
    );
    expect(h.controller.getArchive).not.toHaveBeenCalled();
  });
});
