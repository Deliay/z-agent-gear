import { CloudHostGithubBinding } from '../models/cloud-host-github-binding.js';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { githubService } from './github.js';
import { controllerWorkspaceService } from './controller-workspace.js';
import { normalizeWorkspacePrefix, resolveClonePath } from './workspace-path.js';

/** 候选默认分支（按优先级取第一个本地存在的）。 */
export const DEFAULT_BRANCH_CANDIDATES = ['main', 'master', 'release'] as const;

export interface ResolveWorkspaceDefaultBranchInput {
  userId: string;
  controllerId: string;
  workspaceId: string;
  repoFullName?: string | null;
}

function normalizeRepoFullName(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : null;
}

/**
 * 反查 GitHub 项目绑定：仅当 clone 路径与工作区路径严格相等时采用其仓库。
 * 任何异常（路径非法等）按「未命中」处理。
 */
async function findBoundRepoFullName(
  controllerId: string,
  workspacePath: string,
): Promise<string | null> {
  try {
    const binding = await CloudHostGithubBinding.findOne({ controllerId }).lean();
    if (!binding) return null;
    const clonePath = resolveClonePath(
      normalizeWorkspacePrefix(String(binding.targetPath)),
      String(binding.repoFullName),
    );
    return clonePath === workspacePath ? String(binding.repoFullName) : null;
  } catch {
    return null;
  }
}

async function backfill(workspaceId: string, branch: string): Promise<void> {
  try {
    await ControllerWorkspace.findByIdAndUpdate(workspaceId, { defaultBranch: branch });
  } catch {
    // 回填失败不影响本次解析结果（下次解析会重新探测）
  }
}

/**
 * 解析工作区默认分支（PRD 3.2 功能点 2）：
 * 已存即返 → GitHub API（显式 repoFullName 或 binding 反查）→ [main, master, release] 探测 → null。
 * 探测/GitHub 两步异常一律吞掉按未命中继续；工作区读取失败才抛出。
 */
export async function resolveWorkspaceDefaultBranch(
  input: ResolveWorkspaceDefaultBranchInput,
): Promise<string | null> {
  const workspace = await ControllerWorkspace.findOne({
    _id: input.workspaceId,
    userId: input.userId,
    controllerId: input.controllerId,
  }).lean();
  if (!workspace) {
    throw new Error('Workspace not found');
  }
  if (workspace.defaultBranch) return workspace.defaultBranch;

  const repoFullName =
    normalizeRepoFullName(input.repoFullName) ??
    (await findBoundRepoFullName(input.controllerId, String(workspace.path)));

  if (repoFullName) {
    try {
      const fromGitHub = await githubService.getRepoDefaultBranch(input.userId, repoFullName);
      if (fromGitHub) {
        await backfill(input.workspaceId, fromGitHub);
        return fromGitHub;
      }
    } catch {
      // 未命中，继续候选探测
    }
  }

  try {
    const detected = await controllerWorkspaceService.detectGitRepo(
      input.controllerId,
      input.workspaceId,
      input.userId,
    );
    const branches = Array.isArray(detected?.branches)
      ? (detected.branches as string[]).map((branch) => String(branch))
      : [];
    const branch = DEFAULT_BRANCH_CANDIDATES.find((candidate) => branches.includes(candidate));
    if (branch) {
      await backfill(input.workspaceId, branch);
      return branch;
    }
  } catch {
    // 控制器离线/超时等按未命中处理
  }

  return null;
}
