import mongoose from 'mongoose';
import { PortForward } from '../models/port-forward.js';
import { Controller } from '../models/controller.js';
import { getRedisClient } from '../middleware/redis.js';

const COMMAND_CHANNEL = 'port-forward:command';

export class PortForwardService {
  async findAllByController(controllerId: string, userId: string): Promise<{ portForwards: Record<string, unknown>[]; total: number; limit: number }> {
    const docs = await PortForward.find({ controllerId, userId }).sort({ port: 1 }).lean();
    return {
      portForwards: docs.map(this.mapPortForward),
      total: docs.length,
      limit: 0,
    };
  }

  async create(controllerId: string, userId: string, port: number, maxPerController: number): Promise<Record<string, unknown>> {
    const controller = await Controller.findOne({ _id: controllerId, userId }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }
    if (controller.status !== 'online') {
      throw new Error('Controller is not online');
    }

    const count = await PortForward.countDocuments({ controllerId, userId });
    if (count >= maxPerController) {
      throw new Error(`Maximum ${maxPerController} port forwards per controller`);
    }

    const existing = await PortForward.findOne({ controllerId, port });
    if (existing) {
      throw new Error('Port already forwarded');
    }

    const doc = await PortForward.create({ controllerId, userId, port, status: 'active' });

    const redis = getRedisClient();
    await redis.publish(COMMAND_CHANNEL, JSON.stringify({
      type: 'tunnel:create',
      controllerId,
      port,
    }));

    return this.mapPortForward(doc.toObject());
  }

  async delete(controllerId: string, userId: string, port: number): Promise<boolean> {
    const result = await PortForward.deleteOne({ controllerId, userId, port });
    if (result.deletedCount === 0) {
      return false;
    }

    const redis = getRedisClient();
    await redis.publish(COMMAND_CHANNEL, JSON.stringify({
      type: 'tunnel:close',
      controllerId,
      port,
    }));

    return true;
  }

  private mapPortForward(doc: Record<string, unknown>): Record<string, unknown> {
    return {
      id: (doc._id as mongoose.Types.ObjectId).toString(),
      controllerId: (doc.controllerId as mongoose.Types.ObjectId).toString(),
      port: doc.port,
      status: doc.status,
      createdAt: (doc.createdAt as Date).toISOString(),
    };
  }
}

export const portForwardService = new PortForwardService();
