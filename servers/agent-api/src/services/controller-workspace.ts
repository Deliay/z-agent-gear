import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { Controller } from '../models/controller.js';
import { actorFilter } from './workspace-context.js';
import { getRedisClient } from '../middleware/redis.js';

const MAX_WORKSPACES = 10;

export class ControllerWorkspaceService {
  async findAllByUser(userId: string): Promise<Record<string, unknown>[]> {
    const workspaces = await ControllerWorkspace.find({ userId })
      .sort({ name: 1 })
      .lean();
    return workspaces.map(this.mapWorkspace.bind(this));
  }

  async findAllByController(controllerId: string, userId: string): Promise<Record<string, unknown>[]> {
    const workspaces = await ControllerWorkspace.find({ controllerId, userId })
      .sort({ name: 1 })
      .lean();
    return workspaces.map(this.mapWorkspace.bind(this));
  }

  async findById(id: string, userId: string): Promise<Record<string, unknown> | null> {
    const workspace = await ControllerWorkspace.findOne({ _id: id, userId }).lean();
    if (!workspace) return null;
    return this.mapWorkspace(workspace);
  }

  async create(controllerId: string, userId: string, path: string): Promise<Record<string, unknown>> {
    const controller = await Controller.findOne({ _id: controllerId, ...actorFilter(userId) }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }

    const count = await ControllerWorkspace.countDocuments({ controllerId, userId });
    if (count >= MAX_WORKSPACES) {
      throw new Error('Maximum workspaces reached');
    }

    const existing = await ControllerWorkspace.findOne({ controllerId, userId, path }).lean();
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
      { controllerId, userId, path },
      {
        $setOnInsert: {
          userId,
          controllerId,
          name,
          path,
          isEnabled: true,
        },
      },
      { new: true, upsert: true },
    ).lean();
    return this.mapWorkspace(workspace);
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const result = await ControllerWorkspace.findOneAndDelete({ _id: id, userId });
    return !!result;
  }

  async clear(controllerId: string, userId: string): Promise<boolean> {
    await ControllerWorkspace.deleteMany({ controllerId, userId });
    return true;
  }

  async toggle(id: string, userId: string): Promise<Record<string, unknown> | null> {
    const workspace = await ControllerWorkspace.findOne({ _id: id, userId });
    if (!workspace) return null;

    workspace.isEnabled = !workspace.isEnabled;
    await workspace.save();

    return this.mapWorkspace(workspace.toObject());
  }

  async setDefaultBranch(id: string, userId: string, defaultBranch: string): Promise<Record<string, unknown>> {
    const workspace = await ControllerWorkspace.findOne({ _id: id, userId });
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    workspace.defaultBranch = defaultBranch;
    await workspace.save();

    return this.mapWorkspace(workspace.toObject());
  }

  async detectGitRepo(controllerId: string, workspaceId: string, userId: string): Promise<Record<string, unknown>> {
    const controller = await Controller.findOne({ _id: controllerId, ...actorFilter(userId) }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }

    if (controller.status !== 'online') {
      throw new Error('Controller is offline');
    }

    const workspace = await ControllerWorkspace.findOne({ _id: workspaceId, userId }).lean();
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

    await redis.publish('session:command', JSON.stringify({
      type: 'git:check',
      requestId,
      controllerId,
      path: workspace.path,
    }));

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

    await redis.publish('session:command', JSON.stringify({
      type: 'fs:mkdir',
      requestId,
      controllerId,
      parentPath,
      folderName,
    }));

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

    const workspace = await ControllerWorkspace.findOne({ _id: workspaceId, userId }).lean();
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    const redis = getRedisClient();
    const requestId = `git_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    await redis.publish('session:command', JSON.stringify({
      type: 'git:init',
      requestId,
      controllerId,
      path: workspace.path,
    }));

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
