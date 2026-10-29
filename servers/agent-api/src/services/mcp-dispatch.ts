import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { McpServer } from '../models/mcp-server.js';
import { getRedisClient } from '../middleware/redis.js';
import { mcpEndpointService } from './mcp-endpoint.js';
import { mcpForwarder, ForwardError } from './mcp-forwarder.js';
import {
  handlePlatformMcpRequest,
  PLATFORM_SERVER_NAME,
} from './workflow/tool-handlers.js';
import {
  handleAdminPlatformMcpRequest,
  ADMIN_PLATFORM_SERVER_NAME,
} from './workflow/admin-tools.js';
import {
  handleCloudHostToolRequest,
  CLOUD_HOST_TOOLS_SERVER_NAME,
} from './cloud-host-tools.js';
import { workspaceService } from './workspace-service.js';
import { runWithWorkspace } from './workspace-context.js';

interface McpTokenPayload {
  sessionId?: string;
  userId?: string;
  serverNames?: string[];
  /** 节点作用域：工作流节点会话的实例节点映射 */
  workflow?: { instanceId: string; nodeId: string };
}

interface DispatchInput {
  sessionId: string;
  serverName?: string;
  token?: string;
  body: unknown;
}

interface DispatchResult {
  status: number;
  body: unknown;
}

function jsonRpcError(id: unknown, code: string, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export const dispatch = async (input: DispatchInput): Promise<DispatchResult> => {
  const { sessionId, serverName: pathServerName, token, body } = input;

  if (!token) {
    return { status: 401, body: jsonRpcError(null, 'ENDPOINT_REVOKED', 'Invalid token') };
  }

  let payload: McpTokenPayload;
  try {
    payload = jwt.verify(token, config.mcpEndpointJwtSecret) as McpTokenPayload;
  } catch {
    return { status: 401, body: jsonRpcError(null, 'ENDPOINT_REVOKED', 'Invalid token') };
  }

  if (!payload.sessionId || payload.sessionId !== sessionId) {
    return { status: 401, body: jsonRpcError(null, 'ENDPOINT_REVOKED', 'Invalid token') };
  }

  const status = await mcpEndpointService.getStatus(sessionId);
  if (status !== 'active') {
    return { status: 401, body: jsonRpcError(null, 'ENDPOINT_REVOKED', 'Invalid token') };
  }

  const request = body as {
    jsonrpc?: string;
    method?: string;
    id?: unknown;
    params?: { serverName?: string; name?: string; arguments?: Record<string, unknown> };
  };
  if (!request?.jsonrpc || !request.method) {
    return {
      status: 400,
      body: jsonRpcError(request?.id ?? null, 'INVALID_REQUEST', 'Invalid JSON-RPC request'),
    };
  }

  // Per-server URL path takes precedence; fall back to params.serverName
  // (legacy clients), then to the first assembled server.
  const serverName = pathServerName ?? request.params?.serverName ?? payload.serverNames?.[0];
  if (!serverName) {
    return {
      status: 400,
      body: jsonRpcError(request.id ?? null, 'INVALID_REQUEST', 'No server name specified'),
    };
  }

  // The target server must have been assembled into this session at creation time.
  if (payload.serverNames && !payload.serverNames.includes(serverName)) {
    return { status: 200, body: jsonRpcError(request.id, 'SERVER_NOT_FOUND', 'Server not assembled in this session') };
  }

  const server = await McpServer.findOne({ userId: payload.userId, name: serverName, enabled: true });
  if (!server) {
    return { status: 200, body: jsonRpcError(request.id, 'SERVER_NOT_FOUND', 'Server not found') };
  }

  // 平台内置服务（如 agent-workflow-tools / agent-workflow-admin-tools）：不经 Redis 转发，直接分发到本地 handler
  if (server.transport === 'platform') {
    const isPlatformNotification = request.id === undefined || request.id === null;
    // 多租户二期（F11）：平台工具集按「会话所属租户工作区」过滤/校验
    const sessionContext = await workspaceService.buildSessionWorkspaceContext(
      payload.sessionId,
      payload.userId,
    );
    // 按 serverName 分发：节点作用域工具集要求 workflow payload；管理工具集仅需 userId/sessionId
    const outcome = await runWithWorkspace(sessionContext, async () =>
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
          : serverName === CLOUD_HOST_TOOLS_SERVER_NAME
            ? await handleCloudHostToolRequest(
                { userId: payload.userId ?? '', sessionId: payload.sessionId ?? '' },
                request,
              )
            : { error: { code: 'SERVER_NOT_FOUND', message: 'Unsupported platform server' } },
    );
    if (isPlatformNotification) {
      return { status: 202, body: undefined };
    }
    if (outcome.error) {
      return { status: 200, body: jsonRpcError(request.id, outcome.error.code, outcome.error.message) };
    }
    return { status: 200, body: { jsonrpc: '2.0', id: request.id, result: outcome.result } };
  }

  if (server.transport !== 'registered_proxy') {
    return { status: 200, body: jsonRpcError(request.id, 'SERVER_NOT_FOUND', 'Unsupported transport') };
  }

  const redis = getRedisClient();
  const owner = await redis.get(`mcp:proxy:owner:${server._id.toString()}`);
  if (!owner) {
    return { status: 200, body: jsonRpcError(request.id, 'SERVER_OFFLINE', 'Server offline') };
  }

  // JSON-RPC notifications (no id) get no response per the MCP spec, so the
  // forward chain must not be waited on: acknowledge immediately with 202
  // (MCP Streamable HTTP) and deliver the notification fire-and-forget.
  // Waiting here stalled every notification (e.g. notifications/initialized)
  // for the full 30s forward timeout, which breaks MCP client handshakes.
  const isNotification = request.id === undefined || request.id === null;
  if (isNotification) {
    mcpForwarder
      .request({ serverId: server._id.toString(), sessionId, request: body })
      .catch((err: Error) => {
        console.warn(`[MCP dispatch] notification forward failed: session=${sessionId} server=${serverName} method=${request.method}: ${err.message}`);
      });
    return { status: 202, body: undefined };
  }

  try {
    const result = await mcpForwarder.request({ serverId: server._id.toString(), sessionId, request: body });
    return { status: 200, body: result };
  } catch (err) {
    console.warn(`[MCP dispatch] forward failed: session=${sessionId} server=${serverName} method=${request.method} id=${JSON.stringify(request.id)}: ${(err as Error).message}`);
    if (err instanceof ForwardError) {
      return { status: 200, body: jsonRpcError(request.id, err.code, err.message) };
    }
    return { status: 200, body: jsonRpcError(request.id, 'FORWARD_ERROR', (err as Error).message) };
  }
};