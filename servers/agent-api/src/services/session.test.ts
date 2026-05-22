import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/session.js', () => ({
  Session: {
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    findOneAndDelete: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('../models/acp-message.js', () => ({
  AcpMessage: {
    find: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
    countDocuments: vi.fn(),
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

import { sessionService } from './session.js';
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

function oid(id: string) {
  return { toString: () => id } as import('mongoose').Types.ObjectId;
}

function mockSessionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: oid('sess-1'),
    userId: oid('user-1'),
    controllerId: oid('ctrl-1'),
    controllerName: 'dev-machine',
    acpServerType: 'opencode',
    status: 'creating',
    externalSessionId: null,
    cwd: '/home/user/project',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    endedAt: null,
    toObject() { return { ...this }; },
    ...overrides,
  };
}

function mockMessageDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: oid('msg-1'),
    sessionId: oid('sess-1'),
    direction: 'input',
    type: 'text',
    content: 'Hello',
    metadata: null,
    createdAt: new Date('2026-01-01'),
    toObject() { return { ...this }; },
    ...overrides,
  };
}

describe('SessionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
  });

  describe('findAllByUser', () => {
    it('should return mapped sessions for user', async () => {
      const docs = [mockSessionDoc(), mockSessionDoc({ _id: oid('sess-2') })];
      vi.mocked(Session.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(docs),
        }),
      } as never);

      const result = await sessionService.findAllByUser('user-1');

      expect(Session.find).toHaveBeenCalledWith({ userId: 'user-1' });
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('sess-1');
    });

    it('should return empty array when no sessions', async () => {
      vi.mocked(Session.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      } as never);

      const result = await sessionService.findAllByUser('user-1');
      expect(result).toEqual([]);
    });
  });

  describe('findById', () => {
    it('should return mapped session when found', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc()),
      } as never);

      const result = await sessionService.findById('sess-1', 'user-1');

      expect(Session.findOne).toHaveBeenCalledWith({ _id: 'sess-1', userId: 'user-1' });
      expect(result).not.toBeNull();
      expect(result!.id).toBe('sess-1');
      expect(result!.controllerName).toBe('dev-machine');
    });

    it('should return null when not found', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      const result = await sessionService.findById('sess-1', 'user-1');
      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('should create session with controller name and workspace path', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'my-server' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc({ controllerName: 'my-server' }) as never);

      const result = await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
      });

      expect(Controller.findOne).toHaveBeenCalledWith({ _id: 'ctrl-1', userId: 'user-1' });
      expect(ControllerWorkspace.findOne).toHaveBeenCalledWith({ _id: 'ws-1', userId: 'user-1', controllerId: 'ctrl-1' });
      expect(Session.create).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user-1',
        controllerId: 'ctrl-1',
        controllerName: 'my-server',
        acpServerType: 'opencode',
        status: 'creating',
        cwd: '/home/user/project',
      }));
      expect(result.id).toBe('sess-1');
    });

    it('should throw when controller not found', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
      })).rejects.toThrow('Controller not found');
    });

    it('should throw when workspace not found', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'my-server' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
      })).rejects.toThrow('Workspace not found');
    });
  });

  describe('updateStatus', () => {
    it('should update status and set Redis cache', async () => {
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(mockSessionDoc({ status: 'running' }) as never);

      const result = await sessionService.updateStatus('sess-1', 'user-1', 'running');

      expect(result).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith('session:sess-1:status', 'running');
    });

    it('should delete Redis cache when ended', async () => {
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(mockSessionDoc({ status: 'ended' }) as never);

      await sessionService.updateStatus('sess-1', 'user-1', 'ended');

      expect(mockRedis.del).toHaveBeenCalledWith('session:sess-1:status');
    });

    it('should save externalSessionId when provided', async () => {
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(mockSessionDoc() as never);

      await sessionService.updateStatus('sess-1', 'user-1', 'running', 'ext-123');

      expect(Session.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'sess-1', userId: 'user-1' },
        expect.objectContaining({ externalSessionId: 'ext-123' }),
        { new: true },
      );
    });

    it('should return false when session not found', async () => {
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(null);

      const result = await sessionService.updateStatus('sess-1', 'user-1', 'running');
      expect(result).toBe(false);
    });
  });

  describe('close', () => {
    it('should delegate to updateStatus with ended', async () => {
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(mockSessionDoc({ status: 'ended' }) as never);

      const result = await sessionService.close('sess-1', 'user-1');
      expect(result).toBe(true);
    });
  });

  describe('delete', () => {
    it('should delete session, messages, and Redis cache', async () => {
      vi.mocked(Session.findOneAndDelete).mockResolvedValue(mockSessionDoc() as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue(undefined as never);

      const result = await sessionService.delete('sess-1', 'user-1');

      expect(result).toBe(true);
      expect(AcpMessage.deleteMany).toHaveBeenCalledWith({ sessionId: 'sess-1' });
      expect(mockRedis.del).toHaveBeenCalledWith('session:sess-1:status');
    });

    it('should return false when session not found', async () => {
      vi.mocked(Session.findOneAndDelete).mockResolvedValue(null);

      const result = await sessionService.delete('sess-1', 'user-1');
      expect(result).toBe(false);
    });
  });

  describe('getMessages', () => {
    it('should return mapped messages', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc()),
      } as never);
      vi.mocked(AcpMessage.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          skip: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              lean: vi.fn().mockResolvedValue([mockMessageDoc()]),
            }),
          }),
        }),
      } as never);

      const result = await sessionService.getMessages('sess-1', 'user-1', 10, 0);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('msg-1');
      expect(result[0].content).toBe('Hello');
    });

    it('should throw when session not found', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(sessionService.getMessages('sess-1', 'user-1')).rejects.toThrow('Session not found');
    });
  });

  describe('addMessage', () => {
    it('should create message and publish to Redis', async () => {
      vi.mocked(AcpMessage.create).mockResolvedValue(mockMessageDoc() as never);
      vi.mocked(AcpMessage.countDocuments).mockResolvedValue(1);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const result = await sessionService.addMessage('sess-1', {
        direction: 'input',
        type: 'text',
        content: 'Hello',
      });

      expect(AcpMessage.create).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess-1',
        direction: 'input',
        type: 'text',
        content: 'Hello',
      }));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:message', expect.any(String));
      expect(result.content).toBe('Hello');
    });
  });

  describe('getAcpCapabilities', () => {
    it('should return cached capabilities from Redis', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'ctrl' }),
      } as never);
      vi.mocked(mockRedis.get).mockResolvedValue(JSON.stringify({
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
        checkedAt: new Date().toISOString(),
      }));

      const result = await sessionService.getAcpCapabilities('ctrl-1', 'user-1');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(expect.objectContaining({ type: 'opencode', available: true }));
      expect(result[0].checkedAt).toBeDefined();
      expect(typeof result[0].checkedAt).toBe('string');
    });

    it('should return empty array when no cache', async () => {
      vi.useFakeTimers();
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'ctrl' }),
      } as never);
      vi.mocked(mockRedis.get).mockResolvedValue(null);
      vi.mocked(mockRedis.publish).mockResolvedValue(1);

      const promise = sessionService.getAcpCapabilities('ctrl-1', 'user-1');
      // Advance through all polling intervals
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(500);
      }
      const result = await promise;

      expect(result).toEqual([]);
      vi.useRealTimers();
    });

    it('should throw when controller not found', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(sessionService.getAcpCapabilities('ctrl-1', 'user-1')).rejects.toThrow('Controller not found');
    });
  });

  describe('refreshAcpCapabilities', () => {
    it('should throw when controller not found', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(
        sessionService.refreshAcpCapabilities('ctrl-1', 'user-1'),
      ).rejects.toThrow('Controller not found');
    });

    it('should delete cache and publish invalidate', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'ctrl' }),
      } as never);
      vi.mocked(mockRedis.get).mockResolvedValue(JSON.stringify({
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
        checkedAt: new Date().toISOString(),
      }));

      const result = await sessionService.refreshAcpCapabilities('ctrl-1', 'user-1');

      expect(mockRedis.del).toHaveBeenCalledWith('acp:capability:ctrl-1');
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"acp:cache:invalidate"'),
      );
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"controllerId":"ctrl-1"'),
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('opencode');
    });

    it('should return empty array when refresh produces no data', async () => {
      vi.useFakeTimers();
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'ctrl' }),
      } as never);
      vi.mocked(mockRedis.get).mockResolvedValue(null);
      vi.mocked(mockRedis.publish).mockResolvedValue(1);

      const promise = sessionService.refreshAcpCapabilities('ctrl-1', 'user-1');
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(500);
      }
      const result = await promise;

      expect(mockRedis.del).toHaveBeenCalledWith('acp:capability:ctrl-1');
      expect(result).toEqual([]);
      vi.useRealTimers();
    });
  });

  describe('resume', () => {
    it('should return error when session not found', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      const result = await sessionService.resume('sess-1', 'user-1');

      expect(result).toEqual({ success: false, status: 'ended', error: 'Session not found' });
    });

    it('should return error when session is not ended', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'running' })),
      } as never);

      const result = await sessionService.resume('sess-1', 'user-1');

      expect(result).toEqual({ success: false, status: 'running', error: 'Session is not ended' });
    });

    it('should return error when session is creating', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'creating' })),
      } as never);

      const result = await sessionService.resume('sess-1', 'user-1');

      expect(result).toEqual({ success: false, status: 'creating', error: 'Session is not ended' });
    });

    it('should publish acp:resume and return connecting for ended session', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(
          mockSessionDoc({ status: 'ended', externalSessionId: 'ext-123' }),
        ),
      } as never);

      const result = await sessionService.resume('sess-1', 'user-1');

      expect(result).toEqual({ success: true, status: 'connecting' });
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"type":"acp:resume"'));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"sessionId":"sess-1"'));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"externalSessionId":"ext-123"'));
    });

    it('should publish acp:resume even without externalSessionId', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(
          mockSessionDoc({ status: 'ended', externalSessionId: null }),
        ),
      } as never);

      const result = await sessionService.resume('sess-1', 'user-1');

      expect(result).toEqual({ success: true, status: 'connecting' });
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"externalSessionId":""'));
    });
  });

  describe('setMode', () => {
    it('should return false when session not found', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      const result = await sessionService.setMode('sess-1', 'user-1', 'mode-1');

      expect(result).toBe(false);
    });

    it('should return false when session status is not idling', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'running' })),
      } as never);

      const result = await sessionService.setMode('sess-1', 'user-1', 'mode-1');

      expect(result).toBe(false);
    });

    it('should publish acp:set-mode when session is idling', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'idling' })),
      } as never);

      const result = await sessionService.setMode('sess-1', 'user-1', 'mode-1');

      expect(result).toBe(true);
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"type":"acp:set-mode"'));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"sessionId":"sess-1"'));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"modeId":"mode-1"'));
    });

    it('should return false when connecting', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'connecting' })),
      } as never);

      const result = await sessionService.setMode('sess-1', 'user-1', 'mode-1');

      expect(result).toBe(false);
    });
  });

  describe('setModel', () => {
    it('should return false when session not found', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      const result = await sessionService.setModel('sess-1', 'user-1', 'model-1');

      expect(result).toBe(false);
    });

    it('should return false when session status is not idling', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'running' })),
      } as never);

      const result = await sessionService.setModel('sess-1', 'user-1', 'model-1');

      expect(result).toBe(false);
    });

    it('should publish acp:set-model when session is idling', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'idling' })),
      } as never);

      const result = await sessionService.setModel('sess-1', 'user-1', 'model-1');

      expect(result).toBe(true);
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"type":"acp:set-model"'));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"sessionId":"sess-1"'));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"modelId":"model-1"'));
    });

    it('should return false when connecting', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'connecting' })),
      } as never);

      const result = await sessionService.setModel('sess-1', 'user-1', 'model-1');

      expect(result).toBe(false);
    });
  });
});
