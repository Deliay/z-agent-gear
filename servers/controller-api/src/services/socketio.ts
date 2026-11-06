import { Server as SocketIOServer, type Socket } from 'socket.io';
import bcrypt from 'bcryptjs';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { publish } from '../middleware/publish.js';
import { withTraceMeta } from '../middleware/trace-meta.js';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';
import { runWithLogContext, type LogContext } from '../observability/log-context.js';
import { extractTraceparent, withSpan } from '../observability/trace.js';
import { ControllerKey } from '../models/controller-key.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import { lookupKey } from './key-cache.js';
import { acpSessionManager } from './acp-session-manager.js';
import { acpCapabilityDetector } from './acp-capability-detector.js';
import { acpOptionsProber } from './acp-options-prober.js';
import { folderBrowserService } from './folder-browser.js';
import { gitBrowserService } from './git-browser.js';
import { acpSessionSyncService } from './acp-session-sync.js';
import { worktreeService } from './worktree-service.js';
import { fsMkdirService } from './fs-mkdir-service.js';
import { fsReadFileService } from './fs-read-file-service.js';
import { gatewayRelayService } from './gateway-relay.js';
import { permissionManager } from './permission-manager.js';
import { elicitationManager } from './elicitation-manager.js';
import { harnessLoginManager } from './harness-login-manager.js';
import { mcpRelayService } from './mcp-relay.js';
import { connectionFields, disconnectFields } from './socket-diagnostics.js';

const CURRENT_MAJOR_VERSION = '2';

interface RegisterPayload {
  key: string;
  hostname: string;
  version: string;
  resumeToken?: string;
  homeDir?: string;
  platform?: string;
}

/** 事件报文顶层 `sessionId`（string）提取（A2 日志上下文）；缺失/非字符串返回 undefined。 */
function payloadSessionId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>).sessionId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

export function createSocketIOServer(
  io: SocketIOServer,
  logger: ObservationLogger = rootLogger.child({ component: 'socketio' }),
): void {
  /**
   * socket 事件处理器统一包装（A2）：入口 `runWithLogContext({userId, controllerId, sessionId})`
   * + `withSpan('socket.<event>')`，parent 取事件报文顶层 `_meta.traceparent`（缺失/非法回落握手
   * traceparent，T-OBS13），使事件触发的 Redis 发布（publishJson 注入 `_meta.traceparent`）保持活跃 span。
   * 高频 chunk 路径（`acp:message` / `acp:load-session:message` / `port-forward:data`）与 `heartbeat`
   * 不走本包装（F11：按消息/按分片/心跳不开逐条 span，维持现状）。
   */
  function onEvent(
    socket: Socket,
    event: string,
    handler: (payload: any) => void | Promise<void>,
  ): void {
    socket.on(event, (payload: any) => {
      const sessionId = payloadSessionId(payload);
      const ctx: LogContext = {
        userId: socket.data.userId,
        controllerId: socket.data.controllerId,
      };
      if (sessionId) ctx.sessionId = sessionId;
      const parent =
        extractTraceparent(payload?._meta) ?? (socket.data.traceparent as string | undefined);
      void runWithLogContext(ctx, () =>
        withSpan(
          `socket.${event}`,
          {
            'messaging.system': 'socketio',
            'messaging.destination.name': event,
            socketId: socket.id,
            ...(sessionId ? { sessionId } : {}),
          },
          async () => {
            await handler(payload);
          },
          { parent },
        ),
      ).catch((err: unknown) => {
        logger.error({ event, err }, 'socket event handler error');
      });
    });
  }

  // 引擎级错误监听只注册一次；放在 connection 回调内会随每条连接叠加监听器并重复刷日志。
  // 错误对象进 `err` 字段（B1：不把 err.message 压平进 detail 丢 Error 结构）。
  const transportErrorHandler = (err: unknown) => {
    logger.error({ event: 'transport_error', err }, 'transport error');
  };
  io.on('error', (err) => {
    logger.error({ event: 'engine_error', err }, 'engine error');
  });
  io.engine?.on?.('error', transportErrorHandler);
  io.on('open', () => {
    io.engine?.on?.('error', transportErrorHandler);
  });

  io.on('connection', (socket: Socket) => {
    let authenticated = false;

    // T-OBS13：握手链路传播——客户端可在握手 auth 携带 W3C traceparent（非法/缺失自动忽略），
    // 作为本连接服务端 span 的 parent。
    const handshakeTraceparent = firstString(socket.handshake.auth?.traceparent);
    if (handshakeTraceparent) socket.data.traceparent = handshakeTraceparent;

    // 记录握手来源：用于定位未 register 即断开的匿名连接（IP / Origin / UA / 凭据键名）。
    logger.info(connectionFields(socket), 'socket connected');

    onEvent(socket, 'register', async (payload: RegisterPayload) => {
      try {
        const { key, hostname, version } = payload;

        logger.info(
          {
            event: 'register_attempt',
            socketId: socket.id,
            address: socket.handshake.address ?? null,
            hostname: hostname ?? null,
            version: version ?? null,
            platform: payload.platform ?? null,
          },
          'register attempt',
        );

        const cached = await lookupKey(key);
        if (!cached) {
          logger.warn(
            {
              event: 'register_rejected',
              socketId: socket.id,
              address: socket.handshake.address ?? null,
              hostname: hostname ?? null,
              reason: 'INVALID_KEY',
              detail: 'key not found',
            },
            'register rejected',
          );
          socket.emit('error', withTraceMeta({ code: 'INVALID_KEY', message: 'Key not found' }));
          socket.disconnect(true);
          return;
        }

        const { keyId, keyHash, userId, type: keyType } = cached;
        // 多租户二期：控制器注册从 ControllerKey 继承租户/工作区归属（key 写方为 agent-api）
        const keyDoc = await ControllerKey.findById(keyId)
          .select('tenantId workspaceId')
          .lean<{ tenantId?: unknown; workspaceId?: unknown }>();
        const tenantId = keyDoc?.tenantId ?? userId;
        const keyWorkspaceId = keyDoc?.workspaceId ?? null;

        const valid = await bcrypt.compare(key, keyHash);
        if (!valid) {
          logger.warn(
            {
              event: 'register_rejected',
              socketId: socket.id,
              address: socket.handshake.address ?? null,
              hostname: hostname ?? null,
              keyId,
              reason: 'INVALID_KEY',
              detail: 'hash mismatch',
            },
            'register rejected',
          );
          socket.emit('error', withTraceMeta({ code: 'INVALID_KEY', message: 'Invalid key' }));
          socket.disconnect(true);
          return;
        }

        const clientMajor = version?.split('.')[0];
        if (clientMajor !== CURRENT_MAJOR_VERSION) {
          logger.warn(
            {
              event: 'register_rejected',
              socketId: socket.id,
              address: socket.handshake.address ?? null,
              hostname: hostname ?? null,
              keyId,
              reason: 'VERSION_MISMATCH',
              clientMajor: clientMajor ?? null,
              expectedMajor: CURRENT_MAJOR_VERSION,
            },
            'register rejected',
          );
          socket.emit('error', withTraceMeta({ code: 'VERSION_MISMATCH', message: 'Version mismatch' }));
          socket.disconnect(true);
          return;
        }

        // 新登录优先：原子接管 session。previousSocketId 若指向本进程内仍存活的旧连接，
        // 通知其被替换并断开；若为重启后残留的已死 socketId，则仅覆盖，不报错。
        const previousSocketId = await sessionService.takeoverSession(keyId, socket.id);
        if (previousSocketId && previousSocketId !== socket.id) {
          const previous = io.sockets.sockets.get(previousSocketId);
          if (previous) {
            logger.info(
              {
                event: 'session_replaced',
                keyId,
                previousSocketId,
                newSocketId: socket.id,
                previousHostname: previous.data.hostname ?? null,
                newHostname: hostname ?? null,
                previousVersion: previous.data.version ?? null,
                newVersion: version ?? null,
              },
              'session replaced by newer login',
            );
            previous.emit('error', withTraceMeta({
              code: 'SESSION_REPLACED',
              message: 'Key has been logged in from another connection',
            }));
            previous.disconnect(true);
          }
        }

        const controller = await Controller.findOneAndUpdate(
          { keyId },
          {
            userId,
            // 多租户二期：租户/工作区归属从 ControllerKey 继承（key 创建时由 agent-api 落当前工作区）
            tenantId,
            workspaceId: keyWorkspaceId,
            hostname,
            type: keyType,
            status: 'online',
            keyId,
            version,
            homeDir: payload.homeDir,
            platform: payload.platform,
            lastIp: socket.handshake.address,
            lastHeartbeatAt: new Date(),
            $setOnInsert: { name: hostname },
          },
          { upsert: true, returnDocument: 'after' },
        );

        await ControllerKey.updateOne(
          { _id: keyId },
          { boundControllerId: controller._id, lastUsedAt: new Date() },
        );

        authenticated = true;
        socket.data.keyId = keyId;
        socket.data.userId = userId;
        socket.data.controllerId = controller._id.toString();
        socket.data.lastIp = socket.handshake.address;
        socket.data.hostname = hostname;
        socket.data.version = version;
        socket.join(`user:${userId}`);

        logger.info(
          {
            event: 'registered',
            socketId: socket.id,
            keyId,
            controllerId: controller._id.toString(),
            hostname: hostname ?? null,
            version: version ?? null,
            platform: payload.platform ?? null,
          },
          'registered',
        );

        // Generate resume token for reconnection after server restart
        const resumeToken = await sessionService.storeResumeToken(keyId);
        socket.emit('registered', withTraceMeta({ controllerId: controller._id.toString(), resumeToken }));

        // 重连对账：下发权威活跃会话与待清理会话，controller 据此收割孤儿进程（内部容错，不影响注册）
        await acpSessionManager.reconcileOnRegister(socket, controller._id.toString());
      } catch (err) {
        logger.error(
          {
            event: 'register_error',
            socketId: socket.id,
            address: socket.handshake.address ?? null,
            err,
          },
          'register error',
        );
        socket.emit('error', withTraceMeta({ code: 'INVALID_KEY', message: 'Registration failed' }));
        socket.disconnect(true);
      }
    });

    // F11 豁免：心跳按「心跳与 watch 不开逐条 span」维持现状（heartbeat.tick 每轮单 span 覆盖扫描侧）
    socket.on('heartbeat', async () => {
      if (!authenticated || !socket.data.keyId) return;
      try {
        await sessionService.refreshSession(socket.data.keyId);
        await sessionService.updateHeartbeat(socket.data.keyId);

        await Controller.updateOne(
          { keyId: socket.data.keyId },
          { lastHeartbeatAt: new Date(), lastIp: socket.data.lastIp },
        );
      } catch (err) {
        logger.error({ err }, 'heartbeat error');
      }
    });

    onEvent(socket, 'unregister', async (payload: { reason: string }) => {
      if (!authenticated || !socket.data.keyId) return;

      try {
        const { keyId } = socket.data;

        // 所有权校验：已被接管（session 指向新 socket）的旧连接无权注销新连接。
        const current = await sessionService.getSocketId(keyId);
        if (current && current !== socket.id) {
          socket.disconnect(true);
          return;
        }

        await Controller.deleteOne({ keyId });
        await ControllerKey.deleteOne({ _id: keyId });
        await sessionService.cleanupKey(keyId);

        socket.emit('unregistered', withTraceMeta({}));
        socket.disconnect(true);
      } catch (err) {
        logger.error({ err }, 'unregister error');
      }
    });

    // ACP events
    onEvent(socket, 'acp:permission', async (data: {
      requestId: string;
      sessionId: string;
      toolCall: {
        toolCallId: string;
        title?: string;
        kind?: string;
        rawInput?: unknown;
        locations?: Array<{ path: string; line?: number }>;
      };
      options: Array<{ optionId: string; name: string; kind: string }>;
    }) => {
      if (!authenticated) return;
      try {
        await permissionManager.handlePermissionRequest(socket, data);
      } catch (error) {
        logger.error({ event: 'acp:permission', err: error, sessionId: data.sessionId }, 'error handling permission request');
        socket.emit('acp:permission:response', withTraceMeta({
          requestId: data.requestId,
          outcome: { outcome: 'cancelled' },
        }));
      }
    });

    onEvent(socket, 'acp:elicitation', async (data: {
      requestId: string;
      sessionId: string;
      mode: 'form' | 'url';
      message: string;
      toolCallId?: string | null;
      requestedSchema?: unknown;
      elicitationId?: string;
      url?: string;
    }) => {
      if (!authenticated) return;
      try {
        await elicitationManager.handleElicitationRequest(socket, data);
      } catch (error) {
        logger.error({ event: 'acp:elicitation', err: error, sessionId: data.sessionId }, 'error handling elicitation request');
        socket.emit('acp:elicitation:response', withTraceMeta({
          requestId: data.requestId,
          action: 'cancel',
        }));
      }
    });

    onEvent(socket, 'acp:elicitation:complete', async (data: {
      sessionId: string;
      elicitationId: string;
    }) => {
      if (!authenticated) return;
      try {
        await elicitationManager.handleElicitationComplete(socket, data);
      } catch (error) {
        logger.error({ event: 'acp:elicitation:complete', err: error, sessionId: data.sessionId }, 'error handling elicitation complete');
      }
    });

    onEvent(socket, 'acp:elicitation:resolved', async (data: {
      requestId?: string;
      sessionId: string;
      reason: 'unsupported_mode' | 'timeout' | 'cancelled';
      detail?: string;
    }) => {
      if (!authenticated) return;
      try {
        await elicitationManager.handleElicitationResolved(socket, data);
      } catch (error) {
        logger.error({ event: 'acp:elicitation:resolved', err: error, sessionId: data.sessionId }, 'error handling elicitation resolved');
      }
    });

    onEvent(socket, 'harness:login:required', async (data: {
      requestId: string;
      serverType: string;
      trigger: string;
      url: string;
      userCode: string;
      expiresInSeconds?: number;
      account?: string;
    }) => {
      if (!authenticated) return;
      try {
        await harnessLoginManager.handleLoginRequired(socket, data);
      } catch (error) {
        logger.error({ event: 'harness:login:required', err: error, requestId: data.requestId }, 'error handling harness login required');
      }
    });

    onEvent(socket, 'harness:login:succeeded', async (data: { requestId: string; account?: string }) => {
      if (!authenticated) return;
      try {
        await harnessLoginManager.handleLoginSucceeded(socket, data);
      } catch (error) {
        logger.error({ event: 'harness:login:succeeded', err: error, requestId: data.requestId }, 'error handling harness login succeeded');
      }
    });

    onEvent(socket, 'harness:login:failed', async (data: { requestId: string; reason: 'cancelled' | 'timeout' | 'error'; error?: string }) => {
      if (!authenticated) return;
      try {
        await harnessLoginManager.handleLoginFailed(socket, data);
      } catch (error) {
        logger.error({ event: 'harness:login:failed', err: error, requestId: data.requestId }, 'error handling harness login failed');
      }
    });

    onEvent(socket, 'acp:check:result', async (payload: { requestId: string; servers: Array<{ type: string; available: boolean; version?: string }> }) => {
      if (!authenticated) return;
      acpCapabilityDetector.handleCheckResult(payload.requestId, payload.servers);
    });

    onEvent(socket, 'acp:probe-options:result', async (payload: {
      requestId: string;
      serverType: string;
      success: boolean;
      modes?: Array<{ id: string; name: string; description?: string }>;
      availableModels?: Array<{ id: string; name: string; provider?: string }>;
      currentModeId?: string | null;
      currentModelId?: string | null;
      error?: string;
    }) => {
      if (!authenticated || !socket.data.controllerId) return;
      await acpOptionsProber.handleProbeResult(socket.data.controllerId, payload);
    });

    onEvent(socket, 'acp:start:result', async (payload: {
      requestId: string;
      sessionId: string;
      success: boolean;
      error?: string;
      externalSessionId?: string;
    }) => {
      if (!authenticated) return;
      // This is handled by the acpSessionManager through promise resolution
    });

    onEvent(socket, 'acp:resume:result', async (payload: {
      requestId: string;
      sessionId: string;
      success: boolean;
      error?: string;
    }) => {
      if (!authenticated) return;
      // This is handled by the acpSessionManager through promise resolution
    });

    // F11 豁免：按消息高频 chunk 路径不开逐条 span（维持现状）
    socket.on('acp:message', async (payload: { sessionId: string; message: Record<string, unknown> }) => {
      if (!authenticated) return;
      try {
        await acpSessionManager.handleControllerMessage(payload.sessionId, payload.message as SessionUpdate);
      } catch (err) {
        logger.error({ event: 'acp:message', err, sessionId: payload.sessionId }, 'ACP message error');
      }
    });

    onEvent(socket, 'acp:config-options', async (payload: {
      sessionId: string;
      configOptions: Array<Record<string, unknown>>;
    }) => {
      if (!authenticated) return;
      try {
        const configOptions = payload.configOptions ?? [];
        // publishConfigOptions 内部已写入 Session（含 mode/model 字段），此处无需重复写
        await acpSessionManager.publishConfigOptions(payload.sessionId, configOptions);
      } catch (err) {
        logger.error({ event: 'acp:config-options', err, sessionId: payload.sessionId }, 'ACP config-options error');
      }
    });

    onEvent(socket, 'acp:initial-config:result', async (payload: {
      sessionId: string;
      modeId?: string;
      modelId?: string;
      modeStatus?: 'applied' | 'failed';
      modelStatus?: 'applied' | 'failed';
      error?: string;
    }) => {
      if (!authenticated) return;
      try {
        await acpSessionManager.handleInitialConfigResult(payload);
      } catch (err) {
        logger.error({ event: 'acp:initial-config:result', err, sessionId: payload?.sessionId }, 'ACP initial-config result error');
      }
    });

    onEvent(socket, 'acp:protocol-version-mismatch', async (payload: {
      sessionId: string;
      expectedVersion: number;
      agentVersion: number;
    }) => {
      if (!authenticated) return;
      try {
        await publish('session:status', {
          sessionId: payload.sessionId,
          protocolVersionMismatch: {
            expectedVersion: payload.expectedVersion,
            agentVersion: payload.agentVersion,
          },
        });
      } catch (err) {
        logger.error({ event: 'acp:protocol-version-mismatch', err, sessionId: payload.sessionId }, 'ACP protocol-version-mismatch error');
      }
    });

    onEvent(socket, 'acp:stopped', async (payload: { sessionId: string; reason: string; exitCode?: number }) => {
      if (!authenticated) return;
      try {
        await acpSessionManager.handleControllerStopped(payload.sessionId, payload.reason, payload.exitCode);
      } catch (err) {
        logger.error({ event: 'acp:stopped', err, sessionId: payload.sessionId }, 'ACP stopped error');
      }
    });

    onEvent(socket, 'acp:prompt:start', async (payload: { sessionId: string }) => {
      if (!authenticated) return;
      try {
        await acpSessionManager.handlePromptStart(payload.sessionId);
      } catch (err) {
        logger.error({ event: 'acp:prompt:start', err, sessionId: payload.sessionId }, 'ACP prompt start error');
      }
    });

    onEvent(socket, 'acp:prompt:complete', async (payload: {
      sessionId: string;
      stopReason: string;
    }) => {
      if (!authenticated) return;
      try {
        await acpSessionManager.handlePromptComplete(payload.sessionId, payload.stopReason);
      } catch (err) {
        logger.error({ event: 'acp:prompt:complete', err, sessionId: payload.sessionId }, 'ACP prompt complete error');
      }
    });

    onEvent(socket, 'acp:list-sessions:result', async (payload: {
      requestId: string;
      success: boolean;
      sessions?: Array<{ sessionId: string; title: string | null; cwd: string; updatedAt: string | null }>;
      error?: string;
    }) => {
      if (!authenticated) return;
      const result = {
        success: payload.success,
        sessions: payload.sessions,
        error: payload.error,
      };
      try {
        acpSessionSyncService.handleListResult(payload.requestId, result);
        await acpSessionSyncService.cacheListResult(payload.requestId, result);
      } catch (err) {
        logger.error({ event: 'acp:list-sessions:result', err, requestId: payload.requestId }, 'ACP list-sessions:result error');
      }
    });

    onEvent(socket, 'acp:delete-history-session:result', async (payload: {
      requestId: string;
      sessionId: string;
      success: boolean;
      supported?: boolean;
      error?: string;
    }) => {
      if (!authenticated) return;
      const result = {
        success: payload.success,
        supported: payload.supported,
        error: payload.error,
      };
      try {
        acpSessionSyncService.handleDeleteResult(payload.requestId, result);
        await acpSessionSyncService.cacheDeleteResult(payload.requestId, result);
      } catch (err) {
        logger.error({ event: 'acp:delete-history-session:result', err, requestId: payload.requestId }, 'ACP delete-history-session:result error');
      }
    });

    onEvent(socket, 'acp:load-session:result', async (payload: {
      requestId: string;
      success: boolean;
      sessionId?: string;
      title?: string | null;
      messages?: Array<{ direction: 'input' | 'output'; type: string; content: string }>;
      error?: string;
    }) => {
      if (!authenticated) return;
      const result = {
        success: payload.success,
        sessionId: payload.sessionId,
        title: payload.title,
        messages: payload.messages,
        error: payload.error,
      };
      try {
        acpSessionSyncService.handleLoadResult(payload.requestId, result);
        await acpSessionSyncService.cacheLoadResult(payload.requestId, result);
      } catch (err) {
        logger.error({ event: 'acp:load-session:result', err, requestId: payload.requestId }, 'ACP load-session:result error');
      }
    });

    // F11 豁免：历史消息逐条转发（按消息 chunk）不开逐条 span（维持现状）
    socket.on('acp:load-session:message', async (payload: {
      requestId: string;
      direction: 'input' | 'output';
      type: string;
      content: string;
    }) => {
      if (!authenticated) return;
      acpSessionSyncService.handleLoadResultMessage(payload.requestId, {
        direction: payload.direction,
        type: payload.type,
        content: payload.content,
      });
    });

    onEvent(socket, 'acp:load-session:complete', async (payload: { requestId: string }) => {
      if (!authenticated) return;
      acpSessionSyncService.finalizeAndCacheLoadResult(payload.requestId);
    });

    // File system events
    onEvent(socket, 'fs:browse:result', async (payload: { requestId: string; entries: Array<{ name: string; path: string; isDirectory: boolean }> }) => {
      if (!authenticated) return;
      await folderBrowserService.handleBrowseResult(payload.requestId, payload.entries);
    });

    onEvent(socket, 'fs:home:result', async (payload: { requestId: string; path: string }) => {
      if (!authenticated) return;
      await folderBrowserService.handleHomeResult(payload.requestId, payload.path);
    });

    onEvent(socket, 'git:check:result', async (payload) => {
      if (!authenticated) return;
      await gitBrowserService.handleCheckResult(payload.requestId, payload);
    });

    onEvent(socket, 'git:init:result', async (payload) => {
      if (!authenticated) return;
      await gitBrowserService.handleInitResult(payload.requestId, payload);
    });

    // Worktree / Git extension result events
    onEvent(socket, 'fs:mkdir:result', async (payload: { requestId: string } & Record<string, unknown>) => {
      if (!authenticated) return;
      await fsMkdirService.handleMkdirResult(payload.requestId, payload);
    });

    // fs:read-file 结果（契约 §3.26）：写 Redis fs:read-file:{requestId}（TTL 60s）供 agent-api 轮询
    onEvent(socket, 'fs:read-file:result', async (payload: { requestId: string } & Record<string, unknown>) => {
      if (!authenticated) return;
      await fsReadFileService.handleReadFileResult(payload.requestId, payload);
    });

    onEvent(socket, 'git:worktree:add:result', async (payload: { requestId: string } & Record<string, unknown>) => {
      if (!authenticated) return;
      await worktreeService.handleAddResult(payload.requestId, payload);
    });

    onEvent(socket, 'git:worktree:remove:result', async (payload: { requestId: string } & Record<string, unknown>) => {
      if (!authenticated) return;
      await worktreeService.handleRemoveResult(payload.requestId, payload);
    });

    onEvent(socket, 'git:status:result', async (payload: { requestId: string } & Record<string, unknown>) => {
      if (!authenticated) return;
      await worktreeService.handleStatusResult(payload.requestId, payload);
    });

    onEvent(socket, 'git:commit:result', async (payload: { requestId: string } & Record<string, unknown>) => {
      if (!authenticated) return;
      await worktreeService.handleCommitResult(payload.requestId, payload);
    });

    onEvent(socket, 'git:worktree:list:result', async (payload: { requestId: string } & Record<string, unknown>) => {
      if (!authenticated) return;
      await worktreeService.handleListResult(payload.requestId, payload);
    });

    onEvent(socket, 'fs:remove-dir:result', async (payload: { requestId: string } & Record<string, unknown>) => {
      if (!authenticated) return;
      await worktreeService.handleRemoveDirResult(payload.requestId, payload);
    });

    onEvent(socket, 'error', (err) => {
      logger.error({ event: 'socket_error', socketId: socket.id, keyId: socket.data.keyId, err }, 'error on connection');
    })

    onEvent(socket, 'connect_error', (err) => {
      logger.error({ event: 'connect_error', socketId: socket.id, err }, 'connection error');
    });

    // Port Forward events (event names kept unchanged for backward compatibility)
    onEvent(socket, 'port-forward:created', async (payload: { tunnelId: string; success: boolean; error?: string }) => {
      if (!authenticated) return;
      gatewayRelayService.handleTunnelCreated(payload.tunnelId, payload.success, payload.error);
    });

    // F11 豁免：按分片数据通道（base64 TCP 分片）不开逐条 span（维持现状）
    socket.on('port-forward:data', async (payload: { tunnelId: string; data: string }) => {
      if (!authenticated) return;
      const buffer = Buffer.from(payload.data, 'base64');
      await gatewayRelayService.handleTunnelData(payload.tunnelId, buffer);
    });

    onEvent(socket, 'port-forward:close', async (payload: { tunnelId: string }) => {
      if (!authenticated) return;
      gatewayRelayService.handleTunnelClose(payload.tunnelId);
    });

    onEvent(socket, 'port-forward:error', async (payload: { tunnelId: string; error: string }) => {
      if (!authenticated) return;
      gatewayRelayService.handleTunnelError(payload.tunnelId, payload.error);
    });

    onEvent(socket, 'mcp:request', async (payload: {
      requestId: string;
      sessionId: string;
      serverName: string;
      token: string;
      body: unknown;
    }) => {
      if (!authenticated || !socket.data.controllerId) return;
      if (!payload || !payload.requestId || !payload.sessionId || !payload.serverName) {
        logger.warn({ event: 'mcp:request', detail: 'invalid payload' }, 'invalid mcp:request payload');
        socket.emit('mcp:response', withTraceMeta({ requestId: payload?.requestId ?? 'unknown', status: 400, body: { error: 'Invalid payload' } }));
        return;
      }
      // await 转发：`mcp:relay:request` 发布发生在 socket.mcp:request span 内，`_meta.traceparent` 可续链
      try {
        await mcpRelayService.handleMcpRequest(socket, payload);
      } catch (err) {
        logger.error({ event: 'mcp:request', err, requestId: payload.requestId }, 'mcp:request handler error');
        socket.emit('mcp:response', withTraceMeta({ requestId: payload.requestId, status: 500, body: { error: 'Internal server error' } }));
      }
    });

    socket.on('disconnect', async (reason: string, description?: unknown) => {
      await runWithLogContext({ userId: socket.data.userId, controllerId: socket.data.controllerId }, async () => {
      await withSpan('socket.disconnect', { socketId: socket.id, reason }, async () => {
      logger.info(disconnectFields(socket, reason, description), 'socket disconnected');

      try {
        mcpRelayService.handleSocketDisconnect(socket.id);
        acpSessionSyncService.cleanupSocket(socket);
        // 失联 controller 的 pending 问询无法再收到响应：清 timer，避免 60s 后误发 timeout
        elicitationManager.clearForSocket(socket.id);
        // 登录中的请求随 socket 断开收敛：发布 resolved(failed) + 清注册表
        harnessLoginManager.clearForSocket(socket.id);
        if (socket.data.keyId) {
          // 仅当会话仍归本 socket 所有时才置 offline；被接管的旧连接断开不得影响新连接。
          const released = await sessionService.releaseSession(socket.data.keyId, socket.id);
          if (released) {
            await Controller.updateOne(
              { keyId: socket.data.keyId, status: { $ne: 'unbound' } },
              { status: 'offline' },
            );
          }
        }
        await acpSessionManager.handleSocketDisconnect(socket.id);
      } catch (err) {
        logger.error({ event: 'disconnect', err }, 'disconnect error');
      }
      }, { parent: handshakeTraceparent });
      });
    });
  });
}
