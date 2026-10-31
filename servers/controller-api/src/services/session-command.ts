import { getRedisClient } from '../middleware/redis.js';
import { publish } from '../middleware/publish.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';
import { runWithLogContext } from '../observability/log-context.js';
import { extractTraceparent, withSpan } from '../observability/trace.js';
import { acpSessionManager } from './acp-session-manager.js';
import { acpCapabilityDetector } from './acp-capability-detector.js';
import { acpOptionsProber } from './acp-options-prober.js';
import { acpSessionSyncService } from './acp-session-sync.js';
import { folderBrowserService } from './folder-browser.js';
import { gitBrowserService } from './git-browser.js';
import { worktreeService } from './worktree-service.js';
import { fsMkdirService } from './fs-mkdir-service.js';

const SESSION_COMMAND_CHANNEL = 'session:command';
const SESSION_MESSAGE_CHANNEL = 'session:message';

interface SessionCommandPayload {
  type: string;
  requestId?: string;
  sessionId?: string;
  controllerId?: string;
  serverType?: string;
  cwd?: string;
  path?: string;
  reason?: string;
  externalSessionId?: string;
  acpSessionId?: string;
  modeId?: string;
  modelId?: string;
  configId?: string;
  value?: string | boolean;
  parentPath?: string;
  folderName?: string;
  repoPath?: string;
  worktreePath?: string;
  branch?: string;
  message?: string;
  force?: boolean;
  mcpEndpoint?: { token: string; serverNames: string[] };
  /** Worktree 级提交人（可选；缺省不下发，worker 沿用容器级 bot）。仅此白名单字段，不开放任意 git 命令。 */
  committer?: { name: string; email: string };
  _meta?: { traceparent?: string };
}

export class SessionCommandService {
  private io: SocketIOServer | null = null;
  private readonly logger: ObservationLogger;
  // 同一 session 的生命周期命令（acp:start/acp:resume/acp:stop）按到达顺序串行处理。
  // Redis 订阅回调不等待 async handler，stop 与在途 start 并发处理时，
  // acpSessionManager 的 sessions Map 尚未写入，stop 会被误判为离线而吞掉（进程泄漏）。
  private sessionLifecycleChains = new Map<string, Promise<void>>();

  constructor(logger: ObservationLogger = rootLogger.child({ component: 'session-command' })) {
    this.logger = logger;
  }

  start(io: SocketIOServer): void {
    this.io = io;
    this.subscribe();
  }

  private enqueueSessionLifecycle(sessionId: string, task: () => Promise<void>): Promise<void> {
    const prev = this.sessionLifecycleChains.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    this.sessionLifecycleChains.set(sessionId, next);
    // 链尾清理：map 中仍是本次任务时才删除，避免误删后续排队任务
    void next.finally(() => {
      if (this.sessionLifecycleChains.get(sessionId) === next) {
        this.sessionLifecycleChains.delete(sessionId);
      }
    });
    return next;
  }

  private subscribe(): void {
    const redis = getRedisClient();
    const subscriber = redis.duplicate();

    subscriber.subscribe(SESSION_COMMAND_CHANNEL, (err) => {
      if (err) {
        this.logger.error({ err, channel: SESSION_COMMAND_CHANNEL }, 'failed to subscribe to channel');
        return;
      }
    });

    subscriber.subscribe(SESSION_MESSAGE_CHANNEL, (err) => {
      if (err) {
        this.logger.error({ err, channel: SESSION_MESSAGE_CHANNEL }, 'failed to subscribe to channel');
        return;
      }
    });

    subscriber.on('message', async (channel: string, message: string) => {
      try {
        if (channel === SESSION_COMMAND_CHANNEL) {
          const command = JSON.parse(message) as SessionCommandPayload;
          // 消费入口一个 messaging span（每批/每命令一条，不逐条开 span）；
          // 无 `_meta` / 非法 traceparent 时 parent 为 undefined（容错）。
          const parent = extractTraceparent(command._meta);
          await withSpan(
            'messaging.process',
            {
              'messaging.system': 'redis',
              'messaging.destination.name': channel,
              'messaging.batch.message_count': 1,
              sessionId: command.sessionId,
              controllerId: command.controllerId,
            },
            async () => {
              await runWithLogContext(
                { sessionId: command.sessionId, controllerId: command.controllerId },
                () => this.dispatchCommand(command),
              );
            },
            { parent },
          );
        } else if (channel === SESSION_MESSAGE_CHANNEL) {
          const data = JSON.parse(message) as {
            sessionId: string;
            message: { id: string; direction: string; type: string; content: string };
          };

          if (data.message.direction === 'input') {
            await this.handleInputMessage(data.sessionId, data.message);
          }
        }
      } catch (err) {
        this.logger.error({ err, channel }, 'failed to process session event');
      }
    });
  }

  private async dispatchCommand(command: SessionCommandPayload): Promise<void> {
    if (command.type === 'acp:start' && command.sessionId && command.controllerId && command.serverType) {
      await this.enqueueSessionLifecycle(command.sessionId, () => this.handleAcpStart(command as { sessionId: string; controllerId: string; serverType: string; cwd?: string; mcpEndpoint?: { token: string; serverNames: string[] }; modeId?: string; modelId?: string }));
    } else if (command.type === 'acp:resume' && command.sessionId && command.controllerId && command.externalSessionId) {
      await this.enqueueSessionLifecycle(command.sessionId, () => this.handleAcpResume(command as { sessionId: string; controllerId: string; externalSessionId: string; cwd?: string; mcpEndpoint?: { token: string; serverNames: string[] }; modeId?: string; modelId?: string }));
    } else if (command.type === 'acp:cancel' && command.sessionId) {
      await this.handleAcpCancel(command.sessionId);
    } else if (command.type === 'acp:check' && command.requestId && command.controllerId) {
      await this.handleAcpCheck(command.requestId, command.controllerId);
    } else if (command.type === 'acp:probe-options' && command.requestId && command.controllerId && command.serverType) {
      await this.handleAcpProbeOptions(command.requestId, command.controllerId, command.serverType);
    } else if (command.type === 'acp:stop' && command.sessionId) {
      await this.enqueueSessionLifecycle(command.sessionId, () => this.handleAcpStop(command.sessionId as string, command.reason || 'user_request'));
    } else if (command.type === 'fs:browse' && command.requestId && command.controllerId) {
      await this.handleFsBrowse(command.requestId, command.controllerId, command.path);
    } else if (command.type === 'fs:home' && command.requestId && command.controllerId) {
      await this.handleFsHome(command.requestId, command.controllerId);
    } else if (command.type === 'acp:set-mode' && command.sessionId && command.modeId) {
      await this.handleAcpSetMode(command.sessionId, command.modeId as string);
    } else if (command.type === 'acp:set-model' && command.sessionId && command.modelId) {
      await this.handleAcpSetModel(command.sessionId, command.modelId as string);
    } else if (command.type === 'acp:set-config-option' && command.sessionId && command.configId && command.value !== undefined) {
      await this.handleAcpSetConfigOption(command.sessionId, command.configId as string, command.value);
    } else if (command.type === 'git:check' && command.requestId && command.controllerId && command.path) {
      await this.handleGitCheck(command.requestId, command.controllerId, command.path);
    } else if (command.type === 'git:init' && command.requestId && command.controllerId && command.path) {
      await this.handleGitInit(command.requestId, command.controllerId, command.path);
    } else if (command.type === 'acp:cache:invalidate' && command.controllerId) {
      acpCapabilityDetector.invalidateCache(command.controllerId);
    } else if (command.type === 'acp:capability:query' && command.requestId && command.controllerId) {
      await this.handleAcpCapabilityQuery(command.requestId, command.controllerId);
    } else if (command.type === 'acp:list-sessions' && command.requestId && command.controllerId && command.cwd) {
      await this.handleAcpListSessions(command.requestId, command.controllerId, command.cwd, command.serverType ?? 'opencode');
    } else if (command.type === 'acp:load-session' && command.requestId && command.controllerId && command.sessionId && command.cwd) {
      await this.handleAcpLoadSession(command.requestId, command.controllerId, command.sessionId, command.cwd, command.serverType ?? 'opencode');
    } else if (command.type === 'acp:delete-history-session' && command.requestId && command.controllerId && command.sessionId && command.externalSessionId && command.cwd) {
      await this.handleAcpDeleteHistorySession(command.requestId, command.controllerId, command.sessionId as string, command.externalSessionId as string, command.cwd as string, command.serverType ?? 'opencode');
    } else if (command.type === 'fs:mkdir' && command.requestId && command.controllerId && command.parentPath && command.folderName) {
      await fsMkdirService.handleMkdir(command.requestId, command.controllerId, command.parentPath as string, command.folderName as string);
    } else if (command.type === 'git:worktree:add' && command.requestId && command.controllerId && command.repoPath && command.worktreePath && command.branch) {
      await worktreeService.handleAdd(command.requestId, command.controllerId, command.repoPath as string, command.worktreePath as string, command.branch as string, command.committer);
    } else if (command.type === 'git:worktree:remove' && command.requestId && command.controllerId && command.repoPath && command.worktreePath) {
      const force = command.force === true;
      await worktreeService.handleRemove(command.requestId, command.controllerId, command.repoPath as string, command.worktreePath as string, force);
    } else if (command.type === 'git:worktree:list' && command.requestId && command.controllerId && command.cwd) {
      await worktreeService.handleList(command.requestId, command.controllerId, command.cwd as string);
    } else if (command.type === 'fs:remove-dir' && command.requestId && command.controllerId && command.path) {
      await worktreeService.handleRemoveDir(command.requestId, command.controllerId, command.path as string);
    } else if (command.type === 'git:status' && command.requestId && command.controllerId && command.path) {
      await worktreeService.handleStatus(command.requestId, command.controllerId, command.path as string);
    } else if (command.type === 'git:commit' && command.requestId && command.controllerId && command.path && command.message) {
      await worktreeService.handleCommit(command.requestId, command.controllerId, command.path as string, command.message as string);
    }
  }

  private async handleInputMessage(sessionId: string, message: { id: string; type: string; content: string }): Promise<void> {
    // Forward input message to the controller via WebSocket only (DB already saved by agent-api)
    acpSessionManager.forwardToController(sessionId, {
      type: message.type,
      content: message.content,
    });
  }

  private async handleAcpStart(command: {
    sessionId: string;
    controllerId: string;
    serverType: string;
    cwd?: string;
    mcpEndpoint?: { token: string; serverNames: string[] };
    modeId?: string;
    modelId?: string;
  }): Promise<void> {
    if (!this.io) return;

    // Find the controller's socket
    const controller = await Controller.findById(command.controllerId).lean();
    if (!controller) {
      this.logger.error({ controllerId: command.controllerId, op: 'acp:start' }, 'controller not found');
      return;
    }

    // Get the socket ID from session service
    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      this.logger.error({ controllerId: command.controllerId, op: 'acp:start' }, 'controller not online');
      return;
    }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      this.logger.error({ socketId, op: 'acp:start' }, 'socket not found');
      return;
    }

    // Get user ID from controller
    const userId = controller.userId.toString();

    // Start ACP session
    const result = await acpSessionManager.startSession(
      socket,
      command.sessionId,
      command.controllerId,
      userId,
      command.serverType,
      command.cwd || process.cwd(),
      command.mcpEndpoint,
      command.modeId || command.modelId ? { modeId: command.modeId, modelId: command.modelId } : undefined,
    );

    if (!result.success) {
      this.logger.error({ sessionId: command.sessionId, error: result.error, op: 'acp:start' }, 'ACP start failed');
    }
  }

  private async handleAcpCheck(requestId: string, controllerId: string): Promise<void> {
    if (!this.io) return;

    // Find the controller's socket
    const controller = await Controller.findById(controllerId).lean();
    if (!controller) {
      this.logger.error({ controllerId, requestId, op: 'acp:check' }, 'controller not found');
      return;
    }

    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      this.logger.error({ controllerId, requestId, op: 'acp:check' }, 'controller not online');
      return;
    }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      this.logger.error({ controllerId, requestId, op: 'acp:check' }, 'socket not found');
      return;
    }

    // Use the capability detector to send acp:check and wait for result
    const servers = await acpCapabilityDetector.detectCapabilities(socket, controllerId);
    this.logger.info({ controllerId, requestId, count: servers.length }, 'ACP capabilities detected');
  }

  private async handleAcpProbeOptions(requestId: string, controllerId: string, serverType: string): Promise<void> {
    if (!this.io) return;

    const controller = await Controller.findById(controllerId).lean();
    if (!controller) {
      this.logger.error({ controllerId, requestId, op: 'acp:probe-options' }, 'controller not found');
      return;
    }

    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      this.logger.error({ controllerId, requestId, op: 'acp:probe-options' }, 'controller offline');
      return;
    }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      this.logger.error({ socketId, requestId, op: 'acp:probe-options' }, 'socket not found');
      return;
    }

    const options = await acpOptionsProber.probeOptions(socket, controllerId, serverType);
    this.logger.info({ controllerId, serverType, requestId, modes: options.modes.length, models: options.models.length }, 'ACP options probed');
  }

  private async publishStatus(sessionId: string, status: string, error?: string): Promise<void> {
    const payload: Record<string, unknown> = { sessionId, status };
    if (error) payload.error = error;
    await publish('session:status', payload);
  }

  private async handleAcpResume(command: {
    sessionId: string;
    controllerId: string;
    externalSessionId: string;
    cwd?: string;
    mcpEndpoint?: { token: string; serverNames: string[] };
    modeId?: string;
    modelId?: string;
  }): Promise<void> {
    if (!this.io) return;

    const controller = await Controller.findById(command.controllerId).lean();
    if (!controller) {
      this.logger.error({ controllerId: command.controllerId, sessionId: command.sessionId, op: 'acp:resume' }, 'controller not found');
      await this.publishStatus(command.sessionId, 'ended', 'CONTROLLER_OFFLINE');
      return;
    }

    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      this.logger.error({ controllerId: command.controllerId, sessionId: command.sessionId, op: 'acp:resume' }, 'controller not online');
      await this.publishStatus(command.sessionId, 'ended', 'CONTROLLER_OFFLINE');
      return;
    }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      this.logger.error({ socketId, sessionId: command.sessionId, op: 'acp:resume' }, 'socket not found');
      await this.publishStatus(command.sessionId, 'ended', 'CONTROLLER_OFFLINE');
      return;
    }

    const userId = controller.userId.toString();
    const result = await acpSessionManager.resumeSession(
      socket,
      command.sessionId,
      command.externalSessionId,
      command.controllerId,
      userId,
      command.cwd || process.cwd(),
      command.mcpEndpoint,
      command.modeId || command.modelId ? { modeId: command.modeId, modelId: command.modelId } : undefined,
    );

    if (!result.success) {
      this.logger.error({ sessionId: command.sessionId, error: result.error, op: 'acp:resume' }, 'ACP resume failed');
    }
  }

  private async handleAcpCancel(sessionId: string): Promise<void> {
    this.logger.info({ sessionId }, 'cancelling generation');
    const result = await acpSessionManager.cancelGeneration(sessionId);
    if (!result) {
      this.logger.error({ sessionId, op: 'acp:cancel' }, 'ACP cancel failed: session not found in active sessions');
    }
  }

  private async handleAcpStop(sessionId: string, reason: string): Promise<void> {
    this.logger.info({ sessionId, reason }, 'stopping ACP session');
    await acpSessionManager.stopSession(sessionId, reason);
  }

  private async handleFsBrowse(requestId: string, controllerId: string, path?: string): Promise<void> {
    await folderBrowserService.browse(requestId, controllerId, path);
  }

  private async handleFsHome(requestId: string, controllerId: string): Promise<void> {
    await folderBrowserService.getHomeDirectory(requestId, controllerId);
  }

  private async handleAcpSetMode(sessionId: string, modeId: string): Promise<void> {
    this.logger.info({ sessionId, modeId }, 'setting mode');
    const result = await acpSessionManager.setMode(sessionId, modeId);
    if (!result) {
      this.logger.error({ sessionId, modeId, op: 'acp:set-mode' }, 'ACP set-mode failed');
    }
  }

  private async handleAcpSetModel(sessionId: string, modelId: string): Promise<void> {
    this.logger.info({ sessionId, modelId }, 'setting model');
    const result = await acpSessionManager.setModel(sessionId, modelId);
    if (!result) {
      this.logger.error({ sessionId, modelId, op: 'acp:set-model' }, 'ACP set-model failed');
    }
  }

  private async handleAcpSetConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<void> {
    this.logger.info({ sessionId, configId, value: String(value) }, 'setting config option');
    const result = await acpSessionManager.setConfigOption(sessionId, configId, value);
    if (!result) {
      this.logger.error({ sessionId, configId, op: 'acp:set-config-option' }, 'ACP set-config-option failed');
    }
  }

  private async handleGitCheck(requestId: string, controllerId: string, path: string): Promise<void> {
    await gitBrowserService.check(requestId, controllerId, path);
  }

  private async handleGitInit(requestId: string, controllerId: string, path: string): Promise<void> {
    await gitBrowserService.init(requestId, controllerId, path);
  }

  private async handleAcpCapabilityQuery(requestId: string, controllerId: string): Promise<void> {
    if (!this.io) return;

    const controller = await Controller.findById(controllerId).lean();
    if (!controller) {
      this.logger.error({ controllerId, requestId, op: 'acp:capability:query' }, 'controller not found');
      const redis = getRedisClient();
      await redis.set(`acp:capability:query:${requestId}`, JSON.stringify({ success: false, error: 'Controller not found' }), 'EX', 60);
      return;
    }

    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      this.logger.error({ controllerId, requestId, op: 'acp:capability:query' }, 'controller offline');
      const redis = getRedisClient();
      await redis.set(`acp:capability:query:${requestId}`, JSON.stringify({ success: false, error: 'Controller offline' }), 'EX', 60);
      return;
    }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      this.logger.error({ controllerId, requestId, op: 'acp:capability:query' }, 'socket not found');
      const redis = getRedisClient();
      await redis.set(`acp:capability:query:${requestId}`, JSON.stringify({ success: false, error: 'Socket not found' }), 'EX', 60);
      return;
    }

    // 主动探测能力并回写缓存
    const servers = await acpCapabilityDetector.detectCapabilities(socket, controllerId);
    const redis = getRedisClient();
    await redis.set(`acp:capability:query:${requestId}`, JSON.stringify({ success: true, servers }), 'EX', 60);
    this.logger.info({ controllerId, requestId, count: servers.length }, 'capability query completed');
  }

  private async handleAcpListSessions(requestId: string, controllerId: string, cwd: string, serverType: string = 'opencode'): Promise<void> {
    if (!this.io) return;

    const controller = await Controller.findById(controllerId).lean();
    if (!controller) {
      this.logger.error({ controllerId, requestId, op: 'acp:list-sessions' }, 'controller not found');
      return;
    }

    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      this.logger.error({ controllerId, requestId, op: 'acp:list-sessions' }, 'controller offline');
      return;
    }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      this.logger.error({ controllerId, requestId, op: 'acp:list-sessions' }, 'socket not found');
      return;
    }

    const result = await acpSessionSyncService.listSessions(socket, serverType, cwd);
    await acpSessionSyncService.cacheListResult(requestId, result);
  }

  private async handleAcpLoadSession(requestId: string, controllerId: string, sessionId: string, cwd: string, serverType: string = 'opencode'): Promise<void> {
    if (!this.io) return;

    const controller = await Controller.findById(controllerId).lean();
    if (!controller) {
      this.logger.error({ controllerId, requestId, sessionId, op: 'acp:load-session' }, 'controller not found');
      return;
    }

    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      this.logger.error({ controllerId, requestId, sessionId, op: 'acp:load-session' }, 'controller offline');
      return;
    }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      this.logger.error({ controllerId, requestId, sessionId, op: 'acp:load-session' }, 'socket not found');
      return;
    }

    const result = await acpSessionSyncService.loadSession(socket, serverType, sessionId, cwd);
    await acpSessionSyncService.cacheLoadResult(requestId, result);
  }

  private async handleAcpDeleteHistorySession(requestId: string, controllerId: string, sessionId: string, externalSessionId: string, cwd: string, serverType: string = 'opencode'): Promise<void> {
    if (!this.io) return;

    const controller = await Controller.findById(controllerId).lean();
    if (!controller) {
      this.logger.error({ controllerId, requestId, sessionId, op: 'acp:delete-history-session' }, 'controller not found');
      await acpSessionSyncService.cacheDeleteResult(requestId, { success: false, supported: false, error: 'Controller not found' });
      return;
    }

    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      this.logger.error({ controllerId, requestId, sessionId, op: 'acp:delete-history-session' }, 'controller offline');
      await acpSessionSyncService.cacheDeleteResult(requestId, { success: false, supported: false, error: 'Controller offline' });
      return;
    }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      this.logger.error({ controllerId, requestId, sessionId, op: 'acp:delete-history-session' }, 'socket not found');
      await acpSessionSyncService.cacheDeleteResult(requestId, { success: false, supported: false, error: 'Controller socket not found' });
      return;
    }

    const result = await acpSessionSyncService.deleteHistorySession(socket, serverType, sessionId, externalSessionId, cwd);
    await acpSessionSyncService.cacheDeleteResult(requestId, result);
  }
}

export const sessionCommandService = new SessionCommandService();
