import path from 'path';
import { GraphQLError } from 'graphql';
import { Session } from '../models/session.js';
import { Controller } from '../models/controller.js';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { getRedisClient } from '../middleware/redis.js';
import { sessionService } from './session.js';
import { resolveEffectiveWorktreeDir, worktreeScopePrefix, normalizeForCompare } from './workflow/worktree-utils.js';

export interface WorkspaceWorktree {
  path: string;
  branch: string | null;
  sessions: any[];
  sessionCount: number;
}

export interface WorktreeDeleteFailure {
  sessionId: string;
  error: string;
}

export interface DeleteWorktreeResult {
  success: boolean;
  closedSessionIds: string[];
  failures: WorktreeDeleteFailure[];
  error: string | null;
}

class WorktreeService {
  /**
   * List git worktrees for a workspace, merging controller-reported worktrees
   * with sessions that have worktreePath set.
   */
  async list(controllerId: string, workspaceId: string, userId: string): Promise<WorkspaceWorktree[]> {
    const workspace = await ControllerWorkspace.findOne({
      _id: workspaceId,
      userId,
      controllerId,
    }).lean();
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    const redis = getRedisClient();
    const workspaceRoot = path.normalize(workspace.path);

    // Check if controller is online before querying git worktrees
    const controller = await Controller.findById(controllerId).lean();
    const isOnline = controller?.status === 'online';

    // Query git worktrees from controller via Redis (only if online)
    const gitWorktrees: { path: string; branch: string }[] = [];
    if (isOnline) {
      const requestId = `wtl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await redis.publish('session:command', JSON.stringify({
        type: 'git:worktree:list',
        requestId,
        controllerId,
        cwd: workspace.path,
      }));

      for (let i = 0; i < 30; i++) {
        const result = await redis.get(`git:worktree:list:${requestId}`);
        if (result) {
          const parsed = JSON.parse(result);
          if (parsed.success && Array.isArray(parsed.worktrees)) {
            for (const wt of parsed.worktrees) {
              // git worktree list 首条是主工作区（仓库根）——它不是可管理 worktree，
              // 必须过滤，否则侧边栏可对它发起删除，fs 兜底会 rm 掉整个仓库（含 .git）
              if (path.normalize(wt.path) === workspaceRoot) continue;
              gitWorktrees.push({ path: wt.path, branch: wt.branch || '' });
            }
          }
          await redis.del(`git:worktree:list:${requestId}`);
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Find non-ended sessions with worktreePath in this workspace's controller
    const sessions = await Session.find({
      controllerId,
      userId,
      worktreePath: { $ne: null },
      status: { $ne: 'ended' },
    }).lean();

    // Merge: group by worktreePath
    const worktreeMap = new Map<string, WorkspaceWorktree>();

    for (const wt of gitWorktrees) {
      worktreeMap.set(wt.path, {
        path: wt.path,
        branch: wt.branch || null,
        sessions: [],
        sessionCount: 0,
      });
    }

    // Only group sessions whose worktree belongs to this workspace: either a
    // controller-reported git worktree of this repo, or a path under the
    // workspace's worktreeDir scope (<worktreeDir>/<workspace.name>/).
    const effectiveDir = resolveEffectiveWorktreeDir(controller as { worktreeDir?: string | null } | null);
    if (effectiveDir.includes('~') && !(controller as any)?.homeDir) {
      throw new GraphQLError(
        'Worktree 目录包含 `~` 但控制器未上报 homeDir，无法校验路径归属。请升级控制器，或在设置页将「Git Worktree 工作目录」配置为绝对路径。',
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }
    const scopePrefix = normalizeForCompare(
      worktreeScopePrefix(effectiveDir, workspace.name, (controller as any)?.homeDir),
      (controller as any)?.platform,
    );
    const isWorkspaceWorktreePath = (wtPath: string) =>
      worktreeMap.has(wtPath) || normalizeForCompare(wtPath, (controller as any)?.platform).startsWith(scopePrefix);

    for (const session of sessions) {
      const wtPath = (session as any).worktreePath as string | undefined;
      if (!wtPath || !isWorkspaceWorktreePath(wtPath)) continue;
      const mappedSession = sessionService.mapSession(session as unknown as Record<string, unknown>);
      const existing = worktreeMap.get(wtPath);
      if (existing) {
        existing.sessionCount++;
        existing.sessions.push(mappedSession);
      } else {
        worktreeMap.set(wtPath, {
          path: wtPath,
          branch: (session as any).worktreeBranch || null,
          sessions: [mappedSession],
          sessionCount: 1,
        });
      }
    }

    return Array.from(worktreeMap.values());
  }

  /**
   * Delete a worktree: terminate all sessions at that path, then
   * git:worktree:remove --force, then fs:remove-dir fallback.
   */
  async deleteWorktree(
    controllerId: string,
    workspaceId: string,
    worktreePath: string,
    userId: string,
  ): Promise<DeleteWorktreeResult> {
    const workspace = await ControllerWorkspace.findOne({
      _id: workspaceId,
      userId,
      controllerId,
    }).lean();
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    // 根工作区（仓库本体）永远不可删除——即使上层 list 过滤失守，
    // 也不得对根路径发出任何 git/fs 删除命令（否则 .git 丢失）
    if (path.normalize(worktreePath) === path.normalize(workspace.path)) {
      throw new GraphQLError('cannot delete the workspace root (main working tree)', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    // Path must be a worktree known to this workspace (git worktrees reported
    // by the controller or session-grouped paths under its worktreeDir scope)
    // before we allow any git/fs removal against it.
    const knownWorktrees = await this.list(controllerId, workspaceId, userId);
    if (!knownWorktrees.some((wt) => wt.path === worktreePath)) {
      throw new GraphQLError('worktreePath is not managed by this workspace', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    const closedSessionIds: string[] = [];
    const failures: WorktreeDeleteFailure[] = [];

    // 1. Find and terminate all sessions at this worktreePath
    const sessions = await Session.find({
      controllerId,
      userId,
      worktreePath,
    }).lean();

    for (const session of sessions) {
      const sessionId = (session._id as any).toString();
      try {
        if (await sessionService.delete(sessionId, userId)) closedSessionIds.push(sessionId);
      } catch (err) {
        failures.push({ sessionId, error: (err as Error).message });
      }
    }

    const redis = getRedisClient();

    // 2. git:worktree:remove --force
    let removed = false;
    let removeError: string | null = null;
    const rmReqId = `wtr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await redis.publish('session:command', JSON.stringify({
      type: 'git:worktree:remove',
      requestId: rmReqId,
      controllerId,
      repoPath: workspace.path,
      worktreePath,
      force: true,
    }));

    for (let i = 0; i < 30; i++) {
      const result = await redis.get(`git:worktree:remove:${rmReqId}`);
      if (result) {
        const parsed = JSON.parse(result);
        await redis.del(`git:worktree:remove:${rmReqId}`);
        removed = parsed.success === true;
        if (!parsed.success) removeError = parsed.error || 'git worktree remove failed';
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    // 3. fs:remove-dir fallback if git:worktree:remove didn't succeed
    if (!removed) {
      const fsReqId = `fsr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await redis.publish('session:command', JSON.stringify({
        type: 'fs:remove-dir',
        requestId: fsReqId,
        controllerId,
        path: worktreePath,
      }));

      let fsRemoved = false;
      for (let i = 0; i < 30; i++) {
        const result = await redis.get(`fs:remove-dir:${fsReqId}`);
        if (result) {
          const parsed = JSON.parse(result);
          await redis.del(`fs:remove-dir:${fsReqId}`);
          fsRemoved = parsed.success === true;
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      if (fsRemoved) {
        // Directory is gone despite the git error — clear it.
        removeError = null;
      } else {
        removeError = removeError || 'Failed to remove worktree directory';
      }
    }

    return {
      success: failures.length === 0 && removeError === null,
      closedSessionIds,
      failures,
      error: removeError,
    };
  }
}

export const worktreeService = new WorktreeService();
