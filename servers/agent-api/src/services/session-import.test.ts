import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/session.js', () => ({
  Session: {
    find: vi.fn(),
    findOne: vi.fn(),
    create: vi.fn(),
    deleteOne: vi.fn(),
  },
}));

vi.mock('../models/acp-message.js', () => ({
  AcpMessage: {
    insertMany: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock('../models/controller.js', () => ({
  Controller: {
    findOne: vi.fn(),
  },
}));

vi.mock('../models/controller-workspace.js', () => ({
  ControllerWorkspace: {
    findOne: vi.fn(),
  },
}));

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { sessionImportService } from './session-import.js';
import { Session } from '../models/session.js';
import { AcpMessage } from '../models/acp-message.js';
import { Controller } from '../models/controller.js';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { getRedisClient } from '../middleware/redis.js';

const mockRedis = {
  set: vi.fn(),
  del: vi.fn(),
  get: vi.fn(),
  publish: vi.fn(),
};

function mockSession(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'sess-1' },
    userId: 'user-1',
    controllerId: 'ctrl-1',
    controllerName: 'dev-machine',
    acpServerType: 'opencode',
    status: 'ended',
    title: 'Imported Session',
    externalSessionId: 'hist-1',
    cwd: '/home/user/project',
    endedAt: new Date(),
    toObject() { return { ...this }; },
    ...overrides,
  };
}

function mockLoadResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    sessionId: 'hist-1',
    title: 'Session 1',
    messages: [
      { direction: 'input', type: 'text', content: '{"text":"hello"}' },
    ],
    ...overrides,
  };
}

async function advancePollTimers(intervalMs: number, count: number) {
  for (let i = 0; i < count; i++) {
    await vi.advanceTimersByTimeAsync(intervalMs);
  }
}

describe('SessionImportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
  });

  describe('listHistorySessions', () => {
    it('should return filtered list of importable sessions', async () => {
      vi.useFakeTimers();
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'dev-machine' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(mockRedis.publish).mockResolvedValue(1);
      vi.mocked(mockRedis.get)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({
          success: true,
          sessions: [
            { sessionId: 'hist-1', title: 'Existing', cwd: '/home/user/project', updatedAt: '2026-01-01T00:00:00Z' },
            { sessionId: 'hist-2', title: 'New Session', cwd: '/home/user/project', updatedAt: '2026-01-02T00:00:00Z' },
          ],
        }));
      vi.mocked(Session.find).mockReturnValue({
        distinct: vi.fn().mockResolvedValue(['hist-1']),
      } as never);

      const promise = sessionImportService.listHistorySessions('user-1', 'ctrl-1', 'ws-1');
      await advancePollTimers(500, 3);
      const result = await promise;

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('hist-2');
      expect(result[0].title).toBe('New Session');
      vi.useRealTimers();
    });

    it('should throw when controller not found', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(
        sessionImportService.listHistorySessions('user-1', 'ctrl-1', 'ws-1'),
      ).rejects.toThrow('Controller not found');
    });

    it('should throw when workspace not found', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'dev-machine' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(
        sessionImportService.listHistorySessions('user-1', 'ctrl-1', 'ws-1'),
      ).rejects.toThrow('Workspace not found');
    });

    it('should return empty array when no sessions', async () => {
      vi.useFakeTimers();
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'dev-machine' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(mockRedis.publish).mockResolvedValue(1);
      vi.mocked(mockRedis.get)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({ success: true, sessions: [] }));
      vi.mocked(Session.find).mockReturnValue({
        distinct: vi.fn().mockResolvedValue([]),
      } as never);

      const promise = sessionImportService.listHistorySessions('user-1', 'ctrl-1', 'ws-1');
      await advancePollTimers(500, 3);
      const result = await promise;

      expect(result).toEqual([]);
      vi.useRealTimers();
    });

    it('should pass serverType in Redis publish command', async () => {
      vi.useFakeTimers();
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'dev-machine' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(mockRedis.publish).mockResolvedValue(1);
      vi.mocked(mockRedis.get)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({ success: true, sessions: [] }));
      vi.mocked(Session.find).mockReturnValue({
        distinct: vi.fn().mockResolvedValue([]),
      } as never);

      const promise = sessionImportService.listHistorySessions('user-1', 'ctrl-1', 'ws-1', 'claude_code');
      await advancePollTimers(500, 3);
      await promise;

      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"serverType":"claude_code"'),
      );
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"acp:list-sessions"'),
      );
      vi.useRealTimers();
    });

    it('should default to opencode serverType when not specified', async () => {
      vi.useFakeTimers();
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'dev-machine' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(mockRedis.publish).mockResolvedValue(1);
      vi.mocked(mockRedis.get)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({ success: true, sessions: [] }));
      vi.mocked(Session.find).mockReturnValue({
        distinct: vi.fn().mockResolvedValue([]),
      } as never);

      const promise = sessionImportService.listHistorySessions('user-1', 'ctrl-1', 'ws-1');
      await advancePollTimers(500, 3);
      await promise;

      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"serverType":"opencode"'),
      );
      vi.useRealTimers();
    });

    it('should filter out already imported sessions', async () => {
      vi.useFakeTimers();
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'dev-machine' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(mockRedis.publish).mockResolvedValue(1);
      vi.mocked(mockRedis.get)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({
          success: true,
          sessions: [
            { sessionId: 'hist-1', title: 'S1', cwd: '/home/user/project', updatedAt: null },
            { sessionId: 'hist-2', title: 'S2', cwd: '/home/user/project', updatedAt: null },
          ],
        }));
      vi.mocked(Session.find).mockReturnValue({
        distinct: vi.fn().mockResolvedValue(['hist-1', 'hist-2']),
      } as never);

      const promise = sessionImportService.listHistorySessions('user-1', 'ctrl-1', 'ws-1');
      await advancePollTimers(500, 3);
      const result = await promise;

      expect(result).toEqual([]);
      vi.useRealTimers();
    });
  });

  describe('deleteHistorySession', () => {
    it('should delete local session + messages, sync to agent, and return syncedToAgent when supported', async () => {
      vi.useFakeTimers();
      vi.mocked(Session.findOne).mockResolvedValue(mockSession() as never);
      vi.mocked(Session.deleteOne).mockResolvedValue({ deletedCount: 1 } as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue({ deletedCount: 0 } as never);
      vi.mocked(mockRedis.publish).mockResolvedValue(1);
      vi.mocked(mockRedis.get)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({ success: true, supported: true }));

      const promise = sessionImportService.deleteHistorySession('user-1', 'sess-1');
      await advancePollTimers(500, 3);
      const result = await promise;

      expect(Session.deleteOne).toHaveBeenCalledWith({ _id: 'sess-1', userId: 'user-1' });
      expect(AcpMessage.deleteMany).toHaveBeenCalledWith({ sessionId: 'sess-1' });
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"type":"acp:delete-history-session"'));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"externalSessionId":"hist-1"'));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"cwd":"/home/user/project"'));
      expect(result).toEqual({ success: true, syncedToAgent: true, error: null });
      vi.useRealTimers();
    });

    it('should not sync when syncAgent is false', async () => {
      vi.mocked(Session.findOne).mockResolvedValue(mockSession() as never);
      vi.mocked(Session.deleteOne).mockResolvedValue({ deletedCount: 1 } as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue({ deletedCount: 0 } as never);

      const result = await sessionImportService.deleteHistorySession('user-1', 'sess-1', false);

      expect(mockRedis.publish).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, syncedToAgent: false, error: null });
    });

    it('should not sync when session has no externalSessionId', async () => {
      vi.mocked(Session.findOne).mockResolvedValue(mockSession({ externalSessionId: null }) as never);
      vi.mocked(Session.deleteOne).mockResolvedValue({ deletedCount: 1 } as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue({ deletedCount: 0 } as never);

      const result = await sessionImportService.deleteHistorySession('user-1', 'sess-1');

      expect(mockRedis.publish).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, syncedToAgent: false, error: null });
    });

    it('should return syncedToAgent false when agent lacks delete capability', async () => {
      vi.useFakeTimers();
      vi.mocked(Session.findOne).mockResolvedValue(mockSession() as never);
      vi.mocked(Session.deleteOne).mockResolvedValue({ deletedCount: 1 } as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue({ deletedCount: 0 } as never);
      vi.mocked(mockRedis.publish).mockResolvedValue(1);
      vi.mocked(mockRedis.get)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({ success: false, supported: false, error: 'Session delete not supported by agent' }));

      const promise = sessionImportService.deleteHistorySession('user-1', 'sess-1');
      await advancePollTimers(500, 3);
      const result = await promise;

      expect(result).toEqual({ success: true, syncedToAgent: false, error: null });
      vi.useRealTimers();
    });

    it('should pass through agent error when agent supports delete but fails', async () => {
      vi.useFakeTimers();
      vi.mocked(Session.findOne).mockResolvedValue(mockSession() as never);
      vi.mocked(Session.deleteOne).mockResolvedValue({ deletedCount: 1 } as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue({ deletedCount: 0 } as never);
      vi.mocked(mockRedis.publish).mockResolvedValue(1);
      vi.mocked(mockRedis.get)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({ success: false, supported: true, error: 'agent delete failed' }));

      const promise = sessionImportService.deleteHistorySession('user-1', 'sess-1');
      await advancePollTimers(500, 3);
      const result = await promise;

      expect(result).toEqual({ success: true, syncedToAgent: false, error: 'agent delete failed' });
      vi.useRealTimers();
    });

    it('should reject deleting a running session', async () => {
      vi.mocked(Session.findOne).mockResolvedValue(mockSession({ status: 'running' }) as never);

      await expect(sessionImportService.deleteHistorySession('user-1', 'sess-1')).rejects.toThrow(
        "Cannot delete session in 'running' status",
      );
      expect(Session.deleteOne).not.toHaveBeenCalled();
      expect(mockRedis.publish).not.toHaveBeenCalled();
    });

    it('should allow deleting a connecting (stuck) session', async () => {
      vi.mocked(Session.findOne).mockResolvedValue(mockSession({ status: 'connecting' }) as never);
      vi.mocked(Session.deleteOne).mockResolvedValue({ deletedCount: 1 } as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue({ deletedCount: 0 } as never);

      const result = await sessionImportService.deleteHistorySession('user-1', 'sess-1', false);

      expect(Session.deleteOne).toHaveBeenCalledWith({ _id: 'sess-1', userId: 'user-1' });
      expect(result).toEqual({ success: true, syncedToAgent: false, error: null });
    });

    it('should allow deleting an idling session', async () => {
      vi.mocked(Session.findOne).mockResolvedValue(mockSession({ status: 'idling' }) as never);
      vi.mocked(Session.deleteOne).mockResolvedValue({ deletedCount: 1 } as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue({ deletedCount: 0 } as never);

      const result = await sessionImportService.deleteHistorySession('user-1', 'sess-1', false);

      expect(Session.deleteOne).toHaveBeenCalledWith({ _id: 'sess-1', userId: 'user-1' });
      expect(result).toEqual({ success: true, syncedToAgent: false, error: null });
    });

    it('should throw when session not found', async () => {
      vi.mocked(Session.findOne).mockResolvedValue(null);

      await expect(sessionImportService.deleteHistorySession('user-1', 'nope')).rejects.toThrow('Session not found');
      expect(Session.deleteOne).not.toHaveBeenCalled();
    });
  });

  describe('importSessions', () => {
    it('should import session and create Session + Messages', async () => {
      vi.useFakeTimers();
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'dev-machine' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(mockRedis.publish).mockResolvedValue(1);
      vi.mocked(Session.create).mockResolvedValue(mockSession() as never);
      vi.mocked(mockRedis.get)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify(mockLoadResult()));

      const promise = sessionImportService.importSessions('user-1', 'ctrl-1', 'dev-machine', 'ws-1', ['hist-1']);
      await advancePollTimers(1000, 3);
      const result = await promise;

      expect(result).toHaveLength(1);
      expect(result[0].success).toBe(true);
      expect(result[0].acpSessionId).toBe('hist-1');
      expect(result[0].title).toBe('Session 1');
      expect(result[0].messageCount).toBe(1);
      expect(Session.create).toHaveBeenCalledWith(expect.objectContaining({
        externalSessionId: 'hist-1',
        status: 'ended',
        cwd: '/home/user/project',
      }));
      expect(AcpMessage.insertMany).toHaveBeenCalledWith([
        expect.objectContaining({ direction: 'input', type: 'text' }),
      ]);
      vi.useRealTimers();
    });

    it('should handle import failure for individual session', async () => {
      vi.useFakeTimers();
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'dev-machine' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(mockRedis.publish).mockResolvedValue(1);
      vi.mocked(mockRedis.get)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({ success: false, error: 'ACP session load failed' }));

      const promise = sessionImportService.importSessions('user-1', 'ctrl-1', 'dev-machine', 'ws-1', ['hist-1']);
      await advancePollTimers(1000, 3);
      const result = await promise;

      expect(result).toHaveLength(1);
      expect(result[0].success).toBe(false);
      expect(result[0].error).toBe('ACP session load failed');
      vi.useRealTimers();
    });

    it('should pass serverType in Redis publish for load-session', async () => {
      vi.useFakeTimers();
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'dev-machine' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(mockRedis.publish).mockResolvedValue(1);
      vi.mocked(Session.create).mockResolvedValue(mockSession() as never);
      vi.mocked(mockRedis.get)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify(mockLoadResult()));

      const promise = sessionImportService.importSessions('user-1', 'ctrl-1', 'dev-machine', 'ws-1', ['hist-1'], 'gemini_cli');
      await advancePollTimers(1000, 3);
      await promise;

      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"serverType":"gemini_cli"'),
      );
      vi.useRealTimers();
    });

    it('should create Session with specified acpServerType', async () => {
      vi.useFakeTimers();
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'dev-machine' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(mockRedis.publish).mockResolvedValue(1);
      vi.mocked(Session.create).mockResolvedValue(mockSession() as never);
      vi.mocked(mockRedis.get)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify(mockLoadResult()));

      const promise = sessionImportService.importSessions('user-1', 'ctrl-1', 'dev-machine', 'ws-1', ['hist-1'], 'codex');
      await advancePollTimers(1000, 3);
      await promise;

      expect(Session.create).toHaveBeenCalledWith(expect.objectContaining({
        acpServerType: 'codex',
      }));
      vi.useRealTimers();
    });

    it('should default to opencode acpServerType when creating Session', async () => {
      vi.useFakeTimers();
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'dev-machine' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(mockRedis.publish).mockResolvedValue(1);
      vi.mocked(Session.create).mockResolvedValue(mockSession() as never);
      vi.mocked(mockRedis.get)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify(mockLoadResult()));

      const promise = sessionImportService.importSessions('user-1', 'ctrl-1', 'dev-machine', 'ws-1', ['hist-1']);
      await advancePollTimers(1000, 3);
      await promise;

      expect(Session.create).toHaveBeenCalledWith(expect.objectContaining({
        acpServerType: 'opencode',
      }));
      vi.useRealTimers();
    });

    it('should throw when controller not found', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(
        sessionImportService.importSessions('user-1', 'ctrl-1', 'dev-machine', 'ws-1', ['hist-1']),
      ).rejects.toThrow('Controller not found');
    });

    it('should throw when workspace not found', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'dev-machine' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(
        sessionImportService.importSessions('user-1', 'ctrl-1', 'dev-machine', 'ws-1', ['hist-1']),
      ).rejects.toThrow('Workspace not found');
    });

    it('should generate default title when ACP returns none', async () => {
      vi.useFakeTimers();
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'dev-machine' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(mockRedis.publish).mockResolvedValue(1);
      vi.mocked(Session.create).mockResolvedValue(mockSession() as never);
      vi.mocked(mockRedis.get)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify(mockLoadResult({ title: null, sessionId: 'abc12345' })));

      const promise = sessionImportService.importSessions('user-1', 'ctrl-1', 'dev-machine', 'ws-1', ['abc12345']);
      await advancePollTimers(1000, 3);
      const result = await promise;

      expect(result[0].success).toBe(true);
      expect(result[0].title).toBe('历史会话 - abc12345');
      expect(Session.create).toHaveBeenCalledWith(expect.objectContaining({
        title: '历史会话 - abc12345',
      }));
      vi.useRealTimers();
    });

    it('should import multiple sessions sequentially', async () => {
      vi.useFakeTimers();
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'dev-machine' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(mockRedis.publish).mockResolvedValue(1);
      vi.mocked(Session.create).mockResolvedValue(mockSession() as never);

      let callIndex = 0;
      vi.mocked(mockRedis.get).mockImplementation(async () => {
        const idx = callIndex++;
        if (idx === 0) return null;                  // First poll: hist-1 not ready
        if (idx === 1) return JSON.stringify(mockLoadResult()); // Second poll: hist-1 ready
        if (idx === 2) return null;                  // Third poll: hist-2 not ready
        if (idx === 3) return JSON.stringify(mockLoadResult({ sessionId: 'hist-2', title: 'Session 2' })); // Fourth: hist-2 ready
        return null;
      });

      const promise = sessionImportService.importSessions('user-1', 'ctrl-1', 'dev-machine', 'ws-1', ['hist-1', 'hist-2']);
      await advancePollTimers(1000, 6);
      const result = await promise;

      expect(result).toHaveLength(2);
      expect(result[0].success).toBe(true);
      expect(result[1].success).toBe(true);
      expect(result[0].acpSessionId).toBe('hist-1');
      expect(result[1].acpSessionId).toBe('hist-2');
      vi.useRealTimers();
    });
  });
});
