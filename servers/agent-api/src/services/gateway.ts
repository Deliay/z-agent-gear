import mongoose from 'mongoose';
import { Gateway } from '../models/gateway.js';
import { Controller } from '../models/controller.js';
import { actorFilter } from './workspace-context.js';
import { publish } from '../middleware/publish.js';

const COMMAND_CHANNEL = 'port-forward:command';

export class GatewayService {
  async findAllByController(controllerId: string, userId: string): Promise<{ gateways: Record<string, unknown>[]; total: number; limit: number }> {
    const docs = await Gateway.find({ controllerId, userId }).sort({ name: 1 }).lean();
    return {
      gateways: docs.map(this.mapGateway),
      total: docs.length,
      limit: 0,
    };
  }

  async create(controllerId: string, userId: string, name: string, port: number, maxPerController: number): Promise<Record<string, unknown>> {
    const controller = await Controller.findOne({ _id: controllerId, ...actorFilter(userId) }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }
    if (controller.status !== 'online') {
      throw new Error('Controller is not online');
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error('Name can only contain letters, numbers, hyphens, and underscores');
    }
    if (name.length < 1 || name.length > 50) {
      throw new Error('Name length must be 1-50 characters');
    }

    const count = await Gateway.countDocuments({ controllerId, userId });
    if (count >= maxPerController) {
      throw new Error(`Maximum ${maxPerController} gateways per controller`);
    }

    const existing = await Gateway.findOne({ controllerId, name });
    if (existing) {
      throw new Error('Gateway name already exists');
    }

    const doc = await Gateway.create({ controllerId, userId, name, port, status: 'active' });

    await publish(COMMAND_CHANNEL, {
      type: 'tunnel:create',
      controllerId,
      port,
    });

    return this.mapGateway(doc.toObject());
  }

  async delete(controllerId: string, userId: string, name: string): Promise<boolean> {
    const result = await Gateway.findOneAndDelete({ controllerId, userId, name }).lean();
    if (!result) {
      return false;
    }

    await publish(COMMAND_CHANNEL, {
      type: 'tunnel:close',
      controllerId,
      port: result.port,
    });
    return true;
  }

  private mapGateway(doc: Record<string, unknown>): Record<string, unknown> {
    return {
      id: (doc._id as mongoose.Types.ObjectId).toString(),
      controllerId: (doc.controllerId as mongoose.Types.ObjectId).toString(),
      name: doc.name,
      port: doc.port,
      status: doc.status,
      createdAt: (doc.createdAt as Date).toISOString(),
    };
  }
}

export const gatewayService = new GatewayService();
