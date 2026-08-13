import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { McpServer } from '../models/mcp-server.js';
import { getRedisClient } from '../middleware/redis.js';
import { mcpEndpointService } from '../services/mcp-endpoint.js';
import { mcpForwarder, ForwardError } from '../services/mcp-forwarder.js';
import { handlePlatformMcpRequest } from '../services/workflow/tool-handlers.js';
import {
  handleAdminPlatformMcpRequest,
  ADMIN_PLATFORM_SERVER_NAME,
} from '../services/workflow/admin-tools.js';
import { PLATFORM_SERVER_NAME } from '../services/workflow/tool-handlers.js';

const router = Router();

// Request-level visibility for the MCP entry: the forward chain spans three
// processes, so without this the only way to debug onboarding failures is
// packet capture. Kept to one line per request/response.
router.use((req, res, next) => {
  const start = Date.now();
  let method = '';
  try {
    method = (req.body as { method?: string })?.method ?? '';
  } catch { /* body not parsed yet */ }
  res.on('finish', () => {
    console.log(`[MCP entry] ${req.method} ${req.originalUrl} rpc=${method || '-'} -> ${res.statusCode} in ${Date.now() - start}ms`);
  });
  res.on('close', () => {
    if (!res.writableFinished) {
      console.warn(`[MCP entry] ${req.method} ${req.originalUrl} rpc=${method || '-'} -> connection closed WITHOUT response after ${Date.now() - start}ms`);
    }
  });
  next();
});

interface McpTokenPayload {
  sessionId?: string;
  userId?: string;
  serverNames?: string[];
  /** 节点作用域：工作流节点会话的实例节点映射 */
  workflow?: { instanceId: string; nodeId: string };
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
    params?: { serverName?: string; name?: string; arguments?: Record<string, unknown> };
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

  // 平台内置服务（如 agent-workflow-tools / agent-workflow-admin-tools）：不经 Redis 转发，直接分发到本地 handler
  if (server.transport === 'platform') {
    const isPlatformNotification = request.id === undefined || request.id === null;
    // 按 serverName 分发：节点作用域工具集要求 workflow payload；管理工具集仅需 userId/sessionId
    const outcome =
      serverName === ADMIN_PLATFORM_SERVER_NAME
        ? await handleAdminPlatformMcpRequest(
            { userId: payload.userId, sessionId: payload.sessionId },
            request,
          )
        : serverName === PLATFORM_SERVER_NAME
          ? await handlePlatformMcpRequest(
              { userId: payload.userId, workflow: payload.workflow },
              request,
            )
          : { error: { code: 'SERVER_NOT_FOUND', message: 'Unsupported platform server' } };
    if (isPlatformNotification) {
      res.status(202).end();
      return;
    }
    if (outcome.error) {
      jsonRpcError(res, request.id, outcome.error.code, outcome.error.message);
      return;
    }
    res.json({ jsonrpc: '2.0', id: request.id, result: outcome.result });
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

  // JSON-RPC notifications (no id) get no response per the MCP spec, so the
  // forward chain must not be waited on: acknowledge immediately with 202
  // (MCP Streamable HTTP) and deliver the notification fire-and-forget.
  // Waiting here stalled every notification (e.g. notifications/initialized)
  // for the full 30s forward timeout, which breaks MCP client handshakes.
  const isNotification = request.id === undefined || request.id === null;
  if (isNotification) {
    mcpForwarder
      .request({ serverId: server._id.toString(), sessionId, request: req.body })
      .catch((err: Error) => {
        console.warn(`[MCP entry] notification forward failed: session=${sessionId} server=${serverName} method=${request.method}: ${err.message}`);
      });
    res.status(202).end();
    return;
  }

  try {
    const result = await mcpForwarder.request({ serverId: server._id.toString(), sessionId, request: req.body });
    res.json(result);
  } catch (err) {
    console.warn(`[MCP entry] forward failed: session=${sessionId} server=${serverName} method=${request.method} id=${JSON.stringify(request.id)}: ${(err as Error).message}`);
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

// MCP Streamable HTTP allows a standalone SSE stream via GET; this endpoint
// does not offer one, which per spec is signaled with 405.
router.get('/:sessionId', (_req, res) => {
  res.status(405).json({ jsonrpc: '2.0', id: null, error: { code: 'METHOD_NOT_ALLOWED', message: 'SSE stream not supported' } });
});
router.get('/:sessionId/:serverName', (_req, res) => {
  res.status(405).json({ jsonrpc: '2.0', id: null, error: { code: 'METHOD_NOT_ALLOWED', message: 'SSE stream not supported' } });
});

export const mcpRouter = router;
