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

import { WorkflowTemplatesService, WORKFLOW_TEMPLATES_RESULT_TTL_SECONDS } from './workflow-templates-service.js';
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

describe('WorkflowTemplatesService', () => {
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

  it('T-WTS2 分发：emit workflow-templates:scan 到正确 socket（requestId/path）', async () => {
    const service = new WorkflowTemplatesService();
    service.start(mockIO as never);

    await service.handleScan('req-1', 'ctrl-1', '/home/worker/workspace/project');

    expect(mockSocket.emit).toHaveBeenCalledWith('workflow-templates:scan', {
      requestId: 'req-1',
      path: '/home/worker/workspace/project',
      _meta: {},
    });
    expect(sessionService.getSocketId).toHaveBeenCalledWith('key-1');
  });

  it('T-WTS2b 控制器不存在 / 离线 / socket 缺失仅记 error，不 emit', async () => {
    const service = new WorkflowTemplatesService();
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
  });

  it('T-WTS3 结果写 workflow-templates:scan:{requestId} EX 60，payload 原样', async () => {
    const service = new WorkflowTemplatesService();
    const payload = {
      requestId: 'req-9',
      success: true,
      templates: [{ fileName: 'a.json', content: '{}' }],
      truncated: false,
    };

    await service.handleScanResult('req-9', payload);

    expect(mockRedisClient.set).toHaveBeenCalledWith(
      'workflow-templates:scan:req-9',
      JSON.stringify(payload),
      'EX',
      WORKFLOW_TEMPLATES_RESULT_TTL_SECONDS,
    );
    expect(WORKFLOW_TEMPLATES_RESULT_TTL_SECONDS).toBe(60);
  });

  it('T-WTS4 result.templates 非数组 → 兜底 success:false 落键', async () => {
    const service = new WorkflowTemplatesService();

    await service.handleScanResult('req-10', {
      requestId: 'req-10',
      success: true,
      templates: 'oops',
      truncated: false,
    });

    expect(mockRedisClient.set).toHaveBeenCalledWith(
      'workflow-templates:scan:req-10',
      JSON.stringify({ success: false, templates: [], truncated: false, error: 'not found' }),
      'EX',
      WORKFLOW_TEMPLATES_RESULT_TTL_SECONDS,
    );
  });
});
