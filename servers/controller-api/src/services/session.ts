import crypto from 'node:crypto';
import { getRedisClient } from '../middleware/redis.js';

const SESSION_TTL = 90;
const HEARTBEAT_TTL = 90;

/**
 * 原子接管：读取旧 socketId 后写入新 socketId（同一往返，避免并发注册互相覆盖）。
 * 返回旧 socketId；无旧会话时为 null。
 */
const TAKEOVER_SESSION_SCRIPT = `
local previous = redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return previous
`;

/** 按所有权释放：仅当 session 仍属于该 socketId 时删除，避免旧连接误删新会话。 */
const RELEASE_SESSION_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export class SessionService {
  async takeoverSession(keyId: string, socketId: string): Promise<string | null> {
    const redis = getRedisClient();
    const previous = await redis.eval(
      TAKEOVER_SESSION_SCRIPT,
      1,
      `session:${keyId}`,
      socketId,
      SESSION_TTL,
    );
    return typeof previous === 'string' && previous.length > 0 ? previous : null;
  }

  async releaseSession(keyId: string, socketId: string): Promise<boolean> {
    const redis = getRedisClient();
    const released = await redis.eval(RELEASE_SESSION_SCRIPT, 1, `session:${keyId}`, socketId);
    return released === 1;
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
}

export const sessionService = new SessionService();
