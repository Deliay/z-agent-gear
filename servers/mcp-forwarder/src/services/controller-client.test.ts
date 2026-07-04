import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/index.js', () => ({
  env: {
    port: 3002,
    jwtSecret: 'test-secret',
    controllerApiUrl: 'http://localhost:4001',
    mongodbUri: 'mongodb://localhost:27017/test',
  },
}));

vi.mock('socket.io-client', () => ({
  io: vi.fn().mockReturnValue({
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    connected: true,
  }),
}));

import { getControllerSocket, forwardToProxy } from './controller-client.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('controller-client', () => {
  it('should return a socket instance', () => {
    const socket = getControllerSocket();
    expect(socket).toBeDefined();
  });

  it('should return the same socket instance on multiple calls', () => {
    const socket1 = getControllerSocket();
    const socket2 = getControllerSocket();
    expect(socket1).toBe(socket2);
  });

  it('should forward request to proxy', async () => {
    const mockSocket = getControllerSocket();
    vi.mocked(mockSocket.emit).mockImplementation((_event: string, _data: any, callback: Function) => {
      callback({ data: { jsonrpc: '2.0', id: 1, result: { tools: [] } } });
      return mockSocket;
    });

    const result = await forwardToProxy('server-1', { method: 'tools/list' });

    expect(result).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
  });
});
