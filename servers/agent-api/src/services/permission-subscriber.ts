import Redis from 'ioredis';
import { getRedisClient } from '../middleware/redis.js';
import { todoService } from './todo-service.js';
import { sessionSSEService } from './session-sse.js';

const PERMISSION_REQUEST_CHANNEL = 'permission:request';

interface PermissionRequestData {
  requestId: string;
  controllerId: string;
  sessionId: string;
  userId: string;
  toolCall: { toolCallId: string };
  options: Array<{ optionId: string; name: string; kind: string }>;
}

let subscriber: Redis | null = null;

export class PermissionSubscriberService {
  start(): void {
    if (subscriber) return;

    const redis = getRedisClient();
    subscriber = redis.duplicate();

    subscriber.subscribe(PERMISSION_REQUEST_CHANNEL, (err) => {
      if (err) {
        console.error('Failed to subscribe to permission request channel:', err);
        return;
      }
      console.log('Subscribed to permission:request channel');
    });

    subscriber.on('message', async (channel: string, message: string) => {
      if (channel !== PERMISSION_REQUEST_CHANNEL) return;

      try {
        const data = JSON.parse(message) as PermissionRequestData;
        await this.handlePermissionRequest(data);
      } catch (err) {
        console.error('Error handling permission request:', err);
      }
    });
  }

  private async handlePermissionRequest(data: PermissionRequestData): Promise<void> {
    console.log('Received permission request:', data.requestId);
    
    // Create todo item
    const todo = await todoService.createPermissionTodo(data);
    console.log('Created todo:', todo._id);

    // Push SSE notification to user
    sessionSSEService.pushToUser(data.userId, {
      type: 'permission_request',
      data: {
        requestId: data.requestId,
        sessionId: data.sessionId,
        toolCallId: data.toolCall.toolCallId,
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
