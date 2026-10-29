import * as acp from '@agentclientprotocol/sdk';
import { AcpSpawner } from './spawner.js';
import { CLIENT_CAPABILITIES } from './capabilities.js';

const ACP_PROTOCOL_VERSION = 1;
const CONNECT_TIMEOUT_MS = 30_000;
const LOAD_SESSION_TIMEOUT_MS = 120_000;

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timerPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timerPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

export interface AcpSyncBridgeOptions {
  cwd: string;
}

export class AcpSyncBridge implements acp.Client {
  private spawner: AcpSpawner;
  private connection: acp.ClientSideConnection | null = null;
  private updates: acp.SessionNotification[] = [];
  private capabilities: acp.AgentCapabilities | null = null;

  constructor(options: AcpSyncBridgeOptions, spawner?: AcpSpawner) {
    this.spawner = spawner ?? new AcpSpawner({
      sessionId: `sync_${Date.now()}`,
      cwd: options.cwd,
    });
  }

  async connect(timeoutMs: number = CONNECT_TIMEOUT_MS): Promise<void> {
    this.spawner.start();
    const stream = acp.ndJsonStream(this.spawner.stdin, this.spawner.stdout);
    this.connection = new acp.ClientSideConnection(() => this, stream);

    const exitPromise = this.spawner.closed.then(() => {
      throw new Error('ACP process exited unexpectedly');
    });
    exitPromise.catch(() => {});

    const initPromise = this.connection.initialize({
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: { name: 'agent-gear', version: '1.0.0' },
    });

    const result = await withTimeout(
      Promise.race([initPromise, exitPromise]),
      timeoutMs,
      `ACP connect timed out after ${timeoutMs}ms`,
    );
    this.capabilities = result.agentCapabilities ?? null;
  }

  supportsDelete(): boolean {
    return Boolean(this.capabilities?.sessionCapabilities?.delete);
  }

  async listSessions(cwd: string, cursor?: string | null): Promise<acp.ListSessionsResponse> {
    if (!this.connection) {
      throw new Error('ACP connection not established');
    }
    return this.connection.listSessions({ cwd, ...(cursor ? { cursor } : {}) });
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.connection) {
      throw new Error('ACP connection not established');
    }
    await this.connection.deleteSession({ sessionId });
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    timeoutMs: number = LOAD_SESSION_TIMEOUT_MS,
  ): Promise<{
    config: acp.LoadSessionResponse;
    updates: acp.SessionNotification[];
  }> {
    this.updates = [];

    const exitPromise = this.spawner.closed.then(() => {
      throw new Error('ACP process exited unexpectedly');
    });
    exitPromise.catch(() => {});

    const config = await withTimeout(
      Promise.race([
        this.connection!.loadSession({
          cwd,
          sessionId,
          mcpServers: [],
        }),
        exitPromise,
      ]),
      timeoutMs,
      `ACP load-session timed out after ${timeoutMs}ms`,
    );
    return { config, updates: [...this.updates] };
  }

  async disconnect(sessionId?: string): Promise<void> {
    if (sessionId) {
      await this.connection?.closeSession({ sessionId }).catch(() => {});
    }
    this.spawner.stop();
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.updates.push(params);
  }

  async requestPermission(): Promise<acp.RequestPermissionResponse> {
    return { outcome: { outcome: 'cancelled' } };
  }

  async unstable_createElicitation(): Promise<acp.CreateElicitationResponse> {
    // 同步链路无用户交互通道：声明了 elicitation 能力后 Agent 可能发起问询，
    // 这里显式取消并留日志（声明 + 立即取消是合法降级，不引入交互链路）。
    console.warn('[ACP sync-bridge] elicitation request auto-cancelled: no user channel');
    return { action: 'cancel' };
  }

  async unstable_completeElicitation(): Promise<void> {
    // no-op
  }

  // SDK ≥1.4.0 注册的新方法名（1.9.0 起仅注册新名），委托到与 unstable_* 相同的实现。
  async createElicitation(): Promise<acp.CreateElicitationResponse> {
    return this.unstable_createElicitation();
  }

  async completeElicitation(): Promise<void> {
    return this.unstable_completeElicitation();
  }
}
