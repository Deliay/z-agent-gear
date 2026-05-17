import { getRedisClient } from '../middleware/redis.js';

const COMMAND_CHANNEL = 'controller:command';

export class CommandService {
  async sendShutdown(keyId: string): Promise<void> {
    const redis = getRedisClient();
    await redis.publish(COMMAND_CHANNEL, JSON.stringify({ type: 'shutdown', keyId }));
  }
}

export const commandService = new CommandService();
