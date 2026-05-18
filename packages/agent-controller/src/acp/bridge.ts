import type { Socket } from 'socket.io-client';
import { AcpSpawner, type AcpProcessOptions } from './spawner.js';

export interface AcpBridgeOptions {
  sessionId: string;
  controllerId: string;
  cwd: string;
}

export class AcpWebSocketBridge {
  private spawner: AcpSpawner;
  private socket: Socket;
  private sessionId: string;
  private controllerId: string;

  constructor(socket: Socket, options: AcpBridgeOptions) {
    this.socket = socket;
    this.sessionId = options.sessionId;
    this.controllerId = options.controllerId;
    this.spawner = new AcpSpawner({
      sessionId: options.sessionId,
      cwd: options.cwd,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Handle messages from ACP process
    this.spawner.on('message', (message: Record<string, unknown>) => {
      this.handleAcpMessage(message);
    });

    // Handle process exit
    this.spawner.on('exit', ({ code, signal }: { code: number | null; signal: string | null }) => {
      this.handleAcpExit(code, signal);
    });

    // Handle process error
    this.spawner.on('error', (error: Error) => {
      console.error('ACP process error:', error);
      this.socket.emit('acp:stopped', {
        sessionId: this.sessionId,
        reason: 'error',
      });
    });
  }

  start(): void {
    this.spawner.start();
  }

  stop(): void {
    this.spawner.stop();
  }

  sendInput(message: { type: string; content: string }): void {
    // Convert to JSON-RPC format
    const jsonRpcMessage = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'session/prompt',
      params: {
        sessionId: this.sessionId,
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

  private handleAcpMessage(message: Record<string, unknown>): void {
    // Convert JSON-RPC message to ACP message format
    const acpMessage = this.convertJsonRpcToAcpMessage(message);
    if (acpMessage) {
      this.socket.emit('acp:message', {
        sessionId: this.sessionId,
        message: acpMessage,
      });
    }
  }

  private convertJsonRpcToAcpMessage(message: Record<string, unknown>): Record<string, unknown> | null {
    const method = message.method as string;
    const params = message.params as Record<string, unknown>;

    if (method === 'session/update') {
      const update = params.update as Record<string, unknown>;
      const sessionUpdate = update.sessionUpdate as string;
      const content = update.content as Record<string, unknown>;

      switch (sessionUpdate) {
        case 'agent_message_chunk':
          return {
            type: 'text',
            content: content.text || '',
            metadata: null,
          };
        case 'tool_call':
          return {
            type: 'tool_call',
            content: content.toolName || '',
            metadata: content,
          };
        case 'tool_result':
          return {
            type: 'tool_result',
            content: JSON.stringify(content),
            metadata: content,
          };
        default:
          return {
            type: 'text',
            content: JSON.stringify(content),
            metadata: null,
          };
      }
    }

    return null;
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

    this.socket.emit('acp:stopped', {
      sessionId: this.sessionId,
      reason,
      exitCode: code,
    });
  }
}