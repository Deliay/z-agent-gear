import mongoose from 'mongoose';
import type { Socket } from 'socket.io';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { Session } from '../models/session.js';
import { AcpMessage } from '../models/acp-message.js';
import { getRedisClient } from '../middleware/redis.js';

const EXTERNAL_SESSION_CACHE_TTL = 86400; // 24h
const STOP_ACK_TIMEOUT_MS = 10_000;
const STOP_MAX_RETRIES = 1;

interface ACPSession {
  controllerSocket: Socket;
  sessionId: string;
  controllerId: string;
  userId: string;
}

interface PendingRequest {
  resolve: (value: { success: boolean; error?: string; externalSessionId?: string; modes?: Array<{ id: string; name: string; description?: string }>; currentModeId?: string; currentModel?: { id: string; name: string; provider?: string }; availableModels?: Array<{ id: string; name: string; provider?: string }>; currentModelId?: string; configOptions?: Array<Record<string, unknown>>; promptCapabilities?: { image: boolean; audio: boolean; embeddedContext: boolean }; agentInfo?: { name: string; version?: string }; authMethods?: Array<{ id: string; kind: string; description?: string; url?: string }>; supportsAdditionalDirectories?: boolean }) => void;
  timeout: ReturnType<typeof setTimeout>;
  sessionId: string;
  statusAtStart: string;
}

export class ACPSessionManager {
  private sessions = new Map<string, ACPSession>();
  private socketToSessions = new Map<string, Set<string>>();
  // Per-session promise chain：保证同一 session 的消息「落库 → 推送」严格按到达顺序串行执行。
  // Socket.IO 不等待 async 监听器完成，高频消息并发落库会导致 Redis publish 顺序 ≠ 到达顺序，
  // 进而造成 SSE 推送乱序（DB 按 _id 排序仍正确）。
  private messageQueues = new Map<string, Promise<void>>();
  // 会话尚未就绪（acp:start/acp:resume 进行中）时到达的输入消息队列。
  // agent-api 的 create/resume 与紧随的 addMessage 经不同 Redis channel 并发处理，
  // 消息可能在 acp:start:result/acp:resume:result 之前到达，必须先排队、会话注册后按序补发，
  // 否则首条 prompt 会被静默丢弃（harness 进程已拉起但永远收不到 session/prompt）。
  private pendingInputs = new Map<string, Array<{ type: string; content: string | Record<string, unknown> }>>();
  // Dispatcher: per-socket Map<requestId, PendingRequest> for start/resume results.
  // Replaces per-call socket.once() to fix concurrent session start race condition.
  private socketDispatchers = new Map<string, Map<string, PendingRequest>>();

  async startSession(
    controllerSocket: Socket,
    sessionId: string,
    controllerId: string,
    userId: string,
    serverType: string,
    cwd: string,
    mcpEndpoint?: { url: string; token: string; serverNames: string[] },
    initial?: { modeId?: string; modelId?: string },
  ): Promise<{ success: boolean; error?: string; externalSessionId?: string }> {
    let statusAtStart = 'creating';
    try {
      const session = await Session.findById(sessionId).lean();
      statusAtStart = session?.status ?? 'creating';

      // Update session status to connecting
      await Session.findByIdAndUpdate(sessionId, { status: 'connecting' });
      await this.publishStatus(sessionId, 'connecting');

      // Send acp:start to controller
      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      
      console.log(`[ACP session] Starting session ${sessionId}: requestId=${requestId} controllerId=${controllerId} serverType=${serverType} cwd=${cwd}`);
      
      const startPayload: Record<string, unknown> = {
        requestId,
        sessionId,
        serverType,
        cwd,
      };
      if (mcpEndpoint) {
        startPayload.mcpEndpoint = mcpEndpoint;
      }
      if (initial?.modeId) {
        startPayload.modeId = initial.modeId;
      }
      if (initial?.modelId) {
        startPayload.modelId = initial.modelId;
      }
      controllerSocket.emit('acp:start', startPayload);

      // Use dispatcher to wait for result (supports concurrent starts on same socket)
      const payload = await this.registerPendingRequest(controllerSocket, requestId, sessionId, statusAtStart, 30000);
      
      console.log(`[ACP session] Received acp:start:result for session ${sessionId}: requestId=${requestId} success=${payload.success} error=${payload.error}`);
      
      if (payload.success) {
        // Store session mapping
        this.sessions.set(sessionId, {
          controllerSocket,
          sessionId,
          controllerId,
          userId,
        });
        this.flushPendingInputs(sessionId);

        // Track socket to sessions mapping
        const socketSessions = this.socketToSessions.get(controllerSocket.id) || new Set();
        socketSessions.add(sessionId);
        this.socketToSessions.set(controllerSocket.id, socketSessions);

        // Update session status to idling
        const updateData: Record<string, unknown> = {
          status: 'idling',
          externalSessionId: payload.externalSessionId,
        };
        updateData.modes = payload.modes ?? [];
        if (payload.currentModeId) updateData.currentModeId = payload.currentModeId;
        if (payload.currentModel) updateData.currentModel = payload.currentModel;
        updateData.availableModels = payload.availableModels ?? [];
        if (payload.currentModelId) updateData.currentModelId = payload.currentModelId;
        if (payload.configOptions) updateData.configOptions = payload.configOptions;
        if (payload.promptCapabilities) updateData.promptCapabilities = payload.promptCapabilities;
        if (payload.agentInfo) updateData.agentInfo = payload.agentInfo;
        if (payload.authMethods) updateData.authMethods = payload.authMethods;
        if (payload.supportsAdditionalDirectories != null) {
          updateData.supportsAdditionalDirectories = payload.supportsAdditionalDirectories;
        }
        updateData.authRequired = Boolean(payload.authMethods?.length);
        await Session.findByIdAndUpdate(sessionId, updateData);
        await this.cacheModes(sessionId, payload.modes, payload.currentModeId, payload.currentModel, payload.availableModels, payload.currentModelId);
        await this.cacheConfigOptions(sessionId, payload.configOptions);
        await this.cacheCapabilities(sessionId, {
          promptCapabilities: payload.promptCapabilities,
          agentInfo: payload.agentInfo,
          authMethods: payload.authMethods,
          supportsAdditionalDirectories: payload.supportsAdditionalDirectories,
          authRequired: payload.authMethods?.length ? true : undefined,
        });
        const statusExtra: Record<string, unknown> = {};
        if (payload.modes?.length) statusExtra.modes = payload.modes;
        if (payload.currentModeId) statusExtra.currentModeId = payload.currentModeId;
        if (payload.currentModel) statusExtra.currentModel = payload.currentModel;
        if (payload.availableModels?.length) statusExtra.availableModels = payload.availableModels;
        if (payload.currentModelId) statusExtra.currentModelId = payload.currentModelId;
        if (payload.configOptions?.length) statusExtra.configOptions = payload.configOptions;
        await this.publishStatus(sessionId, 'idling', undefined, statusExtra);

        // Cache externalSessionId in Redis for resume
        if (payload.externalSessionId) {
          const redis = getRedisClient();
          await redis.set(
            `session:${sessionId}:acpSessionId`,
            payload.externalSessionId,
            'EX',
            EXTERNAL_SESSION_CACHE_TTL,
          );
        }

        console.log(`[ACP session] Session ${sessionId} is now idling`);
        return { success: true, externalSessionId: payload.externalSessionId };
      } else {
        // Controller explicitly reported failure — keep session with 'ended' status
        await Session.findByIdAndUpdate(sessionId, { status: 'ended', endedAt: new Date() });
        await this.publishStatus(sessionId, 'ended');
        console.log(`[ACP session] Session ${sessionId} ended by controller: ${payload.error}`);
        return { success: false, error: payload.error };
      }
    } catch (error) {
      console.error(`[ACP session] Error starting session ${sessionId}:`, error);
      await this.cleanupFailedSession(sessionId, statusAtStart);
      return { success: false, error: (error as Error).message };
    }
  }

  private async cleanupFailedSession(sessionId: string, previousStatus: string): Promise<void> {
    this.pendingInputs.delete(sessionId);
    // Only delete sessions that never successfully connected
    if (previousStatus === 'creating' || previousStatus === 'connecting') {
      console.log(`[ACP] Removing failed session ${sessionId} (was ${previousStatus})`);
      await AcpMessage.deleteMany({ sessionId });
      await Session.findByIdAndDelete(sessionId);
      await this.publishStatus(sessionId, 'removed');
    } else {
      await Session.findByIdAndUpdate(sessionId, { status: 'ended', endedAt: new Date() });
      await this.publishStatus(sessionId, 'ended');
    }
  }

  async sendMessage(sessionId: string, message: { type: string; content: string }): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    const rawContent = {
      sessionUpdate: 'user_message_chunk' as const,
      content: { type: 'text' as const, text: message.content },
    };

    // Save input message to database
    const acpMessage = await AcpMessage.create({
      sessionId,
      direction: 'input' as const,
      type: 'text',
      content: rawContent,
    });

    const doc = acpMessage.toObject();
    // Publish message to Redis
    await this.publishMessage(sessionId, {
      id: (doc._id as mongoose.Types.ObjectId).toString(),
      direction: 'input',
      type: 'text',
      content: typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent),
      metadata: null,
      createdAt: (doc.createdAt as Date).toISOString(),
    });

    // Forward message to controller
    session.controllerSocket.emit('acp:message', {
      sessionId,
      message,
    });

    return true;
  }

  async handleControllerMessage(sessionId: string, message: SessionUpdate): Promise<void> {
    // 串行化同一 session 的消息处理，不同 session 之间互不阻塞
    const tail = (this.messageQueues.get(sessionId) ?? Promise.resolve()).then(() =>
      this.processControllerMessage(sessionId, message),
    );
    // 队列尾部始终吞掉错误，保证前一条失败不阻塞后续消息；错误仍通过返回值抛给调用方
    const safeTail = tail.catch(() => {});
    this.messageQueues.set(sessionId, safeTail);
    void safeTail.finally(() => {
      if (this.messageQueues.get(sessionId) === safeTail) {
        this.messageQueues.delete(sessionId);
      }
    });
    return tail;
  }

  private async processControllerMessage(sessionId: string, message: SessionUpdate): Promise<void> {
    // Handle config_option_update - full configOptions is the single source of truth
    if (message.sessionUpdate === 'config_option_update') {
      const update = message as Record<string, unknown>;
      const configOptions = update.configOptions as Array<Record<string, unknown>> | undefined;
      if (configOptions) {
        const updateData: Record<string, unknown> = { configOptions };
        const statusExtra: Record<string, unknown> = { configOptions };
        for (const opt of configOptions) {
          const value = (opt.currentValue ?? opt.value) as string | undefined;
          if (opt.category === 'mode' || opt.id === 'mode') {
            if (value) {
              updateData.currentModeId = value;
              statusExtra.currentModeId = value;
            }
          } else if (opt.category === 'model' || opt.id === 'model') {
            if (value) {
              updateData.currentModelId = value;
              statusExtra.currentModelId = value;
            }
          }
        }
        await Session.findByIdAndUpdate(sessionId, updateData);
        await this.cacheConfigOptions(sessionId, configOptions);
        const currentStatus = await this.getCurrentSessionStatus(sessionId);
        await this.publishStatus(sessionId, currentStatus, undefined, Object.keys(statusExtra).length ? statusExtra : undefined);
      }
    }

    // Handle current_mode_update
    if (message.sessionUpdate === 'current_mode_update') {
      const update = message as Record<string, unknown>;
      const modeId = update.modeId as string | undefined;
      if (modeId) {
        await Session.findByIdAndUpdate(sessionId, { currentModeId: modeId });
        await this.publishStatus(sessionId, 'idling', undefined, { currentModeId: modeId });
      }
    }

    const rawContent = message;
    const messageId = (message as Record<string, unknown>).messageId as string | undefined;

    let type: string;
    switch (message.sessionUpdate) {
      case 'agent_message_chunk':
      case 'user_message_chunk':
      case 'agent_thought_chunk':
        type = 'text';
        break;
      case 'tool_call':
        type = 'tool_call';
        break;
      case 'tool_call_update':
        type = 'tool_call';
        break;
      case 'plan':
        type = 'plan';
        break;
      case 'config_option_update':
      case 'current_mode_update':
        type = 'text';
        break;
      default:
        type = 'text';
        break;
    }

    const acpMessage = await AcpMessage.create({
      sessionId,
      direction: 'output' as const,
      type: type as 'text' | 'image' | 'tool_call' | 'tool_result' | 'plan' | 'error',
      content: rawContent,
      ...(messageId ? { messageId } : {}),
    });

    const doc = acpMessage.toObject() as Record<string, unknown>;
    await this.publishMessage(sessionId, {
      id: (doc._id as mongoose.Types.ObjectId).toString(),
      direction: 'output',
      type,
      content: typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent),
      metadata: null,
      ...(messageId ? { messageId } : {}),
      createdAt: (doc.createdAt as Date).toISOString(),
    });
  }

  async stopSession(sessionId: string, reason: string): Promise<void> {
    return this.stopSessionWithAck(sessionId, reason);
  }

  async handlePromptStart(sessionId: string): Promise<void> {
    const result = await Session.findOneAndUpdate(
      { _id: sessionId, status: 'idling' },
      { status: 'running' },
    );
    if (result) {
      await this.publishStatus(sessionId, 'running');
    }
  }

  async handlePromptComplete(sessionId: string, stopReason: string): Promise<void> {
    const result = await Session.findOneAndUpdate(
      { _id: sessionId, status: 'running' },
      { status: 'idling' },
    );
    if (result) {
      await this.publishStatus(sessionId, 'idling');
    }
  }

  private async handleControllerDisconnect(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      this.pendingInputs.delete(sessionId);
      const socketSessions = this.socketToSessions.get(session.controllerSocket.id);
      if (socketSessions) {
        socketSessions.delete(sessionId);
        if (socketSessions.size === 0) {
          this.socketToSessions.delete(session.controllerSocket.id);
        }
      }
    }

    const result = await Session.findOneAndUpdate(
      { _id: sessionId, status: { $in: ['idling', 'running'] } },
      { status: 'disconnected', disconnectedAt: new Date() },
    );
    if (result) {
      await this.publishStatus(sessionId, 'disconnected');
      return;
    }

    await Session.findOneAndUpdate(
      { _id: sessionId, status: { $nin: ['ended', 'disconnected'] } },
      { status: 'ended', endedAt: new Date() },
    );
    await this.publishStatus(sessionId, 'ended');
  }

  async handleControllerStopped(sessionId: string, reason: string, exitCode?: number): Promise<void> {
    // Clean up session mapping
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      this.pendingInputs.delete(sessionId);
      const socketSessions = this.socketToSessions.get(session.controllerSocket.id);
      if (socketSessions) {
        socketSessions.delete(sessionId);
        if (socketSessions.size === 0) {
          this.socketToSessions.delete(session.controllerSocket.id);
        }
      }
    }

    // Update session status
    await Session.findByIdAndUpdate(sessionId, {
      status: 'ended',
      endedAt: new Date(),
    });
    await this.publishStatus(sessionId, 'ended');
  }

  async handleSocketDisconnect(socketId: string): Promise<void> {
    const socketSessions = this.socketToSessions.get(socketId);
    if (socketSessions) {
      for (const sessionId of socketSessions) {
        await this.handleControllerDisconnect(sessionId);
      }
      this.socketToSessions.delete(socketId);
    }
  }

  async cancelGeneration(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.controllerSocket.emit('acp:cancel', { sessionId });
    return true;
  }

  async resumeSession(
    controllerSocket: Socket,
    sessionId: string,
    externalSessionId: string,
    controllerId: string,
    userId: string,
    cwd: string,
    mcpEndpoint?: { url: string; token: string; serverNames: string[] },
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const sess = await Session.findById(sessionId).lean();
      const acpServerType = sess?.acpServerType ?? 'opencode';
      await Session.findByIdAndUpdate(sessionId, { status: 'connecting' });
      await this.publishStatus(sessionId, 'connecting');

      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      const resumePayload: Record<string, unknown> = {
        requestId,
        sessionId,
        externalSessionId,
        serverType: acpServerType,
        cwd,
      };
      if (mcpEndpoint) {
        resumePayload.mcpEndpoint = mcpEndpoint;
      }
      controllerSocket.emit('acp:resume', resumePayload);

      // Use dispatcher to wait for result (supports concurrent resumes on same socket)
      const payload = await this.registerPendingRequest(controllerSocket, requestId, sessionId, 'connecting', 30000, 'ACP resume timeout');

      if (payload.success) {
        this.sessions.set(sessionId, {
          controllerSocket,
          sessionId,
          controllerId,
          userId,
        });
        this.flushPendingInputs(sessionId);

        const socketSessions = this.socketToSessions.get(controllerSocket.id) || new Set();
        socketSessions.add(sessionId);
        this.socketToSessions.set(controllerSocket.id, socketSessions);

        const updateData: Record<string, unknown> = { status: 'idling' };
        updateData.modes = payload.modes ?? [];
        if (payload.currentModeId) updateData.currentModeId = payload.currentModeId;
        if (payload.currentModel) updateData.currentModel = payload.currentModel;
        updateData.availableModels = payload.availableModels ?? [];
        if (payload.currentModelId) updateData.currentModelId = payload.currentModelId;
        if (payload.configOptions) updateData.configOptions = payload.configOptions;
        if (payload.promptCapabilities) updateData.promptCapabilities = payload.promptCapabilities;
        if (payload.agentInfo) updateData.agentInfo = payload.agentInfo;
        if (payload.authMethods) updateData.authMethods = payload.authMethods;
        if (payload.supportsAdditionalDirectories != null) {
          updateData.supportsAdditionalDirectories = payload.supportsAdditionalDirectories;
        }
        updateData.authRequired = Boolean(payload.authMethods?.length);
        await Session.findByIdAndUpdate(sessionId, updateData);
        await this.refreshSessionCache(sessionId);
        await this.cacheConfigOptions(sessionId, payload.configOptions);
        const statusExtra: Record<string, unknown> = {};
        if (payload.modes?.length) statusExtra.modes = payload.modes;
        if (payload.currentModeId) statusExtra.currentModeId = payload.currentModeId;
        if (payload.currentModel) statusExtra.currentModel = payload.currentModel;
        if (payload.availableModels?.length) statusExtra.availableModels = payload.availableModels;
        if (payload.currentModelId) statusExtra.currentModelId = payload.currentModelId;
        if (payload.configOptions?.length) statusExtra.configOptions = payload.configOptions;
        await this.publishStatus(sessionId, 'idling', undefined, statusExtra);

        return { success: true };
      } else {
        await Session.findByIdAndUpdate(sessionId, { status: 'ended', endedAt: new Date() });
        await this.publishStatus(sessionId, 'ended', payload.error || 'ACP_RESUME_FAILED');
        return { success: false, error: payload.error || 'ACP resume failed' };
      }
    } catch (error) {
      console.error(`[ACP session] Error resuming session ${sessionId}:`, error);
      await Session.findByIdAndUpdate(sessionId, { status: 'ended', endedAt: new Date() });
      await this.publishStatus(sessionId, 'ended', 'ACP_RESUME_FAILED');
      return { success: false, error: (error as Error).message };
    }
  }

  async getExternalSessionId(sessionId: string): Promise<string | null> {
    // Check Redis cache first
    const redis = getRedisClient();
    const cached = await redis.get(`session:${sessionId}:acpSessionId`);
    if (cached) return cached;

    // Fallback to MongoDB
    const session = await Session.findById(sessionId).lean();
    if (session?.externalSessionId) {
      // Re-cache for future use
      await redis.set(
        `session:${sessionId}:acpSessionId`,
        session.externalSessionId,
        'EX',
        EXTERNAL_SESSION_CACHE_TTL,
      );
      return session.externalSessionId;
    }

    return null;
  }

  forwardToController(sessionId: string, message: { type: string; content: string | Record<string, unknown> }): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // 会话尚未进入 active map（start/resume 进行中）：入队等待补发，不再静默丢弃
      const queue = this.pendingInputs.get(sessionId) ?? [];
      if (queue.length >= 100) {
        console.warn(`[ACP session] Pending input queue for session ${sessionId} is full (100), dropping message`);
        return false;
      }
      queue.push(message);
      this.pendingInputs.set(sessionId, queue);
      console.log(`[ACP session] Session ${sessionId} not active yet, queued input message (queue size=${queue.length})`);
      return true;
    }

    const rawContent = typeof message.content === 'string'
      ? message.content
      : (message.content as Record<string, unknown>)?.content && typeof (message.content as Record<string, unknown>).content === 'object'
        ? ((message.content as Record<string, unknown>).content as Record<string, unknown>).text as string ?? ''
        : '';

    session.controllerSocket.emit('acp:message', {
      sessionId,
      message: { type: message.type, content: rawContent },
    });
    return true;
  }

  /** 会话注册成功后按到达顺序补发排队中的输入消息 */
  private flushPendingInputs(sessionId: string): void {
    const queue = this.pendingInputs.get(sessionId);
    if (!queue || queue.length === 0) return;
    this.pendingInputs.delete(sessionId);
    console.log(`[ACP session] Flushing ${queue.length} queued input message(s) for session ${sessionId}`);
    for (const message of queue) {
      this.forwardToController(sessionId, message);
    }
  }

  async setMode(sessionId: string, modeId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.controllerSocket.emit('acp:set-mode', { sessionId, modeId });

    // Optimistic update
    await Session.findByIdAndUpdate(sessionId, { currentModeId: modeId });
    await this.publishStatus(sessionId, 'idling', undefined, { currentModeId: modeId });

    return true;
  }

  async setModel(sessionId: string, modelId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.controllerSocket.emit('acp:set-model', { sessionId, modelId });

    // Optimistic update
    await Session.findByIdAndUpdate(sessionId, { currentModelId: modelId });
    await this.publishStatus(sessionId, 'idling', undefined, { currentModelId: modelId });

    return true;
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.controllerSocket.emit('acp:set-config-option', { sessionId, configId, value });
    return true;
  }

  async publishConfigOptions(sessionId: string, configOptions: Array<Record<string, unknown>>): Promise<void> {
    const updateData: Record<string, unknown> = { configOptions };
    const statusExtra: Record<string, unknown> = { configOptions };
    for (const opt of configOptions) {
      const value = (opt.currentValue ?? opt.value) as string | undefined;
      if (opt.category === 'mode' || opt.id === 'mode') {
        if (value) {
          updateData.currentModeId = value;
          statusExtra.currentModeId = value;
        }
      } else if (opt.category === 'model' || opt.id === 'model') {
        if (value) {
          updateData.currentModelId = value;
          statusExtra.currentModelId = value;
        }
      }
    }
    await Session.findByIdAndUpdate(sessionId, updateData);
    await this.cacheConfigOptions(sessionId, configOptions);
    const currentStatus = await this.getCurrentSessionStatus(sessionId);
    await this.publishStatus(sessionId, currentStatus, undefined, Object.keys(statusExtra).length ? statusExtra : undefined);
  }

  private async getCurrentSessionStatus(sessionId: string): Promise<string> {
    const session = await Session.findById(sessionId).lean();
    return (session?.status as string | undefined) ?? 'idling';
  }

  private async cacheConfigOptions(
    sessionId: string,
    configOptions?: Array<Record<string, unknown>>,
  ): Promise<void> {
    if (!configOptions) return;
    const redis = getRedisClient();
    await redis.set(`session:${sessionId}:configOptions`, JSON.stringify(configOptions), 'EX', 86400);
  }

  private async cacheCapabilities(
    sessionId: string,
    capabilities: {
      promptCapabilities?: { image: boolean; audio: boolean; embeddedContext: boolean };
      agentInfo?: { name: string; version?: string };
      authMethods?: Array<{ id: string; kind: string; description?: string; url?: string }>;
      supportsAdditionalDirectories?: boolean;
      authRequired?: boolean;
    },
  ): Promise<void> {
    const redis = getRedisClient();
    const session = await Session.findById(sessionId).lean();
    if (!session) return;
    if (capabilities.promptCapabilities) {
      await redis.set(`session:${sessionId}:promptCapabilities`, JSON.stringify(capabilities.promptCapabilities), 'EX', 86400);
    }
    if (capabilities.agentInfo) {
      await redis.set(`session:${sessionId}:agentInfo`, JSON.stringify(capabilities.agentInfo), 'EX', 86400);
    }
    if (capabilities.authMethods) {
      await redis.set(`session:${sessionId}:authMethods`, JSON.stringify(capabilities.authMethods), 'EX', 86400);
    }
    if (capabilities.authRequired != null) {
      await redis.set(`session:${sessionId}:authRequired`, String(capabilities.authRequired), 'EX', 86400);
    }
    if (capabilities.supportsAdditionalDirectories != null) {
      await redis.set(`session:${sessionId}:supportsAdditionalDirectories`, String(capabilities.supportsAdditionalDirectories), 'EX', 86400);
    }
  }

  private async refreshSessionCache(sessionId: string): Promise<void> {
    const redis = getRedisClient();
    const session = await Session.findById(sessionId).lean();
    if (!session) return;
    if (session.modes) {
      await redis.set(`session:${sessionId}:modes`, JSON.stringify(session.modes), 'EX', 86400);
    }
    if (session.currentModeId) {
      await redis.set(`session:${sessionId}:currentModeId`, session.currentModeId, 'EX', 86400);
    }
    if (session.currentModel) {
      await redis.set(`session:${sessionId}:currentModel`, JSON.stringify(session.currentModel), 'EX', 86400);
    }
    if (session.availableModels) {
      await redis.set(`session:${sessionId}:availableModels`, JSON.stringify(session.availableModels), 'EX', 86400);
    }
    if (session.currentModelId) {
      await redis.set(`session:${sessionId}:currentModelId`, session.currentModelId, 'EX', 86400);
    }
    if (session.configOptions) {
      await redis.set(`session:${sessionId}:configOptions`, JSON.stringify(session.configOptions), 'EX', 86400);
    }
  }

  private async cacheModes(
    sessionId: string,
    modes?: Array<{ id: string; name: string; description?: string }>,
    currentModeId?: string,
    currentModel?: { id: string; name: string; provider?: string },
    availableModels?: Array<{ id: string; name: string; provider?: string }>,
    currentModelId?: string,
  ): Promise<void> {
    const redis = getRedisClient();
    if (modes) {
      await redis.set(`session:${sessionId}:modes`, JSON.stringify(modes), 'EX', 86400);
    }
    if (currentModeId) {
      await redis.set(`session:${sessionId}:currentModeId`, currentModeId, 'EX', 86400);
    }
    if (currentModel) {
      await redis.set(`session:${sessionId}:currentModel`, JSON.stringify(currentModel), 'EX', 86400);
    }
    if (availableModels) {
      await redis.set(`session:${sessionId}:availableModels`, JSON.stringify(availableModels), 'EX', 86400);
    }
    if (currentModelId) {
      await redis.set(`session:${sessionId}:currentModelId`, currentModelId, 'EX', 86400);
    }
  }

  private async publishMessage(sessionId: string, message: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    await redis.publish('session:message', JSON.stringify({
      sessionId,
      message,
    }));
  }

  private async publishStatus(sessionId: string, status: string, error?: string, extra?: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    const payload: Record<string, unknown> = { sessionId, status };
    if (error) payload.error = error;
    if (extra) {
      if (Array.isArray(extra.modes) && extra.modes.length) payload.modes = extra.modes;
      if (extra.currentModeId) payload.currentModeId = extra.currentModeId;
      if (extra.currentModel) payload.currentModel = extra.currentModel;
      if (Array.isArray(extra.availableModels) && extra.availableModels.length) payload.availableModels = extra.availableModels;
      if (extra.currentModelId) payload.currentModelId = extra.currentModelId;
      if (Array.isArray(extra.configOptions) && extra.configOptions.length) payload.configOptions = extra.configOptions;
    }
    await redis.publish('session:status', JSON.stringify(payload));
  }

  /**
   * Ensure a persistent dispatcher is registered for the given socket.
   * The dispatcher listens for acp:start:result and acp:resume:result,
   * routing by requestId to the correct PendingRequest.
   * This replaces per-call socket.once() which caused race conditions
   * when multiple sessions started concurrently on the same socket.
   */
  ensureSocketDispatcher(socket: Socket): void {
    if (this.socketDispatchers.has(socket.id)) return;
    const dispatcher = new Map<string, PendingRequest>();
    this.socketDispatchers.set(socket.id, dispatcher);

    socket.on('acp:start:result', (payload: { requestId: string; sessionId: string; success: boolean; error?: string; externalSessionId?: string; modes?: Array<{ id: string; name: string; description?: string }>; currentModeId?: string; currentModel?: { id: string; name: string; provider?: string }; availableModels?: Array<{ id: string; name: string; provider?: string }>; currentModelId?: string; configOptions?: Array<Record<string, unknown>>; promptCapabilities?: { image: boolean; audio: boolean; embeddedContext: boolean }; agentInfo?: { name: string; version?: string }; authMethods?: Array<{ id: string; kind: string; description?: string; url?: string }>; supportsAdditionalDirectories?: boolean }) => {
      const pending = dispatcher.get(payload.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        dispatcher.delete(payload.requestId);
        console.log(`[ACP session] Dispatcher resolved start result: requestId=${payload.requestId} sessionId=${pending.sessionId} success=${payload.success}`);
        pending.resolve(payload);
      } else {
        console.log(`[ACP session] Dispatcher: unknown requestId=${payload.requestId} (ignoring)`);
      }
    });

    socket.on('acp:resume:result', (payload: { requestId: string; sessionId: string; success: boolean; error?: string; modes?: Array<{ id: string; name: string; description?: string }>; currentModeId?: string; currentModel?: { id: string; name: string; provider?: string }; availableModels?: Array<{ id: string; name: string; provider?: string }>; currentModelId?: string; configOptions?: Array<Record<string, unknown>>; promptCapabilities?: { image: boolean; audio: boolean; embeddedContext: boolean }; agentInfo?: { name: string; version?: string }; authMethods?: Array<{ id: string; kind: string; description?: string; url?: string }>; supportsAdditionalDirectories?: boolean }) => {
      const pending = dispatcher.get(payload.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        dispatcher.delete(payload.requestId);
        console.log(`[ACP session] Dispatcher resolved resume result: requestId=${payload.requestId} sessionId=${pending.sessionId} success=${payload.success}`);
        pending.resolve(payload);
      } else {
        console.log(`[ACP session] Dispatcher: unknown requestId=${payload.requestId} (ignoring)`);
      }
    });

    socket.on('disconnect', () => {
      // Fail all pending requests for this socket
      for (const [requestId, pending] of dispatcher) {
        clearTimeout(pending.timeout);
        console.log(`[ACP session] Socket disconnected, failing pending request: requestId=${requestId} sessionId=${pending.sessionId}`);
        this.cleanupFailedSession(pending.sessionId, pending.statusAtStart);
        pending.resolve({ success: false, error: 'Controller socket disconnected' });
      }
      dispatcher.clear();
      this.socketDispatchers.delete(socket.id);
    });
  }

  /**
   * Register a pending start/resume request in the dispatcher for the given socket.
   */
  private registerPendingRequest(
    socket: Socket,
    requestId: string,
    sessionId: string,
    statusAtStart: string,
    timeoutMs: number,
    timeoutMessage?: string,
  ): Promise<{ success: boolean; error?: string; externalSessionId?: string; modes?: Array<{ id: string; name: string; description?: string }>; currentModeId?: string; currentModel?: { id: string; name: string; provider?: string }; availableModels?: Array<{ id: string; name: string; provider?: string }>; currentModelId?: string; configOptions?: Array<Record<string, unknown>>; promptCapabilities?: { image: boolean; audio: boolean; embeddedContext: boolean }; agentInfo?: { name: string; version?: string }; authMethods?: Array<{ id: string; kind: string; description?: string; url?: string }>; supportsAdditionalDirectories?: boolean }> {
    this.ensureSocketDispatcher(socket);
    const dispatcher = this.socketDispatchers.get(socket.id)!;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        dispatcher.delete(requestId);
        console.log(`[ACP session] TIMEOUT after ${timeoutMs}ms for session ${sessionId} requestId=${requestId}`);
        this.cleanupFailedSession(sessionId, statusAtStart);
        resolve({ success: false, error: timeoutMessage ?? 'ACP start timeout' });
      }, timeoutMs);
      dispatcher.set(requestId, { resolve, timeout, sessionId, statusAtStart });
    });
  }

  /**
   * Stop a session with ack guarantee: emit acp:stop with ackRequired,
   * wait for acp:stopped ack, retry once on timeout.
   */
  async stopSessionWithAck(sessionId: string, reason: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const controllerSocket = session.controllerSocket;

    // Clean up session mapping immediately
    this.sessions.delete(sessionId);
    this.pendingInputs.delete(sessionId);
    const socketSessions = this.socketToSessions.get(controllerSocket.id);
    if (socketSessions) {
      socketSessions.delete(sessionId);
      if (socketSessions.size === 0) {
        this.socketToSessions.delete(controllerSocket.id);
      }
    }

    // Update session status
    await Session.findByIdAndUpdate(sessionId, {
      status: 'ended',
      endedAt: new Date(),
    });
    await this.publishStatus(sessionId, 'ended');

    // Send acp:stop with ackRequired and wait for ack
    let ackReceived = false;
    const onStopped = (payload: { sessionId: string; reason: string; killed?: boolean }) => {
      if (payload.sessionId === sessionId) {
        ackReceived = true;
        console.log(`[ACP session] Received acp:stopped ack for session ${sessionId}: reason=${payload.reason} killed=${payload.killed ?? false}`);
      }
    };
    controllerSocket.once('acp:stopped', onStopped);

    for (let attempt = 0; attempt <= STOP_MAX_RETRIES; attempt++) {
      controllerSocket.emit('acp:stop', { sessionId, ackRequired: true });
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), STOP_ACK_TIMEOUT_MS);
        const checkAck = () => {
          if (ackReceived) {
            clearTimeout(timeout);
            resolve();
          }
        };
        // Poll for ack
        const poll = setInterval(() => {
          checkAck();
          if (ackReceived) clearInterval(poll);
        }, 100);
        setTimeout(() => clearInterval(poll), STOP_ACK_TIMEOUT_MS + 100);
      });
      if (ackReceived) break;
      console.log(`[ACP session] acp:stop ack timeout for session ${sessionId}, attempt ${attempt + 1}/${STOP_MAX_RETRIES + 1}`);
    }

    controllerSocket.off('acp:stopped', onStopped);

    if (!ackReceived) {
      // Controller may be offline — record for pending reconciliation
      console.log(`[ACP session] acp:stop ack not received for session ${sessionId}, recording as pending`);
      const redis = getRedisClient();
      await redis.lpush(`acp:stop:pending:${session.controllerId}`, sessionId);
      await redis.expire(`acp:stop:pending:${session.controllerId}`, 86400);
    }
  }
}

export const acpSessionManager = new ACPSessionManager();