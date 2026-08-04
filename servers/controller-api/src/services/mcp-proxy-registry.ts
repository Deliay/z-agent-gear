import crypto from 'crypto';
import type { Redis } from 'ioredis';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import bcrypt from 'bcryptjs';
import { McpServer } from '../models/mcp-server.js';
import { McpProxyKey } from '../models/mcp-proxy-key.js';
import { getRedisClient } from '../middleware/redis.js';

const OWNER_TTL_SECONDS = 45;

interface ProxyConnection {
  socket: Socket;
  serverId: string;
  userId: string;
  command: string;
}

export class McpProxyRegistry {
  private connections: Map<string, ProxyConnection> = new Map();
  private pendingRequests: Map<string, { proxyId: string; resolve: (value: any) => void; reject: (reason: any) => void; timeout: NodeJS.Timeout }> = new Map();
  readonly instanceId: string = crypto.randomUUID();

  constructor(
    private io: SocketIOServer,
    private redis: Redis = getRedisClient(),
  ) {}

  private async setOwner(serverId: string): Promise<void> {
    await this.redis.set(`mcp:proxy:owner:${serverId}`, this.instanceId, 'EX', OWNER_TTL_SECONDS);
  }

  private async clearOwner(serverId: string): Promise<void> {
    await this.redis.del(`mcp:proxy:owner:${serverId}`);
  }

  async register(
    rawKey: string,
    hostname: string,
    command: string,
    serverName: string,
  ): Promise<{ success: boolean; proxyId?: string; serverId?: string; error?: string }> {
    const keys = await McpProxyKey.find({ status: 'active' });
    let userId: string | undefined;
    let keyId: string | undefined;

    for (const key of keys) {
      const match = await bcrypt.compare(rawKey, (key as any).keyHash as string);
      if (match) {
        userId = (key as any).userId as string;
        keyId = (key as any)._id.toString();
        await McpProxyKey.findByIdAndUpdate((key as any)._id, { lastUsedAt: new Date() });
        break;
      }
    }

    if (!userId || !keyId) {
      return { success: false, error: 'Invalid key' };
    }

    const server = await McpServer.create({
      userId,
      name: serverName,
      transport: 'registered_proxy',
      command,
      status: 'active',
    });

    const proxyId = `proxy_${server._id}`;
    return { success: true, proxyId, serverId: server._id.toString() };
  }

  setupNamespace(): void {
    const nsp = this.io.of('/mcp-proxy');

    nsp.on('connection', (socket: Socket) => {
      let proxyId: string | null = null;

      socket.on('proxy:register', async (data: { proxyId: string; key: string }) => {
        proxyId = data.proxyId;
        const serverId = proxyId.replace('proxy_', '');

        const server = await McpServer.findByIdAndUpdate(
          serverId,
          { proxyConnectionId: socket.id, status: 'active', lastHeartbeatAt: new Date() },
          { new: true },
        );

        if (!server) {
          socket.emit('proxy:error', { code: 'PROXY_NOT_FOUND', message: 'Server not found' });
          socket.disconnect(true);
          return;
        }

        this.connections.set(proxyId, {
          socket,
          serverId,
          userId: (server as any).userId as string,
          command: (server as any).command as string,
        });

        await this.setOwner(serverId);
        socket.emit('proxy:registered', { proxyId, serverId });
      });

      socket.on('proxy:heartbeat', async (data: { proxyId: string }) => {
        const conn = this.connections.get(data.proxyId);
        if (conn) {
          await McpServer.findByIdAndUpdate(conn.serverId, { lastHeartbeatAt: new Date() });
          await this.setOwner(conn.serverId);
        }
      });

      socket.on('proxy:response', (data: { requestId: string; response: any }) => {
        const pending = this.pendingRequests.get(data.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          pending.resolve(data.response);
          this.pendingRequests.delete(data.requestId);
        }
      });

      socket.on('proxy:unregister', async () => {
        if (proxyId) {
          await this.handleDisconnect(proxyId);
        }
      });

      socket.on('disconnect', async () => {
        if (proxyId) {
          await this.handleDisconnect(proxyId);
        }
      });
    });
  }

  async forwardRequest(proxyId: string, request: any): Promise<any> {
    const conn = this.connections.get(proxyId);
    if (!conn) {
      throw new Error('Proxy not connected');
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Request timeout'));
      }, 30000);

      this.pendingRequests.set(requestId, { proxyId, resolve, reject, timeout });
      conn.socket.emit('proxy:request', { requestId, request });
    });
  }

  private async handleDisconnect(proxyId: string): Promise<void> {
    const conn = this.connections.get(proxyId);
    if (conn) {
      await McpServer.findByIdAndUpdate(conn.serverId, { status: 'offline', proxyConnectionId: null });
      await this.clearOwner(conn.serverId);
      this.connections.delete(proxyId);
      
      // Clean up pending requests owned by this proxy only — rejecting every
      // in-flight request would break other proxies on the same replica.
      for (const [requestId, pending] of this.pendingRequests.entries()) {
        if (pending.proxyId !== proxyId) continue;
        clearTimeout(pending.timeout);
        pending.reject(new Error('Proxy disconnected'));
        this.pendingRequests.delete(requestId);
      }
    }
  }

  getActiveProxy(serverId: string): ProxyConnection | undefined {
    const proxyId = `proxy_${serverId}`;
    return this.connections.get(proxyId);
  }

  hasActiveProxy(serverId: string): boolean {
    return this.getActiveProxy(serverId) !== undefined;
  }
}
