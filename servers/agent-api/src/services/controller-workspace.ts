import mongoose from 'mongoose';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { Controller } from '../models/controller.js';

const MAX_WORKSPACES = 10;

export class ControllerWorkspaceService {
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
    const controller = await Controller.findOne({ _id: controllerId, userId }).lean();
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

  private mapWorkspace(workspace: Record<string, unknown>): Record<string, unknown> {
    return {
      id: (workspace._id as mongoose.Types.ObjectId).toString(),
      userId: (workspace.userId as mongoose.Types.ObjectId).toString(),
      controllerId: (workspace.controllerId as mongoose.Types.ObjectId).toString(),
      name: workspace.name,
      path: workspace.path,
      isEnabled: workspace.isEnabled,
      createdAt: (workspace.createdAt as Date).toISOString(),
      updatedAt: (workspace.updatedAt as Date).toISOString(),
    };
  }
}

export const controllerWorkspaceService = new ControllerWorkspaceService();
