import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { CloudContainer } from '../models/cloud-container.js';
import { CloudHost } from '../models/cloud-host.js';
import { CloudHostGithubBinding } from '../models/cloud-host-github-binding.js';
import { CloudHostSetupOperation } from '../models/cloud-host-setup-operation.js';
import { GitHubAccount } from '../models/github-account.js';
import { GitHubInstallation } from '../models/github-installation.js';
import {
  CloudControllerClient,
  cloudControllerClient,
} from './cloud-controller-client.js';
import { cloudHostService } from './cloud-host-service.js';
import {
  cloudHostWorkloadService,
  CloudHostWorkloadService,
  mapOperation,
  sanitizeOperationError,
} from './cloud-host-workload-service.js';
import { cloudWorkloadCatalog } from './cloud-workload-catalog.js';
import { controllerWorkspaceService } from './controller-workspace.js';
import { KeyedMutex } from './keyed-mutex.js';
import { sessionService } from './session.js';
import { normalizeWorkspacePrefix, resolveClonePath } from './workspace-path.js';

type Doc = Record<string, unknown>;

interface GithubSetupServiceDeps {
  controllerClient?: CloudControllerClient;
  workloadService?: CloudHostWorkloadService;
  catalog?: typeof cloudWorkloadCatalog;
  createSession?: typeof sessionService.create;
  ensureWorkspace?: typeof controllerWorkspaceService.ensureWorkspace;
  stepTimeoutMs?: number;
}

/** 幂等 Git 设置脚本：认证由容器的 github-credential-manager 在批次前完成。 */
export const GITHUB_SETUP_SCRIPT = `set -euo pipefail
TARGET="\${WORKLOAD_PARAM_TARGETPATH:?missing targetPath}"
REPO="\${WORKLOAD_PARAM_REPOFULLNAME:?missing repoFullName}"
command -v gh >/dev/null || { echo "gh 不可用，请先安装 Github 工作负载"; exit 1; }
if [ -d "$TARGET/.git" ]; then
  ORIGIN="$(git -C "$TARGET" remote get-url origin 2>/dev/null || true)"
  case "$ORIGIN" in
    *"github.com/$REPO"|*"github.com:$REPO") git -C "$TARGET" pull --ff-only ;;
    *) echo "目标目录已存在其他 Git 仓库，请修改 clone 路径"; exit 2 ;;
  esac
else
  if [ -d "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
    echo "目标目录非空且不是 Git 仓库，请修改 clone 路径"; exit 3
  fi
  gh repo clone "$REPO" "$TARGET"
fi
`;

/**
 * 云主机 Github 项目设置编排：工作负载安装 → 凭据/仓库拉取（runtime 脚本）→ 会话创建。
 * 设置批次下发前 upsert 绑定记录，供容器凭据管理器按 controllerId 取回本机仓库凭据。
 */
export class CloudHostGithubService {
  /** 同一云主机串行化设置请求（进程内），与 DB RUNNING 查询构成双保险。 */
  private readonly mutex = new KeyedMutex();
  private readonly controllerClient: CloudControllerClient;
  private readonly workloadService: CloudHostWorkloadService;
  private readonly catalog: typeof cloudWorkloadCatalog;
  private readonly createSession: typeof sessionService.create;
  private readonly ensureWorkspace: typeof controllerWorkspaceService.ensureWorkspace;

  constructor(deps: GithubSetupServiceDeps = {}) {
    this.controllerClient = deps.controllerClient ?? cloudControllerClient;
    this.workloadService = deps.workloadService ?? cloudHostWorkloadService;
    this.catalog = deps.catalog ?? cloudWorkloadCatalog;
    this.createSession = deps.createSession ?? sessionService.create.bind(sessionService);
    this.ensureWorkspace =
      deps.ensureWorkspace ?? controllerWorkspaceService.ensureWorkspace.bind(controllerWorkspaceService);
  }

  async createOperation(input: {
    userId: string;
    controllerId: string;
    accountId: string;
    repoFullName: string;
    targetPath: string;
    workloadIds?: string[];
    createSession?: boolean;
  }): Promise<Doc> {
    const host = await this.workloadService.requireCloudHost(input.userId, input.controllerId);
    if (host.status !== 'RUNNING') throw new Error('cloud host is not running');
    if (!host.containerId) throw new Error('cloud host is not running');

    const repoFullName = input.repoFullName.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repoFullName)) {
      throw new Error('仓库格式应为 owner/repo');
    }
    // targetPath 语义为 clone 前缀地址（工作根目录）；最终目录由服务端权威拼接。
    const prefix = normalizeWorkspacePrefix(input.targetPath);
    const targetPath = resolveClonePath(prefix, repoFullName);

    const account = await GitHubAccount.findOne({
      _id: input.accountId,
      userId: input.userId,
    }).lean();
    if (!account) throw new Error('Github 账号不存在或不属于当前用户');
    const installations = await GitHubInstallation.find({ accountId: account._id }).lean();
    const authorized = installations.some((installation) =>
      (installation.repos ?? []).some(
        (repo) => repo.fullName.toLowerCase() === repoFullName.toLowerCase(),
      ),
    );
    if (!authorized) throw new Error('仓库未授权，请前往设置页重新授权');

    return this.mutex.runExclusive(`github-setup:${input.controllerId}`, async () => {
      const running = await CloudHostSetupOperation.findOne({
        controllerId: input.controllerId,
        userId: input.userId,
        kind: 'githubSetup',
        status: 'RUNNING',
      }).lean();
      if (running) throw new Error('该云电脑正在执行 Github 项目设置');

      const operation = await CloudHostSetupOperation.create(({
        userId: input.userId,
        controllerId: input.controllerId,
        hostId: host._id,
        kind: 'githubSetup',
        status: 'RUNNING',
        steps: [
          { key: 'workload', status: 'PENDING', detail: null },
          { key: 'gitSetup', status: 'PENDING', detail: null },
          input.createSession === false
            ? {
                key: 'session',
                status: 'SKIPPED',
                detail: '多 Harness 不自动创建会话',
              }
            : { key: 'session', status: 'PENDING', detail: null },
        ],
        containerId: String(host.containerId),
        accountId: input.accountId,
        repoFullName,
        targetPath,
        setupWorkloadIds: input.workloadIds ?? [],
      }) as any);
      this.enqueue(String(operation._id));
      return mapOperation(operation.toObject());
    });
  }

  enqueue(opId: string): void {
    void this.run(opId).catch((err) => this.workloadService.fail(opId, err));
  }

  /** 重试：仅 FAILED；失败步骤及其后续步骤重置 PENDING，保留 SUCCEEDED/SKIPPED。 */
  async retry(opId: string, userId: string): Promise<Doc> {
    const operation = await CloudHostSetupOperation.findOne({ _id: opId, userId }).lean();
    if (!operation) throw new Error('Operation not found');
    if (operation.status !== 'FAILED') throw new Error('仅失败的操作可以重试');
    const steps = (operation.steps as any[]).map((step: Record<string, unknown>) => ({
      ...step,
      status:
        step.status === 'SUCCEEDED' || step.status === 'SKIPPED' ? step.status : 'PENDING',
      detail:
        step.status === 'SUCCEEDED' || step.status === 'SKIPPED' ? step.detail : null,
    }));
    await CloudHostSetupOperation.updateOne(
      { _id: opId },
      { $set: { status: 'RUNNING', error: null, steps } },
    );
    this.enqueue(opId);
    const updated = await CloudHostSetupOperation.findById(opId).lean();
    return mapOperation(updated as Doc);
  }

  private async run(opId: string): Promise<void> {
    const operation = await CloudHostSetupOperation.findById(opId).lean();
    if (!operation || operation.status !== 'RUNNING') return;
    const op = operation as Doc;
    const steps = new Map(
      ((op.steps ?? []) as Array<Record<string, unknown>>).map((step) => [
        String(step.key),
        String(step.status),
      ]),
    );

    try {
      // 1) 工作负载：Github 预制项（已安装则跳过）
      if (steps.get('workload') !== 'SUCCEEDED' && steps.get('workload') !== 'SKIPPED') {
        try {
          await this.runWorkloadStep(opId, op);
        } catch (err) {
          await this.workloadService.fail(opId, this.describe(err), 'workload');
          return;
        }
      }

      // 2) Git 项目设置：绑定 upsert + runtime 脚本 + 轮询
      if (steps.get('gitSetup') !== 'SUCCEEDED' && steps.get('gitSetup') !== 'SKIPPED') {
        try {
          await this.runGitSetupStep(opId, op);
        } catch (err) {
          await this.workloadService.fail(opId, this.describe(err), 'gitSetup');
          return;
        }
      }

      // 3) 会话创建（失败不使 operation FAILED）
      if (steps.get('session') === 'SUCCEEDED' || steps.get('session') === 'SKIPPED') {
        await CloudHostSetupOperation.updateOne(
          { _id: opId },
          { $set: { status: 'SUCCEEDED', error: null } },
        );
        return;
      }
      await this.runSessionStep(opId, op);
    } catch (err) {
      await this.workloadService.fail(opId, this.describe(err), await this.failingStep(opId));
    }
  }

  private async failingStep(opId: string): Promise<string> {
    const operation = await CloudHostSetupOperation.findById(opId).lean();
    const steps = (operation?.steps ?? []) as unknown as Array<Record<string, unknown>>;
    const failed = steps.find((step) => step.status === 'FAILED');
    if (failed) return String(failed.key);
    const running = steps.find((step) => step.status === 'RUNNING');
    return running ? String(running.key) : 'workload';
  }

  private async runWorkloadStep(opId: string, op: Doc): Promise<void> {
    const github = await this.catalog.findGithubPreset();
    if (!github) throw new Error('Github 工作负载未配置');
    const installed = await this.isInstalled(String(op.hostId), github.id);
    if (installed) {
      await this.workloadService.updateStep(opId, 'workload', {
        status: 'SKIPPED',
        detail: 'Github 工作负载已安装',
      });
    } else {
      await this.workloadService.updateStep(opId, 'workload', {
        status: 'RUNNING',
        detail: github.name,
      });
      const result = await this.controllerClient.startRuntimeWorkload({
        containerId: String(op.containerId),
        workloadId: github.id,
        params: {
          repoFullName: String(op.repoFullName ?? ''),
          targetPath: String(op.targetPath ?? ''),
        },
        source: 'user',
      });
      await this.workloadService.pollBatch(
        opId,
        String(op.containerId),
        result.items.map((item) => item.logId),
        'workload',
      );
    }

    // 弹窗中额外勾选的 standard 工作负载（Github 固定，已去重）；Github 已安装时同样执行。
    const extras = Array.isArray(op.setupWorkloadIds)
      ? (op.setupWorkloadIds as unknown[]).map((value) => String(value))
      : [];
    const extraNames: string[] = [];
    for (const extraId of extras) {
      if (extraId === github.id) continue;
      const workload = await this.catalog.findById(extraId);
      if (!workload || workload.workloadKind !== 'standard') {
        throw new Error('工作负载不存在或不支持安装');
      }
      if (await this.isInstalled(String(op.hostId), workload.id)) continue;
      await this.workloadService.updateStep(opId, 'workload', {
        status: 'RUNNING',
        detail: workload.name,
      });
      const extra = await this.controllerClient.startRuntimeWorkload({
        containerId: String(op.containerId),
        workloadId: workload.id,
        params: {},
        source: 'user',
      });
      await this.workloadService.pollBatch(
        opId,
        String(op.containerId),
        extra.items.map((item) => item.logId),
        'workload',
      );
      extraNames.push(workload.name);
    }

    if (!installed || extraNames.length > 0) {
      await this.workloadService.updateStep(opId, 'workload', {
        status: 'SUCCEEDED',
        detail: [installed ? `${github.name}（已安装）` : github.name, ...extraNames].join('、'),
      });
    }
  }

  private async runGitSetupStep(opId: string, op: Doc): Promise<void> {
    const repoFullName = String(op.repoFullName ?? '');
    const targetPath = String(op.targetPath ?? '');
    await CloudHostGithubBinding.findOneAndUpdate(
      { controllerId: op.controllerId } as any,
      {
        $set: {
          userId: op.userId,
          accountId: op.accountId,
          repoFullName,
          targetPath,
        },
      },
      { upsert: true, new: true },
    );

    const github = await this.catalog.findGithubPreset();
    if (!github) throw new Error('Github 工作负载未配置');
    await this.workloadService.updateStep(opId, 'gitSetup', {
      status: 'RUNNING',
      detail: '正在申请凭据并拉取仓库',
    });
    const result = await this.controllerClient.startRuntimeScript({
      containerId: String(op.containerId),
      workloadId: github.id,
      workloadName: 'Git 项目设置',
      script: GITHUB_SETUP_SCRIPT,
      params: { repoFullName, targetPath },
      source: 'system',
      githubAuth: true,
    });
    await this.workloadService.pollBatch(opId, String(op.containerId), [result.logId], 'gitSetup');
    await this.workloadService.updateStep(opId, 'gitSetup', {
      status: 'SUCCEEDED',
      detail: repoFullName,
    });
  }

  private async runSessionStep(opId: string, op: Doc): Promise<void> {
    const targetPath = String(op.targetPath ?? '');
    try {
      await this.workloadService.updateStep(opId, 'session', {
        status: 'RUNNING',
        detail: targetPath,
      });
      const workspace = await this.ensureWorkspace(
        String(op.controllerId),
        String(op.userId),
        targetPath,
      );
      const session = await this.createSession(String(op.userId), {
        controllerId: String(op.controllerId),
        workspaceId: String(workspace.id),
        acpServerType: 'opencode',
      });
      // D2：项目会话成功后回填云电脑默认会话（CAS：仅当仍为空，避免覆盖既有默认会话）。
      // phase2：Git 项目设置是创建默认工作区的唯一入口，同时回写 workspaceId，
      // 使 hasDefaultWorkspace / defaultWorkspace 反映真实工作区（CAS：不覆盖既有绑定）。
      if (op.hostId) {
        await CloudHost.updateOne(
          { _id: op.hostId, workspaceId: null },
          { $set: { workspaceId: workspace.id } },
        ).catch((err) => {
          console.warn(
            '[cloud-host-github] backfill workspaceId failed:',
            (err as Error).message,
          );
        });
        await CloudHost.updateOne(
          { _id: op.hostId, defaultSessionId: null },
          { $set: { defaultSessionId: session.id } },
        ).catch((err) => {
          console.warn(
            '[cloud-host-github] backfill defaultSessionId failed:',
            (err as Error).message,
          );
        });
      }
      await CloudHostSetupOperation.updateOne(
        { _id: opId },
        {
          $set: {
            status: 'SUCCEEDED',
            sessionId: session.id,
            error: null,
          },
        },
      );
      await this.workloadService.updateStep(opId, 'session', {
        status: 'SUCCEEDED',
        detail: targetPath,
      });
    } catch (err) {
      const message = sanitizeOperationError(err);
      await this.workloadService.updateStep(opId, 'session', {
        status: 'FAILED',
        detail: `仓库已就绪，请手动创建会话（${message}）`,
      });
      await CloudHostSetupOperation.updateOne(
        { _id: opId },
        { $set: { status: 'SUCCEEDED', error: `仓库已就绪，请手动创建会话：${message}` } },
      );
    }
  }

  private async isInstalled(hostId: string, workloadId: string): Promise<boolean> {
    const container = await CloudContainer.findOne({ hostId }).sort({ createdAt: -1 }).lean();
    const entries = Array.isArray(container?.installedWorkloads)
      ? (container!.installedWorkloads as Array<Record<string, unknown>>)
      : [];
    return entries.some((entry) => String(entry.workloadId) === workloadId);
  }

  private describe(err: unknown): string {
    return sanitizeOperationError(err);
  }
}

export const cloudHostGithubService = new CloudHostGithubService();
