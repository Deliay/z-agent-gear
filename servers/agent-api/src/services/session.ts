import mongoose from 'mongoose';
import { Session } from '../models/session.js';
import { AcpMessage } from '../models/acp-message.js';
import { Controller } from '../models/controller.js';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { getRedisClient } from '../middleware/redis.js';

export class SessionService {
  async findAllByUser(userId: string): Promise<Record<string, unknown>[]> {
    const sessions = await Session.find({ userId }).sort({ createdAt: -1 }).lean();
    return sessions.map(this.mapSession.bind(this));
  }

  async findById(id: string, userId: string): Promise<Record<string, unknown> | null> {
    const session = await Session.findOne({ _id: id, userId }).lean();
    if (!session) return null;
    return this.mapSession(session);
  }

  async create(userId: string, input: { controllerId: string; acpServerType: string; workspaceId: string }): Promise<Record<string, unknown>> {
    const controller = await Controller.findOne({ _id: input.controllerId, userId }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }

    const workspace = await ControllerWorkspace.findOne({ _id: input.workspaceId, userId, controllerId: input.controllerId }).lean();
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    const session = await Session.create({
      userId,
      controllerId: input.controllerId,
      controllerName: controller.name,
      acpServerType: input.acpServerType as 'opencode',
      status: 'creating',
      cwd: workspace.path,
    });

    // Notify controller-api to start ACP session via Redis Pub/Sub
    const redis = getRedisClient();
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:start',
      sessionId: session._id.toString(),
      controllerId: input.controllerId,
      serverType: input.acpServerType,
      cwd: workspace.path,
    }));

    return this.mapSession(session.toObject());
  }

  async updateStatus(id: string, userId: string, status: string, externalSessionId?: string): Promise<boolean> {
    const updateData: Record<string, unknown> = { status };
    if (externalSessionId) {
      updateData.externalSessionId = externalSessionId;
    }
    if (status === 'ended') {
      updateData.endedAt = new Date();
    }

    const result = await Session.findOneAndUpdate(
      { _id: id, userId },
      updateData,
      { new: true },
    );

    if (result) {
      // Update Redis cache
      const redis = getRedisClient();
      await redis.set(`session:${id}:status`, status);
      if (status === 'ended') {
        await redis.del(`session:${id}:status`);
      }
    }

    return !!result;
  }

  async setMode(sessionId: string, userId: string, modeId: string): Promise<boolean> {
    const session = await Session.findOne({ _id: sessionId, userId }).lean();
    if (!session) return false;
    if (session.status !== 'idling') return false;

    const redis = getRedisClient();
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:set-mode',
      sessionId,
      modeId,
    }));
    return true;
  }

  async setModel(sessionId: string, userId: string, modelId: string): Promise<boolean> {
    const session = await Session.findOne({ _id: sessionId, userId }).lean();
    if (!session) return false;
    if (session.status !== 'idling') return false;

    const redis = getRedisClient();
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:set-model',
      sessionId,
      modelId,
    }));
    return true;
  }

  async cancelGeneration(sessionId: string, userId: string): Promise<boolean> {
    const session = await Session.findOne({ _id: sessionId, userId }).lean();
    if (!session) return false;

    const redis = getRedisClient();
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:cancel',
      sessionId,
    }));
    return true;
  }

  async resume(id: string, userId: string): Promise<{ success: boolean; status: string; error?: string }> {
    const session = await Session.findOne({ _id: id, userId }).lean();
    if (!session) {
      return { success: false, status: 'ended', error: 'Session not found' };
    }
    if (session.status !== 'ended') {
      return { success: false, status: session.status, error: 'Session is not ended' };
    }

    const redis = getRedisClient();
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:resume',
      sessionId: id,
      controllerId: session.controllerId.toString(),
      externalSessionId: session.externalSessionId || '',
      cwd: session.cwd || '',
    }));
    return { success: true, status: 'connecting' };
  }

  async close(id: string, userId: string): Promise<boolean> {
    const result = await Session.findOneAndUpdate(
      { _id: id, userId },
      { status: 'ended', endedAt: new Date() },
    );
    if (result) {
      const redis = getRedisClient();
      await redis.del(`session:${id}:status`);
      // Notify controller-api to stop ACP session
      await redis.publish('session:command', JSON.stringify({
        type: 'acp:stop',
        sessionId: id,
        reason: 'user_close',
      }));
      return true;
    }
    return false;
  }

  async delete(id: string, userId: string): Promise<boolean> {
    // Notify controller-api to stop ACP session before deleting
    const redis = getRedisClient();
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:stop',
      sessionId: id,
      reason: 'user_delete',
    }));

    const result = await Session.findOneAndDelete({ _id: id, userId });
    if (result) {
      await AcpMessage.deleteMany({ sessionId: id });
      await redis.del(`session:${id}:status`);
      return true;
    }
    return false;
  }

  async getMessages(sessionId: string, userId: string, limit = 100, offset = 0): Promise<Record<string, unknown>[]> {
    // Verify session belongs to user
    const session = await Session.findOne({ _id: sessionId, userId }).lean();
    if (!session) {
      throw new Error('Session not found');
    }

    const messages = await AcpMessage.find({ sessionId })
      .sort({ _id: 1 })
      .skip(offset)
      .limit(limit)
      .lean();

    return messages.map(this.mapMessage.bind(this));
  }

  async addMessage(sessionId: string, message: { direction: string; type: string; content: string; metadata?: string }): Promise<Record<string, unknown>> {
    const acpMessage = await AcpMessage.create({
      sessionId,
      direction: message.direction as 'input' | 'output',
      type: message.type as 'text' | 'image' | 'tool_call' | 'tool_result' | 'plan' | 'error',
      content: message.content,
      metadata: message.metadata,
    });

    // Set session title from first user message
    if (message.direction === 'input') {
      const messageCount = await AcpMessage.countDocuments({ sessionId, direction: 'input' });
      if (messageCount === 1) {
        // First user message - extract text content as title
        let title = message.content;
        try {
          const parsed = JSON.parse(message.content);
          if (parsed.sessionUpdate === 'user_message_chunk' && parsed.content?.text) {
            title = parsed.content.text;
          }
        } catch {
          // use raw content
        }
        // Truncate to 50 chars
        if (title.length > 50) {
          title = title.slice(0, 50) + '...';
        }
        await Session.findByIdAndUpdate(sessionId, { title });
      }
    }

    const mappedMessage = this.mapMessage(acpMessage.toObject());

    // Publish to Redis for SSE
    const redis = getRedisClient();
    redis.publish('session:message', JSON.stringify({
      sessionId,
      message: mappedMessage,
    }));

    return mappedMessage;
  }

  async getAcpCapabilities(controllerId: string, userId: string): Promise<Record<string, unknown>[]> {
    // Verify controller belongs to user
    const controller = await Controller.findOne({ _id: controllerId, userId }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }

    const redis = getRedisClient();

    // Check Redis cache first
    const cached = await redis.get(`acp:capability:${controllerId}`);
    if (cached) {
      return JSON.parse(cached).servers;
    }

    // Trigger ACP capability detection via Redis Pub/Sub
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:check',
      requestId,
      controllerId,
    }));

    // Poll Redis cache for result (controller-api will cache it after detection)
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const result = await redis.get(`acp:capability:${controllerId}`);
      if (result) {
        return JSON.parse(result).servers;
      }
    }

    // Timeout — return empty
    return [];
  }

  private mapSession(session: Record<string, unknown>): Record<string, unknown> {
    return {
      id: (session._id as mongoose.Types.ObjectId).toString(),
      userId: (session.userId as mongoose.Types.ObjectId).toString(),
      controllerId: (session.controllerId as mongoose.Types.ObjectId).toString(),
      controllerName: session.controllerName,
      acpServerType: session.acpServerType,
      status: session.status,
      title: session.title || 'New Session',
      externalSessionId: session.externalSessionId || null,
      cwd: session.cwd || null,
      modes: session.modes || [],
      currentModeId: session.currentModeId || null,
      currentModel: session.currentModel || null,
      currentModelId: session.currentModelId || null,
      availableModels: session.availableModels || [],
      createdAt: (session.createdAt as Date).toISOString(),
      updatedAt: (session.updatedAt as Date).toISOString(),
      endedAt: session.endedAt ? (session.endedAt as Date).toISOString() : null,
    };
  }

  private mapMessage(message: Record<string, unknown>): Record<string, unknown> {
    return {
      id: (message._id as mongoose.Types.ObjectId).toString(),
      sessionId: (message.sessionId as mongoose.Types.ObjectId).toString(),
      direction: message.direction,
      type: message.type,
      content: message.content,
      metadata: message.metadata || null,
      createdAt: (message.createdAt as Date).toISOString(),
    };
  }
}

export const sessionService = new SessionService();