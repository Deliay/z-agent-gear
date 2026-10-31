import Redis from 'ioredis';
import { getRedisClient } from '../middleware/redis.js';
import { logger as rootLogger } from '../observability/logger.js';
import { extractTraceparent, withSpan } from '../observability/trace.js';
import { todoService } from './todo-service.js';
import { sessionSSEService } from './session-sse.js';

const PERMISSION_REQUEST_CHANNEL = 'permission:request';

const logger = rootLogger.child({ component: 'permission-subscriber' });

interface PermissionRequestData {
  requestId: string;
  controllerId: string;
  sessionId: string;
  userId: string;
  toolCall: {
    toolCallId: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
    locations?: Array<{ path: string; line?: number }>;
  };
  options: Array<{ optionId: string; name: string; kind: string }>;
  _meta?: unknown;
}

let subscriber: Redis | null = null;

export class PermissionSubscriberService {
  start(): void {
    if (subscriber) return;

    const redis = getRedisClient();
    subscriber = redis.duplicate();

    subscriber.subscribe(PERMISSION_REQUEST_CHANNEL, (err) => {
      if (err) {
        logger.error({ err, channel: PERMISSION_REQUEST_CHANNEL }, 'failed to subscribe to permission request channel');
        return;
      }
      logger.info({ channel: PERMISSION_REQUEST_CHANNEL }, 'subscribed to permission request channel');
    });

    subscriber.on('message', async (channel: string, message: string) => {
      if (channel !== PERMISSION_REQUEST_CHANNEL) return;

      try {
        const data = JSON.parse(message) as PermissionRequestData;
        const parent = extractTraceparent(data._meta);
        await withSpan(
          'permission:request handle',
          {
            'messaging.destination.name': PERMISSION_REQUEST_CHANNEL,
            requestId: data.requestId,
            sessionId: data.sessionId,
            userId: data.userId,
          },
          async () => {
            await this.handlePermissionRequest(data);
          },
          { parent },
        );
      } catch (err) {
        logger.error({ err }, 'error handling permission request');
      }
    });
  }

  private async handlePermissionRequest(data: PermissionRequestData): Promise<void> {
    logger.debug({ event: 'received', requestId: data.requestId, sessionId: data.sessionId }, 'received permission request');

    // Create todo item
    const todo = await todoService.createPermissionTodo(data);
    logger.debug({ event: 'todo-created', requestId: data.requestId, todoId: String(todo._id) }, 'created permission todo');

    // Push SSE notification to user
    sessionSSEService.pushToUser(data.userId, {
      type: 'permission_request',
      data: {
        requestId: data.requestId,
        sessionId: data.sessionId,
        toolCallId: data.toolCall.toolCallId,
        toolCall: data.toolCall,
        options: data.options,
        todoId: todo._id,
        createdAt: todo.createdAt,
      },
    });
  }

  stop(): void {
    if (subscriber) {
      subscriber.unsubscribe();
      subscriber.quit();
      subscriber = null;
    }
  }
}

export const permissionSubscriberService = new PermissionSubscriberService();
