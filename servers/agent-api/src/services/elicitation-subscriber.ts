import type { Redis } from 'ioredis';
import { getRedisClient } from '../middleware/redis.js';
import { todoService } from './todo-service.js';
import { sessionSSEService } from './session-sse.js';

const ELICITATION_REQUEST_CHANNEL = 'elicitation:request';
const ELICITATION_COMPLETE_CHANNEL = 'elicitation:complete';

interface ElicitationRequestData {
  requestId: string;
  controllerId: string;
  sessionId: string;
  userId: string;
  mode: 'form' | 'url';
  message: string;
  toolCallId?: string;
  requestedSchema?: { title?: string } & Record<string, unknown>;
  elicitationId?: string;
  url?: string;
}

interface ElicitationCompleteData {
  sessionId: string;
  elicitationId: string;
  userId: string;
}

export class ElicitationSubscriberService {
  private subscriber: Redis | null = null;

  start(): void {
    if (this.subscriber) return;

    const redis = getRedisClient();
    this.subscriber = redis.duplicate();

    this.subscriber.subscribe(ELICITATION_REQUEST_CHANNEL, ELICITATION_COMPLETE_CHANNEL, (err) => {
      if (err) {
        console.error('Failed to subscribe to elicitation channels:', err);
        return;
      }
      console.log('Subscribed to elicitation:request and elicitation:complete channels');
    });

    this.subscriber.on('message', async (channel: string, message: string) => {
      try {
        if (channel === ELICITATION_REQUEST_CHANNEL) {
          await this.handleElicitationRequest(JSON.parse(message) as ElicitationRequestData);
        } else if (channel === ELICITATION_COMPLETE_CHANNEL) {
          await this.handleElicitationComplete(JSON.parse(message) as ElicitationCompleteData);
        }
      } catch (err) {
        console.error('Error handling elicitation message:', err);
      }
    });
  }

  private async handleElicitationRequest(data: ElicitationRequestData): Promise<void> {
    console.log('Received elicitation request:', data.requestId);

    // Create todo item
    const todo = await todoService.createElicitationTodo(data);
    console.log('Created todo:', todo._id);

    // Push SSE notification to user
    sessionSSEService.pushToUser(data.userId, {
      type: 'elicitation_request',
      data: {
        requestId: data.requestId,
        sessionId: data.sessionId,
        toolCallId: data.toolCallId,
        mode: data.mode,
        message: data.message,
        requestedSchema: data.requestedSchema,
        elicitationId: data.elicitationId,
        url: data.url,
        todoId: todo._id,
        createdAt: todo.createdAt,
      },
    });
  }

  private async handleElicitationComplete(data: ElicitationCompleteData): Promise<void> {
    console.log('Received elicitation complete:', data.elicitationId);

    // Mark the matching elicitation todo as read
    await todoService.markElicitationCompleted(data.elicitationId);

    // Push SSE notification to user
    sessionSSEService.pushToUser(data.userId, {
      type: 'elicitation_complete',
      data: {
        elicitationId: data.elicitationId,
      },
    });
  }

  stop(): void {
    if (this.subscriber) {
      this.subscriber.unsubscribe();
      this.subscriber.quit();
      this.subscriber = null;
    }
  }
}

export const elicitationSubscriberService = new ElicitationSubscriberService();
