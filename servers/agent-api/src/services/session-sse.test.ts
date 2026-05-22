import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/session.js', () => ({
  sessionService: {
    findById: vi.fn(),
    getMessages: vi.fn(),
  },
}));

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { sessionSSEService } from './session-sse.js';
import { sessionService } from './session.js';
import { getRedisClient } from '../middleware/redis.js';

function createMockResponse() {
  const written: string[] = [];
  const closeHandlers: (() => void)[] = [];
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    writeHead: vi.fn(),
    write: vi.fn((data: string) => { written.push(data); }),
    end: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'close') closeHandlers.push(handler);
    }),
    _written: written,
    _closeHandlers: closeHandlers,
    _triggerClose() { closeHandlers.forEach((h) => { h(); }); },
  };
}

function createMockRedis() {
  const messageHandlers: ((channel: string, message: string) => void)[] = [];
  const subscriber = {
    subscribe: vi.fn(),
    on: vi.fn((event: string, handler: (channel: string, message: string) => void) => {
      if (event === 'message') messageHandlers.push(handler);
    }),
    unsubscribe: vi.fn(),
    quit: vi.fn(),
  };
  return {
    duplicate: vi.fn().mockReturnValue(subscriber),
    _emitMessage: (channel: string, message: string) => {
      messageHandlers.forEach((h) => { h(channel, message); });
    },
    _subscriber: subscriber,
  };
}

describe('SessionSSEService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('addConnection', () => {
    it('should return 404 when session not found', async () => {
      vi.mocked(sessionService.findById).mockResolvedValue(null);
      const res = createMockResponse();

      await sessionSSEService.addConnection('sess-1', 'user-1', res as never);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Session not found' });
    });

    it('should set SSE headers and send history', async () => {
      vi.mocked(sessionService.findById).mockResolvedValue({ id: 'sess-1' });
      vi.mocked(sessionService.getMessages).mockResolvedValue([{ id: 'msg-1' }]);
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const res = createMockResponse();

      await sessionSSEService.addConnection('sess-1', 'user-1', res as never);

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }));
      expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"type":"history"'));
      expect(mockRedis._subscriber.subscribe).toHaveBeenCalledWith('session:message');
    });

    it('should forward Redis messages to response', async () => {
      vi.mocked(sessionService.findById).mockResolvedValue({ id: 'sess-1' });
      vi.mocked(sessionService.getMessages).mockResolvedValue([]);
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const res = createMockResponse();

      await sessionSSEService.addConnection('sess-1', 'user-1', res as never);

      const msg = JSON.stringify({ sessionId: 'sess-1', message: { id: 'msg-1', direction: 'output', type: 'text', content: 'hello' } });
      mockRedis._emitMessage('session:message', msg);

      expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ type: 'message', data: { id: 'msg-1', direction: 'output', type: 'text', content: 'hello' } })}\n\n`);
    });

    it('should ignore messages from other sessions', async () => {
      vi.mocked(sessionService.findById).mockResolvedValue({ id: 'sess-1' });
      vi.mocked(sessionService.getMessages).mockResolvedValue([]);
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const res = createMockResponse();

      await sessionSSEService.addConnection('sess-1', 'user-1', res as never);

      const before = res._written.length;
      const msg = JSON.stringify({ sessionId: 'sess-other', message: { id: 'msg-1' } });
      mockRedis._emitMessage('session:message', msg);

      expect(res._written.length).toBe(before);
    });

    it('should clean up on connection close', async () => {
      vi.mocked(sessionService.findById).mockResolvedValue({ id: 'sess-1' });
      vi.mocked(sessionService.getMessages).mockResolvedValue([]);
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const res = createMockResponse();

      await sessionSSEService.addConnection('sess-1', 'user-1', res as never);

      res._triggerClose();

      expect(mockRedis._subscriber.unsubscribe).toHaveBeenCalled();
      expect(mockRedis._subscriber.quit).toHaveBeenCalled();
    });
  });

  describe('broadcastMessage', () => {
    it('should write message to matching connections', async () => {
      vi.mocked(sessionService.findById).mockResolvedValue({ id: 'sess-1' });
      vi.mocked(sessionService.getMessages).mockResolvedValue([]);
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const res = createMockResponse();

      await sessionSSEService.addConnection('sess-1', 'user-1', res as never);

      const before = res._written.length;
      sessionSSEService.broadcastMessage('sess-1', { id: 'msg-2' });

      expect(res._written.length).toBe(before + 1);
      expect(res._written.at(-1)).toContain('"type":"message"');
    });

    it('should not write to connections for other sessions', async () => {
      vi.mocked(sessionService.findById).mockResolvedValue({ id: 'sess-1' });
      vi.mocked(sessionService.getMessages).mockResolvedValue([]);
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const res = createMockResponse();

      await sessionSSEService.addConnection('sess-1', 'user-1', res as never);

      const before = res._written.length;
      sessionSSEService.broadcastMessage('sess-other', { id: 'msg-2' });

      expect(res._written.length).toBe(before);
    });
  });

  describe('broadcastStatus', () => {
    it('should write status to matching connections', async () => {
      vi.mocked(sessionService.findById).mockResolvedValue({ id: 'sess-1' });
      vi.mocked(sessionService.getMessages).mockResolvedValue([]);
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const res = createMockResponse();

      await sessionSSEService.addConnection('sess-1', 'user-1', res as never);

      const before = res._written.length;
      sessionSSEService.broadcastStatus('sess-1', 'running');

      expect(res._written.length).toBe(before + 1);
      expect(res._written.at(-1)).toContain('"type":"status"');
      expect(res._written.at(-1)).toContain('"status":"running"');
    });

    it('should include error field when provided', async () => {
      vi.mocked(sessionService.findById).mockResolvedValue({ id: 'sess-1' });
      vi.mocked(sessionService.getMessages).mockResolvedValue([]);
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const res = createMockResponse();

      await sessionSSEService.addConnection('sess-1', 'user-1', res as never);

      sessionSSEService.broadcastStatus('sess-1', 'ended', 'CONTROLLER_OFFLINE');

      const lastWrite = res._written.at(-1);
      expect(lastWrite).toContain('"status":"ended"');
      expect(lastWrite).toContain('"error":"CONTROLLER_OFFLINE"');
    });

    it('should not include error field when absent', async () => {
      vi.mocked(sessionService.findById).mockResolvedValue({ id: 'sess-1' });
      vi.mocked(sessionService.getMessages).mockResolvedValue([]);
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const res = createMockResponse();

      await sessionSSEService.addConnection('sess-1', 'user-1', res as never);

      sessionSSEService.broadcastStatus('sess-1', 'ended');

      const lastWrite = res._written.at(-1);
      expect(lastWrite).not.toContain('"error"');
    });
  });

  describe('broadcastStatus with extra fields', () => {
    it('should include modes when provided', async () => {
      vi.mocked(sessionService.findById).mockResolvedValue({ id: 'sess-1' });
      vi.mocked(sessionService.getMessages).mockResolvedValue([]);
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const res = createMockResponse();

      await sessionSSEService.addConnection('sess-1', 'user-1', res as never);

      sessionSSEService.broadcastStatus('sess-1', 'idling', undefined, {
        modes: [{ id: 'mode-1', name: 'Code', description: 'Coding mode' }],
        currentModeId: 'mode-1',
      });

      const lastWrite = res._written.at(-1);
      expect(lastWrite).toContain('"type":"status"');
      expect(lastWrite).toContain('"modes"');
      expect(lastWrite).toContain('"currentModeId":"mode-1"');
    });

    it('should include currentModel when provided', async () => {
      vi.mocked(sessionService.findById).mockResolvedValue({ id: 'sess-1' });
      vi.mocked(sessionService.getMessages).mockResolvedValue([]);
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const res = createMockResponse();

      await sessionSSEService.addConnection('sess-1', 'user-1', res as never);

      sessionSSEService.broadcastStatus('sess-1', 'running', undefined, {
        currentModel: { id: 'model-1', name: 'GPT-4' },
      });

      const lastWrite = res._written.at(-1);
      expect(lastWrite).toContain('"currentModel"');
      expect(lastWrite).toContain('"name":"GPT-4"');
    });
  });

  describe('broadcastModeChanged', () => {
    it('should write mode:changed event to matching connections', async () => {
      vi.mocked(sessionService.findById).mockResolvedValue({ id: 'sess-1' });
      vi.mocked(sessionService.getMessages).mockResolvedValue([]);
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const res = createMockResponse();

      await sessionSSEService.addConnection('sess-1', 'user-1', res as never);

      sessionSSEService.broadcastModeChanged('sess-1', { modeId: 'mode-2' });

      const lastWrite = res._written.at(-1);
      expect(lastWrite).toContain('"type":"mode:changed"');
      expect(lastWrite).toContain('"modeId":"mode-2"');
    });

    it('should not write when payload has no modeId', async () => {
      vi.mocked(sessionService.findById).mockResolvedValue({ id: 'sess-1' });
      vi.mocked(sessionService.getMessages).mockResolvedValue([]);
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const res = createMockResponse();

      await sessionSSEService.addConnection('sess-1', 'user-1', res as never);

      const before = res._written.length;
      sessionSSEService.broadcastModeChanged('sess-1', {});

      expect(res._written.length).toBe(before);
    });

    it('should not write to connections for other sessions', async () => {
      vi.mocked(sessionService.findById).mockResolvedValue({ id: 'sess-1' });
      vi.mocked(sessionService.getMessages).mockResolvedValue([]);
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const res = createMockResponse();

      await sessionSSEService.addConnection('sess-1', 'user-1', res as never);

      const before = res._written.length;
      sessionSSEService.broadcastModeChanged('sess-other', { modeId: 'mode-3' });

      expect(res._written.length).toBe(before);
    });
  });

  describe('removeConnections', () => {
    it('should end connections and clear heartbeat', async () => {
      vi.mocked(sessionService.findById).mockResolvedValue({ id: 'sess-1' });
      vi.mocked(sessionService.getMessages).mockResolvedValue([]);
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const res = createMockResponse();

      await sessionSSEService.addConnection('sess-1', 'user-1', res as never);

      sessionSSEService.removeConnections('sess-1');

      expect(res.end).toHaveBeenCalled();
    });
  });
});
