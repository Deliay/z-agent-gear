import { describe, expect, it } from 'vitest';
import {
  describeConnection,
  describeDisconnect,
  redactLogValue,
} from './socket-diagnostics.js';

interface TestSocket {
  id: string;
  nsp: { name: string };
  data: Record<string, unknown>;
  handshake: {
    address: string;
    headers: Record<string, string | string[] | undefined>;
    query: Record<string, unknown>;
    auth: Record<string, unknown>;
  };
}

function createDiagnosticSocket(overrides: Record<string, unknown> = {}): TestSocket {
  const socket: TestSocket = {
    id: 'socket-123',
    nsp: { name: '/' },
    data: {},
    handshake: {
      address: '10.0.0.1',
      headers: {
        origin: 'https://app.example.com',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0',
        'x-forwarded-for': '203.0.113.7, 10.0.0.1',
      },
      query: {
        EIO: '4',
        transport: 'websocket',
      },
      auth: {},
    },
  };
  return { ...socket, ...overrides } as TestSocket;
}


describe('socket-diagnostics', () => {
  describe('describeConnection', () => {
    it('includes who is connecting: id, address, transport, namespace and UA', () => {
      const line = describeConnection(createDiagnosticSocket() as never);

      expect(line).toContain('[socket] connected');
      expect(line).toContain('id=socket-123');
      expect(line).toContain('address=10.0.0.1');
      expect(line).toContain('transport=websocket');
      expect(line).toContain('ns=/');
      expect(line).toContain('origin=https://app.example.com');
      expect(line).toContain('ua="Mozilla/5.0');
      expect(line).toContain('xff="203.0.113.7, 10.0.0.1"');
    });

    it('redacts sensitive query values and keeps query keys for diagnosis', () => {
      const socket = createDiagnosticSocket();
      socket.handshake.query = {
        EIO: '4',
        token: 'super-secret-token',
        key: 'zag_k_1_secret',
      };

      const line = describeConnection(socket as never);

      expect(line).toContain('"EIO":"4"');
      expect(line).toContain('"token":"***"');
      expect(line).toContain('"key":"***"');
      expect(line).not.toContain('super-secret-token');
      expect(line).not.toContain('zag_k_1_secret');
    });

    it('logs only auth key names so credentials never reach logs', () => {
      const socket = createDiagnosticSocket();
      socket.handshake.auth = { token: 'secret-in-auth' };

      const line = describeConnection(socket as never);

      expect(line).toContain('auth=[token]');
      expect(line).not.toContain('secret-in-auth');
    });

    it('marks anonymous connections with auth=[] and skips missing headers', () => {
      const socket = createDiagnosticSocket();
      socket.handshake.headers = {};
      socket.handshake.auth = {};
      socket.handshake.query = {};

      const line = describeConnection(socket as never);

      expect(line).toContain('auth=[]');
      expect(line).not.toContain('origin=');
      expect(line).not.toContain('ua=');
      expect(line).toContain('query={}');
    });

    it('truncates oversized header values to keep a single line', () => {
      const socket = createDiagnosticSocket();
      socket.handshake.headers['user-agent'] = 'u'.repeat(500);

      const line = describeConnection(socket as never);

      expect(line.length).toBeLessThan(500);
      expect(line).toContain('truncated');
    });
  });

  describe('describeDisconnect', () => {
    it('logs disconnect reason and authenticated identity in one line', () => {
      const socket = createDiagnosticSocket({
        data: { keyId: 'key123' },
      });

      const line = describeDisconnect(socket as never, 'transport close');

      expect(line).toBe(
        '[socket] disconnected id=socket-123 address=10.0.0.1 ns=/ key=key123 authenticated=true reason=transport close',
      );
    });

    it('does not print "undefined" for anonymous disconnects', () => {
      const line = describeDisconnect(createDiagnosticSocket() as never, 'client namespace disconnect');

      expect(line).toContain('key=-');
      expect(line).toContain('authenticated=false');
      expect(line).not.toContain('undefined');
    });

    it('appends a sanitized description when provided', () => {
      const line = describeDisconnect(
        createDiagnosticSocket() as never,
        'server namespace disconnect',
        new Error('forced close'),
      );

      expect(line).toContain('desc="forced close"');
    });
  });

  describe('redactLogValue', () => {
    it('never returns sensitive values', () => {
      expect(redactLogValue('authorization', 'Bearer abc')).toBe('***');
      expect(redactLogValue('cookie', 'a=b')).toBe('***');
      expect(redactLogValue('transport', 'websocket')).toBe('websocket');
    });
  });
});
