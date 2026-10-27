import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/cloud-container.js', () => ({
  CloudContainer: { findOne: vi.fn() },
}));
vi.mock('../models/cloud-host-github-binding.js', () => ({
  CloudHostGithubBinding: { findOneAndUpdate: vi.fn() },
}));
vi.mock('../models/cloud-host.js', () => ({
  CloudHost: { updateOne: vi.fn(), findById: vi.fn() },
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
import { CloudHost } from '../models/cloud-host.js';
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
  targetPath: '/home/worker/workspace/repo',
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
    vi.mocked(CloudHost.updateOne).mockResolvedValue({} as never);
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
        params: { repoFullName: 'owner/repo', targetPath: '/home/worker/workspace/repo' },
      }),
    );
    expect(CloudHostGithubBinding.findOneAndUpdate).toHaveBeenCalled();
    expect(ensureWorkspace).toHaveBeenCalledWith(
      CONTROLLER_ID,
      USER_ID,
      '/home/worker/workspace/repo',
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
    // R-7：Git 项目设置创建默认工作区后回写 workspaceId（仅空时），hasDefaultWorkspace 随之翻转
    expect(CloudHost.updateOne).toHaveBeenCalledWith(
      { _id: HOST_ID, workspaceId: null },
      { $set: { workspaceId: 'ws-1' } },
    );
    // D2：项目会话成功后 CAS 回填 defaultSessionId（仅空时）
    expect(CloudHost.updateOne).toHaveBeenCalledWith(
      { _id: HOST_ID, defaultSessionId: null },
      { $set: { defaultSessionId: 'session-1' } },
    );
  });

  it('U-1: createSession 失败仍回写 workspaceId（hasDefaultWorkspace 可区分「会话创建失败」）', async () => {
    vi.mocked(CloudHostSetupOperation.findById).mockReturnValue(lean(operation));
    const { service, createSession } = makeService();
    createSession.mockRejectedValue(new Error('create session failed'));

    await (service as any).run('op1');

    expect(CloudHost.updateOne).toHaveBeenCalledWith(
      { _id: HOST_ID, workspaceId: null },
      { $set: { workspaceId: 'ws-1' } },
    );
    // 会话未成功，不得回填 defaultSessionId
    expect(CloudHost.updateOne).not.toHaveBeenCalledWith(
      { _id: HOST_ID, defaultSessionId: null },
      expect.anything(),
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

  it('T-CHG2b: Github 已安装时仍安装弹窗额外勾选的工作负载', async () => {
    const EXTRA_ID = '507f1f77bcf86cd799439018';
    vi.mocked(CloudContainer.findOne).mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          installedWorkloads: [{ workloadId: WORKLOAD_ID }],
        }),
      }),
    } as never);
    vi.mocked(CloudHostSetupOperation.findById).mockReturnValue(
      lean({ ...operation, setupWorkloadIds: [WORKLOAD_ID, EXTRA_ID] }),
    );
    const catalog = {
      findGithubPreset: vi.fn().mockResolvedValue({
        id: WORKLOAD_ID,
        name: 'Github',
        workloadKind: 'standard',
      }),
      findById: vi.fn().mockResolvedValue({
        id: EXTRA_ID,
        name: 'Node.js',
        workloadKind: 'standard',
      }),
    };
    const { service, controllerClient, workloadService } = makeService({ catalog: catalog as never });

    await (service as any).run('op1');

    expect(controllerClient.startRuntimeWorkload).toHaveBeenCalledTimes(1);
    expect(controllerClient.startRuntimeWorkload).toHaveBeenCalledWith(
      expect.objectContaining({ workloadId: EXTRA_ID }),
    );
    expect(workloadService.updateStep).toHaveBeenCalledWith('op1', 'workload', {
      status: 'SUCCEEDED',
      detail: 'Github（已安装）、Node.js',
    });
  });

  it('T-CHG9: createSession=false（多 Harness）在 gitSetup 收尾初始化工作区并 CAS 回写', async () => {
    const skippedOperation = {
      ...operation,
      steps: [
        { key: 'workload', status: 'SUCCEEDED', detail: 'Github' },
        { key: 'gitSetup', status: 'PENDING', detail: null },
        { key: 'session', status: 'SKIPPED', detail: '多 Harness 不自动创建会话' },
      ],
    };
    vi.mocked(CloudHostSetupOperation.findById).mockReturnValue(lean(skippedOperation));
    const { service, workloadService, ensureWorkspace, createSession } = makeService();

    await (service as any).run('op1');

    // 工作区初始化不再依赖 session 步骤
    expect(ensureWorkspace).toHaveBeenCalledTimes(1);
    expect(ensureWorkspace).toHaveBeenCalledWith(
      CONTROLLER_ID,
      USER_ID,
      '/home/worker/workspace/repo',
    );
    expect(CloudHost.updateOne).toHaveBeenCalledWith(
      { _id: HOST_ID, workspaceId: null },
      { $set: { workspaceId: 'ws-1' } },
    );
    expect(workloadService.updateStep).toHaveBeenCalledWith('op1', 'gitSetup', {
      status: 'SUCCEEDED',
      detail: 'owner/repo',
    });
    expect(workloadService.updateStep).not.toHaveBeenCalledWith(
      'op1',
      'session',
      expect.anything(),
    );
    expect(createSession).not.toHaveBeenCalled();
    expect(CloudHostSetupOperation.updateOne).toHaveBeenLastCalledWith(
      { _id: 'op1' },
      { $set: { status: 'SUCCEEDED', error: null } },
    );
  });

  it('T-CHG10: ensureWorkspace 抛错 → gitSetup FAILED、operation FAILED，session 不执行', async () => {
    vi.mocked(CloudHostSetupOperation.findById).mockReturnValue(lean(operation));
    const { service, workloadService, ensureWorkspace, createSession } = makeService();
    ensureWorkspace.mockRejectedValue(new Error('ensure workspace failed'));

    await (service as any).run('op1');

    expect(workloadService.fail).toHaveBeenCalledWith(
      'op1',
      'ensure workspace failed',
      'gitSetup',
    );
    expect(workloadService.updateStep).not.toHaveBeenCalledWith(
      'op1',
      'gitSetup',
      expect.objectContaining({ status: 'SUCCEEDED' }),
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it('T-CHG10b: 初始化失败后重试幂等收敛（不重复创建 operation）', async () => {
    vi.mocked(CloudHostSetupOperation.findById).mockReturnValue(lean(operation));
    const { service, ensureWorkspace, workloadService, createSession } = makeService();
    ensureWorkspace.mockRejectedValueOnce(new Error('ensure workspace failed'));

    await (service as any).run('op1');
    expect(workloadService.fail).toHaveBeenCalledTimes(1);

    // 重试重跑同一 operation：clone 脚本幂等（git pull --ff-only），工作区 upsert 幂等
    await (service as any).run('op1');
    // 首轮仅 gitSetup 收尾 1 次（session 未执行）；次轮 gitSetup 收尾 + session 兜底 2 次
    expect(ensureWorkspace).toHaveBeenCalledTimes(3);
    expect(CloudHostSetupOperation.create).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('T-CHG11: createSession=true 时收尾与 session 兜底两次幂等初始化，defaultSessionId 回写不变', async () => {
    vi.mocked(CloudHostSetupOperation.findById).mockReturnValue(lean(operation));
    const { service, ensureWorkspace, createSession } = makeService();

    await (service as any).run('op1');

    expect(ensureWorkspace).toHaveBeenCalledTimes(2);
    expect(ensureWorkspace).toHaveBeenNthCalledWith(
      1,
      CONTROLLER_ID,
      USER_ID,
      '/home/worker/workspace/repo',
    );
    expect(ensureWorkspace).toHaveBeenNthCalledWith(
      2,
      CONTROLLER_ID,
      USER_ID,
      '/home/worker/workspace/repo',
    );
    const workspaceCasCalls = vi
      .mocked(CloudHost.updateOne)
      .mock.calls.filter(
        ([filter]) => (filter as unknown as Record<string, unknown>).workspaceId === null,
      );
    expect(workspaceCasCalls).toHaveLength(2);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(CloudHost.updateOne).toHaveBeenCalledWith(
      { _id: HOST_ID, defaultSessionId: null },
      { $set: { defaultSessionId: 'session-1' } },
    );
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

  describe('createOperation 前缀拼接（T-CHG-P1..P6）', () => {
    const created: Array<Record<string, unknown>> = [];

    beforeEach(() => {
      created.length = 0;
      vi.mocked(GitHubAccount.findOne).mockReturnValue(lean({ _id: ACCOUNT_ID }) as never);
      vi.mocked(GitHubInstallation.find).mockReturnValue(
        lean([{ repos: [{ fullName: 'User/Repo' }] }]) as never,
      );
      vi.mocked(CloudHostSetupOperation.findOne).mockReturnValue(lean(null) as never);
      vi.mocked(CloudHostSetupOperation.create).mockImplementation((async (doc: unknown) => {
        const value = doc as Record<string, unknown>;
        created.push(value);
        return { _id: 'op1', toObject: () => ({ _id: 'op1', ...value }) };
      }) as never);
    });

    it('T-CHG-P1: 前缀末尾斜杠 + User/Repo → 最终路径为前缀/仓库', async () => {
      const { service } = makeService();

      await service.createOperation({
        userId: USER_ID,
        controllerId: CONTROLLER_ID,
        accountId: ACCOUNT_ID,
        repoFullName: ' User/Repo ',
        targetPath: '/home/worker/workspace/',
      });

      expect(created[0]).toMatchObject({
        repoFullName: 'User/Repo',
        targetPath: '/home/worker/workspace/User/Repo',
      });
    });

    it('T-CHG-P1b: createSession=false 时 session 步骤初始化为 SKIPPED（多 Harness）', async () => {
      const { service } = makeService();

      await service.createOperation({
        userId: USER_ID,
        controllerId: CONTROLLER_ID,
        accountId: ACCOUNT_ID,
        repoFullName: 'User/Repo',
        targetPath: '/home/worker/workspace',
        createSession: false,
      });

      expect(created[0].steps).toEqual([
        { key: 'workload', status: 'PENDING', detail: null },
        { key: 'gitSetup', status: 'PENDING', detail: null },
        { key: 'session', status: 'SKIPPED', detail: '多 Harness 不自动创建会话' },
      ]);
    });

    it('T-CHG-P1c: 缺省 createSession 保持 PENDING（单 Harness 旧行为）', async () => {
      const { service } = makeService();

      await service.createOperation({
        userId: USER_ID,
        controllerId: CONTROLLER_ID,
        accountId: ACCOUNT_ID,
        repoFullName: 'User/Repo',
        targetPath: '/home/worker/workspace',
      });

      expect(created[0].steps).toEqual([
        { key: 'workload', status: 'PENDING', detail: null },
        { key: 'gitSetup', status: 'PENDING', detail: null },
        { key: 'session', status: 'PENDING', detail: null },
      ]);
    });

    it('T-CHG-P1d: 默认前缀（迁移 008 后）拼出单层目录', async () => {
      const { service } = makeService();
      await service.createOperation({
        userId: USER_ID,
        controllerId: CONTROLLER_ID,
        accountId: ACCOUNT_ID,
        repoFullName: 'User/Repo',
        targetPath: '/home/worker/workspace',
      });
      expect(created[0].targetPath).toBe('/home/worker/workspace/User/Repo');
    });

    it('T-CHG-P7: ~ 前缀展开后落库为绝对路径', async () => {
      const { service } = makeService();
      await service.createOperation({
        userId: USER_ID,
        controllerId: CONTROLLER_ID,
        accountId: ACCOUNT_ID,
        repoFullName: 'User/Repo',
        targetPath: '~/workspace',
      });
      expect(created[0].targetPath).toBe('/home/worker/workspace/User/Repo');
    });

    it('T-CHG-P2/P3/P4: binding / 脚本 / 会话均使用 finalPath', async () => {
      vi.mocked(CloudHostSetupOperation.findById).mockReturnValue(
        lean({
          _id: 'op1',
          userId: USER_ID,
          controllerId: CONTROLLER_ID,
          hostId: HOST_ID,
          containerId: CONTAINER_ID,
          accountId: ACCOUNT_ID,
          repoFullName: 'User/Repo',
          targetPath: '/home/worker/workspace/User/Repo',
          status: 'RUNNING',
          steps: [
            { key: 'workload', status: 'PENDING', detail: null },
            { key: 'gitSetup', status: 'PENDING', detail: null },
            { key: 'session', status: 'PENDING', detail: null },
          ],
        }) as never,
      );
      const { service, controllerClient, ensureWorkspace } = makeService();

      await (service as any).run('op1');

      expect(CloudHostGithubBinding.findOneAndUpdate).toHaveBeenCalledWith(
        { controllerId: CONTROLLER_ID },
        expect.objectContaining({
          $set: expect.objectContaining({ targetPath: '/home/worker/workspace/User/Repo' }),
        }),
        { upsert: true, new: true },
      );
      expect(controllerClient.startRuntimeScript).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { repoFullName: 'User/Repo', targetPath: '/home/worker/workspace/User/Repo' },
        }),
      );
      expect(ensureWorkspace).toHaveBeenCalledWith(
        CONTROLLER_ID,
        USER_ID,
        '/home/worker/workspace/User/Repo',
      );
    });

    it('T-CHG-P6: 非法前缀在创建前报错，不产生 operation', async () => {
      const { service } = makeService();

      await expect(
        service.createOperation({
          userId: USER_ID,
          controllerId: CONTROLLER_ID,
          accountId: ACCOUNT_ID,
          repoFullName: 'User/Repo',
          targetPath: 'root/workspace',
        }),
      ).rejects.toThrow('前缀地址必须以 / 或 ~ 开头');

      await expect(
        service.createOperation({
          userId: USER_ID,
          controllerId: CONTROLLER_ID,
          accountId: ACCOUNT_ID,
          repoFullName: 'User/Repo',
          targetPath: '/home/worker/../etc',
        }),
      ).rejects.toThrow('前缀地址不能包含 ..');

      await expect(
        service.createOperation({
          userId: USER_ID,
          controllerId: CONTROLLER_ID,
          accountId: ACCOUNT_ID,
          repoFullName: 'owner/..',
          targetPath: '/home/worker/workspace',
        }),
      ).rejects.toThrow('仓库格式应为 owner/repo');

      expect(CloudHostSetupOperation.create).not.toHaveBeenCalled();
    });
  });

  describe('Github 帐号锁定（T-CHG12..T-CHG14）', () => {
    const baseWorkload = {
      updateStep: vi.fn().mockResolvedValue(undefined),
      pollBatch: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };

    beforeEach(() => {
      vi.mocked(GitHubAccount.findOne).mockReturnValue(lean({ _id: ACCOUNT_ID }) as never);
      vi.mocked(GitHubInstallation.find).mockReturnValue(
        lean([{ repos: [{ fullName: 'owner/repo' }] }]) as never,
      );
      vi.mocked(CloudHostSetupOperation.findOne).mockReturnValue(lean(null) as never);
      vi.mocked(CloudHostSetupOperation.create).mockReturnValue({
        _id: 'op1',
        toObject: () => ({ _id: 'op1' }),
      } as never);
    });

    it('T-CHG12: 未锁定首绑 CAS 后创建 operation', async () => {
      vi.mocked(CloudHost.updateOne).mockResolvedValue({ matchedCount: 1 } as never);
      const host = {
        _id: HOST_ID,
        controllerId: CONTROLLER_ID,
        status: 'RUNNING',
        containerId: CONTAINER_ID,
      };
      const { service } = makeService({
        workloadService: { ...baseWorkload, requireCloudHost: vi.fn().mockResolvedValue(host) },
      });
      await service.createOperation({
        userId: USER_ID,
        controllerId: CONTROLLER_ID,
        accountId: ACCOUNT_ID,
        repoFullName: 'owner/repo',
        targetPath: '/home/worker/workspace',
      });
      expect(CloudHost.updateOne).toHaveBeenCalledWith(
        { _id: HOST_ID, githubAccountId: null },
        { $set: { githubAccountId: ACCOUNT_ID } },
      );
      expect(CloudHostSetupOperation.create).toHaveBeenCalled();
    });

    it('T-CHG13: 已锁定同帐号照常执行', async () => {
      const host = {
        _id: HOST_ID,
        controllerId: CONTROLLER_ID,
        status: 'RUNNING',
        containerId: CONTAINER_ID,
        githubAccountId: ACCOUNT_ID,
      };
      const { service } = makeService({
        workloadService: { ...baseWorkload, requireCloudHost: vi.fn().mockResolvedValue(host) },
      });
      await service.createOperation({
        userId: USER_ID,
        controllerId: CONTROLLER_ID,
        accountId: ACCOUNT_ID,
        repoFullName: 'owner/repo',
        targetPath: '/home/worker/workspace',
      });
      expect(CloudHostSetupOperation.create).toHaveBeenCalled();
    });

    it('T-CHG14: 已锁定异帐号拒绝且不创建 operation', async () => {
      vi.mocked(GitHubAccount.findOne).mockReturnValue(
        lean({ _id: '507f1f77bcf86cd799439099' }) as never,
      );
      const host = {
        _id: HOST_ID,
        controllerId: CONTROLLER_ID,
        status: 'RUNNING',
        containerId: CONTAINER_ID,
        githubAccountId: ACCOUNT_ID,
      };
      const { service } = makeService({
        workloadService: { ...baseWorkload, requireCloudHost: vi.fn().mockResolvedValue(host) },
      });
      await expect(
        service.createOperation({
          userId: USER_ID,
          controllerId: CONTROLLER_ID,
          accountId: '507f1f77bcf86cd799439099',
          repoFullName: 'owner/repo',
          targetPath: '/home/worker/workspace',
        }),
      ).rejects.toThrow('github account is locked');
      expect(CloudHostSetupOperation.create).not.toHaveBeenCalled();
    });

    it('T-CHG15: CAS 未命中时重读并按已锁定重判（并发首绑）', async () => {
      vi.mocked(CloudHost.updateOne).mockResolvedValue({ matchedCount: 0 } as never);
      vi.mocked(CloudHost.findById).mockReturnValue(
        lean({ githubAccountId: ACCOUNT_ID }) as never,
      );
      const host = {
        _id: HOST_ID,
        controllerId: CONTROLLER_ID,
        status: 'RUNNING',
        containerId: CONTAINER_ID,
      };
      const { service } = makeService({
        workloadService: { ...baseWorkload, requireCloudHost: vi.fn().mockResolvedValue(host) },
      });
      await service.createOperation({
        userId: USER_ID,
        controllerId: CONTROLLER_ID,
        accountId: ACCOUNT_ID,
        repoFullName: 'owner/repo',
        targetPath: '/home/worker/workspace',
      });
      expect(CloudHost.findById).toHaveBeenCalledWith(HOST_ID);
      expect(CloudHostSetupOperation.create).toHaveBeenCalled();
    });

    it('T-CHG16: 锁定帐号被删除时报归属错误且不解除锁定', async () => {
      vi.mocked(GitHubAccount.findOne).mockReturnValue(lean(null) as never);
      const host = {
        _id: HOST_ID,
        controllerId: CONTROLLER_ID,
        status: 'RUNNING',
        containerId: CONTAINER_ID,
        githubAccountId: ACCOUNT_ID,
      };
      const { service } = makeService({
        workloadService: { ...baseWorkload, requireCloudHost: vi.fn().mockResolvedValue(host) },
      });
      await expect(
        service.createOperation({
          userId: USER_ID,
          controllerId: CONTROLLER_ID,
          accountId: ACCOUNT_ID,
          repoFullName: 'owner/repo',
          targetPath: '/home/worker/workspace',
        }),
      ).rejects.toThrow('Github 账号不存在或不属于当前用户');
      expect(CloudHost.updateOne).not.toHaveBeenCalled();
      expect(CloudHostSetupOperation.create).not.toHaveBeenCalled();
    });
  });
});
