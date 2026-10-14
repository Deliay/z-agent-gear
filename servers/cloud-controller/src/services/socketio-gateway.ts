import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { ContainerService } from './container-service.js';
import type { HeartbeatTracker } from './heartbeat-tracker.js';
import type { TokenService } from './token-service.js';

export const WORKER_NAMESPACE = '/worker';
export const CURRENT_MAJOR_VERSION = '2';

interface Logger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

interface RegisterPayload {
  key?: string;
  hostname?: string;
  version?: string;
  platform?: string;
  homeDir?: string;
}

export interface WorkerGatewayDeps {
  tokenService: TokenService;
  containerService: ContainerService;
  heartbeatTracker: HeartbeatTracker;
  logger?: Logger;
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

/**
 * Socket.IO `/worker` namespace 接入网关。
 * 握手 middleware 校验一次性 token；register 绑定 containerId → online；
 * heartbeat 计时；shutdown 通知；disconnect 退回 connecting。
 */
export function registerWorkerGateway(
  io: SocketIOServer,
  deps: WorkerGatewayDeps,
): void {
  const logger = deps.logger ?? console;
  const nsp = io.of(WORKER_NAMESPACE);

  nsp.use((socket: Socket, next) => {
    const token = firstString(socket.handshake.query?.token);
    void deps.tokenService
      .verify(token)
      .then((container) => {
        if (!container) {
          logger.warn?.(
            `[worker] handshake rejected from ${socket.handshake.address}: INVALID_TOKEN`,
          );
          next(new Error('INVALID_TOKEN'));
          return;
        }
        socket.data.containerId = container.id;
        next();
      })
      .catch((err) => {
        logger.error?.('[worker] handshake error', err);
        next(new Error('INVALID_TOKEN'));
      });
  });

  // 销毁流程：向绑定到 containerId room 的在线容器发送 shutdown。
  deps.containerService.onShutdown((containerId) => {
    nsp.to(containerId).emit('shutdown', { reason: '强制销毁' });
  });

  nsp.on('connection', (socket: Socket) => {
    const containerId = socket.data.containerId as string;
    socket.join(containerId);

    socket.on('register', async (payload: RegisterPayload = {}) => {
      // key 字段被忽略（由握手 token 替代）。
      const major = typeof payload?.version === 'string' ? payload.version.split('.')[0] : undefined;
      if (major !== CURRENT_MAJOR_VERSION) {
        socket.emit('error', {
          code: 'VERSION_MISMATCH',
          message: 'agent-gear 版本不兼容，请升级到 major 2 后重试',
        });
        socket.disconnect(true);
        return;
      }

      try {
        socket.data.registered = true;
        socket.data.hostname = payload?.hostname;
        deps.heartbeatTracker.record(containerId);
        await deps.containerService.markOnline(containerId);
        socket.emit('registered', { controllerId: containerId });
      } catch (err) {
        logger.error?.('[worker] register error', err);
        socket.emit('error', { code: 'REGISTER_FAILED', message: '注册失败' });
        socket.disconnect(true);
      }
    });

    socket.on('heartbeat', () => {
      if (!socket.data.registered) return;
      deps.heartbeatTracker.record(containerId);
    });

    socket.on('unregister', () => {
      socket.emit('unregistered', {});
      socket.disconnect(true);
    });

    socket.on('disconnect', () => {
      deps.heartbeatTracker.remove(containerId);
      if (!socket.data.registered) return;
      void deps.containerService
        .getById(containerId)
        .then((record) => {
          if (record && record.status === 'online') {
            return deps.containerService.markConnecting(containerId);
          }
          return undefined;
        })
        .catch((err) => {
          logger.error?.('[worker] disconnect handling error', err);
        });
    });
  });
}
