import { getRedisClient } from '../middleware/redis.js';

const SESSION_TTL = 90;
const HEARTBEAT_TTL = 90;

export class SessionService {
  async acquireSession(keyId: string, socketId: string): Promise<boolean> {
    const redis = getRedisClient();
    const existing = await redis.get(`session:${keyId}`);
    if (existing) {
      return false;
    }
    await redis.set(`session:${keyId}`, socketId, 'EX', SESSION_TTL);
    return true;
  }

  async refreshSession(keyId: string): Promise<void> {
    const redis = getRedisClient();
    await redis.expire(`session:${keyId}`, SESSION_TTL);
  }

  async removeSession(keyId: string): Promise<void> {
    const redis = getRedisClient();
    await redis.del(`session:${keyId}`);
  }

  async getSocketId(keyId: string): Promise<string | null> {
    const redis = getRedisClient();
    return redis.get(`session:${keyId}`);
  }

  async updateHeartbeat(keyId: string): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`heartbeat:${keyId}`, new Date().toISOString(), 'EX', HEARTBEAT_TTL);
  }

  async removeHeartbeat(keyId: string): Promise<void> {
    const redis = getRedisClient();
    await redis.del(`heartbeat:${keyId}`);
  }

  async cleanupKey(keyId: string): Promise<void> {
    await Promise.all([
      this.removeSession(keyId),
      this.removeHeartbeat(keyId),
    ]);
  }
}

export const sessionService = new SessionService();
