import { Controller } from '../../models/controller.js';
import { getRedisClient } from '../../middleware/redis.js';
import { publish } from '../../middleware/publish.js';
import { sanitizeWorkspaceName, generateWorktreeSuffix, resolveEffectiveWorktreeDir } from './worktree-utils.js';
import type { ResolvedWorktreeCommitter } from '../commit-settings-service.js';

/**
 * 工作流 Worktree 助手（自 `services/workflow/instance.ts` 零行为抽取）：
 * 供实例化与实例接续共用，签名与行为逐字保持。
 */

/** 创建工作流 Worktree：通过 Redis 发送 git:worktree:add 命令到控制器，使用随机后缀天然去重 */
export async function createWorkflowWorktree(
  controllerId: string,
  workspace: { _id: string; name: string; path: string; defaultBranch?: string },
  workflowName: string,
  committer?: ResolvedWorktreeCommitter | null,
): Promise<{ path: string; branch: string }> {
  const redis = getRedisClient();

  // 查询控制器获取 worktreeDir 配置（生效目录解析：已配置用配置值，未配置回退默认值，与校验端同源）
  const controller = await Controller.findOne({ _id: controllerId }).lean();
  const worktreeDir = resolveEffectiveWorktreeDir(controller as { worktreeDir?: string | null } | null);

  // slug 化处理：纯中文名会产生空串，使用兜底值
  const slug = workflowName
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
    || `wf-${Date.now().toString(36)}`;

  // 使用共享 sanitize 函数，确保与 session.ts 校验前缀一致
  const safeWorkspaceName = sanitizeWorkspaceName(workspace.name);

  // 使用随机后缀天然去重，避免多实例并发碰撞
  const uniqueSuffix = generateWorktreeSuffix();
  const branch = `workflow/${slug}-${uniqueSuffix}`;
  const wtPath = `${worktreeDir}/${safeWorkspaceName}/workflow-${slug}-${uniqueSuffix}`;

  const requestId = `wt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await publish('session:command', {
    type: 'git:worktree:add',
    requestId,
    controllerId,
    repoPath: workspace.path,
    worktreePath: wtPath,
    branch,
    // 可选：缺省 = 不写 worktree 身份（沿用容器级 bot；旧 worker 忽略未知字段）
    ...(committer ? { committer } : {}),
  });

  // 等待控制器响应（最多 30 秒）
  for (let i = 0; i < 30; i++) {
    const result = await redis.get(`git:worktree:add:${requestId}`);
    if (result) {
      const parsed = JSON.parse(result);
      await redis.del(`git:worktree:add:${requestId}`);

      if (!parsed.success) {
        throw new Error(`创建工作流 Worktree 失败: ${parsed.error}`);
      }

      return {
        path: parsed.worktreePath || wtPath,
        branch,
      };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('创建工作流 Worktree 超时');
}

/** 清理工作流 Worktree：通过 Redis 发送 git:worktree:remove 命令到控制器，失败/超时抛错 */
export async function removeWorkflowWorktree(
  controllerId: string,
  repoPath: string,
  worktreePath: string,
  worktreeBranch?: string,
): Promise<void> {
  const redis = getRedisClient();
  const requestId = `wtr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await publish('session:command', {
    type: 'git:worktree:remove',
    requestId,
    controllerId,
    repoPath,
    worktreePath,
    branch: worktreeBranch,
  });
  // 等待控制器响应（最多 10 秒）
  for (let i = 0; i < 10; i++) {
    const result = await redis.get(`git:worktree:remove:${requestId}`);
    if (result) {
      const parsed = JSON.parse(result);
      await redis.del(`git:worktree:remove:${requestId}`);
      if (!parsed.success) {
        throw new Error(`清理 Worktree 失败: ${parsed.error}`);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('清理 Worktree 超时');
}
