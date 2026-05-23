import { getRedisClient } from '../middleware/redis.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';

interface GitCheckResult {
  isGitRepo: boolean;
  currentBranch?: string;
  branches?: string[];
  defaultBranch?: string;
  error?: string;
}

interface GitInitResult {
  success: boolean;
  error?: string;
}

export class GitBrowserService {
  private io: SocketIOServer | null = null;

  start(io: SocketIOServer): void {
    this.io = io;
  }

  async check(requestId: string, controllerId: string, path: string): Promise<void> {
    if (!this.io) return;
    const controller = await Controller.findById(controllerId).lean();
    if (!controller) { console.error(`Controller not found for git:check: ${controllerId}`); return; }
    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) { console.error(`Controller offline for git:check: ${controllerId}`); return; }
    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) { console.error(`Socket not found for git:check: ${controllerId}`); return; }
    socket.emit('git:check', { requestId, path });
  }

  async init(requestId: string, controllerId: string, path: string): Promise<void> {
    if (!this.io) return;
    const controller = await Controller.findById(controllerId).lean();
    if (!controller) { console.error(`Controller not found for git:init: ${controllerId}`); return; }
    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) { console.error(`Controller offline for git:init: ${controllerId}`); return; }
    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) { console.error(`Socket not found for git:init: ${controllerId}`); return; }
    socket.emit('git:init', { requestId, path });
  }

  async handleCheckResult(requestId: string, result: GitCheckResult): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`git:check:${requestId}`, JSON.stringify(result), 'EX', 60);
  }

  async handleInitResult(requestId: string, result: GitInitResult): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`git:init:${requestId}`, JSON.stringify(result), 'EX', 30);
  }
}

export const gitBrowserService = new GitBrowserService();
