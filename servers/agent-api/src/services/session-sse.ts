import type { Response } from 'express';
import { getRedisClient } from '../middleware/redis.js';
import { sessionService } from './session.js';

interface SSEConnection {
  res: Response;
  sessionId: string;
  userId: string;
  heartbeat: NodeJS.Timeout;
}

const connections = new Map<string, SSEConnection>();

export class SessionSSEService {
  async addConnection(sessionId: string, userId: string, res: Response): Promise<void> {
    // Verify session exists and belongs to user
    const session = await sessionService.findById(sessionId, userId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send history messages
    const history = await sessionService.getMessages(sessionId, userId, 100);
    res.write(`data: ${JSON.stringify({ type: 'history', data: history })}\n\n`);

    // Create connection
    const connectionId = `${sessionId}:${userId}`;
    const heartbeat = setInterval(() => {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
    }, 30000);

    connections.set(connectionId, {
      res,
      sessionId,
      userId,
      heartbeat,
    });

    // Subscribe to Redis channel
    const redis = getRedisClient();
    const subscriber = redis.duplicate();
    await subscriber.subscribe(`session:${sessionId}:messages`);

    subscriber.on('message', (channel, message) => {
      if (channel === `session:${sessionId}:messages`) {
        res.write(`data: ${message}\n\n`);
      }
    });

    // Clean up on connection close
    res.on('close', () => {
      clearInterval(heartbeat);
      subscriber.unsubscribe();
      subscriber.quit();
      connections.delete(connectionId);
    });
  }

  broadcastMessage(sessionId: string, message: Record<string, unknown>): void {
    const data = JSON.stringify({ type: 'message', data: message });
    for (const [key, connection] of connections) {
      if (connection.sessionId === sessionId) {
        connection.res.write(`data: ${data}\n\n`);
      }
    }
  }

  broadcastStatus(sessionId: string, status: string): void {
    const data = JSON.stringify({ type: 'status', data: { sessionId, status } });
    for (const [key, connection] of connections) {
      if (connection.sessionId === sessionId) {
        connection.res.write(`data: ${data}\n\n`);
      }
    }
  }

  removeConnections(sessionId: string): void {
    for (const [key, connection] of connections) {
      if (connection.sessionId === sessionId) {
        clearInterval(connection.heartbeat);
        connection.res.end();
        connections.delete(key);
      }
    }
  }
}

export const sessionSSEService = new SessionSSEService();