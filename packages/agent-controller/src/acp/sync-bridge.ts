import * as acp from '@agentclientprotocol/sdk';
import { AcpSpawner } from './spawner.js';

const ACP_PROTOCOL_VERSION = 1;

export interface AcpSyncBridgeOptions {
  cwd: string;
}

export class AcpSyncBridge implements acp.Client {
  private spawner: AcpSpawner;
  private connection: acp.ClientSideConnection | null = null;
  private updates: acp.SessionNotification[] = [];

  constructor(options: AcpSyncBridgeOptions, spawner?: AcpSpawner) {
    this.spawner = spawner ?? new AcpSpawner({
      sessionId: `sync_${Date.now()}`,
      cwd: options.cwd,
    });
  }

  async connect(): Promise<void> {
    this.spawner.start();
    const stream = acp.ndJsonStream(this.spawner.stdin, this.spawner.stdout);
    this.connection = new acp.ClientSideConnection(() => this, stream);
    await this.connection.initialize({
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'agent-controller', version: '1.0.0' },
    });
  }

  async listSessions(cwd: string): Promise<acp.ListSessionsResponse> {
    return this.connection!.listSessions({ cwd });
  }

  async loadSession(sessionId: string, cwd: string): Promise<{
    config: acp.LoadSessionResponse;
    updates: acp.SessionNotification[];
  }> {
    this.updates = [];
    const config = await this.connection!.loadSession({
      cwd,
      sessionId,
      mcpServers: [],
    });
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
}
