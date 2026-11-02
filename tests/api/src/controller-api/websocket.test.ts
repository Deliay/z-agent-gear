import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import Redis from 'ioredis';
import mongoose from 'mongoose';
import { createFrontUser } from '../support/front-users.js';

const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(REDIS_URL, { enableOfflineQueue: false, retryStrategy: () => null });

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const body: Record<string, unknown> = { query };
  if (variables) {
    body.variables = variables;
  }
  return fetch(AGENT_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const CREATE_KEY = `
  mutation CreateControllerKey($input: CreateKeyInput!) {
    createControllerKey(input: $input) {
      key { id name type keyPrefix status createdAt updatedAt }
      rawKey
    }
  }
`;

const REVOKE_KEY = `
  mutation RevokeControllerKey($id: ID!) {
    revokeControllerKey(id: $id)
  }
`;

function createClient(): ClientSocket {
  return SocketIOClient(CONTROLLER_API_URL, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
}

function waitForEvent<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

let authToken = '';

async function createKey(name: string): Promise<{ rawKey: string; keyId: string }> {
  const res = await gqlRequest(
    CREATE_KEY,
    { input: { name, type: 'local' } },
    authToken,
  );
  const body = await res.json();
  return {
    rawKey: body.data.createControllerKey.rawKey,
    keyId: body.data.createControllerKey.key.id,
  };
}

async function revokeKey(keyId: string): Promise<void> {
  await gqlRequest(REVOKE_KEY, { id: keyId }, authToken);
}

describe('Controller API WebSocket', () => {
  beforeAll(async () => {
    const frontUser = await createFrontUser();
    authToken = frontUser.token;
    expect(authToken).toBeTruthy();
  });

  describe('register', () => {
    it('should register with valid key and return controllerId', async () => {
      const { rawKey } = await createKey(`ws_v_${Date.now()}`);
      const client = createClient();

      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: rawKey, hostname: 'test-host', version: '2.0.0' });

      const data = await registered;
      expect(data.controllerId).toBeDefined();
      expect(typeof data.controllerId).toBe('string');

      client.disconnect();
    });

    it('should reject register with invalid key', async () => {
      const client = createClient();

      const error = waitForEvent<{ code: string; message: string }>(client, 'error');
      client.emit('register', { key: 'zag_k_1_nonexistent', hostname: 'test-host', version: '2.0.0' });

      const err = await error;
      expect(err.code).toBe('INVALID_KEY');
    });

    it('should reject register with version mismatch', async () => {
      const { rawKey } = await createKey(`ws_ver_${Date.now()}`);
      const client = createClient();

      const error = waitForEvent<{ code: string; message: string }>(client, 'error');
      client.emit('register', { key: rawKey, hostname: 'test-host', version: '99.0.0' });

      const err = await error;
      expect(err.code).toBe('VERSION_MISMATCH');

      client.disconnect();
    });
  });

  describe('heartbeat', () => {
    it('should accept heartbeat from authenticated client', async () => {
      const { rawKey } = await createKey(`ws_hb_${Date.now()}`);
      const client = createClient();

      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: rawKey, hostname: 'test-host', version: '2.0.0' });
      await registered;

      client.emit('heartbeat');

      await new Promise((r) => setTimeout(r, 200));
      expect(client.connected).toBe(true);

      client.disconnect();
    });
  });

  describe('unregister', () => {
    it('should unregister and disconnect', async () => {
      const { rawKey } = await createKey(`ws_unreg_${Date.now()}`);
      const client = createClient();

      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: rawKey, hostname: 'test-host', version: '2.0.0' });
      await registered;

      const unregistered = waitForEvent(client, 'unregistered');
      client.emit('unregister', { reason: 'user_detach' });
      await unregistered;

      await new Promise((r) => setTimeout(r, 300));
      expect(client.connected).toBe(false);
    });
  });

  describe('session exclusivity', () => {
    it('T-ST11: a second connection takes over and the first receives SESSION_REPLACED', async () => {
      const { rawKey } = await createKey(`ws_excl_${Date.now()}`);

      const client1 = createClient();
      const replaced = waitForEvent<{ code: string }>(client1, 'error');
      const registered1 = waitForEvent<{ controllerId: string }>(client1, 'registered');
      client1.emit('register', { key: rawKey, hostname: 'host-1', version: '2.0.0' });
      await registered1;

      const client2 = createClient();
      const registered2 = waitForEvent<{ controllerId: string }>(client2, 'registered');
      client2.emit('register', { key: rawKey, hostname: 'host-2', version: '2.0.0' });

      const data2 = await registered2;
      expect(data2.controllerId).toBeDefined();

      const err = await replaced;
      expect(err.code).toBe('SESSION_REPLACED');

      // 旧连接被服务端断开
      await new Promise((r) => setTimeout(r, 300));
      expect(client1.connected).toBe(false);

      // 新连接心跳后持续在线
      client2.emit('heartbeat');
      await new Promise((r) => setTimeout(r, 200));
      expect(client2.connected).toBe(true);

      client1.disconnect();
      client2.disconnect();
    });

    it('T-ST12: a leftover session (controller-api restart) is taken over without KEY_ALREADY_ONLINE', async () => {
      const { rawKey, keyId } = await createKey(`ws_restart_${Date.now()}`);
      // 模拟 controller-api 重启后 Redis 残留的旧 socketId，客户端不携带 resumeToken
      await redis.set(`session:${keyId}`, 'dead-socket-id', 'EX', 90);

      const client = createClient();
      const errors: string[] = [];
      client.on('error', (data: { code: string }) => errors.push(data.code));

      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: rawKey, hostname: 'restart-host', version: '2.0.0' });

      const data = await registered;
      expect(data.controllerId).toBeDefined();

      await new Promise((r) => setTimeout(r, 300));
      expect(errors).not.toContain('KEY_ALREADY_ONLINE');
      expect(client.connected).toBe(true);

      client.disconnect();
    });

    it('T-ST15: a startup heartbeat scan does not kick the newly reconnected session', async () => {
      const mongodbUri = process.env.MONGODB_URI;
      if (!mongodbUri) {
        throw new Error('MONGODB_URI is required for T-ST15 (assert controller status directly)');
      }
      if (mongoose.connection.readyState === 0) await mongoose.connect(mongodbUri);
      const db = mongoose.connection.db!;

      const { rawKey, keyId } = await createKey(`ws_scan_${Date.now()}`);
      await redis.set(`session:${keyId}`, 'dead-socket-id', 'EX', 90);

      const client = createClient();
      const shutdowns: string[] = [];
      client.on('shutdown', (data: { reason: string }) => shutdowns.push(data.reason));

      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: rawKey, hostname: 'scan-host', version: '2.0.0' });
      await registered;

      // 模拟重启后第一轮巡检读到超时快照，但新连接已刷新心跳（CAS 应不命中）
      await db.collection('controllers').updateOne(
        { keyId: new mongoose.Types.ObjectId(keyId) },
        { $set: { lastHeartbeatAt: new Date(Date.now() - 120_000) } },
      );
      client.emit('heartbeat');
      await new Promise((r) => setTimeout(r, 300));

      // 等待至少一个巡检周期
      await new Promise((r) => setTimeout(r, 16_000));

      expect(shutdowns).not.toContain('heartbeat_timeout');
      expect(client.connected).toBe(true);
      expect(await redis.get(`session:${keyId}`)).toBeTruthy();

      const controller = await db.collection('controllers').findOne({
        keyId: new mongoose.Types.ObjectId(keyId),
      });
      expect(controller?.status).toBe('online');

      client.disconnect();
    }, 30_000);
  });
});

afterAll(async () => {
  redis.disconnect();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});
