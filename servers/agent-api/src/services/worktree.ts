import { Session } from '../models/session.js';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { getRedisClient } from '../middleware/redis.js';
import { sessionService } from './session.js';

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

    // Query git worktrees from controller via Redis
    const requestId = `wtl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await redis.publish('session:command', JSON.stringify({
      type: 'git:worktree:list',
      requestId,
      controllerId,
      cwd: workspace.path,
    }));

    const gitWorktrees: { path: string; branch: string }[] = [];
    for (let i = 0; i < 30; i++) {
      const result = await redis.get(`git:worktree:list:${requestId}`);
      if (result) {
        const parsed = JSON.parse(result);
        if (parsed.success && Array.isArray(parsed.worktrees)) {
          for (const wt of parsed.worktrees) {
            gitWorktrees.push({ path: wt.path, branch: wt.branch || '' });
          }
        }
        await redis.del(`git:worktree:list:${requestId}`);
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    // Find sessions with worktreePath in this workspace's controller
    const sessions = await Session.find({
      controllerId,
      userId,
      worktreePath: { $ne: null },
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

    for (const session of sessions) {
      const wtPath = (session as any).worktreePath as string | undefined;
      if (!wtPath) continue;
      const existing = worktreeMap.get(wtPath);
      if (existing) {
        existing.sessionCount++;
        existing.sessions.push(session);
      } else {
        worktreeMap.set(wtPath, {
          path: wtPath,
          branch: (session as any).worktreeBranch || null,
          sessions: [session],
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
      if (!fsRemoved) {
        removeError = removeError || 'Failed to remove worktree directory';
      }
    }

    return {
      success: failures.length === 0,
      closedSessionIds,
      failures,
      error: removeError,
    };
  }
}

export const worktreeService = new WorktreeService();
