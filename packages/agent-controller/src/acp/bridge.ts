import { EventEmitter } from 'events';
import type { Socket } from 'socket.io-client';
import { AcpSpawner, type AcpProcessOptions } from './spawner.js';

const ACP_PROTOCOL_VERSION = 1;
const INITIALIZE_TIMEOUT_MS = 30_000;
const SESSION_NEW_TIMEOUT_MS = 30_000;

export interface AcpBridgeOptions {
  sessionId: string;
  controllerId: string;
  cwd: string;
  mcpServers?: Array<{ name: string; command: string; args?: string[]; env?: Array<{ name: string; value: string }> }>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AcpWebSocketBridge extends EventEmitter {
  private spawner: AcpSpawner;
  private socket: Socket;
  private sessionId: string;
  private controllerId: string;
  private cwd: string;
  private mcpServers: AcpBridgeOptions['mcpServers'];
  private acpSessionId: string | null = null;
  private initialized = false;
  private pendingRequests = new Map<number, PendingRequest>();
  private requestIdCounter = 0;
  private inputQueue: Array<{ type: string; content: string }> = [];

  constructor(socket: Socket, options: AcpBridgeOptions, spawner?: AcpSpawner) {
    super();
    this.socket = socket;
    this.sessionId = options.sessionId;
    this.controllerId = options.controllerId;
    this.cwd = options.cwd;
    this.mcpServers = options.mcpServers;
    this.spawner = spawner ?? new AcpSpawner({
      sessionId: options.sessionId,
      cwd: options.cwd,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.spawner.on('message', (message: Record<string, unknown>) => {
      this.handleAcpMessage(message);
    });

    this.spawner.on('exit', ({ code, signal }: { code: number | null; signal: string | null }) => {
      this.handleAcpExit(code, signal);
    });

    this.spawner.on('error', (error: Error) => {
      console.error('ACP process error:', error);
      this.emit('acp:stopped', {
        sessionId: this.sessionId,
        reason: 'error',
      });
      this.socket.emit('acp:stopped', {
        sessionId: this.sessionId,
        reason: 'error',
      });
    });
  }

  start(): void {
    this.spawner.start();
    this.initialize();
  }

  stop(): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Session closing'));
    }
    this.pendingRequests.clear();
    this.spawner.stop();
  }

  sendInput(message: { type: string; content: string }): void {
    if (!this.initialized || !this.acpSessionId) {
      this.inputQueue.push(message);
      return;
    }

    this.sendPrompt(message);
  }

  private async initialize(): Promise<void> {
    const startTime = Date.now();
    try {
      console.log(`[ACP bridge] Step 1/3: Sending initialize request for session ${this.sessionId}`);
      const t1 = Date.now();
      const initResult = await this.sendRequest('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
        },
        clientInfo: {
          name: 'agent-controller',
          title: 'Agent Controller',
          version: '1.0.0',
        },
      });

      console.log(`[ACP bridge] Step 1/3 done in ${Date.now() - t1}ms. Response:`, initResult);

      console.log(`[ACP bridge] Step 2/3: Sending session/new for cwd=${this.cwd}`);
      const t2 = Date.now();
      const sessionResult = await this.sendRequest('session/new', {
        cwd: this.cwd,
        mcpServers: this.mcpServers ?? [],
      });

      this.acpSessionId = (sessionResult as { sessionId: string }).sessionId;
      this.initialized = true;

      console.log(`[ACP bridge] Step 2/3 done in ${Date.now() - t2}ms. ACP session created: ${this.acpSessionId}`);
      console.log(`[ACP bridge] Step 3/3: Emitting acp:initialized for session ${this.sessionId}`);

      this.emit('acp:initialized', {
        sessionId: this.sessionId,
        acpSessionId: this.acpSessionId,
      });

      console.log(`[ACP bridge] All steps completed in ${Date.now() - startTime}ms`);

      this.flushInputQueue();
    } catch (error) {
      console.error(`[ACP bridge] Initialization failed after ${Date.now() - startTime}ms for session ${this.sessionId}:`, error);
      this.emit('acp:stopped', {
        sessionId: this.sessionId,
        reason: 'error',
        error: (error as Error).message,
      });
      this.socket.emit('acp:stopped', {
        sessionId: this.sessionId,
        reason: 'error',
        error: (error as Error).message,
      });
      this.spawner.stop();
    }
  }

  private flushInputQueue(): void {
    while (this.inputQueue.length > 0) {
      const message = this.inputQueue.shift()!;
      this.sendPrompt(message);
    }
  }

  private sendPrompt(message: { type: string; content: string }): void {
    const jsonRpcMessage = {
      jsonrpc: '2.0',
      id: this.nextRequestId(),
      method: 'session/prompt',
      params: {
        sessionId: this.acpSessionId,
        prompt: [
          {
            type: message.type,
            text: message.content,
          },
        ],
      },
    };

    this.spawner.send(jsonRpcMessage);
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId();
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`ACP request '${method}' timed out`));
      }, method === 'initialize' ? INITIALIZE_TIMEOUT_MS : SESSION_NEW_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timer });

      this.spawner.send({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });
    });
  }

  private nextRequestId(): number {
    return ++this.requestIdCounter;
  }

  private handleAcpMessage(message: Record<string, unknown>): void {
    if (message.id != null && (message.result !== undefined || message.error !== undefined)) {
      this.handleJsonRpcResponse(message);
      return;
    }

    if (message.method) {
      this.handleJsonRpcNotification(message);
    }
  }

  private handleJsonRpcResponse(message: Record<string, unknown>): void {
    const id = message.id as number;
    const pending = this.pendingRequests.get(id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(id);

    if (message.error) {
      const error = message.error as { code: number; message: string };
      pending.reject(new Error(`ACP error ${error.code}: ${error.message}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleJsonRpcNotification(message: Record<string, unknown>): void {
    const method = message.method as string;
    const params = message.params as Record<string, unknown>;

    if (method === 'session/update') {
      const acpMessage = this.convertSessionUpdateToAcpMessage(params);
      if (acpMessage) {
        this.socket.emit('acp:message', {
          sessionId: this.sessionId,
          message: acpMessage,
        });
      }
    }
  }

  private convertSessionUpdateToAcpMessage(params: Record<string, unknown>): Record<string, unknown> | null {
    const update = params.update as Record<string, unknown>;
    if (!update) return null;

    const sessionUpdate = update.sessionUpdate as string;
    const content = update.content as Record<string, unknown>;

    switch (sessionUpdate) {
      case 'agent_message_chunk':
        return {
          type: 'text',
          content: content?.text || '',
          metadata: null,
        };
      case 'tool_call':
        return {
          type: 'tool_call',
          content: content?.toolName || '',
          metadata: content,
        };
      case 'tool_result':
        return {
          type: 'tool_result',
          content: JSON.stringify(content),
          metadata: content,
        };
      case 'user_message_chunk':
        return null;
      default:
        return {
          type: 'text',
          content: JSON.stringify(content),
          metadata: null,
        };
    }
  }

  private handleAcpExit(code: number | null, signal: string | null): void {
    let reason: string;
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      reason = 'user_close';
    } else if (code === 0) {
      reason = 'agent_exit';
    } else {
      reason = 'error';
    }

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('ACP process exited'));
    }
    this.pendingRequests.clear();

    this.socket.emit('acp:stopped', {
      sessionId: this.sessionId,
      reason,
      exitCode: code,
    });
    this.emit('acp:stopped', {
      sessionId: this.sessionId,
      reason,
      exitCode: code,
    });
  }
}
