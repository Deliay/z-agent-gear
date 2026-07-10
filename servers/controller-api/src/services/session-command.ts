import { getRedisClient } from '../middleware/redis.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';
import { acpSessionManager } from './acp-session-manager.js';
import { acpCapabilityDetector } from './acp-capability-detector.js';
import { acpSessionSyncService } from './acp-session-sync.js';
import { folderBrowserService } from './folder-browser.js';
import { gitBrowserService } from './git-browser.js';
import { worktreeService } from './worktree-service.js';
import { fsMkdirService } from './fs-mkdir-service.js';

const SESSION_COMMAND_CHANNEL = 'session:command';
const SESSION_MESSAGE_CHANNEL = 'session:message';

export class SessionCommandService {
  private io: SocketIOServer | null = null;

  start(io: SocketIOServer): void {
    this.io = io;
    this.subscribe();
  }

  private subscribe(): void {
    const redis = getRedisClient();
    const subscriber = redis.duplicate();

    subscriber.subscribe(SESSION_COMMAND_CHANNEL, (err) => {
      if (err) {
        console.error('Failed to subscribe to session command channel:', err);
        return;
      }
    });

    subscriber.subscribe(SESSION_MESSAGE_CHANNEL, (err) => {
      if (err) {
        console.error('Failed to subscribe to session message channel:', err);
        return;
      }
    });

    subscriber.on('message', async (channel: string, message: string) => {
      try {
        if (channel === SESSION_COMMAND_CHANNEL) {
          const command = JSON.parse(message) as {
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
            parentPath?: string;
            folderName?: string;
            repoPath?: string;
            worktreePath?: string;
            branch?: string;
            message?: string;
          };

          if (command.type === 'acp:start' && command.sessionId && command.controllerId && command.serverType) {
            await this.handleAcpStart(command as { sessionId: string; controllerId: string; serverType: string; cwd?: string });
          } else if (command.type === 'acp:resume' && command.sessionId && command.controllerId && command.externalSessionId) {
            await this.handleAcpResume(command as { sessionId: string; controllerId: string; externalSessionId: string; cwd?: string });
          } else if (command.type === 'acp:cancel' && command.sessionId) {
            await this.handleAcpCancel(command.sessionId);
          } else if (command.type === 'acp:check' && command.requestId && command.controllerId) {
            await this.handleAcpCheck(command.requestId, command.controllerId);
          } else if (command.type === 'acp:stop' && command.sessionId) {
            await this.handleAcpStop(command.sessionId, command.reason || 'user_request');
          } else if (command.type === 'fs:browse' && command.requestId && command.controllerId) {
            await this.handleFsBrowse(command.requestId, command.controllerId, command.path);
          } else if (command.type === 'fs:home' && command.requestId && command.controllerId) {
            await this.handleFsHome(command.requestId, command.controllerId);
          } else if (command.type === 'acp:set-mode' && command.sessionId && command.modeId) {
            await this.handleAcpSetMode(command.sessionId, command.modeId as string);
          } else if (command.type === 'acp:set-model' && command.sessionId && command.modelId) {
            await this.handleAcpSetModel(command.sessionId, command.modelId as string);
          } else if (command.type === 'git:check' && command.requestId && command.controllerId && command.path) {
            await this.handleGitCheck(command.requestId, command.controllerId, command.path);
          } else if (command.type === 'git:init' && command.requestId && command.controllerId && command.path) {
            await this.handleGitInit(command.requestId, command.controllerId, command.path);
          } else if (command.type === 'acp:cache:invalidate' && command.controllerId) {
            acpCapabilityDetector.invalidateCache(command.controllerId);
          } else if (command.type === 'acp:list-sessions' && command.requestId && command.controllerId && command.cwd) {
            await this.handleAcpListSessions(command.requestId, command.controllerId, command.cwd, command.serverType ?? 'opencode');
          } else if (command.type === 'acp:load-session' && command.requestId && command.controllerId && command.sessionId && command.cwd) {
            await this.handleAcpLoadSession(command.requestId, command.controllerId, command.sessionId, command.cwd, command.serverType ?? 'opencode');
          } else if (command.type === 'fs:mkdir' && command.requestId && command.controllerId && command.parentPath && command.folderName) {
            await fsMkdirService.handleMkdir(command.requestId, command.controllerId, command.parentPath as string, command.folderName as string);
          } else if (command.type === 'git:worktree:add' && command.requestId && command.controllerId && command.repoPath && command.worktreePath && command.branch) {
            await worktreeService.handleAdd(command.requestId, command.controllerId, command.repoPath as string, command.worktreePath as string, command.branch as string);
          } else if (command.type === 'git:worktree:remove' && command.requestId && command.controllerId && command.repoPath && command.worktreePath) {
            await worktreeService.handleRemove(command.requestId, command.controllerId, command.repoPath as string, command.worktreePath as string);
          } else if (command.type === 'git:status' && command.requestId && command.controllerId && command.path) {
            await worktreeService.handleStatus(command.requestId, command.controllerId, command.path as string);
          } else if (command.type === 'git:commit' && command.requestId && command.controllerId && command.path && command.message) {
            await worktreeService.handleCommit(command.requestId, command.controllerId, command.path as string, command.message as string);
          }
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
        console.error('Failed to process session event:', err);
      }
    });
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
  }): Promise<void> {
    if (!this.io) return;

    // Find the controller's socket
    const controller = await Controller.findById(command.controllerId).lean();
    if (!controller) {
      console.error(`Controller not found: ${command.controllerId}`);
      return;
    }

    // Get the socket ID from session service
    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      console.error(`Controller not online: ${command.controllerId}`);
      return;
    }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      console.error(`Socket not found: ${socketId}`);
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
    );

    if (!result.success) {
      console.error(`ACP start failed: ${result.error}`);
    }
  }

  private async handleAcpCheck(requestId: string, controllerId: string): Promise<void> {
    if (!this.io) return;

    // Find the controller's socket
    const controller = await Controller.findById(controllerId).lean();
    if (!controller) {
      console.error(`Controller not found for ACP check: ${controllerId}`);
      return;
    }

    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      console.error(`Controller online for ACP check: ${controllerId}`);
      return;
    }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      console.error(`Socket not found for ACP check: ${controllerId}`);
      return;
    }

    // Use the capability detector to send acp:check and wait for result
    const servers = await acpCapabilityDetector.detectCapabilities(socket, controllerId);
    console.log(`ACP capabilities detected for ${controllerId}:`, servers);
  }

  private async publishStatus(sessionId: string, status: string, error?: string): Promise<void> {
    const redis = getRedisClient();
    const payload: Record<string, unknown> = { sessionId, status };
    if (error) payload.error = error;
    await redis.publish('session:status', JSON.stringify(payload));
  }

  private async handleAcpResume(command: {
    sessionId: string;
    controllerId: string;
    externalSessionId: string;
    cwd?: string;
  }): Promise<void> {
    if (!this.io) return;

    const controller = await Controller.findById(command.controllerId).lean();
    if (!controller) {
      console.error(`Controller not found for resume: ${command.controllerId}`);
      await this.publishStatus(command.sessionId, 'ended', 'CONTROLLER_OFFLINE');
      return;
    }

    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      console.error(`Controller not online for resume: ${command.controllerId}`);
      await this.publishStatus(command.sessionId, 'ended', 'CONTROLLER_OFFLINE');
      return;
    }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      console.error(`Socket not found for resume: ${socketId}`);
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
    );

    if (!result.success) {
      console.error(`ACP resume failed: ${result.error}`);
    }
  }

  private async handleAcpCancel(sessionId: string): Promise<void> {
    console.log(`[SessionCommand] Cancelling generation for session ${sessionId}`);
    const result = await acpSessionManager.cancelGeneration(sessionId);
    if (!result) {
      console.error(`ACP cancel failed: session ${sessionId} not found in active sessions`);
    }
  }

  private async handleAcpStop(sessionId: string, reason: string): Promise<void> {
    console.log(`[SessionCommand] Stopping ACP session ${sessionId}: reason=${reason}`);
    await acpSessionManager.stopSession(sessionId, reason);
  }

  private async handleFsBrowse(requestId: string, controllerId: string, path?: string): Promise<void> {
    await folderBrowserService.browse(requestId, controllerId, path);
  }

  private async handleFsHome(requestId: string, controllerId: string): Promise<void> {
    await folderBrowserService.getHomeDirectory(requestId, controllerId);
  }

  private async handleAcpSetMode(sessionId: string, modeId: string): Promise<void> {
    console.log(`[SessionCommand] Setting mode for session ${sessionId}: modeId=${modeId}`);
    const result = await acpSessionManager.setMode(sessionId, modeId);
    if (!result) {
      console.error(`ACP set-mode failed: session ${sessionId} not found in active sessions`);
    }
  }

  private async handleAcpSetModel(sessionId: string, modelId: string): Promise<void> {
    console.log(`[SessionCommand] Setting model for session ${sessionId}: modelId=${modelId}`);
    const result = await acpSessionManager.setModel(sessionId, modelId);
    if (!result) {
      console.error(`ACP set-model failed: session ${sessionId} not found in active sessions`);
    }
  }

  private async handleGitCheck(requestId: string, controllerId: string, path: string): Promise<void> {
    await gitBrowserService.check(requestId, controllerId, path);
  }

  private async handleGitInit(requestId: string, controllerId: string, path: string): Promise<void> {
    await gitBrowserService.init(requestId, controllerId, path);
  }

  private async handleAcpListSessions(requestId: string, controllerId: string, cwd: string, serverType: string = 'opencode'): Promise<void> {
    if (!this.io) return;

    const controller = await Controller.findById(controllerId).lean();
    if (!controller) {
      console.error(`Controller not found for list-sessions: ${controllerId}`);
      return;
    }

    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      console.error(`Controller offline for list-sessions: ${controllerId}`);
      return;
    }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      console.error(`Socket not found for list-sessions: ${controllerId}`);
      return;
    }

    const result = await acpSessionSyncService.listSessions(socket, serverType, cwd);
    await acpSessionSyncService.cacheListResult(requestId, result);
  }

  private async handleAcpLoadSession(requestId: string, controllerId: string, sessionId: string, cwd: string, serverType: string = 'opencode'): Promise<void> {
    if (!this.io) return;

    const controller = await Controller.findById(controllerId).lean();
    if (!controller) {
      console.error(`Controller not found for load-session: ${controllerId}`);
      return;
    }

    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) {
      console.error(`Controller offline for load-session: ${controllerId}`);
      return;
    }

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      console.error(`Socket not found for load-session: ${controllerId}`);
      return;
    }

    const result = await acpSessionSyncService.loadSession(socket, serverType, sessionId, cwd);
    await acpSessionSyncService.cacheLoadResult(requestId, result);
  }
}

export const sessionCommandService = new SessionCommandService();
