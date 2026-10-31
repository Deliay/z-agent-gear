import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { User } from '../models/user.js';
import { verifyToken } from '../services/auth.js';
import { Gateway } from '../models/gateway.js';
import { getRedisClient } from '../middleware/redis.js';
import { publish } from '../middleware/publish.js';
import { logger as rootLogger } from '../observability/logger.js';

const router = Router();

const logger = rootLogger.child({ component: 'gateway-proxy' });

const COMMAND_CHANNEL = 'port-forward:command';
const RESPONSE_CHANNEL = 'port-forward:response';
const PROXY_TIMEOUT_MS = 30_000;

const gatewayResponseSubscriber = (() => {
  const sub = getRedisClient().duplicate();
  sub.subscribe(RESPONSE_CHANNEL).catch((err: Error) => {
    logger.error({ err, channel: RESPONSE_CHANNEL }, 'failed to subscribe to gateway response channel');
  });
  return sub;
})();

export async function authenticateExpressUser(req: Request): Promise<{ id: string; username: string } | null> {
  let token: string | undefined;

  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    token = header.slice(7);
  }

  if (!token) {
    token = req.cookies?.token;
  }

  if (!token) return null;

  try {
    const payload = verifyToken(token);
    const user = await User.findById(payload.userId).select('username');
    if (!user) return null;
    return { id: user._id.toString(), username: user.username };
  } catch {
    return null;
  }
}

router.all('/gateway/:controllerId/:name/{*path}', async (req: Request, res: Response) => {
  const currentUser = await authenticateExpressUser(req);
  if (!currentUser) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const controllerId = req.params.controllerId as string;
  const name = req.params.name as string;
  const subPath = (Array.isArray(req.params.path) ? '/' + (req.params.path as string[]).join('/') : (req.params.path as string) || '/');

  const record = await Gateway.findOne({ controllerId, name, status: 'active' });
  if (!record) {
    res.status(404).json({ error: 'Gateway not found or not active' });
    return;
  }

  const port = record.port;
  const requestId = crypto.randomUUID();

  const bodyChunks: Buffer[] = [];
  for await (const chunk of req) {
    bodyChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const body = bodyChunks.length > 0 ? Buffer.concat(bodyChunks).toString('base64') : undefined;

  const command: Record<string, unknown> = {
    type: 'proxy:request',
    requestId,
    controllerId,
    port,
    path: subPath,
    method: req.method,
    headers: req.headers,
    body,
  };

  const responsePromise = new Promise<{ status: number; headers: Record<string, string>; body: string } | null>((resolve) => {
    const timeout = setTimeout(() => resolve(null), PROXY_TIMEOUT_MS);

    const onMessage = (channel: string, message: string) => {
      if (channel !== RESPONSE_CHANNEL) return;
      try {
        const data = JSON.parse(message) as { requestId: string; statusCode: number; headers: Record<string, string>; body: string };
        if (data.requestId === requestId) {
          clearTimeout(timeout);
          gatewayResponseSubscriber.off('message', onMessage);
          resolve({ status: data.statusCode, headers: data.headers, body: data.body });
        }
      } catch {
        // ignore parse errors
      }
    };

    gatewayResponseSubscriber.on('message', onMessage);
    timeout.unref?.();
  });

  await publish(COMMAND_CHANNEL, command);
  const proxyResponse = await responsePromise;

  if (!proxyResponse) {
    res.status(502).json({ error: 'Proxy timeout' });
    return;
  }

  if (proxyResponse.headers) {
    for (const [key, value] of Object.entries(proxyResponse.headers)) {
      if (key.toLowerCase() !== 'transfer-encoding') {
        res.setHeader(key, value);
      }
    }
  }

  res.status(proxyResponse.status);
  if (proxyResponse.body) {
    res.send(Buffer.from(proxyResponse.body, 'base64'));
  } else {
    res.end();
  }
});

export const gatewayProxyRouter = router;
