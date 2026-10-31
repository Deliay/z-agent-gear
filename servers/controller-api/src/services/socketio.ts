import { Server as SocketIOServer, type Socket } from 'socket.io';
import bcrypt from 'bcryptjs';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { publish } from '../middleware/publish.js';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';
import { runWithLogContext } from '../observability/log-context.js';
import { injectTraceparent, withSpan } from '../observability/trace.js';
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

/** 服务端下发报文统一注入顶层 `_meta.traceparent`（契约 agent-session-websocket.md §7）：不破坏既有 payload 字段。 */
function withMeta<T>(payload: T): T {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const meta = injectTraceparent({});
  // 无活跃 span 时不注入空 `_meta`（保持既有报文形态，`_meta` 为可选保留位）。
  if (Object.keys(meta).length === 0) return payload;
  const record = payload as Record<string, unknown>;
  const existing = record._meta;
  const existingMeta =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return { ...record, _meta: { ...existingMeta, ...meta } } as T;
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
  // 引擎级错误监听只注册一次；放在 connection 回调内会随每条连接叠加监听器并重复刷日志。
  const transportErrorHandler = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ event: 'transport_error', detail: msg }, 'transport error');
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

    socket.on('register', async (payload: RegisterPayload) => {
      await runWithLogContext({ userId: socket.data.userId, controllerId: socket.data.controllerId }, async () => {
      await withSpan('socket.register', { socketId: socket.id, 'messaging.system': 'socketio' }, async () => {
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
          socket.emit('error', withMeta({ code: 'INVALID_KEY', message: 'Key not found' }));
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
          socket.emit('error', withMeta({ code: 'INVALID_KEY', message: 'Invalid key' }));
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
          socket.emit('error', withMeta({ code: 'VERSION_MISMATCH', message: 'Version mismatch' }));
          socket.disconnect(true);
          return;
        }

        const acquired = await sessionService.acquireSession(keyId, socket.id, payload.resumeToken);
        if (!acquired) {
          logger.warn(
            {
              event: 'register_rejected',
              socketId: socket.id,
              address: socket.handshake.address ?? null,
              hostname: hostname ?? null,
              keyId,
              reason: 'KEY_ALREADY_ONLINE',
            },
            'register rejected',
          );
          socket.emit('error', withMeta({ code: 'KEY_ALREADY_ONLINE', message: 'Key already has an active session' }));
          socket.disconnect(true);
          return;
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
        socket.emit('registered', withMeta({ controllerId: controller._id.toString(), resumeToken }));

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
        socket.emit('error', withMeta({ code: 'INVALID_KEY', message: 'Registration failed' }));
        socket.disconnect(true);
      }
      }, { parent: handshakeTraceparent });
      });
    });

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

    socket.on('unregister', async (payload: { reason: string }) => {
      if (!authenticated || !socket.data.keyId) return;

      try {
        const { keyId } = socket.data;

        await Controller.deleteOne({ keyId });
        await ControllerKey.deleteOne({ _id: keyId });
        await sessionService.cleanupKey(keyId);

        socket.emit('unregistered');
        socket.disconnect(true);
      } catch (err) {
        logger.error({ err }, 'unregister error');
      }
    });

    // ACP events
    socket.on('acp:permission', async (data: {
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
        socket.emit('acp:permission:response', withMeta({
          requestId: data.requestId,
          outcome: { outcome: 'cancelled' },
        }));
      }
    });

    socket.on('acp:elicitation', async (data: {
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
        socket.emit('acp:elicitation:response', withMeta({
          requestId: data.requestId,
          action: 'cancel',
        }));
      }
    });

    socket.on('acp:elicitation:complete', async (data: {
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

    socket.on('acp:elicitation:resolved', async (data: {
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

    socket.on('harness:login:required', async (data: {
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

    socket.on('harness:login:succeeded', async (data: { requestId: string; account?: string }) => {
      if (!authenticated) return;
      try {
        await harnessLoginManager.handleLoginSucceeded(socket, data);
      } catch (error) {
        logger.error({ event: 'harness:login:succeeded', err: error, requestId: data.requestId }, 'error handling harness login succeeded');
      }
    });

    socket.on('harness:login:failed', async (data: { requestId: string; reason: 'cancelled' | 'timeout' | 'error'; error?: string }) => {
      if (!authenticated) return;
      try {
        await harnessLoginManager.handleLoginFailed(socket, data);
      } catch (error) {
        logger.error({ event: 'harness:login:failed', err: error, requestId: data.requestId }, 'error handling harness login failed');
      }
    });

    socket.on('acp:check:result', async (payload: { requestId: string; servers: Array<{ type: string; available: boolean; version?: string }> }) => {
      if (!authenticated) return;
      acpCapabilityDetector.handleCheckResult(payload.requestId, payload.servers);
    });

    socket.on('acp:probe-options:result', async (payload: {
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

    socket.on('acp:start:result', async (payload: {
      requestId: string;
      sessionId: string;
      success: boolean;
      error?: string;
      externalSessionId?: string;
    }) => {
      if (!authenticated) return;
      // This is handled by the acpSessionManager through promise resolution
    });

    socket.on('acp:resume:result', async (payload: {
      requestId: string;
      sessionId: string;
      success: boolean;
      error?: string;
    }) => {
      if (!authenticated) return;
      // This is handled by the acpSessionManager through promise resolution
    });

    socket.on('acp:message', async (payload: { sessionId: string; message: Record<string, unknown> }) => {
      if (!authenticated) return;
      try {
        await acpSessionManager.handleControllerMessage(payload.sessionId, payload.message as SessionUpdate);
      } catch (err) {
        logger.error({ event: 'acp:message', err, sessionId: payload.sessionId }, 'ACP message error');
      }
    });

    socket.on('acp:config-options', async (payload: {
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

    socket.on('acp:initial-config:result', async (payload: {
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

    socket.on('acp:protocol-version-mismatch', async (payload: {
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

    socket.on('acp:stopped', async (payload: { sessionId: string; reason: string; exitCode?: number }) => {
      if (!authenticated) return;
      try {
        await acpSessionManager.handleControllerStopped(payload.sessionId, payload.reason, payload.exitCode);
      } catch (err) {
        logger.error({ event: 'acp:stopped', err, sessionId: payload.sessionId }, 'ACP stopped error');
      }
    });

    socket.on('acp:prompt:start', async (payload: { sessionId: string }) => {
      if (!authenticated) return;
      try {
        await acpSessionManager.handlePromptStart(payload.sessionId);
      } catch (err) {
        logger.error({ event: 'acp:prompt:start', err, sessionId: payload.sessionId }, 'ACP prompt start error');
      }
    });

    socket.on('acp:prompt:complete', async (payload: {
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

    socket.on('acp:list-sessions:result', async (payload: {
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

    socket.on('acp:delete-history-session:result', async (payload: {
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

    socket.on('acp:load-session:result', async (payload: {
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

    socket.on('acp:load-session:complete', async (payload: { requestId: string }) => {
      if (!authenticated) return;
      acpSessionSyncService.finalizeAndCacheLoadResult(payload.requestId);
    });

    // File system events
    socket.on('fs:browse:result', async (payload: { requestId: string; entries: Array<{ name: string; path: string; isDirectory: boolean }> }) => {
      if (!authenticated) return;
      await folderBrowserService.handleBrowseResult(payload.requestId, payload.entries);
    });

    socket.on('fs:home:result', async (payload: { requestId: string; path: string }) => {
      if (!authenticated) return;
      await folderBrowserService.handleHomeResult(payload.requestId, payload.path);
    });

    socket.on('git:check:result', async (payload) => {
      if (!authenticated) return;
      await gitBrowserService.handleCheckResult(payload.requestId, payload);
    });

    socket.on('git:init:result', async (payload) => {
      if (!authenticated) return;
      await gitBrowserService.handleInitResult(payload.requestId, payload);
    });

    // Worktree / Git extension result events
    socket.on('fs:mkdir:result', async (payload: { requestId: string } & Record<string, unknown>) => {
      if (!authenticated) return;
      await fsMkdirService.handleMkdirResult(payload.requestId, payload);
    });

    socket.on('git:worktree:add:result', async (payload: { requestId: string } & Record<string, unknown>) => {
      if (!authenticated) return;
      await worktreeService.handleAddResult(payload.requestId, payload);
    });

    socket.on('git:worktree:remove:result', async (payload: { requestId: string } & Record<string, unknown>) => {
      if (!authenticated) return;
      await worktreeService.handleRemoveResult(payload.requestId, payload);
    });

    socket.on('git:status:result', async (payload: { requestId: string } & Record<string, unknown>) => {
      if (!authenticated) return;
      await worktreeService.handleStatusResult(payload.requestId, payload);
    });

    socket.on('git:commit:result', async (payload: { requestId: string } & Record<string, unknown>) => {
      if (!authenticated) return;
      await worktreeService.handleCommitResult(payload.requestId, payload);
    });

    socket.on('git:worktree:list:result', async (payload: { requestId: string } & Record<string, unknown>) => {
      if (!authenticated) return;
      await worktreeService.handleListResult(payload.requestId, payload);
    });

    socket.on('fs:remove-dir:result', async (payload: { requestId: string } & Record<string, unknown>) => {
      if (!authenticated) return;
      await worktreeService.handleRemoveDirResult(payload.requestId, payload);
    });

    socket.on('error', (err) => {
      logger.error({ event: 'socket_error', socketId: socket.id, keyId: socket.data.keyId, err }, 'error on connection');
    })

    socket.on('connect_error', (err) => {
      logger.error({ event: 'connect_error', socketId: socket.id, err }, 'connection error');
    });

    // Port Forward events (event names kept unchanged for backward compatibility)
    socket.on('port-forward:created', async (payload: { tunnelId: string; success: boolean; error?: string }) => {
      if (!authenticated) return;
      gatewayRelayService.handleTunnelCreated(payload.tunnelId, payload.success, payload.error);
    });

    socket.on('port-forward:data', async (payload: { tunnelId: string; data: string }) => {
      if (!authenticated) return;
      const buffer = Buffer.from(payload.data, 'base64');
      await gatewayRelayService.handleTunnelData(payload.tunnelId, buffer);
    });

    socket.on('port-forward:close', async (payload: { tunnelId: string }) => {
      if (!authenticated) return;
      gatewayRelayService.handleTunnelClose(payload.tunnelId);
    });

    socket.on('port-forward:error', async (payload: { tunnelId: string; error: string }) => {
      if (!authenticated) return;
      gatewayRelayService.handleTunnelError(payload.tunnelId, payload.error);
    });

    socket.on('mcp:request', (payload: {
      requestId: string;
      sessionId: string;
      serverName: string;
      token: string;
      body: unknown;
    }) => {
      if (!authenticated || !socket.data.controllerId) return;
      if (!payload || !payload.requestId || !payload.sessionId || !payload.serverName) {
        logger.warn({ event: 'mcp:request', detail: 'invalid payload' }, 'invalid mcp:request payload');
        socket.emit('mcp:response', withMeta({ requestId: payload?.requestId ?? 'unknown', status: 400, body: { error: 'Invalid payload' } }));
        return;
      }
      mcpRelayService.handleMcpRequest(socket, payload).catch((err) => {
        logger.error({ event: 'mcp:request', err, requestId: payload.requestId }, 'mcp:request handler error');
        socket.emit('mcp:response', withMeta({ requestId: payload.requestId, status: 500, body: { error: 'Internal server error' } }));
      });
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
          await Controller.updateOne(
            { keyId: socket.data.keyId, status: { $ne: 'unbound' } },
            { status: 'offline' },
          );
          await sessionService.removeSession(socket.data.keyId);
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
