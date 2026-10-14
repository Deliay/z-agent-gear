import { describe, it, expect } from 'vitest';
import { io, type Socket } from 'socket.io-client';

// cloud-controller `/worker` namespace 握手鉴权（契约 §3.1）。
//
// 合法的「一次性 token」仅在 cloud-controller 进程内签发并注入 K8s Job env，
// 外部无法取得，因此本套件覆盖「非法/缺失 token 被拒绝」这一可外部验证的边界；
// 合法握手 + register 绑定 + shutdown 触发退出由 cloud-controller 单测
// （servers/cloud-controller/src/services/socketio-gateway.test.ts，真实 socket.io-client）
// 与部署侧真实集群链路验收覆盖。
const HTTP_BASE = process.env.CLOUD_CONTROLLER_URL || 'http://localhost:10004';

function connect(token?: string): Socket {
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  return io(`${HTTP_BASE}/worker${query}`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
}

function waitError(socket: Socket, timeoutMs = 5000): Promise<Error> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for connect_error')), timeoutMs);
    socket.once('connect_error', (err: Error) => {
      clearTimeout(timer);
      resolve(err);
    });
  });
}

describe('cloud-controller worker handshake', () => {
  it('T-IW1: rejects a connection without a token', async () => {
    const socket = connect();
    const err = await waitError(socket);
    expect(err.message).toBe('INVALID_TOKEN');
    socket.close();
  });

  it('T-IW1: rejects a forged token', async () => {
    const socket = connect('forged-container.deadbeef');
    const err = await waitError(socket);
    expect(err.message).toBe('INVALID_TOKEN');
    socket.close();
  });
});
