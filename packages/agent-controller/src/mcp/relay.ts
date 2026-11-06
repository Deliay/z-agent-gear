import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';
import { withSpan } from '../observability/trace.js';

export interface SessionEndpoint {
  token: string;
  serverNames: string[];
}

export interface McpRelayResult {
  status: number;
  body: unknown;
}

interface McpRequestPayload {
  requestId: string;
  sessionId: string;
  serverName: string;
  token: string;
  body: unknown;
}

interface PendingRequest {
  sessionId: string;
  resolve: (result: McpRelayResult) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 60_000;

/** Review 等长等待 MCP 服务超时默认值（30min，契约 §2.12.1；env MCP_REVIEW_TIMEOUT_MS 可调） */
const MCP_REVIEW_TIMEOUT_DEFAULT_MS = 1_800_000;

/** 平台内建长时工具服务：会话 Review（agent-api agent-session-preview-tools） */
const PREVIEW_TOOLS_SERVER_NAME = 'agent-session-preview-tools';

function getMcpReviewTimeoutMs(): number {
  const raw = process.env.MCP_REVIEW_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MCP_REVIEW_TIMEOUT_DEFAULT_MS;
}

/** 按 serverName 取超时的常量表（裁决 9）：仅 preview-tools 放宽，其余 server 保持 60s */
const SERVER_TIMEOUT_OVERRIDES: Record<string, () => number> = {
  [PREVIEW_TOOLS_SERVER_NAME]: getMcpReviewTimeoutMs,
};

export function resolveServerTimeoutMs(serverName: string): number {
  return SERVER_TIMEOUT_OVERRIDES[serverName]?.() ?? REQUEST_TIMEOUT_MS;
}

export class McpRelay {
  private pendingRequests = new Map<string, PendingRequest>();
  private sessionEndpoints = new Map<string, SessionEndpoint>();
  private emitMcpRequest: (payload: McpRequestPayload) => void;
  private log: ObservationLogger;

  constructor(emitMcpRequest: (payload: McpRequestPayload) => void, logger?: ObservationLogger) {
    this.emitMcpRequest = emitMcpRequest;
    this.log = logger ?? rootLogger.child({ component: 'mcp-relay' });
  }

  registerSession(sessionId: string, endpoint: SessionEndpoint): void {
    this.sessionEndpoints.set(sessionId, endpoint);
  }

  hasSession(sessionId: string): boolean {
    return this.sessionEndpoints.has(sessionId);
  }

  hasServer(sessionId: string, serverName: string): boolean {
    const endpoint = this.sessionEndpoints.get(sessionId);
    return endpoint ? endpoint.serverNames.includes(serverName) : false;
  }

  unregisterSession(sessionId: string): void {
    if (!this.sessionEndpoints.delete(sessionId)) return;
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(requestId);
      pending.resolve({ status: 410, body: { error: 'SESSION_ENDED', message: 'MCP session has ended' } });
    }
  }

  async forward(sessionId: string, serverName: string, body: unknown): Promise<McpRelayResult> {
    const endpoint = this.sessionEndpoints.get(sessionId);
    if (!endpoint) return { status: 404, body: { error: 'SESSION_NOT_FOUND' } };
    const requestId = `mcpreq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const method = (body as { method?: string })?.method ?? '?';
    // mcp tool call：一次 MCP 调用一个 span（请求体 chunk 不逐条开 span）
    return withSpan(
      'mcp.tool.call',
      { sessionId, serverName, method },
      () => {
        this.log.debug({ event: 'mcp_forward', requestId, sessionId, serverName, method }, 'mcp forward');
        return new Promise<McpRelayResult>((resolve) => {
          const timeoutMs = resolveServerTimeoutMs(serverName);
          const timer = setTimeout(() => {
            this.pendingRequests.delete(requestId);
            this.log.info(
              { event: 'mcp_forward_timeout', requestId, timeoutMs },
              'mcp request timed out',
            );
            resolve({ status: 504, body: { error: 'TIMEOUT', message: 'MCP request timed out' } });
          }, timeoutMs);
          this.pendingRequests.set(requestId, { sessionId, resolve, timer });
          this.emitMcpRequest({ requestId, sessionId, serverName, token: endpoint.token, body });
        });
      },
    );
  }

  handleMcpResponse(requestId: string, status: number, body: unknown): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      this.log.info(
        { event: 'mcp_response_ignored', requestId, status },
        'mcp response ignored (no pending request)',
      );
      return;
    }
    this.log.debug({ event: 'mcp_response', requestId, status }, 'mcp response');
    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);
    pending.resolve({ status, body });
  }

  handleDisconnect(): void {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(requestId);
      pending.resolve({ status: 503, body: { error: 'CONTROLLER_DISCONNECTED', message: 'Controller disconnected' } });
    }
  }
}