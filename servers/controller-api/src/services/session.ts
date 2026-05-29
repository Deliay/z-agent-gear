import crypto from 'node:crypto';
import { getRedisClient } from '../middleware/redis.js';

const SESSION_TTL = 90;
const HEARTBEAT_TTL = 90;

export class SessionService {
  async acquireSession(keyId: string, socketId: string, resumeToken?: string): Promise<boolean> {
    const redis = getRedisClient();
    const existing = await redis.get(`session:${keyId}`);
    if (existing) {
      if (resumeToken) {
        const stored = await redis.get(`resume:${keyId}`);
        if (stored === resumeToken) {
          await redis.del(`session:${keyId}`);
        } else {
          return false;
        }
      } else {
        return false;
      }
    }
    await redis.set(`session:${keyId}`, socketId, 'EX', SESSION_TTL);
    return true;
  }

  async storeResumeToken(keyId: string): Promise<string> {
    const redis = getRedisClient();
    const token = crypto.randomUUID();
    await redis.set(`resume:${keyId}`, token);
    return token;
  }

  async removeResumeToken(keyId: string): Promise<void> {
    const redis = getRedisClient();
    await redis.del(`resume:${keyId}`);
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
      this.removeResumeToken(keyId),
    ]);
  }

  async cleanupAllSessions(): Promise<void> {
    const redis = getRedisClient();
    const keys = await redis.keys('session:*');
    if (keys.length > 0) {
      await redis.del(...keys);
      console.log(`Cleaned up ${keys.length} stale sessions from Redis`);
    }
  }
}

export const sessionService = new SessionService();
