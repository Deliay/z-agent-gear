import { Controller } from '../models/controller.js';
import { getRedisClient } from '../middleware/redis.js';

export class FolderBrowserService {
  async browse(controllerId: string, userId: string, path?: string): Promise<Record<string, unknown>[]> {
    const controller = await Controller.findOne({ _id: controllerId, userId }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }

    if (controller.status !== 'online') {
      throw new Error('Controller is offline');
    }

    const redis = getRedisClient();
    const requestId = `fs_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    await redis.publish('session:command', JSON.stringify({
      type: 'fs:browse',
      requestId,
      controllerId,
      path: path || null,
    }));

    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const result = await redis.get(`fs:browse:${requestId}`);
      if (result) {
        await redis.del(`fs:browse:${requestId}`);
        return JSON.parse(result).entries;
      }
    }

    throw new Error('Folder browse timeout');
  }

  async getHomeDirectory(controllerId: string, userId: string): Promise<string | null> {
    const controller = await Controller.findOne({ _id: controllerId, userId }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }

    if (controller.status !== 'online') {
      throw new Error('Controller is offline');
    }

    const redis = getRedisClient();
    const requestId = `fs_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    await redis.publish('session:command', JSON.stringify({
      type: 'fs:home',
      requestId,
      controllerId,
    }));

    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const result = await redis.get(`fs:home:${requestId}`);
      if (result) {
        await redis.del(`fs:home:${requestId}`);
        return JSON.parse(result).path;
      }
    }

    throw new Error('Get home directory timeout');
  }
}

export const folderBrowserService = new FolderBrowserService();
