import { io as ioClient, Socket } from 'socket.io-client';
import { env } from '../config/index.js';

let controllerSocket: Socket | null = null;

export function getControllerSocket(): Socket {
  if (!controllerSocket) {
    controllerSocket = ioClient(env.controllerApiUrl, {
      transports: ['websocket'],
      autoConnect: true,
    });

    controllerSocket.on('connect', () => {
      console.log('Connected to controller-api');
    });

    controllerSocket.on('disconnect', () => {
      console.log('Disconnected from controller-api');
    });
  }
  return controllerSocket;
}

export async function forwardToProxy(serverId: string, request: any): Promise<any> {
  const socket = getControllerSocket();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Request timeout'));
    }, 30000);

    socket.emit('mcp:forward', { serverId, request }, (response: any) => {
      clearTimeout(timeout);
      if (response.error) {
        reject(new Error(response.error));
      } else {
        resolve(response.data);
      }
    });
  });
}
