import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { McpServer } from '../models/mcp-server.js';
import { getRedisClient } from '../middleware/redis.js';
import { mcpEndpointService } from '../services/mcp-endpoint.js';
import { mcpForwarder, ForwardError } from '../services/mcp-forwarder.js';

const router = Router();

interface McpTokenPayload {
  sessionId?: string;
  userId?: string;
  serverNames?: string[];
}

function jsonRpcError(res: Response, id: unknown, code: string, message: string): void {
  res.status(200).json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

const mcpEntryHandler = async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const pathServerName = req.params.serverName as string | undefined;

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

  if (!token) {
    res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: 'ENDPOINT_REVOKED', message: 'Invalid token' } });
    return;
  }

  let payload: McpTokenPayload;
  try {
    payload = jwt.verify(token, config.mcpEndpointJwtSecret) as McpTokenPayload;
  } catch {
    res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: 'ENDPOINT_REVOKED', message: 'Invalid token' } });
    return;
  }

  if (!payload.sessionId || payload.sessionId !== sessionId) {
    res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: 'ENDPOINT_REVOKED', message: 'Invalid token' } });
    return;
  }

  const status = await mcpEndpointService.getStatus(sessionId);
  if (status !== 'active') {
    res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: 'ENDPOINT_REVOKED', message: 'Invalid token' } });
    return;
  }

  const request = req.body as {
    jsonrpc?: string;
    method?: string;
    id?: unknown;
    params?: { serverName?: string };
  };
  if (!request?.jsonrpc || !request.method) {
    res.status(400).json({
      jsonrpc: '2.0',
      id: request?.id ?? null,
      error: { code: 'INVALID_REQUEST', message: 'Invalid JSON-RPC request' },
    });
    return;
  }

  // Per-server URL path takes precedence; fall back to params.serverName
  // (legacy clients), then to the first assembled server.
  const serverName = pathServerName ?? request.params?.serverName ?? payload.serverNames?.[0];
  if (!serverName) {
    res.status(400).json({
      jsonrpc: '2.0',
      id: request.id ?? null,
      error: { code: 'INVALID_REQUEST', message: 'No server name specified' },
    });
    return;
  }

  // The target server must have been assembled into this session at creation time.
  if (payload.serverNames && !payload.serverNames.includes(serverName)) {
    jsonRpcError(res, request.id, 'SERVER_NOT_FOUND', 'Server not assembled in this session');
    return;
  }

  const server = await McpServer.findOne({ userId: payload.userId, name: serverName, enabled: true });
  if (!server) {
    jsonRpcError(res, request.id, 'SERVER_NOT_FOUND', 'Server not found');
    return;
  }

  if (server.transport !== 'registered_proxy') {
    jsonRpcError(res, request.id, 'SERVER_NOT_FOUND', 'Unsupported transport');
    return;
  }

  const redis = getRedisClient();
  const owner = await redis.get(`mcp:proxy:owner:${server._id.toString()}`);
  if (!owner) {
    jsonRpcError(res, request.id, 'SERVER_OFFLINE', 'Server offline');
    return;
  }

  try {
    const result = await mcpForwarder.request({ serverId: server._id.toString(), sessionId, request: req.body });
    res.json(result);
  } catch (err) {
    if (err instanceof ForwardError) {
      jsonRpcError(res, request.id, err.code, err.message);
    } else {
      jsonRpcError(res, request.id, 'FORWARD_ERROR', (err as Error).message);
    }
  }
};

// Express 5 / path-to-regexp v8 has no optional-param syntax, so register both
// shapes explicitly: legacy single endpoint and per-server URL.
router.post('/:sessionId', mcpEntryHandler);
router.post('/:sessionId/:serverName', mcpEntryHandler);

export const mcpRouter = router;
