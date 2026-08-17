import { Session } from '../models/session.js';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { getRedisClient } from '../middleware/redis.js';

export interface WorkspaceWorktree {
  worktreePath: string;
  branch: string;
  sessionCount: number;
  sessionIds: string[];
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
        worktreePath: wt.path,
        branch: wt.branch,
        sessionCount: 0,
        sessionIds: [],
      });
    }

    for (const session of sessions) {
      const wtPath = (session as any).worktreePath as string | undefined;
      if (!wtPath) continue;
      const existing = worktreeMap.get(wtPath);
      if (existing) {
        existing.sessionCount++;
        existing.sessionIds.push((session._id as any).toString());
      } else {
        worktreeMap.set(wtPath, {
          worktreePath: wtPath,
          branch: (session as any).worktreeBranch || '',
          sessionCount: 1,
          sessionIds: [(session._id as any).toString()],
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
  ): Promise<boolean> {
    const workspace = await ControllerWorkspace.findOne({
      _id: workspaceId,
      userId,
      controllerId,
    }).lean();
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    const redis = getRedisClient();

    // 1. Find and terminate all sessions at this worktreePath
    const sessions = await Session.find({
      controllerId,
      userId,
      worktreePath,
    }).lean();

    for (const session of sessions) {
      const sessionId = (session._id as any).toString();
      await redis.publish('session:command', JSON.stringify({
        type: 'acp:stop',
        sessionId,
        reason: 'worktree_delete',
      }));
      await Session.findOneAndUpdate(
        { _id: sessionId },
        { status: 'ended', endedAt: new Date() },
      );
    }

    // 2. git:worktree:remove --force
    const rmReqId = `wtr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await redis.publish('session:command', JSON.stringify({
      type: 'git:worktree:remove',
      requestId: rmReqId,
      controllerId,
      repoPath: workspace.path,
      worktreePath,
      force: true,
    }));

    let removed = false;
    for (let i = 0; i < 30; i++) {
      const result = await redis.get(`git:worktree:remove:${rmReqId}`);
      if (result) {
        const parsed = JSON.parse(result);
        await redis.del(`git:worktree:remove:${rmReqId}`);
        removed = parsed.success === true;
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

      for (let i = 0; i < 30; i++) {
        const result = await redis.get(`fs:remove-dir:${fsReqId}`);
        if (result) {
          await redis.del(`fs:remove-dir:${fsReqId}`);
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    return true;
  }
}

export const worktreeService = new WorktreeService();
