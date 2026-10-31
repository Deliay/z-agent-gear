import crypto from 'node:crypto';
import { getRedisClient } from '../middleware/redis.js';
import { publish } from '../middleware/publish.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer, Socket } from 'socket.io';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';
import { extractTraceparent, withSpan } from '../observability/trace.js';

const COMMAND_CHANNEL = 'port-forward:command';
const RESPONSE_CHANNEL = 'port-forward:response';

interface TunnelInfo {
  controllerId: string;
  port: number;
  socketId: string;
}

interface ProxyRequestContext {
  requestId: string;
  controllerId: string;
  port: number;
  socket: Socket;
  responseChunks: Buffer[];
  resolved: boolean;
  timeout: ReturnType<typeof setTimeout>;
}

export class GatewayRelayService {
  private io: SocketIOServer | null = null;
  private tunnels: Map<string, TunnelInfo> = new Map();
  private proxyRequests: Map<string, ProxyRequestContext> = new Map();
  private readonly logger: ObservationLogger;

  constructor(logger: ObservationLogger = rootLogger.child({ component: 'gateway-relay' })) {
    this.logger = logger;
  }

  start(io: SocketIOServer): void {
    this.io = io;
    this.subscribeCommands();
    this.subscribeResponses();
  }

  private subscribeCommands(): void {
    const redis = getRedisClient();
    const subscriber = redis.duplicate();

    subscriber.subscribe(COMMAND_CHANNEL, (err) => {
      if (err) {
        this.logger.error({ err, channel: COMMAND_CHANNEL }, 'failed to subscribe to channel');
        return;
      }
    });

    subscriber.on('message', async (channel: string, message: string) => {
      if (channel !== COMMAND_CHANNEL) return;

      try {
        const command = JSON.parse(message) as { type: string; _meta?: { traceparent?: string } } & Record<string, unknown>;
        const parent = extractTraceparent(command._meta);
        await withSpan(
          `${COMMAND_CHANNEL} handle`,
          { 'messaging.system': 'redis', 'messaging.destination.name': channel, commandType: command.type },
          async () => {
            switch (command.type) {
              case 'tunnel:create':
                await this.handleTunnelCreate(command.controllerId as string, command.port as number);
                break;
              case 'tunnel:close':
                this.handleTunnelClose(command.tunnelId as string);
                break;
              case 'proxy:request':
                await this.handleProxyRequest(command as unknown as {
                  requestId: string;
                  controllerId: string;
                  port: number;
                  path: string;
                  method: string;
                  headers: Record<string, string>;
                  body?: string;
                });
                break;
            }
          },
          { parent },
        );
      } catch (err) {
        this.logger.error({ err, channel }, 'failed to process gateway command');
      }
    });
  }

  private subscribeResponses(): void {
    const redis = getRedisClient();
    const subscriber = redis.duplicate();

    subscriber.subscribe(RESPONSE_CHANNEL, (err) => {
      if (err) {
        this.logger.error({ err, channel: RESPONSE_CHANNEL }, 'failed to subscribe to channel');
        return;
      }
    });

    subscriber.on('message', (_channel: string, _message: string) => {
      // Response channel is used by agent-api to receive responses
      // controller-api publishes to this channel, does not consume
    });
  }

  private async handleTunnelCreate(controllerId: string, port: number): Promise<void> {
    const tunnelId = `${controllerId}:${port}:${crypto.randomUUID()}`;
    const socket = await this.findControllerSocket(controllerId);
    if (!socket) {
      this.logger.error({ controllerId, port }, 'controller offline');
      return;
    }
    this.tunnels.set(tunnelId, { controllerId, port, socketId: socket.id });
    socket.emit('port-forward:create', { tunnelId, port });
  }

  private async handleProxyRequest(payload: {
    requestId: string;
    controllerId: string;
    port: number;
    path: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<void> {
    const { requestId, controllerId, port, path, method, headers, body } = payload;

    let tunnelId: string | null = null;
    for (const [id, tunnel] of this.tunnels) {
      if (tunnel.controllerId === controllerId && tunnel.port === port) {
        tunnelId = id;
        break;
      }
    }

    if (!tunnelId) {
      this.logger.error({ controllerId, port, requestId }, 'no tunnel found for controller');
      await this.publishResponse(requestId, 502, {}, 'No tunnel available');
      return;
    }

    const tunnel = this.tunnels.get(tunnelId)!;
    const socket = this.io?.sockets.sockets.get(tunnel.socketId);
    if (!socket) {
      this.logger.error({ tunnelId, requestId }, 'socket not found for tunnel');
      this.tunnels.delete(tunnelId);
      await this.publishResponse(requestId, 502, {}, 'Controller socket not found');
      return;
    }

    const timeout = setTimeout(() => {
      const ctx = this.proxyRequests.get(requestId);
      if (ctx && !ctx.resolved) {
        ctx.resolved = true;
        this.proxyRequests.delete(requestId);
        this.publishResponse(requestId, 504, {}, 'Gateway timeout');
      }
    }, 30_000);

    this.proxyRequests.set(requestId, {
      requestId,
      controllerId,
      port,
      socket,
      responseChunks: [],
      resolved: false,
      timeout,
    });

    const requestData = JSON.stringify({
      type: 'http-request',
      requestId,
      method,
      path,
      headers,
      body,
    });

    socket.emit('port-forward:data', {
      tunnelId,
      data: Buffer.from(requestData).toString('base64'),
    });
  }

  async handleTunnelData(tunnelId: string, data: Buffer): Promise<void> {
    let matchedRequestId: string | null = null;
    for (const [requestId, ctx] of this.proxyRequests) {
      if (!ctx.resolved) {
        const tunnel = this.tunnels.get(tunnelId);
        if (tunnel && tunnel.controllerId === ctx.controllerId && tunnel.port === ctx.port) {
          matchedRequestId = requestId;
          break;
        }
      }
    }

    if (!matchedRequestId) {
      return;
    }

    const ctx = this.proxyRequests.get(matchedRequestId)!;

    if (data[0] === 123) {
      try {
        const raw = data.toString();
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.type === 'http-response' && parsed.requestId === ctx.requestId) {
          ctx.resolved = true;
          clearTimeout(ctx.timeout);
          this.proxyRequests.delete(matchedRequestId);

          const bodyBuffer = Buffer.from(parsed.body as string, 'base64');
          const headerEnd = bodyBuffer.indexOf('\r\n\r\n');
          if (headerEnd === -1) {
            await this.publishResponse(parsed.requestId as string, 502, {}, 'Bad gateway response');
            return;
          }

          const headerBlock = bodyBuffer.subarray(0, headerEnd).toString();
          const responseBody = bodyBuffer.subarray(headerEnd + 4);
          const statusLine = headerBlock.split('\r\n')[0];
          const statusCode = parseInt(statusLine.split(' ')[1], 10) || 502;

          const headers: Record<string, string> = {};
          for (const line of headerBlock.split('\r\n').slice(1)) {
            const idx = line.indexOf(':');
            if (idx !== -1) {
              headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
            }
          }

          await this.publishResponse(
            parsed.requestId as string,
            statusCode,
            headers,
            responseBody.toString('base64'),
          );
          return;
        }
      } catch {
        // fall through to chunk buffering
      }
    }

    ctx.responseChunks.push(data);
  }

  handleTunnelCreated(tunnelId: string, success: boolean, error?: string): void {
    if (!success) {
      this.logger.error({ tunnelId, error }, 'tunnel creation failed');
      this.tunnels.delete(tunnelId);
    }
  }

  handleTunnelClose(tunnelId: string): void {
    const tunnel = this.tunnels.get(tunnelId);
    this.tunnels.delete(tunnelId);

    if (tunnel) {
      for (const [requestId, ctx] of this.proxyRequests) {
        if (ctx.controllerId === tunnel.controllerId && ctx.port === tunnel.port && !ctx.resolved) {
          ctx.resolved = true;
          clearTimeout(ctx.timeout);
          this.proxyRequests.delete(requestId);
          this.publishResponse(requestId, 502, {}, 'Tunnel closed');
        }
      }
    }
  }

  handleTunnelError(tunnelId: string, error: string): void {
    this.logger.error({ tunnelId, error }, 'tunnel error');
    this.handleTunnelClose(tunnelId);
  }

  private async publishResponse(
    requestId: string,
    statusCode: number,
    headers: Record<string, string>,
    body: string,
  ): Promise<void> {
    await publish(RESPONSE_CHANNEL, { requestId, statusCode, headers, body });
  }

  private async findControllerSocket(controllerId: string): Promise<Socket | null> {
    if (!this.io) return null;
    const controller = await Controller.findById(controllerId).lean();
    if (!controller) return null;
    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) return null;
    return this.io.sockets.sockets.get(socketId) || null;
  }
}

export const gatewayRelayService = new GatewayRelayService();
