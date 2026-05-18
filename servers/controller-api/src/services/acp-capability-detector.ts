import type { Socket } from 'socket.io';
import { getRedisClient } from '../middleware/redis.js';

interface AcpServerInfo {
  type: string;
  available: boolean;
  version?: string;
}

interface AcpCheckRequest {
  requestId: string;
  controllerSocket: Socket;
  resolve: (servers: AcpServerInfo[]) => void;
}

export class ACPCapabilityDetector {
  private pendingRequests = new Map<string, AcpCheckRequest>();
  private cache = new Map<string, { servers: AcpServerInfo[]; checkedAt: Date }>();

  async detectCapabilities(controllerSocket: Socket, controllerId: string): Promise<AcpServerInfo[]> {
    // Check cache first
    const cached = this.cache.get(controllerId);
    if (cached) {
      const cacheAge = Date.now() - cached.checkedAt.getTime();
      if (cacheAge < 3600000) { // 1 hour
        return cached.servers;
      }
    }

    // Check Redis cache
    const redis = getRedisClient();
    const redisCached = await redis.get(`acp:capability:${controllerId}`);
    if (redisCached) {
      const parsed = JSON.parse(redisCached);
      const servers = parsed.servers;
      this.cache.set(controllerId, { servers, checkedAt: new Date(parsed.checkedAt) });
      return servers;
    }

    // Send acp:check to controller
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        resolve([]);
      }, 10000);

      this.pendingRequests.set(requestId, {
        requestId,
        controllerSocket,
        resolve: (servers) => {
          clearTimeout(timeout);
          this.pendingRequests.delete(requestId);
          
          // Cache the result
          this.cache.set(controllerId, { servers, checkedAt: new Date() });
          
          // Save to Redis
          redis.set(`acp:capability:${controllerId}`, JSON.stringify({
            servers,
            checkedAt: new Date().toISOString(),
          }), 'EX', 3600);
          
          resolve(servers);
        },
      });

      controllerSocket.emit('acp:check', { requestId });
    });
  }

  handleCheckResult(requestId: string, servers: AcpServerInfo[]): void {
    const request = this.pendingRequests.get(requestId);
    if (request) {
      request.resolve(servers);
    }
  }

  invalidateCache(controllerId: string): void {
    this.cache.delete(controllerId);
    const redis = getRedisClient();
    redis.del(`acp:capability:${controllerId}`);
  }
}

export const acpCapabilityDetector = new ACPCapabilityDetector();