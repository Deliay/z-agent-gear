import net from 'node:net';
import type { Socket } from 'socket.io-client';

interface Tunnel {
  id: string;
  port: number;
  localSocket: net.Socket;
}

export class GatewayManager {
  private tunnels: Map<string, Tunnel> = new Map();

  async createTunnel(tunnelId: string, port: number, serverSocket: Socket): Promise<void> {
    const localSocket = net.connect({ host: '127.0.0.1', port });

    return new Promise<void>((resolve) => {
      const onError = (err: Error) => {
        console.error(`Gateway tunnel error: tunnelId=${tunnelId} error=${err.message}`);
        serverSocket.emit('port-forward:created', {
          tunnelId,
          success: false,
          error: err.message,
        });
        localSocket.destroy();
        resolve();
      };

      localSocket.once('error', onError);

      localSocket.once('connect', () => {
        localSocket.removeListener('error', onError);

        this.tunnels.set(tunnelId, { id: tunnelId, port, localSocket });
        console.log(`Gateway tunnel created: tunnelId=${tunnelId} port=${port}`);

        serverSocket.emit('port-forward:created', { tunnelId, success: true });

        localSocket.on('data', (data: Buffer) => {
          serverSocket.emit('port-forward:data', {
            tunnelId,
            data: data.toString('base64'),
          });
        });

        localSocket.on('close', () => {
          console.log(`Gateway local socket closed: tunnelId=${tunnelId}`);
          this.tunnels.delete(tunnelId);
          serverSocket.emit('port-forward:close', { tunnelId });
        });

        localSocket.on('error', (err: Error) => {
          console.error(`Gateway local socket error: tunnelId=${tunnelId} error=${err.message}`);
          this.tunnels.delete(tunnelId);
          serverSocket.emit('port-forward:error', { tunnelId, error: err.message });
        });

        resolve();
      });
    });
  }

  handleTunnelData(tunnelId: string, data: string): void {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) {
      console.warn(`Gateway data for unknown tunnel: tunnelId=${tunnelId}`);
      return;
    }
    tunnel.localSocket.write(Buffer.from(data, 'base64'));
  }

  closeTunnel(tunnelId: string): void {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) return;
    console.log(`Gateway closing tunnel: tunnelId=${tunnelId}`);
    tunnel.localSocket.destroy();
    this.tunnels.delete(tunnelId);
  }

  closeAll(): void {
    console.log(`Gateway closing all tunnels: count=${this.tunnels.size}`);
    for (const tunnel of this.tunnels.values()) {
      tunnel.localSocket.destroy();
    }
    this.tunnels.clear();
  }
}

export const gatewayManager = new GatewayManager();
