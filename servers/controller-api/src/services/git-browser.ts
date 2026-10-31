import { getRedisClient } from '../middleware/redis.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';

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
  private readonly logger: ObservationLogger;

  constructor(logger: ObservationLogger = rootLogger.child({ component: 'git-browser' })) {
    this.logger = logger;
  }

  start(io: SocketIOServer): void {
    this.io = io;
  }

  async check(requestId: string, controllerId: string, path: string): Promise<void> {
    if (!this.io) return;
    const controller = await Controller.findById(controllerId).lean();
    if (!controller) { this.logger.error({ controllerId, requestId, op: 'git:check' }, 'controller not found'); return; }
    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) { this.logger.error({ controllerId, requestId, op: 'git:check' }, 'controller offline'); return; }
    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) { this.logger.error({ controllerId, socketId, requestId, op: 'git:check' }, 'socket not found'); return; }
    socket.emit('git:check', { requestId, path });
  }

  async init(requestId: string, controllerId: string, path: string): Promise<void> {
    if (!this.io) return;
    const controller = await Controller.findById(controllerId).lean();
    if (!controller) { this.logger.error({ controllerId, requestId, op: 'git:init' }, 'controller not found'); return; }
    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) { this.logger.error({ controllerId, requestId, op: 'git:init' }, 'controller offline'); return; }
    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) { this.logger.error({ controllerId, socketId, requestId, op: 'git:init' }, 'socket not found'); return; }
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
