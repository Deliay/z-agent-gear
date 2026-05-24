import * as acp from '@agentclientprotocol/sdk';
import { EventEmitter } from 'events';
import type { Socket } from 'socket.io-client';
import { AcpSpawner } from './spawner.js';

const ACP_PROTOCOL_VERSION = 1;

export interface AcpBridgeOptions {
  sessionId: string;
  cwd: string;
  mcpServers?: Array<{ name: string; command: string; args?: string[]; env?: Array<{ name: string; value: string }> }>;
}

interface QueuedInput {
  type: string;
  content: string;
}

function toMcpServers(servers: AcpBridgeOptions['mcpServers']): acp.McpServer[] {
  return (servers ?? []).map((s) => ({
    name: s.name,
    command: s.command,
    args: s.args ?? [],
    env: s.env ?? [],
  }));
}

export class AcpSessionBridge extends EventEmitter implements acp.Client {
  private spawner: AcpSpawner;
  private socket: Socket;
  private sessionId: string;
  private cwd: string;
  private mcpServers: AcpBridgeOptions['mcpServers'];
  private connection: acp.ClientSideConnection | null = null;
  private acpSessionId: string | null = null;
  private activePrompt: Promise<acp.PromptResponse> | null = null;
  private inputQueue: QueuedInput[] = [];
  private textChunkBuffer = '';
  private textChunkTimer: ReturnType<typeof setTimeout> | null = null;
  private initializing = false;

  constructor(socket: Socket, options: AcpBridgeOptions, spawner?: AcpSpawner) {
    super();
    this.socket = socket;
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.mcpServers = options.mcpServers;
    this.spawner = spawner ?? new AcpSpawner({ sessionId: options.sessionId, cwd: options.cwd });
  }

  async start(): Promise<void> {
    if (this.initializing) return;
    this.initializing = true;

    this.spawner.start();
    try {
      await this.initConnection();
      const result = await this.connection!.newSession({
        cwd: this.cwd,
        mcpServers: toMcpServers(this.mcpServers),
      });
      this.acpSessionId = result.sessionId;
      this.initializing = false;

      this.emit('acp:initialized', {
        sessionId: this.sessionId,
        acpSessionId: this.acpSessionId,
        modes: this.extractModes(result.modes),
        currentModeId: result.modes?.currentModeId ?? null,
        currentModel: this.extractCurrentModel(result.models),
        availableModels: this.extractAvailableModels(result.models),
        currentModelId: result.models?.currentModelId ?? null,
      });

      this.flushInputQueue();
    } catch (error) {
      this.initializing = false;
      this.handleError(error);
    }
  }

  async resume(externalSessionId: string): Promise<void> {
    if (this.initializing) return;
    this.initializing = true;

    this.spawner.start();
    try {
      await this.initConnection();
      const result = await this.connection!.resumeSession({
        sessionId: externalSessionId,
        cwd: this.cwd,
      });
      this.acpSessionId = externalSessionId;
      this.initializing = false;

      this.emit('acp:initialized', {
        sessionId: this.sessionId,
        acpSessionId: this.acpSessionId,
        modes: this.extractModes(result.modes),
        currentModeId: result.modes?.currentModeId ?? null,
        currentModel: this.extractCurrentModel(result.models),
        availableModels: this.extractAvailableModels(result.models),
        currentModelId: result.models?.currentModelId ?? null,
      });
    } catch (error) {
      // resumeSession may fail if agent doesn't support session.resume
      // fallback to newSession
      try {
        const result = await this.connection!.newSession({
          cwd: this.cwd,
          mcpServers: toMcpServers(this.mcpServers),
        });
        this.acpSessionId = result.sessionId;
        this.initializing = false;

        this.emit('acp:initialized', {
          sessionId: this.sessionId,
          acpSessionId: this.acpSessionId,
          modes: this.extractModes(result.modes),
          currentModeId: result.modes?.currentModeId ?? null,
          currentModel: this.extractCurrentModel(result.models),
        availableModels: this.extractAvailableModels(result.models),
        currentModelId: result.models?.currentModelId ?? null,
        });
      } catch (fallbackError) {
        this.initializing = false;
        this.handleError(fallbackError);
      }
    }
  }

  async stop(): Promise<void> {
    try {
      if (this.acpSessionId && this.connection) {
        await this.connection.cancel({ sessionId: this.acpSessionId });
        await this.connection.closeSession({ sessionId: this.acpSessionId });
      }
    } catch { /* ignore */ }
    this.activePrompt = null;
    this.inputQueue = [];
    this.spawner.stop();
    this.emitStopped('user_close');
  }

  cancel(): void {
    if (this.acpSessionId && this.connection) {
      this.connection.cancel({ sessionId: this.acpSessionId });
    }
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.connection || !this.acpSessionId) return;
    await this.connection.setSessionMode({
      sessionId: this.acpSessionId,
      modeId,
    });
  }

  async setModel(modelId: string): Promise<void> {
    if (!this.connection || !this.acpSessionId) return;
    await this.connection.unstable_setSessionModel({
      sessionId: this.acpSessionId,
      modelId,
    });
  }

  sendInput(message: { type: string; content: string }): void {
    if (this.activePrompt) {
      this.inputQueue.push(message);
      return;
    }
    this.processPrompt(message);
  }

  private async processPrompt(message: QueuedInput): Promise<void> {
    if (!this.connection || !this.acpSessionId) return;

    this.activePrompt = this.connection.prompt({
      sessionId: this.acpSessionId,
      prompt: [{ type: 'text' as const, text: message.content }],
    });

    try {
      await this.activePrompt;
    } catch {
      // cancelled or error
    } finally {
      this.activePrompt = null;
      if (this.inputQueue.length > 0) {
        this.processPrompt(this.inputQueue.shift()!);
      }
    }
  }

  private async initConnection(): Promise<void> {
    const input = this.spawner.stdin;
    const output = this.spawner.stdout;
    const stream = acp.ndJsonStream(input, output);
    this.connection = new acp.ClientSideConnection(() => this, stream);
    await this.connection.initialize({
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: {
        name: 'agent-gear',
        version: '1.0.0',
      },
    });
  }

  private flushInputQueue(): void {
    while (this.inputQueue.length > 0) {
      this.processPrompt(this.inputQueue.shift()!);
    }
  }

  private extractModes(modes: acp.SessionModeState | null | undefined): Array<{ id: string; name: string; description?: string }> | null {
    if (!modes?.availableModes) return null;
    return modes.availableModes.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description ?? undefined,
    }));
  }

  private extractCurrentModel(models: acp.SessionModelState | null | undefined): { id: string; name: string; provider?: string } | null {
    if (!models?.availableModels || !models.currentModelId) return null;
    const found = models.availableModels.find((m) => m.modelId === models.currentModelId);
    if (!found) return null;
    return { id: found.modelId, name: found.name };
  }

  private extractAvailableModels(models: acp.SessionModelState | null | undefined): Array<{ id: string; name: string; provider?: string }> | null {
    if (!models?.availableModels) return null;
    return models.availableModels.map((m) => ({
      id: m.modelId,
      name: m.name,
    }));
  }

  // ── acp.Client implementation ──

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') {
          this.textChunkBuffer += update.content.text;
          this.scheduleTextFlush();
        }
        break;
      case 'tool_call':
      case 'tool_call_update':
      case 'plan':
      case 'agent_thought_chunk':
        this.flushTextBuffer();
        this.sendUpdate(update);
        break;
      case 'user_message_chunk':
        break;
      default:
        this.flushTextBuffer();
        this.sendUpdate(update);
        break;
    }
  }

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    return {
      outcome: {
        outcome: 'selected',
        optionId: params.options.find((o) => o.kind === 'allow_once')?.optionId ?? params.options[0]?.optionId ?? 'reject',
      },
    };
  }

  // ── text buffering ──

  private scheduleTextFlush(): void {
    if (this.textChunkTimer) clearTimeout(this.textChunkTimer);
    this.textChunkTimer = setTimeout(() => this.flushTextBuffer(), 50);
  }

  private flushTextBuffer(): void {
    if (this.textChunkTimer) {
      clearTimeout(this.textChunkTimer);
      this.textChunkTimer = null;
    }
    if (this.textChunkBuffer) {
      this.sendUpdate({
        sessionUpdate: 'agent_message_chunk' as const,
        content: { type: 'text' as const, text: this.textChunkBuffer },
      } as acp.SessionUpdate);
      this.textChunkBuffer = '';
    }
  }

  // ── socket forwarding ──

  private sendUpdate(update: acp.SessionUpdate): void {
    this.socket.emit('acp:message', {
      sessionId: this.sessionId,
      message: update,
    });
  }

  private emitStopped(reason: string, exitCode?: number): void {
    this.socket.emit('acp:stopped', { sessionId: this.sessionId, reason, exitCode });
    this.emit('acp:stopped', { sessionId: this.sessionId, reason, exitCode });
  }

  private handleError(error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    this.socket.emit('acp:stopped', {
      sessionId: this.sessionId,
      reason: 'error',
      error: msg,
    });
    this.emit('acp:stopped', {
      sessionId: this.sessionId,
      reason: 'error',
      error: msg,
    });
    this.spawner.stop();
  }
}
