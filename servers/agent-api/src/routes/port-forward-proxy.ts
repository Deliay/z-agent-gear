import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { User } from '../models/user.js';
import { verifyToken } from '../services/auth.js';
import { PortForward } from '../models/port-forward.js';
import { getRedisClient } from '../middleware/redis.js';

const router = Router();

const COMMAND_CHANNEL = 'port-forward:command';
const RESPONSE_CHANNEL = 'port-forward:response';
const PROXY_TIMEOUT_MS = 30_000;

async function authenticateExpressUser(req: Request): Promise<{ id: string; username: string } | null> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice(7);
  try {
    const payload = verifyToken(token);
    const user = await User.findById(payload.userId).select('username');
    if (!user) return null;
    return { id: user._id.toString(), username: user.username };
  } catch {
    return null;
  }
}

router.all('/forward/:controllerId/:port/*', async (req: Request, res: Response) => {
  const currentUser = await authenticateExpressUser(req);
  if (!currentUser) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const controllerId = req.params.controllerId as string;
  const port = Number(req.params.port as string);
  const subPath = req.params[0] as string || '/';

  const record = await PortForward.findOne({ controllerId, port, status: 'active' });
  if (!record) {
    res.status(404).json({ error: 'Port forward not found or not active' });
    return;
  }

  const requestId = crypto.randomUUID();
  const redis = getRedisClient();

  const bodyChunks: Buffer[] = [];
  for await (const chunk of req) {
    bodyChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const body = bodyChunks.length > 0 ? Buffer.concat(bodyChunks).toString('base64') : undefined;

  const command = JSON.stringify({
    type: 'proxy:request',
    requestId,
    controllerId,
    port,
    path: subPath,
    method: req.method,
    headers: req.headers,
    body,
  });

  const subscriber = redis.duplicate();
  await subscriber.connect();

  try {
    const responsePromise = new Promise<{ status: number; headers: Record<string, string>; body: string } | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), PROXY_TIMEOUT_MS);

      subscriber.on('message', (channel: string, message: string) => {
        if (channel !== RESPONSE_CHANNEL) return;
        try {
          const data = JSON.parse(message);
          if (data.requestId === requestId) {
            clearTimeout(timeout);
            resolve(data);
          }
        } catch {
          // ignore parse errors
        }
      });

      subscriber.subscribe(RESPONSE_CHANNEL);
    });

    await redis.publish(COMMAND_CHANNEL, command);
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
  } finally {
    await subscriber.unsubscribe(RESPONSE_CHANNEL);
    await subscriber.quit();
  }
});

export const portForwardProxyRouter = router;
