import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { Controller } from '../models/controller.js';
import { actorFilter, getWorkspaceContext } from './workspace-context.js';
import { getRedisClient } from '../middleware/redis.js';
import { publish } from '../middleware/publish.js';
import { sessionService } from './session.js';

const MAX_WORKSPACES = 10;

export class ControllerWorkspaceService {
  /** 当前用户可见的控制器（工作区上下文内=本工作区全部控制器）。 */
  private async visibleControllerIds(userId: string): Promise<mongoose.Types.ObjectId[]> {
    const controllers = await Controller.find({ ...actorFilter(userId) }).lean();
    return controllers.map((controller) => controller._id as mongoose.Types.ObjectId);
  }

  private async isControllerVisible(controllerId: string, userId: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(controllerId)) return false;
    const controller = await Controller.findOne({
      _id: controllerId,
      ...actorFilter(userId),
    }).lean();
    return Boolean(controller);
  }

  /**
   * 项目工作区（ControllerWorkspace）是控制器的从属资源：请求工作区上下文存在时，
   * 可见性跟随控制器（同工作区成员共享），而不是创建者 userId；无上下文（引擎/内部/
   * 测试）沿用一期 userId 归属口径。
   */
  private async findVisibleWorkspace(
    id: string,
    userId: string,
  ): Promise<Record<string, unknown> | null> {
    if (!getWorkspaceContext()) {
      return (await ControllerWorkspace.findOne({ _id: id, userId }).lean()) as Record<
        string,
        unknown
      > | null;
    }
    if (!mongoose.isValidObjectId(id)) return null;
    const workspace = await ControllerWorkspace.findById(id).lean();
    if (!workspace) return null;
    const visible = await this.isControllerVisible(String(workspace.controllerId), userId);
    return visible ? (workspace as Record<string, unknown>) : null;
  }

  async findAllByUser(userId: string): Promise<Record<string, unknown>[]> {
    if (!getWorkspaceContext()) {
      const workspaces = await ControllerWorkspace.find({ userId })
        .sort({ name: 1 })
        .lean();
      return workspaces.map(this.mapWorkspace.bind(this));
    }
    const controllerIds = await this.visibleControllerIds(userId);
    if (controllerIds.length === 0) return [];
    const workspaces = await ControllerWorkspace.find({ controllerId: { $in: controllerIds } })
      .sort({ name: 1 })
      .lean();
    return workspaces.map(this.mapWorkspace.bind(this));
  }

  async findAllByController(controllerId: string, userId: string): Promise<Record<string, unknown>[]> {
    if (getWorkspaceContext() && !(await this.isControllerVisible(controllerId, userId))) {
      return [];
    }
    const filter = getWorkspaceContext() ? { controllerId } : { controllerId, userId };
    const workspaces = await ControllerWorkspace.find(filter)
      .sort({ name: 1 })
      .lean();
    return workspaces.map(this.mapWorkspace.bind(this));
  }

  async findById(id: string, userId: string): Promise<Record<string, unknown> | null> {
    const workspace = await this.findVisibleWorkspace(id, userId);
    if (!workspace) return null;
    return this.mapWorkspace(workspace);
  }

  async create(controllerId: string, userId: string, path: string): Promise<Record<string, unknown>> {
    const controller = await Controller.findOne({ _id: controllerId, ...actorFilter(userId) }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }

    const ownership = getWorkspaceContext() ? { controllerId } : { controllerId, userId };
    const count = await ControllerWorkspace.countDocuments(ownership);
    if (count >= MAX_WORKSPACES) {
      throw new Error('Maximum workspaces reached');
    }

    const existing = await ControllerWorkspace.findOne({ ...ownership, path }).lean();
    if (existing) {
      throw new Error('Workspace already exists');
    }

    const name = path.split('/').filter(Boolean).pop() || path;

    const workspace = await ControllerWorkspace.create({
      userId,
      controllerId,
      name,
      path,
      isEnabled: true,
    });

    return this.mapWorkspace(workspace.toObject());
  }

  /**
   * 为云电脑预置默认工作区（幂等 upsert，不触发 10 个工作区上限）。
   * 路径与 worker `ZAG_DEFAULT_WORKSPACE` 保持一致。
   */
  async ensureCloudHostWorkspace(
    controllerId: string,
    userId: string,
    workspacePath: string,
  ): Promise<Record<string, unknown>> {
    return this.ensureWorkspace(controllerId, userId, workspacePath);
  }

  /**
   * 按路径幂等 upsert 工作区（不触发 10 个工作区上限；名称取路径末段）。
   * 供云电脑默认工作区与 Git 项目 clone 目标目录复用。
   */
  async ensureWorkspace(
    controllerId: string,
    userId: string,
    workspacePath: string,
  ): Promise<Record<string, unknown>> {
    const path = workspacePath.trim() || '/home/worker/workspace';
    const name = path.split('/').filter(Boolean).pop() || 'workspace';
    const workspace = await ControllerWorkspace.findOneAndUpdate(
      // 同一控制器按路径幂等（项目目录属于控制器，团队成员/后台回调共用一行）。
      { controllerId, path },
      {
        $setOnInsert: {
          userId,
          controllerId,
          name,
          path,
          isEnabled: true,
        },
      },
      { returnDocument: 'after', upsert: true },
    ).lean();
    return this.mapWorkspace(workspace);
  }

  /**
   * 删除工作区：删除前先连带归档其下普通会话（「先结束后归档」，D7）。
   * **归档失败抛错中止删除**（工作区行保留），避免「工作区没了、会话未归档」的中间态。
   */
  async delete(id: string, userId: string): Promise<boolean> {
    const workspace = await this.findVisibleWorkspace(id, userId);
    if (!workspace) return false;
    await sessionService.archiveByWorkspace(userId, workspace as never);
    const result = await ControllerWorkspace.findOneAndDelete({
      _id: id,
      ...(getWorkspaceContext() ? {} : { userId }),
    });
    return !!result;
  }

  /**
   * 清空控制器下全部工作区：逐个执行连带归档，**任一失败中止**（不删除任何工作区行），
   * 全部成功后才 `deleteMany`。
   */
  async clear(controllerId: string, userId: string): Promise<boolean> {
    if (getWorkspaceContext() && !(await this.isControllerVisible(controllerId, userId))) return false;
    const filter = getWorkspaceContext() ? { controllerId } : { controllerId, userId };
    const workspaces = await ControllerWorkspace.find(filter).lean();
    for (const workspace of workspaces) {
      await sessionService.archiveByWorkspace(userId, workspace);
    }
    await ControllerWorkspace.deleteMany(filter);
    return true;
  }

  async toggle(id: string, userId: string): Promise<Record<string, unknown> | null> {
    const workspace = await this.findVisibleWorkspaceDoc(id, userId);
    if (!workspace) return null;

    workspace.isEnabled = !workspace.isEnabled;
    await workspace.save();

    return this.mapWorkspace(workspace.toObject());
  }

  async setDefaultBranch(id: string, userId: string, defaultBranch: string): Promise<Record<string, unknown>> {
    const workspace = await this.findVisibleWorkspaceDoc(id, userId);
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    workspace.defaultBranch = defaultBranch;
    await workspace.save();

    return this.mapWorkspace(workspace.toObject());
  }

  /** 需要 save() 的路径：无上下文沿用一期直接文档查询（含既有 mock 口径）。 */
  private async findVisibleWorkspaceDoc(id: string, userId: string) {
    if (!getWorkspaceContext()) {
      return ControllerWorkspace.findOne({ _id: id, userId });
    }
    const visible = await this.findVisibleWorkspace(id, userId);
    if (!visible) return null;
    return ControllerWorkspace.findById(id);
  }

  async detectGitRepo(controllerId: string, workspaceId: string, userId: string): Promise<Record<string, unknown>> {
    const controller = await Controller.findOne({ _id: controllerId, ...actorFilter(userId) }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }

    if (controller.status !== 'online') {
      throw new Error('Controller is offline');
    }

    const workspace = await ControllerWorkspace.findOne(
      getWorkspaceContext() ? { _id: workspaceId, controllerId } : { _id: workspaceId, userId },
    ).lean();
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    const redis = getRedisClient();
    const pathMd5 = createHash('md5').update(workspace.path).digest('hex');

    const cached = await redis.get(`git:branches:${controllerId}:${pathMd5}`);
    if (cached) {
      return JSON.parse(cached);
    }

    const requestId = `git_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    await publish('session:command', {
      type: 'git:check',
      requestId,
      controllerId,
      path: workspace.path,
    });

    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const result = await redis.get(`git:check:${requestId}`);
      if (result) {
        await redis.del(`git:check:${requestId}`);
        const parsed = JSON.parse(result);
        // Persist isGitRepo to workspace so Sidebar can render WorktreeSidebarGroup
        if (parsed.isGitRepo !== undefined) {
          await ControllerWorkspace.findByIdAndUpdate(workspaceId, { isGitRepo: parsed.isGitRepo });
        }
        return parsed;
      }
    }

    throw new Error('Git detection timeout');
  }

  async createFolder(controllerId: string, userId: string, parentPath: string, folderName: string): Promise<Record<string, unknown>> {
    const controller = await Controller.findOne({ _id: controllerId, ...actorFilter(userId) }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }

    if (controller.status !== 'online') {
      throw new Error('Controller is offline');
    }

    const redis = getRedisClient();
    const requestId = `mkdir_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    await publish('session:command', {
      type: 'fs:mkdir',
      requestId,
      controllerId,
      parentPath,
      folderName,
    });

    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const result = await redis.get(`fs:mkdir:${requestId}`);
      if (result) {
        await redis.del(`fs:mkdir:${requestId}`);
        const parsed = JSON.parse(result);
        if (!parsed.success) {
          throw new Error(parsed.error || 'Failed to create folder');
        }
        return { name: parsed.name, path: parsed.path, isDirectory: true };
      }
    }

    throw new Error('Create folder timeout');
  }

  async initGitRepo(controllerId: string, workspaceId: string, userId: string): Promise<boolean> {
    const controller = await Controller.findOne({ _id: controllerId, ...actorFilter(userId) }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }

    if (controller.status !== 'online') {
      throw new Error('Controller is offline');
    }

    const workspace = await ControllerWorkspace.findOne(
      getWorkspaceContext() ? { _id: workspaceId, controllerId } : { _id: workspaceId, userId },
    ).lean();
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    const redis = getRedisClient();
    const requestId = `git_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    await publish('session:command', {
      type: 'git:init',
      requestId,
      controllerId,
      path: workspace.path,
    });

    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const result = await redis.get(`git:init:${requestId}`);
      if (result) {
        await redis.del(`git:init:${requestId}`);

        const pathMd5 = createHash('md5').update(workspace.path).digest('hex');
        await redis.del(`git:branches:${controllerId}:${pathMd5}`);

        const parsed = JSON.parse(result);
        if (!parsed.success) {
          throw new Error(parsed.error || 'Git init failed');
        }
        return true;
      }
    }

    throw new Error('Git init timeout');
  }

  private mapWorkspace(workspace: Record<string, unknown>): Record<string, unknown> {
    return {
      id: (workspace._id as mongoose.Types.ObjectId).toString(),
      userId: (workspace.userId as mongoose.Types.ObjectId).toString(),
      controllerId: (workspace.controllerId as mongoose.Types.ObjectId).toString(),
      name: workspace.name,
      path: workspace.path,
      isEnabled: workspace.isEnabled,
      isGitRepo: workspace.isGitRepo ?? null,
      defaultBranch: workspace.defaultBranch || null,
      createdAt: (workspace.createdAt as Date).toISOString(),
      updatedAt: (workspace.updatedAt as Date).toISOString(),
    };
  }
}

export const controllerWorkspaceService = new ControllerWorkspaceService();
