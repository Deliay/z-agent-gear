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

export class McpRelay {
  private pendingRequests = new Map<string, PendingRequest>();
  private sessionEndpoints = new Map<string, SessionEndpoint>();
  private emitMcpRequest: (payload: McpRequestPayload) => void;

  constructor(emitMcpRequest: (payload: McpRequestPayload) => void) {
    this.emitMcpRequest = emitMcpRequest;
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
    return new Promise<McpRelayResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        resolve({ status: 504, body: { error: 'TIMEOUT', message: 'MCP request timed out' } });
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(requestId, { sessionId, resolve, timer });
      this.emitMcpRequest({ requestId, sessionId, serverName, token: endpoint.token, body });
    });
  }

  handleMcpResponse(requestId: string, status: number, body: unknown): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
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