import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('../models/controller.js', () => ({
  Controller: {
    findById: vi.fn(),
  },
}));

vi.mock('./session.js', () => ({
  sessionService: {
    getSocketId: vi.fn(),
  },
}));

import {
  KnowledgeBasesService,
  KNOWLEDGE_BASES_RESULT_TTL_SECONDS,
} from './knowledge-bases-service.js';
import { getRedisClient } from '../middleware/redis.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';

function createMockSocket() {
  return { emit: vi.fn() };
}

function createMockIO() {
  return {
    sockets: {
      sockets: new Map<string, ReturnType<typeof createMockSocket>>(),
    },
  };
}

describe('KnowledgeBasesService', () => {
  let mockSocket: ReturnType<typeof createMockSocket>;
  let mockIO: ReturnType<typeof createMockIO>;
  let mockRedisClient: { set: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockSocket = createMockSocket();
    mockIO = createMockIO();
    mockIO.sockets.sockets.set('socket-123', mockSocket);

    mockRedisClient = { set: vi.fn().mockResolvedValue('OK') };
    vi.mocked(getRedisClient).mockReturnValue(mockRedisClient as never);
    vi.mocked(Controller.findById).mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'ctrl-1',
        keyId: { toString: () => 'key-1' },
      }),
    } as never);
    vi.mocked(sessionService.getSocketId).mockResolvedValue('socket-123');
  });

  it('T-RKB-RELAY2 分发：emit knowledge-bases:scan 到正确 socket（requestId/path）', async () => {
    const service = new KnowledgeBasesService();
    service.start(mockIO as never);

    await service.handleScan('req-1', 'ctrl-1', '/home/worker/workspace/project');

    expect(mockSocket.emit).toHaveBeenCalledWith('knowledge-bases:scan', {
      requestId: 'req-1',
      path: '/home/worker/workspace/project',
      _meta: {},
    });
    expect(sessionService.getSocketId).toHaveBeenCalledWith('key-1');
  });

  it('T-RKB-RELAY2b 控制器不存在 / 离线 / socket 缺失仅记 error，不 emit', async () => {
    const service = new KnowledgeBasesService();
    service.start(mockIO as never);

    vi.mocked(Controller.findById).mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue(null),
    } as never);
    await service.handleScan('req-2', 'ctrl-x', '/a');

    vi.mocked(sessionService.getSocketId).mockResolvedValueOnce(null);
    await service.handleScan('req-3', 'ctrl-1', '/a');

    vi.mocked(sessionService.getSocketId).mockResolvedValueOnce('missing-socket');
    await service.handleScan('req-4', 'ctrl-1', '/a');

    expect(mockSocket.emit).not.toHaveBeenCalled();
    expect(mockRedisClient.set).not.toHaveBeenCalled();
  });

  it('T-RKB-RELAY3 结果写 knowledge-bases:scan:{requestId} EX 60，payload 原样', async () => {
    const service = new KnowledgeBasesService();
    const payload = {
      requestId: 'req-9',
      success: true,
      sources: [
        {
          source: 'zag',
          knowledgeBases: [{ folder: 'a', schema: '{"name":"A"}', documents: [] }],
          truncated: false,
        },
      ],
      truncated: false,
    };

    await service.handleScanResult('req-9', payload);

    expect(mockRedisClient.set).toHaveBeenCalledWith(
      'knowledge-bases:scan:req-9',
      JSON.stringify(payload),
      'EX',
      KNOWLEDGE_BASES_RESULT_TTL_SECONDS,
    );
  });

  it('T-RKB-RELAY4 sources 非数组 → 兜底整体失败落键', async () => {
    const service = new KnowledgeBasesService();

    await service.handleScanResult('req-10', { requestId: 'req-10', success: true, sources: 'bad' });

    expect(mockRedisClient.set).toHaveBeenCalledWith(
      'knowledge-bases:scan:req-10',
      JSON.stringify({ success: false, sources: [], truncated: false, error: 'not found' }),
      'EX',
      KNOWLEDGE_BASES_RESULT_TTL_SECONDS,
    );
  });
});
