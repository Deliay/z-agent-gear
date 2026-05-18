import mongoose from 'mongoose';
import { Controller } from '../models/controller.js';
import { ControllerKey } from '../models/controller-key.js';
import { evictKeyById } from './key-cache.js';
import { commandService } from './command.js';

export class ControllerService {
  async findAllByUser(userId: string): Promise<Record<string, unknown>[]> {
    const controllers = await Controller.find({ userId }).sort({ createdAt: -1 }).lean();
    return controllers.map(this.mapController.bind(this));
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

  private mapController(controller: Record<string, unknown>): Record<string, unknown> {
    return {
      id: (controller._id as mongoose.Types.ObjectId).toString(),
      name: controller.name,
      hostname: controller.hostname,
      type: controller.type,
      status: controller.status,
      keyId: (controller.keyId as mongoose.Types.ObjectId).toString(),
      version: controller.version,
      lastHeartbeatAt: controller.lastHeartbeatAt ? (controller.lastHeartbeatAt as Date).toISOString() : null,
      createdAt: (controller.createdAt as Date).toISOString(),
      updatedAt: (controller.updatedAt as Date).toISOString(),
    };
  }
}

export const controllerService = new ControllerService();
