import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/controller.js', () => ({
  Controller: { findOne: vi.fn() },
}));
vi.mock('../models/cloud-container.js', () => ({
  CloudContainer: { findOne: vi.fn() },
}));
vi.mock('../models/cloud-host-setup-operation.js', () => ({
  CloudHostSetupOperation: {
    create: vi.fn(),
    findById: vi.fn(),
    findOne: vi.fn(),
    updateOne: vi.fn(),
  },
}));
vi.mock('./cloud-host-service.js', () => ({
  cloudHostService: { findOwnedRawHostByController: vi.fn() },
}));

import { Controller } from '../models/controller.js';
import { CloudContainer } from '../models/cloud-container.js';
import { CloudHostSetupOperation } from '../models/cloud-host-setup-operation.js';
import { cloudHostService } from './cloud-host-service.js';
import {
  CloudHostWorkloadService,
  mapOperation,
  sanitizeOperationError,
} from './cloud-host-workload-service.js';

const USER_ID = '507f1f77bcf86cd799439012';
const CONTROLLER_ID = '507f1f77bcf86cd799439013';
const HOST_ID = '507f1f77bcf86cd799439014';
const CONTAINER_ID = '507f1f77bcf86cd799439015';
const W1 = '507f1f77bcf86cd799439016';

function lean<T>(value: T) {
  return { lean: vi.fn().mockResolvedValue(value) } as never;
}

describe('CloudHostWorkloadService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Controller.findOne).mockReturnValue(lean({ type: 'cloud' }));
    vi.mocked(cloudHostService.findOwnedRawHostByController).mockResolvedValue({
      _id: HOST_ID,
      controllerId: CONTROLLER_ID,
      status: 'RUNNING',
      containerId: CONTAINER_ID,
    } as never);
  });

  it('T-CHW1: list 只返回 standard 并附安装标记', async () => {
    vi.mocked(CloudContainer.findOne).mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          installedWorkloads: [
            { workloadId: 'w1', name: 'Github', installedAt: new Date(), source: 'user' },
          ],
        }),
      }),
    } as never);
    const service = new CloudHostWorkloadService({
      catalog: {
        listStandard: vi.fn().mockResolvedValue([
          {
            id: 'w1',
            name: 'Github',
            paramSchema: [],
            dependsOnWorkloadIds: ['w2'],
            isPreset: true,
            workloadKind: 'standard',
            initScript: 'x',
          },
          {
            id: 'w2',
            name: 'Node',
            paramSchema: [],
            dependsOnWorkloadIds: [],
            isPreset: false,
            workloadKind: 'standard',
            initScript: 'x',
          },
        ]),
      } as never,
    });

    const items = await service.list(USER_ID, CONTROLLER_ID);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ workloadId: 'w1', installed: true, source: 'user' });
    // C-27：dependsOnWorkloadIds 作为契约字段必须原样透出（不能只返回 installed/name）
    expect(items[0].dependsOnWorkloadIds).toEqual(['w2']);
    expect(items[1]).toMatchObject({ workloadId: 'w2', installed: false, dependsOnWorkloadIds: [] });
  });

  it('T-CHW1-b: list 透出 workloadKind（standard 固定 STANDARD）', async () => {
    vi.mocked(CloudContainer.findOne).mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
    } as never);
    const service = new CloudHostWorkloadService({
      catalog: {
        listStandard: vi.fn().mockResolvedValue([
          {
            id: 'w1',
            name: 'Docker',
            paramSchema: [],
            dependsOnWorkloadIds: [],
            isPreset: false,
            workloadKind: 'standard',
            initScript: 'x',
          },
        ]),
      } as never,
    });

    const items = await service.list(USER_ID, CONTROLLER_ID);
    expect(items[0].workloadKind).toBe('STANDARD');
  });

  it('T-CHW-CAT: listCatalog 无主机上下文返回全部 standard 且 installed=false', async () => {
    const listStandard = vi.fn().mockResolvedValue([
      {
        id: 'w1',
        name: 'Aspire',
        paramSchema: [{ key: 'x', label: 'X', type: 'text', options: [], defaultValue: '' }],
        dependsOnWorkloadIds: ['w0'],
        isPreset: false,
        workloadKind: 'standard',
        initScript: 'x',
      },
    ]);
    const service = new CloudHostWorkloadService({ catalog: { listStandard } as never });

    const items = await service.listCatalog();

    expect(items).toEqual([
      {
        workloadId: 'w1',
        name: 'Aspire',
        workloadKind: 'STANDARD',
        paramSchema: [{ key: 'x', label: 'X', type: 'text', options: [], defaultValue: '' }],
        dependsOnWorkloadIds: ['w0'],
        isPreset: false,
        installed: false,
        installedAt: null,
        source: null,
      },
    ]);
    expect(CloudContainer.findOne).not.toHaveBeenCalled();
  });

  it('T-CHW2/T-CHW5: 已安装项走 SKIPPED，不调用 runtime 接口', async () => {
    vi.mocked(CloudContainer.findOne).mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          installedWorkloads: [{ workloadId: W1, name: 'Github' }],
        }),
      }),
    } as never);
    vi.mocked(CloudHostSetupOperation.create).mockResolvedValue({
      _id: 'op1',
      toObject: () => ({
        _id: 'op1',
        kind: 'installWorkload',
        status: 'RUNNING',
        steps: [{ key: 'workload', status: 'PENDING' }],
      }),
    } as never);
    vi.mocked(CloudHostSetupOperation.findById).mockReturnValue(
      lean({
        _id: 'op1',
        hostId: HOST_ID,
        containerId: CONTAINER_ID,
        workloadId: W1,
        status: 'RUNNING',
      }),
    );
    const controllerClient = { startRuntimeWorkload: vi.fn() };
    const updateStep = vi.fn();
    const service = new CloudHostWorkloadService({
      controllerClient: controllerClient as never,
      catalog: {
        findById: vi.fn().mockResolvedValue({
          id: W1,
          name: 'Github',
          workloadKind: 'standard',
        }),
      } as never,
    });
    vi.spyOn(service, 'updateStep').mockImplementation(updateStep);
    vi.spyOn(service, 'enqueue').mockImplementation(() => undefined);

    await service.createInstallOperation({
      userId: USER_ID,
      controllerId: CONTROLLER_ID,
      workloadId: W1,
    });
    await (service as any).runInstall('op1');

    expect(controllerClient.startRuntimeWorkload).not.toHaveBeenCalled();
    expect(updateStep).toHaveBeenCalledWith('op1', 'workload', {
      status: 'SKIPPED',
      detail: 'Github（已安装）',
    });
  });

  it('T-CHW3: 安装成功 → startRuntimeWorkload + poll → SUCCEEDED', async () => {
    vi.mocked(CloudContainer.findOne).mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ installedWorkloads: [] }),
      }),
    } as never);
    vi.mocked(CloudHostSetupOperation.findById).mockReturnValue(
      lean({
        _id: 'op2',
        hostId: HOST_ID,
        containerId: CONTAINER_ID,
        workloadId: W1,
        status: 'RUNNING',
        installParams: { version: '20' },
      }),
    );
    const controllerClient = {
      startRuntimeWorkload: vi.fn().mockResolvedValue({
        batchId: 'b1',
        items: [{ logId: 'l1', workloadId: 'w1', workloadName: 'Github' }],
      }),
      getWorkloadLogs: vi.fn().mockResolvedValue([
        { id: 'l1', status: 'success', workloadName: 'Github', log: '' },
      ]),
    };
    const service = new CloudHostWorkloadService({
      controllerClient: controllerClient as never,
      catalog: {
        findById: vi.fn().mockResolvedValue({
          id: W1,
          name: 'Github',
          workloadKind: 'standard',
        }),
      } as never,
    });
    vi.spyOn(service, 'updateStep').mockResolvedValue();
    vi.spyOn(service, 'pollBatch').mockResolvedValue();

    await (service as any).runInstall('op2');

    expect(controllerClient.startRuntimeWorkload).toHaveBeenCalledWith({
      containerId: CONTAINER_ID,
      workloadId: W1,
      params: { version: '20' },
      source: 'user',
    });
    expect(CloudHostSetupOperation.updateOne).toHaveBeenLastCalledWith(
      { _id: 'op2' },
      { $set: { status: 'SUCCEEDED', error: null } },
    );
  });

  it('T-CHW4: 执行失败 → operation FAILED，错误可读且脱敏', async () => {
    vi.mocked(CloudHostSetupOperation.findById).mockReturnValue(
      lean({
        _id: 'op3',
        status: 'RUNNING',
        steps: [{ key: 'workload', status: 'RUNNING' }],
      }),
    );
    const service = new CloudHostWorkloadService();
    vi.spyOn(service, 'updateStep').mockResolvedValue();

    await service.fail('op3', new Error('token=ghp_secret Authorization: Bearer abc'));

    const patch = vi.mocked(CloudHostSetupOperation.updateOne).mock.calls.at(-1)?.[1] as any;
    expect(patch.$set.status).toBe('FAILED');
    expect(patch.$set.error).not.toContain('ghp_secret');
    expect(patch.$set.error).not.toContain('Bearer abc');
  });

  it('T-CHW4b: runInstall 执行失败 → step.workload 被置 FAILED（不再把 workloadId 当 stepKey）', async () => {
    vi.mocked(CloudHostSetupOperation.findById).mockReturnValue(
      lean({
        _id: 'op4',
        hostId: HOST_ID,
        containerId: CONTAINER_ID,
        workloadId: W1,
        status: 'RUNNING',
        steps: [{ key: 'workload', status: 'RUNNING', detail: 'Github' }],
      }),
    );
    const controllerClient = {
      startRuntimeWorkload: vi.fn().mockRejectedValue(new Error('control plane down')),
    };
    const service = new CloudHostWorkloadService({
      controllerClient: controllerClient as never,
      catalog: {
        findById: vi.fn().mockResolvedValue({
          id: W1,
          name: 'Github',
          workloadKind: 'standard',
        }),
      } as never,
    });
    vi.spyOn(service, 'updateStep').mockResolvedValue();

    await (service as any).runInstall('op4');

    const patch = vi.mocked(CloudHostSetupOperation.updateOne).mock.calls.at(-1)?.[1] as any;
    expect(patch.$set.status).toBe('FAILED');
    expect(patch.$set.steps).toEqual([
      expect.objectContaining({ key: 'workload', status: 'FAILED' }),
    ]);
  });

  it('mapOperation/sanitizeOperationError 输出契约形态', () => {
    expect(
      mapOperation({
        _id: 'op1',
        kind: 'githubSetup',
        status: 'FAILED',
        steps: [{ key: 'workload', status: 'SUCCEEDED', detail: null }],
        createdAt: new Date('2026-10-22T00:00:00.000Z'),
        updatedAt: new Date('2026-10-22T00:01:00.000Z'),
      }),
    ).toMatchObject({ kind: 'GITHUB_SETUP', status: 'FAILED' });
    expect(sanitizeOperationError('ghp_abc123 token=xyz')).toBe('*** token=***');
  });
});
