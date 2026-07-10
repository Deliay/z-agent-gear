import net from 'node:net';
import type { Socket } from 'socket.io-client';

interface Tunnel {
  id: string;
  port: number;
  localSocket: net.Socket | null;
  serverSocket: Socket;
  pendingRequestId?: string | null;
  responseBuffer: Buffer[];
  responseTimer?: ReturnType<typeof setTimeout> | null;
}

const RECONNECT_INTERVAL_MS = 3000;
const HTTP_RESPONSE_COLLECT_MS = 100;

export class GatewayManager {
  private tunnels: Map<string, Tunnel> = new Map();
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  async createTunnel(tunnelId: string, port: number, serverSocket: Socket): Promise<void> {
    this.tunnels.set(tunnelId, { id: tunnelId, port, localSocket: null, serverSocket, responseBuffer: [] });
    await this.connect(tunnelId, true);
  }

  private async connect(tunnelId: string, isInitial: boolean): Promise<void> {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) return;

    const localSocket = net.connect({ host: '127.0.0.1', port: tunnel.port });
    localSocket.setKeepAlive(true, 5000);

    return new Promise<void>((resolve) => {
      const onError = (err: Error) => {
        console.error(`Gateway tunnel error: tunnelId=${tunnelId} error=${err.message}`);
        localSocket.destroy();
        this.scheduleReconnect(tunnelId);
        resolve();
      };

      localSocket.once('error', onError);

      localSocket.once('connect', () => {
        localSocket.removeListener('error', onError);

        tunnel.localSocket = localSocket;
        console.log(`Gateway tunnel connected: tunnelId=${tunnelId} port=${tunnel.port}`);

        if (isInitial) {
          tunnel.serverSocket.emit('port-forward:created', { tunnelId, success: true });
        }

        localSocket.on('data', (data: Buffer) => {
          if (tunnel.pendingRequestId) {
            tunnel.responseBuffer.push(data);
            if (tunnel.responseTimer) clearTimeout(tunnel.responseTimer);
            tunnel.responseTimer = setTimeout(() => this.flushResponse(tunnel), HTTP_RESPONSE_COLLECT_MS);
          } else {
            tunnel.serverSocket.emit('port-forward:data', {
              tunnelId,
              data: data.toString('base64'),
            });
          }
        });

        localSocket.on('close', () => {
          console.log(`Gateway local socket closed: tunnelId=${tunnelId}`);
          tunnel.localSocket = null;
          this.scheduleReconnect(tunnelId);
        });

        localSocket.on('error', (err: Error) => {
          console.error(`Gateway local socket error: tunnelId=${tunnelId} error=${err.message}`);
          tunnel.serverSocket.emit('port-forward:error', { tunnelId, error: err.message });
        });

        resolve();
      });
    });
  }

  private flushResponse(tunnel: Tunnel): void {
    if (!tunnel.pendingRequestId) return;
    const combined = Buffer.concat(tunnel.responseBuffer);
    tunnel.responseBuffer = [];
    const requestId = tunnel.pendingRequestId;
    tunnel.pendingRequestId = null;
    tunnel.responseTimer = null;

    tunnel.serverSocket.emit('port-forward:data', {
      tunnelId: tunnel.id,
      data: Buffer.from(JSON.stringify({
        type: 'http-response',
        requestId,
        body: combined.toString('base64'),
      })).toString('base64'),
    });
  }

  private scheduleReconnect(tunnelId: string): void {
    if (!this.tunnels.has(tunnelId) || this.reconnectTimers.has(tunnelId)) return;

    console.log(`Gateway scheduling reconnection: tunnelId=${tunnelId}`);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(tunnelId);
      this.connect(tunnelId, false);
    }, RECONNECT_INTERVAL_MS);

    this.reconnectTimers.set(tunnelId, timer);
  }

  handleTunnelData(tunnelId: string, data: string): void {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) {
      console.warn(`Gateway data for unknown tunnel: tunnelId=${tunnelId}`);
      return;
    }

    const buffer = Buffer.from(data, 'base64');
    let parsed: any;
    try {
      parsed = JSON.parse(buffer.toString('utf8'));
    } catch {
      if (tunnel.localSocket) {
        tunnel.localSocket.write(buffer);
      }
      return;
    }

    if (parsed.type === 'http-request') {
      const { method, path, headers, body } = parsed;
      let rawRequest = `${method} ${path} HTTP/1.1\r\n`;
      for (const [key, value] of Object.entries(headers || {})) {
        rawRequest += `${key}: ${value}\r\n`;
      }
      rawRequest += `Host: 127.0.0.1:${tunnel.port}\r\n`;
      rawRequest += 'Connection: close\r\n';
      rawRequest += '\r\n';
      if (body) rawRequest += Buffer.from(body, 'base64').toString('utf8');

      tunnel.pendingRequestId = parsed.requestId;
      tunnel.responseBuffer = [];

      if (tunnel.localSocket) {
        tunnel.localSocket.write(rawRequest);
      }
      return;
    }

    if (tunnel.localSocket) {
      tunnel.localSocket.write(buffer);
    }
  }

  closeTunnel(tunnelId: string): void {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) return;

    console.log(`Gateway closing tunnel: tunnelId=${tunnelId}`);

    const timer = this.reconnectTimers.get(tunnelId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(tunnelId);
    }

    this.tunnels.delete(tunnelId);

    if (tunnel.localSocket) {
      tunnel.localSocket.destroy();
    }
    tunnel.serverSocket.emit('port-forward:close', { tunnelId });
  }

  closeAll(): void {
    console.log(`Gateway closing all tunnels: count=${this.tunnels.size}`);

    for (const [tunnelId, tunnel] of [...this.tunnels]) {
      const timer = this.reconnectTimers.get(tunnelId);
      if (timer) {
        clearTimeout(timer);
        this.reconnectTimers.delete(tunnelId);
      }

      this.tunnels.delete(tunnelId);

      if (tunnel.localSocket) {
        tunnel.localSocket.destroy();
      }
      tunnel.serverSocket.emit('port-forward:close', { tunnelId: tunnel.id });
    }
  }
}

export const gatewayManager = new GatewayManager();
