import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/cloud-container.js', () => ({
  CloudContainer: { findOne: vi.fn() },
}));
vi.mock('../models/cloud-host-github-binding.js', () => ({
  CloudHostGithubBinding: { findOneAndUpdate: vi.fn() },
}));
vi.mock('../models/cloud-host-setup-operation.js', () => ({
  CloudHostSetupOperation: {
    create: vi.fn(),
    findById: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
  },
}));
vi.mock('../models/github-account.js', () => ({
  GitHubAccount: { findOne: vi.fn() },
}));
vi.mock('../models/github-installation.js', () => ({
  GitHubInstallation: { find: vi.fn() },
}));

import { CloudContainer } from '../models/cloud-container.js';
import { CloudHostGithubBinding } from '../models/cloud-host-github-binding.js';
import { CloudHostSetupOperation } from '../models/cloud-host-setup-operation.js';
import { GitHubAccount } from '../models/github-account.js';
import { GitHubInstallation } from '../models/github-installation.js';
import {
  CloudHostGithubService,
  GITHUB_SETUP_SCRIPT,
} from './cloud-host-github-service.js';

const USER_ID = '507f1f77bcf86cd799439012';
const CONTROLLER_ID = '507f1f77bcf86cd799439013';
const HOST_ID = '507f1f77bcf86cd799439014';
const CONTAINER_ID = '507f1f77bcf86cd799439015';
const ACCOUNT_ID = '507f1f77bcf86cd799439016';
const WORKLOAD_ID = '507f1f77bcf86cd799439017';

function lean<T>(value: T) {
  return { lean: vi.fn().mockResolvedValue(value) } as never;
}

function makeService(overrides: Record<string, unknown> = {}) {
  const workloadService = {
    requireCloudHost: vi.fn().mockResolvedValue({
      _id: HOST_ID,
      controllerId: CONTROLLER_ID,
      status: 'RUNNING',
      containerId: CONTAINER_ID,
    }),
    updateStep: vi.fn().mockResolvedValue(undefined),
    pollBatch: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
  };
  const controllerClient = {
    startRuntimeWorkload: vi.fn().mockResolvedValue({
      batchId: 'b1',
      items: [{ logId: 'l1', workloadId: WORKLOAD_ID, workloadName: 'Github' }],
    }),
    startRuntimeScript: vi.fn().mockResolvedValue({ batchId: 'b2', logId: 'l2' }),
  };
  const createSession = vi.fn().mockResolvedValue({ id: 'session-1' });
  const ensureWorkspace = vi.fn().mockResolvedValue({ id: 'ws-1' });
  const service = new CloudHostGithubService({
    workloadService: workloadService as never,
    controllerClient: controllerClient as never,
    catalog: {
      findGithubPreset: vi.fn().mockResolvedValue({
        id: WORKLOAD_ID,
        name: 'Github',
        workloadKind: 'standard',
      }),
    } as never,
    createSession,
    ensureWorkspace,
    ...overrides,
  });
  return { service, workloadService, controllerClient, createSession, ensureWorkspace };
}

const operation = {
  _id: 'op1',
  userId: USER_ID,
  controllerId: CONTROLLER_ID,
  hostId: HOST_ID,
  containerId: CONTAINER_ID,
  accountId: ACCOUNT_ID,
  repoFullName: 'owner/repo',
  targetPath: '/root/workspace/repo',
  status: 'RUNNING',
  steps: [
    { key: 'workload', status: 'PENDING', detail: null },
    { key: 'gitSetup', status: 'PENDING', detail: null },
    { key: 'session', status: 'PENDING', detail: null },
  ],
};

describe('CloudHostGithubService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(CloudContainer.findOne).mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ installedWorkloads: [] }) }),
    } as never);
    vi.mocked(CloudHostGithubBinding.findOneAndUpdate).mockResolvedValue({} as never);
    vi.mocked(CloudHostSetupOperation.updateOne).mockResolvedValue({} as never);
  });

  it('T-CHG1: 三步成功，sessionId 回填', async () => {
    vi.mocked(CloudHostSetupOperation.findById).mockReturnValue(lean(operation));
    const { service, controllerClient, createSession, ensureWorkspace } = makeService();

    await (service as any).run('op1');

    expect(controllerClient.startRuntimeWorkload).toHaveBeenCalledWith(
      expect.objectContaining({ workloadId: WORKLOAD_ID, source: 'user' }),
    );
    expect(controllerClient.startRuntimeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        workloadId: WORKLOAD_ID,
        workloadName: 'Git 项目设置',
        githubAuth: true,
        source: 'system',
        params: { repoFullName: 'owner/repo', targetPath: '/root/workspace/repo' },
      }),
    );
    expect(CloudHostGithubBinding.findOneAndUpdate).toHaveBeenCalled();
    expect(ensureWorkspace).toHaveBeenCalledWith(
      CONTROLLER_ID,
      USER_ID,
      '/root/workspace/repo',
    );
    expect(createSession).toHaveBeenCalledWith(USER_ID, {
      controllerId: CONTROLLER_ID,
      workspaceId: 'ws-1',
      acpServerType: 'opencode',
    });
    expect(CloudHostSetupOperation.updateOne).toHaveBeenLastCalledWith(
      { _id: 'op1' },
      { $set: { status: 'SUCCEEDED', sessionId: 'session-1', error: null } },
    );
  });

  it('T-CHG2: workload 已安装 → SKIPPED，仍执行 gitSetup', async () => {
    vi.mocked(CloudContainer.findOne).mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          installedWorkloads: [{ workloadId: WORKLOAD_ID }],
        }),
      }),
    } as never);
    vi.mocked(CloudHostSetupOperation.findById).mockReturnValue(lean(operation));
    const { service, controllerClient, workloadService } = makeService();

    await (service as any).run('op1');

    expect(workloadService.updateStep).toHaveBeenCalledWith('op1', 'workload', {
      status: 'SKIPPED',
      detail: 'Github 工作负载已安装',
    });
    expect(controllerClient.startRuntimeWorkload).not.toHaveBeenCalled();
    expect(controllerClient.startRuntimeScript).toHaveBeenCalled();
  });

  it('T-CHG3: gitSetup 失败 → operation FAILED，session 保持 PENDING', async () => {
    vi.mocked(CloudHostSetupOperation.findById).mockReturnValue(lean(operation));
    const { service, controllerClient, workloadService, createSession } = makeService();
    controllerClient.startRuntimeScript.mockRejectedValue(new Error('clone failed'));

    await (service as any).run('op1');

    expect(createSession).not.toHaveBeenCalled();
    expect(workloadService.fail).toHaveBeenCalledWith('op1', 'clone failed', 'gitSetup');
  });

  it('T-CHG4: session 失败 → operation SUCCEEDED + error 手动建会话提示', async () => {
    vi.mocked(CloudHostSetupOperation.findById).mockReturnValue(lean(operation));
    const { service, createSession } = makeService();
    createSession.mockRejectedValue(new Error('session create failed'));

    await (service as any).run('op1');

    expect(CloudHostSetupOperation.updateOne).toHaveBeenCalledWith(
      { _id: 'op1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'SUCCEEDED',
          error: expect.stringContaining('仓库已就绪，请手动创建会话'),
        }),
      }),
    );
  });

  it('T-CHG7: 错误脱敏：operation error 不含 token', async () => {
    vi.mocked(CloudHostSetupOperation.findById).mockReturnValue(lean(operation));
    const { service, controllerClient, workloadService } = makeService();
    controllerClient.startRuntimeScript.mockRejectedValue(
      new Error('failed token=ghp_secret Authorization: Bearer abc'),
    );

    await (service as any).run('op1');

    const message = workloadService.fail.mock.calls[0][1];
    expect(message).not.toContain('ghp_secret');
    expect(message).not.toContain('Bearer abc');
  });

  it('T-CHG8: 幂等脚本不含 token 且校验目标目录', () => {
    expect(GITHUB_SETUP_SCRIPT).not.toContain('TOKEN');
    expect(GITHUB_SETUP_SCRIPT).toContain('gh repo clone "$REPO" "$TARGET"');
    expect(GITHUB_SETUP_SCRIPT).toContain('目标目录非空且不是 Git 仓库');
    expect(GITHUB_SETUP_SCRIPT).toContain('git -C "$TARGET" pull --ff-only');
  });
});
