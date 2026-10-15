import { isTrustedProxy } from '../config/index.js';

/** 可从 Fetch `Request` 或 Node `IncomingMessage` 上探测到的底层对端地址载体。 */
interface PeerLike {
  socket?: { remoteAddress?: string | null } | null;
  server?: { request?: { socket?: { remoteAddress?: string | null } } | null } | null;
}

function normalize(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 从底层 socket 探测对端地址（Node IncomingMessage / 兼容挂在 Fetch Request 上的形态）。 */
function socketPeer(source: unknown): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const obj = source as PeerLike;
  return (
    normalize(obj.socket?.remoteAddress) ??
    normalize(obj.server?.request?.socket?.remoteAddress)
  );
}

/**
 * 提取客户端 IP 供登录限速使用（问题 49）。
 *
 * 安全前提：`x-forwarded-for` / `x-real-ip` 可被客户端伪造，默认**不信任**：
 * 1. 优先取底层 socket 对端地址（Node 由 `@whatwg-node/server` 以 `req` 形式透传给 context）；
 * 2. **仅当对端命中受信代理列表**（`TRUST_PROXY`，问题 57）时，才信任转发头，且取
 *    `x-forwarded-for` 的**末跳**（末跳由受信代理追加；首跳可被客户端伪造）。
 *
 * 无法确定对端时返回空串，调用方据此跳过按 IP 限速——绝不回落共享的 `unknown` 桶
 * （否则对单一管理员的失败即锁死全站）。
 */
export function clientIpFrom(request: Request, nodeRequest?: unknown): string {
  const peer = socketPeer(nodeRequest) ?? socketPeer(request);

  if (peer && isTrustedProxy(peer)) {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
      const hops = forwarded.split(',').map((h) => h.trim()).filter(Boolean);
      const last = hops[hops.length - 1];
      if (last) return last;
    }
    const realIp = normalize(request.headers.get('x-real-ip'));
    if (realIp) return realIp;
  }

  return peer ?? '';
}
