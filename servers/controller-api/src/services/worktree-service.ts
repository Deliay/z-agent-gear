import { getRedisClient } from '../middleware/redis.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import type { Server as SocketIOServer } from 'socket.io';

export class WorktreeService {
  private io: SocketIOServer | null = null;

  start(io: SocketIOServer): void {
    this.io = io;
  }

  private async emitToController(controllerId: string, event: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.io) return;
    const controller = await Controller.findById(controllerId).lean();
    if (!controller) { console.error(`Controller not found: ${controllerId}`); return; }
    const keyId = controller.keyId.toString();
    const socketId = await sessionService.getSocketId(keyId);
    if (!socketId) { console.error(`Controller offline: ${controllerId}`); return; }
    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) { console.error(`Socket not found: ${socketId}`); return; }
    socket.emit(event, payload);
  }

  async handleAdd(requestId: string, controllerId: string, repoPath: string, worktreePath: string, branch: string): Promise<void> {
    await this.emitToController(controllerId, 'git:worktree:add', { requestId, repoPath, worktreePath, branch });
  }

  async handleRemove(requestId: string, controllerId: string, repoPath: string, worktreePath: string, force?: boolean): Promise<void> {
    await this.emitToController(controllerId, 'git:worktree:remove', { requestId, repoPath, worktreePath, ...(force ? { force: true } : {}) });
  }

  async handleList(requestId: string, controllerId: string, workspacePath: string): Promise<void> {
    await this.emitToController(controllerId, 'git:worktree:list', { requestId, workspacePath });
  }

  async handleRemoveDir(requestId: string, controllerId: string, path: string): Promise<void> {
    await this.emitToController(controllerId, 'fs:remove-dir', { requestId, path });
  }

  async handleStatus(requestId: string, controllerId: string, path: string): Promise<void> {
    await this.emitToController(controllerId, 'git:status', { requestId, path });
  }

  async handleCommit(requestId: string, controllerId: string, path: string, message: string): Promise<void> {
    await this.emitToController(controllerId, 'git:commit', { requestId, path, message });
  }

  async handleAddResult(requestId: string, result: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`git:worktree:add:${requestId}`, JSON.stringify(result), 'EX', 60);
  }

  async handleRemoveResult(requestId: string, result: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`git:worktree:remove:${requestId}`, JSON.stringify(result), 'EX', 60);
  }

  async handleStatusResult(requestId: string, result: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`git:status:${requestId}`, JSON.stringify(result), 'EX', 60);
  }

  async handleCommitResult(requestId: string, result: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`git:commit:${requestId}`, JSON.stringify(result), 'EX', 60);
  }

  async handleListResult(requestId: string, result: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`git:worktree:list:${requestId}`, JSON.stringify(result), 'EX', 60);
  }

  async handleRemoveDirResult(requestId: string, result: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`fs:remove-dir:${requestId}`, JSON.stringify(result), 'EX', 60);
  }
}

export const worktreeService = new WorktreeService();