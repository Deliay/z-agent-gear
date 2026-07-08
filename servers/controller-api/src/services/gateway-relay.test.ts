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

vi.mock('node:crypto', () => ({
  default: { randomUUID: vi.fn(() => 'mock-uuid') },
}));

import { GatewayRelayService } from './gateway-relay.js';
import { getRedisClient } from '../middleware/redis.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';

function createMockSocket(id = 'socket-123') {
  return { emit: vi.fn(), id };
}

function createMockIO() {
  return {
    sockets: {
      sockets: new Map<string, ReturnType<typeof createMockSocket>>(),
    },
  };
}

function createMockRedis() {
  const messageHandlers: ((channel: string, message: string) => void)[] = [];
  return {
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn(),
    on: vi.fn((event: string, handler: (channel: string, message: string) => void) => {
      if (event === 'message') {
        messageHandlers.push(handler);
      }
    }),
    duplicate: vi.fn().mockImplementation(() => createMockRedis()),
    _emitMessage: (channel: string, message: string) => {
      messageHandlers.forEach((h) => { h(channel, message); });
    },
  };
}

describe('GatewayRelayService', () => {
  let service: GatewayRelayService;
  let mockSocket: ReturnType<typeof createMockSocket>;
  let mockIO: ReturnType<typeof createMockIO>;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRedis = createMockRedis();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);

    mockSocket = createMockSocket();
    mockIO = createMockIO();
    mockIO.sockets.sockets.set('socket-123', mockSocket);

    vi.mocked(Controller.findById).mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'ctrl-1',
        keyId: { toString: () => 'key-1' },
      }),
    } as never);
    vi.mocked(sessionService.getSocketId).mockResolvedValue('socket-123');

    service = new GatewayRelayService();
  });

  describe('start', () => {
    it('should store IO reference', () => {
      service.start(mockIO as never);
      expect((service as any).io).toBe(mockIO);
    });
  });

  describe('handleTunnelCreated', () => {
    it('should not remove tunnel on success', () => {
      (service as any).tunnels.set('tunnel-1', {
        controllerId: 'ctrl-1',
        port: 8080,
        socketId: 'socket-123',
      });

      service.handleTunnelCreated('tunnel-1', true);

      expect((service as any).tunnels.has('tunnel-1')).toBe(true);
    });

    it('should remove tunnel from tunnels map on failure', () => {
      (service as any).tunnels.set('tunnel-1', {
        controllerId: 'ctrl-1',
        port: 8080,
        socketId: 'socket-123',
      });

      service.handleTunnelCreated('tunnel-1', false, 'connection refused');

      expect((service as any).tunnels.has('tunnel-1')).toBe(false);
    });
  });

  describe('handleTunnelClose', () => {
    it('should remove tunnel from tunnels map', () => {
      (service as any).tunnels.set('tunnel-1', {
        controllerId: 'ctrl-1',
        port: 8080,
        socketId: 'socket-123',
      });

      service.handleTunnelClose('tunnel-1');

      expect((service as any).tunnels.has('tunnel-1')).toBe(false);
    });

    it('should clean up associated proxy request contexts', () => {
      const publishSpy = vi.spyOn(service as any, 'publishResponse').mockResolvedValue(undefined);

      (service as any).tunnels.set('tunnel-1', {
        controllerId: 'ctrl-1',
        port: 8080,
        socketId: 'socket-123',
      });

      const timeout = setTimeout(() => {}, 30_000);
      (service as any).proxyRequests.set('req-1', {
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        port: 8080,
        socket: mockSocket,
        responseChunks: [],
        resolved: false,
        timeout,
      });

      service.handleTunnelClose('tunnel-1');

      expect((service as any).proxyRequests.has('req-1')).toBe(false);
      expect(publishSpy).toHaveBeenCalledWith('req-1', 502, {}, 'Tunnel closed');

      publishSpy.mockRestore();
    });
  });

  describe('handleTunnelError', () => {
    it('should call handleTunnelClose for cleanup', () => {
      const closeSpy = vi.spyOn(service, 'handleTunnelClose');

      service.handleTunnelError('tunnel-1', 'connection lost');

      expect(closeSpy).toHaveBeenCalledWith('tunnel-1');

      closeSpy.mockRestore();
    });
  });

  describe('handleTunnelData', () => {
    it('should parse http-response and publish to Redis response channel', async () => {
      service.start(mockIO as never);

      (service as any).tunnels.set('tunnel-1', {
        controllerId: 'ctrl-1',
        port: 8080,
        socketId: 'socket-123',
      });

      const timeout = setTimeout(() => {}, 30_000);
      (service as any).proxyRequests.set('req-1', {
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        port: 8080,
        socket: mockSocket,
        responseChunks: [],
        resolved: false,
        timeout,
      });

      const responseBody = Buffer.from('hello').toString('base64');
      const data = Buffer.from(JSON.stringify({
        type: 'http-response',
        requestId: 'req-1',
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
        body: responseBody,
      }));

      service.handleTunnelData('tunnel-1', data);

      await vi.waitFor(() => {
        expect(mockRedis.publish).toHaveBeenCalledWith(
          'port-forward:response',
          JSON.stringify({
            requestId: 'req-1',
            statusCode: 200,
            headers: { 'content-type': 'text/plain' },
            body: responseBody,
          }),
        );
      });

      expect((service as any).proxyRequests.has('req-1')).toBe(false);
    });

    it('should ignore data when no matching proxy request exists', () => {
      service.start(mockIO as never);

      const data = Buffer.from(JSON.stringify({
        type: 'http-response',
        requestId: 'req-unknown',
        statusCode: 200,
        headers: {},
        body: '',
      }));

      service.handleTunnelData('tunnel-1', data);

      expect(mockRedis.publish).not.toHaveBeenCalled();
    });
  });

  describe('handleTunnelCreate (via command channel)', () => {
    it('should send port-forward:create event via Socket.IO', async () => {
      service.start(mockIO as never);

      await (service as any).handleTunnelCreate('ctrl-1', 8080);

      expect(mockSocket.emit).toHaveBeenCalledWith('port-forward:create', {
        tunnelId: 'ctrl-1:8080:mock-uuid',
        port: 8080,
      });
      expect((service as any).tunnels.has('ctrl-1:8080:mock-uuid')).toBe(true);
    });

    it('should log error when controller is offline', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(Controller.findById).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      service.start(mockIO as never);

      await (service as any).handleTunnelCreate('ctrl-offline', 8080);

      expect(consoleSpy).toHaveBeenCalledWith('Controller offline: ctrl-offline');
      expect(mockSocket.emit).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('handleProxyRequest (via command channel)', () => {
    it('should publish 502 response when no tunnel found', async () => {
      service.start(mockIO as never);

      await (service as any).handleProxyRequest({
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        port: 9090,
        path: '/',
        method: 'GET',
        headers: {},
      });

      expect(mockRedis.publish).toHaveBeenCalledWith(
        'port-forward:response',
        JSON.stringify({
          requestId: 'req-1',
          statusCode: 502,
          headers: {},
          body: 'No tunnel available',
        }),
      );
    });
  });
});
