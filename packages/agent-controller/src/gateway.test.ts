import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:net', () => ({
  default: {
    connect: vi.fn(),
  },
}));

import net from 'node:net';
import { GatewayManager } from './gateway.js';
import { createTestLogger, type TestLogger } from './observability/testing.js';

function createMockLocalSocket() {
  const handlers = new Map<string, Function>();
  return {
    once: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler);
    }),
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler);
    }),
    removeListener: vi.fn(),
    destroy: vi.fn(),
    write: vi.fn(),
    emit: vi.fn(),
    setKeepAlive: vi.fn(),
    _handlers: handlers,
    _trigger(event: string, ...args: unknown[]) {
      const handler = handlers.get(event);
      if (handler) handler(...args);
    },
  };
}

function createMockServerSocket() {
  return {
    emit: vi.fn(),
  };
}

describe('GatewayManager', () => {
  let gatewayManager: GatewayManager;
  let testLog: TestLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    testLog = createTestLogger('gateway');
    gatewayManager = new GatewayManager(testLog.logger);
  });

  describe('createTunnel', () => {
    it('should send port-forward:created(success: true) and store tunnel on connection success', async () => {
      const mockLocalSocket = createMockLocalSocket();
      const mockServerSocket = createMockServerSocket();
      vi.mocked(net.connect).mockReturnValue(mockLocalSocket as never);

      const promise = gatewayManager.createTunnel('tunnel-1', 3000, mockServerSocket as never);
      mockLocalSocket._trigger('connect');
      await promise;

      expect(net.connect).toHaveBeenCalledWith({ host: '127.0.0.1', port: 3000 });
      expect(mockLocalSocket.setKeepAlive).toHaveBeenCalledWith(true, 5000);
      expect(mockServerSocket.emit).toHaveBeenCalledWith('port-forward:created', {
        tunnelId: 'tunnel-1',
        success: true,
      });
    });

    it('should destroy socket and schedule reconnect on connection failure (not emit failure to server)', async () => {
      const mockLocalSocket = createMockLocalSocket();
      const mockServerSocket = createMockServerSocket();
      vi.mocked(net.connect).mockReturnValue(mockLocalSocket as never);

      const promise = gatewayManager.createTunnel('tunnel-1', 3000, mockServerSocket as never);
      mockLocalSocket._trigger('error', new Error('ECONNREFUSED'));
      await promise;

      expect(mockServerSocket.emit).not.toHaveBeenCalled();
      expect(mockLocalSocket.destroy).toHaveBeenCalled();
    });

    it('should send port-forward:data with base64 encoded data when local socket receives data', async () => {
      const mockLocalSocket = createMockLocalSocket();
      const mockServerSocket = createMockServerSocket();
      vi.mocked(net.connect).mockReturnValue(mockLocalSocket as never);

      const promise = gatewayManager.createTunnel('tunnel-1', 3000, mockServerSocket as never);
      mockLocalSocket._trigger('connect');
      await promise;

      const testData = Buffer.from('hello world');
      mockLocalSocket._trigger('data', testData);

      expect(mockServerSocket.emit).toHaveBeenCalledWith('port-forward:data', {
        tunnelId: 'tunnel-1',
        data: testData.toString('base64'),
      });
    });

    it('should schedule reconnect (not emit close) when local socket closes', async () => {
      const mockLocalSocket = createMockLocalSocket();
      const mockServerSocket = createMockServerSocket();
      vi.mocked(net.connect).mockReturnValue(mockLocalSocket as never);

      const promise = gatewayManager.createTunnel('tunnel-1', 3000, mockServerSocket as never);
      mockLocalSocket._trigger('connect');
      await promise;

      mockLocalSocket._trigger('close');

      expect(mockServerSocket.emit).not.toHaveBeenCalledWith('port-forward:close', expect.anything());
    });

    it('should send port-forward:error on local socket error after connect', async () => {
      const mockLocalSocket = createMockLocalSocket();
      const mockServerSocket = createMockServerSocket();
      vi.mocked(net.connect).mockReturnValue(mockLocalSocket as never);

      const promise = gatewayManager.createTunnel('tunnel-1', 3000, mockServerSocket as never);
      mockLocalSocket._trigger('connect');
      await promise;

      mockLocalSocket._trigger('error', new Error('ECONNRESET'));

      expect(mockServerSocket.emit).toHaveBeenCalledWith('port-forward:error', {
        tunnelId: 'tunnel-1',
        error: 'ECONNRESET',
      });
    });
  });

  describe('handleTunnelData', () => {
    it('should write base64 decoded data to the corresponding local socket', async () => {
      const mockLocalSocket = createMockLocalSocket();
      const mockServerSocket = createMockServerSocket();
      vi.mocked(net.connect).mockReturnValue(mockLocalSocket as never);

      const promise = gatewayManager.createTunnel('tunnel-1', 3000, mockServerSocket as never);
      mockLocalSocket._trigger('connect');
      await promise;

      const base64Data = Buffer.from('test payload').toString('base64');
      gatewayManager.handleTunnelData('tunnel-1', base64Data);

      expect(mockLocalSocket.write).toHaveBeenCalledWith(Buffer.from('test payload'));
    });

    it('should parse http-request JSON and write raw HTTP request to local socket', async () => {
      const mockLocalSocket = createMockLocalSocket();
      const mockServerSocket = createMockServerSocket();
      vi.mocked(net.connect).mockReturnValue(mockLocalSocket as never);

      const promise = gatewayManager.createTunnel('tunnel-1', 3000, mockServerSocket as never);
      mockLocalSocket._trigger('connect');
      await promise;

      const httpRequest = {
        type: 'http-request',
        requestId: 'req-1',
        method: 'POST',
        path: '/api/test',
        headers: { 'content-type': 'application/json', 'x-custom': 'val' },
        body: Buffer.from('{"key":"value"}').toString('base64'),
      };
      const base64Data = Buffer.from(JSON.stringify(httpRequest)).toString('base64');
      gatewayManager.handleTunnelData('tunnel-1', base64Data);

      const expected = 'POST /api/test HTTP/1.1\r\n' +
        'content-type: application/json\r\n' +
        'x-custom: val\r\n' +
        'Host: 127.0.0.1:3000\r\n' +
        'Connection: close\r\n' +
        '\r\n' +
        '{"key":"value"}';

      expect(mockLocalSocket.write).toHaveBeenCalledWith(expected);
    });

    it('should send raw base64 TCP response when no pending http-request', async () => {
      const mockLocalSocket = createMockLocalSocket();
      const mockServerSocket = createMockServerSocket();
      vi.mocked(net.connect).mockReturnValue(mockLocalSocket as never);

      const promise = gatewayManager.createTunnel('tunnel-1', 3000, mockServerSocket as never);
      mockLocalSocket._trigger('connect');
      await promise;

      const testData = Buffer.from('HTTP/1.1 200 OK\r\n\r\nok');
      mockLocalSocket._trigger('data', testData);

      expect(mockServerSocket.emit).toHaveBeenCalledWith('port-forward:data', {
        tunnelId: 'tunnel-1',
        data: testData.toString('base64'),
      });
    });

    it('should wrap TCP response in http-response JSON when pendingRequestId is set', async () => {
      vi.useFakeTimers();

      const mockLocalSocket = createMockLocalSocket();
      const mockServerSocket = createMockServerSocket();
      vi.mocked(net.connect).mockReturnValue(mockLocalSocket as never);

      const promise = gatewayManager.createTunnel('tunnel-1', 3000, mockServerSocket as never);
      mockLocalSocket._trigger('connect');
      await promise;

      const httpRequest = {
        type: 'http-request',
        requestId: 'req-42',
        method: 'GET',
        path: '/',
        headers: {},
      };
      gatewayManager.handleTunnelData('tunnel-1', Buffer.from(JSON.stringify(httpRequest)).toString('base64'));

      mockLocalSocket.write.mockClear();
      mockServerSocket.emit.mockClear();

      const tcpResponse = Buffer.from('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok');
      mockLocalSocket._trigger('data', tcpResponse);

      expect(mockServerSocket.emit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(150);

      expect(mockServerSocket.emit).toHaveBeenCalledWith('port-forward:data', expect.objectContaining({
        tunnelId: 'tunnel-1',
      }));
      const emitArg = mockServerSocket.emit.mock.calls.find(
        (c: any[]) => c[0] === 'port-forward:data',
      )?.[1];
      expect(emitArg).toBeDefined();
      const decoded = JSON.parse(Buffer.from(emitArg.data as string, 'base64').toString('utf8'));
      expect(decoded.type).toBe('http-response');
      expect(decoded.requestId).toBe('req-42');
      expect(decoded.body).toBe(tcpResponse.toString('base64'));

      vi.useRealTimers();
    });

    it('should log warning and ignore for unknown tunnelId', () => {
      gatewayManager.handleTunnelData('unknown-tunnel', 'data');
      expect(testLog.records).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          msg: expect.stringContaining('unknown tunnel'),
          tunnelId: 'unknown-tunnel',
        }),
      );
    });
  });

  describe('closeTunnel', () => {
    it('should destroy local socket, emit close, and remove tunnel from map', async () => {
      const mockLocalSocket = createMockLocalSocket();
      const mockServerSocket = createMockServerSocket();
      vi.mocked(net.connect).mockReturnValue(mockLocalSocket as never);

      const promise = gatewayManager.createTunnel('tunnel-1', 3000, mockServerSocket as never);
      mockLocalSocket._trigger('connect');
      await promise;

      gatewayManager.closeTunnel('tunnel-1');

      expect(mockLocalSocket.destroy).toHaveBeenCalled();
      expect(mockServerSocket.emit).toHaveBeenCalledWith('port-forward:close', {
        tunnelId: 'tunnel-1',
      });
    });

    it('should silently ignore unknown tunnelId', () => {
      expect(() => gatewayManager.closeTunnel('unknown-tunnel')).not.toThrow();
    });
  });

  describe('closeAll', () => {
    it('should close all tunnels, emit close events, and clear the map', async () => {
      const socket1 = createMockLocalSocket();
      const socket2 = createMockLocalSocket();
      const mockServerSocket = createMockServerSocket();
      vi.mocked(net.connect)
        .mockReturnValueOnce(socket1 as never)
        .mockReturnValueOnce(socket2 as never);

      const promise1 = gatewayManager.createTunnel('tunnel-1', 3000, mockServerSocket as never);
      socket1._trigger('connect');
      await promise1;

      const promise2 = gatewayManager.createTunnel('tunnel-2', 4000, mockServerSocket as never);
      socket2._trigger('connect');
      await promise2;

      gatewayManager.closeAll();

      expect(socket1.destroy).toHaveBeenCalled();
      expect(socket2.destroy).toHaveBeenCalled();
      expect(mockServerSocket.emit).toHaveBeenCalledWith('port-forward:close', {
        tunnelId: 'tunnel-1',
      });
      expect(mockServerSocket.emit).toHaveBeenCalledWith('port-forward:close', {
        tunnelId: 'tunnel-2',
      });
    });
  });
});
