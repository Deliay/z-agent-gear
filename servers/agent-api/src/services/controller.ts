import mongoose from 'mongoose';
import { Controller } from '../models/controller.js';
import { ControllerKey } from '../models/controller-key.js';
import { CloudHost } from '../models/cloud-host.js';
import { McpServer } from '../models/mcp-server.js';
import { evictKeyById } from './key-cache.js';
import { commandService } from './command.js';
import { CLOUD_HOST_TOOLS_SERVER_NAME } from './cloud-host-tools.js';

export interface ControllerDefaultMcpInput {
  useAllEnabled: boolean;
  serverIds?: string[] | null;
}

export class ControllerService {
  async findAllByUser(userId: string): Promise<Record<string, unknown>[]> {
    const controllers = await Controller.find({ userId }).sort({ createdAt: -1 }).lean();
    // 软删除的云电脑不再展示（Controller/会话保留）。普通主机不受影响。
    const cloudControllerIds = controllers
      .filter((controller) => controller.type === 'cloud')
      .map((controller) => controller._id);
    if (cloudControllerIds.length === 0) {
      return controllers.map(this.mapController.bind(this));
    }
    const deletedHosts = await CloudHost.find({
      controllerId: { $in: cloudControllerIds },
      deletedAt: { $ne: null },
    })
      .select('controllerId')
      .lean();
    const deleted = new Set(deletedHosts.map((host) => String(host.controllerId)));
    return controllers
      .filter((controller) => !deleted.has(String(controller._id)))
      .map(this.mapController.bind(this));
  }

  /** 预创建云电脑 Controller（由 agent-api 编排；register upsert 不覆盖用户命名）。 */
  async createCloudHostController(
    userId: string,
    controllerId: string,
    name: string,
    keyId: string,
  ): Promise<Record<string, unknown>> {
    const controller = await Controller.create({
      _id: controllerId,
      userId,
      name,
      hostname: name,
      type: 'cloud',
      status: 'registering',
      keyId,
      version: '0.0.0',
    });
    return this.mapController(controller.toObject());
  }

  /** 云电脑删除后 Controller 留档：仅置连接态 offline。 */
  async markCloudHostOffline(controllerId: string, userId: string): Promise<boolean> {
    const result = await Controller.findOneAndUpdate(
      { _id: controllerId, userId, type: 'cloud' },
      { $set: { status: 'offline' } },
    );
    return result !== null;
  }

  async findById(id: string, userId: string): Promise<Record<string, unknown> | null> {
    const controller = await Controller.findOne({ _id: id, userId }).lean();
    if (!controller) return null;
    return this.mapController(controller);
  }

  async rename(id: string, userId: string, name: string): Promise<Record<string, unknown> | null> {
    const controller = await Controller.findOneAndUpdate(
      { _id: id, userId },
      { name },
      { new: true },
    ).lean();
    if (!controller) return null;
    return this.mapController(controller);
  }

  async unbind(id: string, userId: string): Promise<boolean> {
    const controller = await Controller.findOne({ _id: id, userId });
    if (!controller) return false;

    const keyId = controller.keyId.toString();

    // Send shutdown to connected controller
    await commandService.sendShutdown(keyId);

    // Evict key from Redis cache
    await evictKeyById(keyId);

    // Delete the key and controller
    await ControllerKey.deleteOne({ _id: keyId });
    await Controller.deleteOne({ _id: id });

    return true;
  }

  async setWorktreeDir(id: string, userId: string, worktreeDir: string): Promise<Record<string, unknown> | null> {
    const controller = await Controller.findOneAndUpdate(
      { _id: id, userId },
      { worktreeDir },
      { new: true },
    ).lean();
    if (!controller) return null;
    return this.mapController(controller);
  }

  /**
   * 保存控制器默认 MCP。
   * - useAllEnabled=true：忽略入参 serverIds 并归一为 []（保持动态跟随新增 MCP）
   * - useAllEnabled=false：serverIds 去重后逐个校验归属与启用状态，非法/停用/不存在统一 MCP_SERVER_NOT_FOUND
   */
  async setDefaultMcp(
    userId: string,
    controllerId: string,
    input: ControllerDefaultMcpInput,
  ): Promise<Record<string, unknown> | null> {
    const controller = await Controller.findOne({ _id: controllerId, userId });
    if (!controller) return null;

    const useAllEnabled = input.useAllEnabled !== false;
    let serverIds: string[] = [];
    if (!useAllEnabled) {
      serverIds = Array.from(
        new Set((input.serverIds ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0)),
      );
      if (serverIds.some((id) => !mongoose.isValidObjectId(id))) {
        throw new Error('MCP_SERVER_NOT_FOUND');
      }
      if (serverIds.length > 0) {
        const selectable = await McpServer.countDocuments({
          _id: { $in: serverIds },
          userId,
          enabled: true,
          name: { $ne: CLOUD_HOST_TOOLS_SERVER_NAME },
        });
        if (selectable !== serverIds.length) {
          throw new Error('MCP_SERVER_NOT_FOUND');
        }
      }
    }

    controller.set('defaultMcp', { useAllEnabled, serverIds });
    await controller.save();
    return this.mapController(controller.toObject());
  }

  private mapController(controller: Record<string, unknown>): Record<string, unknown> {
    const rawDefaultMcp = (controller.defaultMcp ?? {}) as {
      useAllEnabled?: boolean | null;
      serverIds?: unknown[] | null;
    };
    return {
      id: (controller._id as mongoose.Types.ObjectId).toString(),
      name: controller.name,
      hostname: controller.hostname,
      type: controller.type,
      status: controller.status,
      keyId: (controller.keyId as mongoose.Types.ObjectId).toString(),
      version: controller.version,
      worktreeDir: (controller as any).worktreeDir || null,
      lastHeartbeatAt: controller.lastHeartbeatAt ? (controller.lastHeartbeatAt as Date).toISOString() : null,
      createdAt: (controller.createdAt as Date).toISOString(),
      updatedAt: (controller.updatedAt as Date).toISOString(),
      defaultMcp: {
        useAllEnabled: rawDefaultMcp.useAllEnabled !== false,
        serverIds: (rawDefaultMcp.serverIds ?? []).map((id) => String(id)),
      },
    };
  }
}

export const controllerService = new ControllerService();
