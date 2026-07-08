import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:net', () => ({
  default: {
    connect: vi.fn(),
  },
}));

import net from 'node:net';
import { GatewayManager } from './gateway.js';

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

  beforeEach(() => {
    vi.clearAllMocks();
    gatewayManager = new GatewayManager();
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
      expect(mockServerSocket.emit).toHaveBeenCalledWith('port-forward:created', {
        tunnelId: 'tunnel-1',
        success: true,
      });
    });

    it('should send port-forward:created(success: false, error) and destroy socket on connection failure', async () => {
      const mockLocalSocket = createMockLocalSocket();
      const mockServerSocket = createMockServerSocket();
      vi.mocked(net.connect).mockReturnValue(mockLocalSocket as never);

      const promise = gatewayManager.createTunnel('tunnel-1', 3000, mockServerSocket as never);
      mockLocalSocket._trigger('error', new Error('ECONNREFUSED'));
      await promise;

      expect(mockServerSocket.emit).toHaveBeenCalledWith('port-forward:created', {
        tunnelId: 'tunnel-1',
        success: false,
        error: 'ECONNREFUSED',
      });
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

    it('should send port-forward:close and remove tunnel when local socket closes', async () => {
      const mockLocalSocket = createMockLocalSocket();
      const mockServerSocket = createMockServerSocket();
      vi.mocked(net.connect).mockReturnValue(mockLocalSocket as never);

      const promise = gatewayManager.createTunnel('tunnel-1', 3000, mockServerSocket as never);
      mockLocalSocket._trigger('connect');
      await promise;

      mockLocalSocket._trigger('close');

      expect(mockServerSocket.emit).toHaveBeenCalledWith('port-forward:close', {
        tunnelId: 'tunnel-1',
      });
    });

    it('should send port-forward:error and remove tunnel when local socket errors after connect', async () => {
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

    it('should log warning and ignore for unknown tunnelId', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      gatewayManager.handleTunnelData('unknown-tunnel', 'data');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('unknown tunnel'),
      );
      warnSpy.mockRestore();
    });
  });

  describe('closeTunnel', () => {
    it('should destroy local socket and remove tunnel from map', async () => {
      const mockLocalSocket = createMockLocalSocket();
      const mockServerSocket = createMockServerSocket();
      vi.mocked(net.connect).mockReturnValue(mockLocalSocket as never);

      const promise = gatewayManager.createTunnel('tunnel-1', 3000, mockServerSocket as never);
      mockLocalSocket._trigger('connect');
      await promise;

      gatewayManager.closeTunnel('tunnel-1');

      expect(mockLocalSocket.destroy).toHaveBeenCalled();
    });

    it('should silently ignore unknown tunnelId', () => {
      expect(() => gatewayManager.closeTunnel('unknown-tunnel')).not.toThrow();
    });
  });

  describe('closeAll', () => {
    it('should close all tunnels and clear the map', async () => {
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
    });
  });
});
