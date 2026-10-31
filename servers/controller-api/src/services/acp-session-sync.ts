import type { Socket } from 'socket.io';
import { getRedisClient } from '../middleware/redis.js';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';

interface SessionInfo {
  sessionId: string;
  title: string | null;
  cwd: string;
  updatedAt: string | null;
}

interface HistoryMessage {
  direction: 'input' | 'output';
  type: string;
  content: string;
}

interface ListResult {
  success: boolean;
  sessions?: SessionInfo[];
  error?: string;
}

interface DeleteResult {
  success: boolean;
  supported?: boolean;
  error?: string;
}

interface LoadResult {
  success: boolean;
  sessionId?: string;
  title?: string | null;
  messages?: HistoryMessage[];
  error?: string;
}

interface LoadAccumulator {
  result: LoadResult;
  messages: HistoryMessage[];
  timeout: NodeJS.Timeout;
  controllerSocket: Socket;
}

export class AcpSessionSyncService {
  private readonly logger: ObservationLogger;

  constructor(logger: ObservationLogger = rootLogger.child({ component: 'acp-session-sync' })) {
    this.logger = logger;
  }

  private pendingLists = new Map<string, {
    resolve: (result: ListResult) => void;
    timeout: NodeJS.Timeout;
    controllerSocket: Socket;
  }>();

  private pendingLoads = new Map<string, {
    resolve: (result: LoadResult) => void;
    timeout: NodeJS.Timeout;
    controllerSocket: Socket;
  }>();

  private pendingDeletes = new Map<string, {
    resolve: (result: DeleteResult) => void;
    timeout: NodeJS.Timeout;
    controllerSocket: Socket;
  }>();

  private loadAccumulators = new Map<string, LoadAccumulator>();

  async listSessions(controllerSocket: Socket, serverType: string, cwd: string): Promise<ListResult> {
    const requestId = `sync_list_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingLists.delete(requestId);
        resolve({ success: false, error: 'ACP list-sessions timeout' });
      }, 120000);

      this.pendingLists.set(requestId, {
        resolve: (result) => {
          clearTimeout(timeout);
          this.pendingLists.delete(requestId);
          resolve(result);
        },
        timeout,
        controllerSocket,
      });

      controllerSocket.emit('acp:list-sessions', { requestId, serverType, cwd });
    });
  }

  async loadSession(controllerSocket: Socket, serverType: string, acpSessionId: string, cwd: string): Promise<LoadResult> {
    const requestId = `sync_load_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    this.initLoadAccumulator(requestId, controllerSocket);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingLoads.delete(requestId);
        this.loadAccumulators.delete(requestId);
        resolve({ success: false, error: 'ACP load-session timeout' });
      }, 300000);

      this.pendingLoads.set(requestId, {
        resolve: (result) => {
          clearTimeout(timeout);
          this.pendingLoads.delete(requestId);
          resolve(result);
        },
        timeout,
        controllerSocket,
      });

      controllerSocket.emit('acp:load-session', { requestId, serverType, sessionId: acpSessionId, cwd });
    });
  }

  async deleteHistorySession(controllerSocket: Socket, serverType: string, sessionId: string, externalSessionId: string, cwd: string): Promise<DeleteResult> {
    const requestId = `sync_delete_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingDeletes.delete(requestId);
        resolve({ success: false, error: 'ACP delete-session timeout' });
      }, 120000);

      this.pendingDeletes.set(requestId, {
        resolve: (result) => {
          clearTimeout(timeout);
          this.pendingDeletes.delete(requestId);
          resolve(result);
        },
        timeout,
        controllerSocket,
      });

      controllerSocket.emit('acp:delete-history-session', { requestId, serverType, sessionId, externalSessionId, cwd });
    });
  }

  handleListResult(requestId: string, result: ListResult): void {
    const pending = this.pendingLists.get(requestId);
    if (pending) {
      pending.resolve(result);
    }
  }

  handleDeleteResult(requestId: string, result: DeleteResult): void {
    const pending = this.pendingDeletes.get(requestId);
    if (pending) {
      pending.resolve(result);
    }
  }

  handleLoadResult(requestId: string, result: LoadResult): void {
    const acc = this.loadAccumulators.get(requestId);
    if (acc) {
      acc.result.title = result.title;
      acc.result.sessionId = result.sessionId;
      if (result.success === false) {
        acc.result.success = false;
        acc.result.error = result.error;
      }
      if (result.messages && result.messages.length > 0) {
        acc.result.messages = result.messages;
      }
      if ((result.messages && result.messages.length > 0) || result.success === false) {
        this.loadAccumulators.delete(requestId);
        const pending = this.pendingLoads.get(requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingLoads.delete(requestId);
          pending.resolve(acc.result);
        }
        this.cacheLoadResult(requestId, acc.result).catch((err) => {
          this.logger.error({ err, requestId }, 'cacheLoadResult error');
        });
      }
      return;
    }
    const pending = this.pendingLoads.get(requestId);
    if (pending) {
      pending.resolve(result);
    }
  }

  handleLoadResultMessage(requestId: string, message: HistoryMessage): number {
    const acc = this.loadAccumulators.get(requestId);
    if (acc) {
      acc.messages.push(message);
      return acc.messages.length;
    }
    return 0;
  }

  finalizeAndCacheLoadResult(requestId: string): void {
    const acc = this.loadAccumulators.get(requestId);
    if (!acc) return;

    acc.result.messages = acc.messages;
    this.loadAccumulators.delete(requestId);

    const pending = this.pendingLoads.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingLoads.delete(requestId);
      pending.resolve(acc.result);
    }

    this.cacheLoadResult(requestId, acc.result).catch((err) => {
      this.logger.error({ err, requestId }, 'cacheLoadResult error');
    });
  }

  initLoadAccumulator(requestId: string, controllerSocket: Socket): void {
    const timeout = setTimeout(() => {
      this.loadAccumulators.delete(requestId);
      const pending = this.pendingLoads.get(requestId);
      if (pending) {
        this.pendingLoads.delete(requestId);
        pending.resolve({ success: false, error: 'ACP load-session message streaming timeout' });
      }
    }, 310000);

    this.loadAccumulators.set(requestId, {
      result: { success: true },
      messages: [],
      timeout,
      controllerSocket,
    });
  }

  cleanupSocket(socket: Socket): void {
    for (const [requestId, pending] of this.pendingLists) {
      if (pending.controllerSocket.id === socket.id) {
        clearTimeout(pending.timeout);
        this.pendingLists.delete(requestId);
        pending.resolve({ success: false, error: 'Controller disconnected' });
      }
    }
    for (const [requestId, pending] of this.pendingLoads) {
      if (pending.controllerSocket.id === socket.id) {
        clearTimeout(pending.timeout);
        this.pendingLoads.delete(requestId);
        pending.resolve({ success: false, error: 'Controller disconnected' });
      }
    }
    for (const [requestId, pending] of this.pendingDeletes) {
      if (pending.controllerSocket.id === socket.id) {
        clearTimeout(pending.timeout);
        this.pendingDeletes.delete(requestId);
        pending.resolve({ success: false, error: 'Controller disconnected' });
      }
    }
    for (const [requestId, acc] of this.loadAccumulators) {
      if (acc.controllerSocket.id === socket.id) {
        clearTimeout(acc.timeout);
        this.loadAccumulators.delete(requestId);
      }
    }
  }

  async cacheListResult(requestId: string, result: ListResult): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`acp:list-sessions:${requestId}`, JSON.stringify(result), 'EX', 120);
  }

  async cacheDeleteResult(requestId: string, result: DeleteResult): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`acp:delete-session:${requestId}`, JSON.stringify(result), 'EX', 120);
  }

  async cacheLoadResult(requestId: string, result: LoadResult): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`acp:load-session:${requestId}`, JSON.stringify(result), 'EX', 300);
  }

  async getCachedListResult(requestId: string): Promise<ListResult | null> {
    const redis = getRedisClient();
    const cached = await redis.get(`acp:list-sessions:${requestId}`);
    return cached ? JSON.parse(cached) : null;
  }

  async getCachedLoadResult(requestId: string): Promise<LoadResult | null> {
    const redis = getRedisClient();
    const cached = await redis.get(`acp:load-session:${requestId}`);
    return cached ? JSON.parse(cached) : null;
  }
}

export const acpSessionSyncService = new AcpSessionSyncService();
