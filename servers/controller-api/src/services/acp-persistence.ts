import mongoose from 'mongoose';
import { AcpMessage } from '../models/acp-message.js';
import { Session } from '../models/session.js';
import { publish } from '../middleware/publish.js';

export class AcpPersistenceService {
  async saveMessage(sessionId: string, message: {
    direction: string;
    type: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string; createdAt: string }> {
    const acpMessage = await AcpMessage.create({
      sessionId,
      direction: message.direction as 'input' | 'output',
      type: message.type as 'text' | 'image' | 'tool_call' | 'tool_result' | 'plan' | 'error',
      content: message.content,
      metadata: message.metadata,
    });

    const doc = acpMessage.toObject();
    return {
      id: (doc._id as mongoose.Types.ObjectId).toString(),
      createdAt: (doc.createdAt as Date).toISOString(),
    };
  }

  async updateSessionStatus(sessionId: string, status: string, externalSessionId?: string): Promise<void> {
    const updateData: Record<string, unknown> = { status };
    if (externalSessionId) {
      updateData.externalSessionId = externalSessionId;
    }
    if (status === 'ended') {
      updateData.endedAt = new Date();
    }

    await Session.findByIdAndUpdate(sessionId, updateData);
  }

  async getSession(sessionId: string): Promise<Record<string, unknown> | null> {
    const session = await Session.findById(sessionId).lean();
    if (!session) return null;

    return {
      id: session._id.toString(),
      userId: session.userId.toString(),
      controllerId: session.controllerId.toString(),
      controllerName: session.controllerName,
      acpServerType: session.acpServerType,
      status: session.status,
      externalSessionId: session.externalSessionId || null,
      cwd: session.cwd || null,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      endedAt: session.endedAt ? session.endedAt.toISOString() : null,
    };
  }

  async publishMessage(sessionId: string, message: Record<string, unknown>): Promise<void> {
    await publish('session:message', {
      sessionId,
      message,
    });
  }

  async publishStatus(sessionId: string, status: string): Promise<void> {
    await publish('session:status', {
      sessionId,
      status,
    });
  }
}

export const acpPersistenceService = new AcpPersistenceService();