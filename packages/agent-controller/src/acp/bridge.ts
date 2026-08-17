import * as acp from '@agentclientprotocol/sdk';
import { EventEmitter } from 'events';
import type { Socket } from 'socket.io-client';
import { AcpSpawner } from './spawner.js';

const ACP_PROTOCOL_VERSION = 1;

export interface AcpBridgeOptions {
  sessionId: string;
  cwd: string;
  additionalDirectories?: string[];
  mcpServers?: Array<{ name: string; command: string; args?: string[]; env?: Array<{ name: string; value: string }> }>;
  mcpEndpoint?: { url: string; token: string; serverNames: string[] };
  /** 会话初始化时应用的工作模式/模型（工作流节点配置；不提供则使用 harness 默认） */
  initialModeId?: string;
  initialModelId?: string;
}

interface QueuedInput {
  type: string;
  content: string;
}

export interface SessionConfigOptionData {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type: 'select' | 'boolean';
  currentValue: string | null;
  options: Array<{ value: string; name?: string }>;
}

export interface AcpAuthMethodData {
  id: string;
  kind: 'env_var' | 'terminal' | 'agent' | null;
  description?: string | null;
  url?: string | null;
}

export interface AcpInitializedPayload {
  sessionId: string;
  acpSessionId: string | null;
  modes: Array<{ id: string; name: string; description?: string }>;
  currentModeId: string | null;
  currentModel: { id: string; name: string; provider?: string } | null;
  availableModels: Array<{ id: string; name: string; provider?: string }>;
  currentModelId: string | null;
  configOptions: SessionConfigOptionData[];
  promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean } | null;
  agentInfo: { name: string; version?: string | null } | null;
  authMethods: AcpAuthMethodData[];
  supportsAdditionalDirectories: boolean;
  protocolVersion?: number | null;
}

function toMcpServers(servers: AcpBridgeOptions['mcpServers']): acp.McpServer[] {
  return (servers ?? []).map((s) => ({
    name: s.name,
    command: s.command,
    args: s.args ?? [],
    env: s.env ?? [],
  }));
}

// Sanitized, token-free summary of the MCP servers about to be sent to the
// agent, so launch failures are diagnosable from local logs alone.
function describeMcpServersForLog(servers: acp.McpServer[]): string {
  if (servers.length === 0) return 'none';
  return servers.map((s) => {
    if ('url' in s) {
      const headerNames = (s.headers ?? []).map((h) => h.name).join('+');
      return `${s.name}(type=${(s as { type?: string }).type ?? 'http'}, url=${s.url}${headerNames ? `, headers=${headerNames}` : ''})`;
    }
    return `${s.name}(type=stdio, cmd=${(s as { command?: string }).command})`;
  }).join(' ');
}

function toMcpEndpointServers(mcpEndpoint: NonNullable<AcpBridgeOptions['mcpEndpoint']>): acp.McpServer[] {
  // Fail loudly with a diagnosable message instead of a raw TypeError when the
  // upstream payload drifts from the contract (serverNames is required).
  if (!Array.isArray(mcpEndpoint.serverNames) || mcpEndpoint.serverNames.length === 0) {
    throw new Error(
      `Invalid mcpEndpoint payload: "serverNames" must be a non-empty array ` +
      `(received: ${JSON.stringify(mcpEndpoint.serverNames)}, url: ${mcpEndpoint.url})`,
    );
  }
  const headers: acp.HttpHeader[] = [{ name: 'Authorization', value: `Bearer ${mcpEndpoint.token}` }];
  // Each assembled server gets its own URL so the entry point can route
  // standard MCP clients (which never send a serverName param) correctly.
  return mcpEndpoint.serverNames.map((name) => ({
    type: 'http' as const,
    name,
    url: `${mcpEndpoint.url}/${encodeURIComponent(name)}`,
    headers,
  }));
}

export function extractConfigOptions(
  configOptions: acp.SessionConfigOption[] | null | undefined,
): SessionConfigOptionData[] {
  if (!configOptions) return [];
  return configOptions.map((opt) => {
    const base = {
      id: opt.id,
      name: opt.name,
      description: opt.description ?? null,
      category: opt.category ?? null,
    };
    if (opt.type === 'boolean') {
      return {
        ...base,
        type: 'boolean' as const,
        currentValue: String(opt.currentValue),
        options: [],
      };
    }
    const options = Array.isArray(opt.options)
      ? (opt.options as Array<acp.SessionConfigSelectOption | acp.SessionConfigSelectGroup>).flatMap((o) =>
          'group' in o
            ? o.options.map((inner) => ({ value: inner.value, name: `${o.name}/${inner.name}` }))
            : [{ value: o.value, name: o.name }],
        )
      : [];
    return {
      ...base,
      type: 'select' as const,
      currentValue: opt.currentValue,
      options,
    };
  });
}

function findConfigByCategory(
  configOptions: SessionConfigOptionData[],
  category: string,
): SessionConfigOptionData | null {
  return configOptions.find((o) => o.category === category) ?? null;
}

function extractConfigModes(
  configOptions: SessionConfigOptionData[],
): { modes: Array<{ id: string; name: string }>; currentModeId: string | null } | null {
  const opt = findConfigByCategory(configOptions, 'mode');
  if (!opt || opt.type !== 'select') return null;
  return {
    modes: opt.options.map((o) => ({ id: o.value, name: o.name ?? o.value })),
    currentModeId: opt.currentValue,
  };
}

function extractConfigModels(
  configOptions: SessionConfigOptionData[],
): {
  availableModels: Array<{ id: string; name: string; provider?: string }>;
  currentModelId: string | null;
  currentModel: { id: string; name: string; provider?: string } | null;
} | null {
  const opt = findConfigByCategory(configOptions, 'model');
  if (!opt || opt.type !== 'select') return null;
  const availableModels = opt.options.map((o) => ({ id: o.value, name: o.name ?? o.value }));
  const currentModelId = opt.currentValue;
  const current = availableModels.find((m) => m.id === currentModelId) ?? null;
  return { availableModels, currentModelId, currentModel: current };
}

function toAuthMethods(authMethods: acp.AuthMethod[] | undefined): AcpAuthMethodData[] {
  if (!authMethods || authMethods.length === 0) return [];
  return authMethods.map((m) => {
    if ('type' in m) {
      const kind = m.type === 'env_var' ? 'env_var' : m.type === 'terminal' ? 'terminal' : 'agent';
      return {
        id: m.id,
        kind,
        description: (m as { description?: string | null }).description ?? null,
        url: (m as { url?: string | null }).url ?? null,
      };
    }
    // AuthMethodAgent 无 type 字段（SDK 1.3.0），是默认认证方式
    return { id: m.id, kind: 'agent', description: null, url: null };
  });
}

export class AcpSessionBridge extends EventEmitter implements acp.Client {
  private spawner: AcpSpawner;
  private socket: Socket;
  private sessionId: string;
  private cwd: string;
  private additionalDirectories: string[];
  private mcpServers: AcpBridgeOptions['mcpServers'];
  private mcpEndpoint: AcpBridgeOptions['mcpEndpoint'];
  private initialModeId: string | undefined;
  private initialModelId: string | undefined;
  private connection: acp.ClientSideConnection | null = null;
  private acpSessionId: string | null = null;
  private activePrompt: Promise<acp.PromptResponse> | null = null;
  private inputQueue: QueuedInput[] = [];
  private textChunkBuffer = '';
  private textChunkMessageId: string | null | undefined;
  private textChunkTimer: ReturnType<typeof setTimeout> | null = null;
  private initializing = false;
  private stopped = false;
  private pendingPermissions = new Map<string, {
    resolve: (response: acp.RequestPermissionResponse) => void;
    timeout: NodeJS.Timeout;
  }>();
  private pendingElicitations = new Map<string, {
    resolve: (response: acp.CreateElicitationResponse) => void;
    timeout: NodeJS.Timeout;
  }>();

  // Capability snapshot from initialize / session/new / resume
  private configOptions: SessionConfigOptionData[] = [];
  private promptCapabilities: AcpInitializedPayload['promptCapabilities'] = null;
  private agentInfo: AcpInitializedPayload['agentInfo'] = null;
  private authMethods: AcpAuthMethodData[] = [];
  private supportsAdditionalDirectories = false;
  private agentProtocolVersion: number | null = null;
  private agentMcpCapabilities: { http?: boolean | null; sse?: boolean | null } | null = null;

  constructor(socket: Socket, options: AcpBridgeOptions, spawner?: AcpSpawner) {
    super();
    this.socket = socket;
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.additionalDirectories = options.additionalDirectories ?? [];
    this.mcpServers = options.mcpServers;
    this.mcpEndpoint = options.mcpEndpoint;
    this.initialModeId = options.initialModeId;
    this.initialModelId = options.initialModelId;
    this.spawner = spawner ?? new AcpSpawner({ sessionId: options.sessionId, cwd: options.cwd });
  }

  private resolveMcpServers(): acp.McpServer[] {
    if (this.mcpEndpoint) {
      return toMcpEndpointServers(this.mcpEndpoint);
    }
    return toMcpServers(this.mcpServers);
  }

  // Log the MCP configuration that is about to be handed to the agent via
  // session/new (or session/resume), and warn when the agent did not
  // advertise the required MCP transport capability in initialize.
  private logMcpServersForSession(method: 'session/new' | 'session/resume', servers: acp.McpServer[]): void {
    console.log(`[ACP bridge] session ${this.sessionId}: passing MCP servers via ${method}: ${describeMcpServersForLog(servers)}`);
    const httpServers = servers.filter((s) => 'url' in s && (s as { type?: string }).type === 'http');
    if (httpServers.length > 0 && this.agentMcpCapabilities && this.agentMcpCapabilities.http === false) {
      console.warn(
        `[ACP bridge] session ${this.sessionId}: agent did not advertise mcpCapabilities.http ` +
        `but ${httpServers.length} http MCP server(s) are being passed: ${httpServers.map((s) => s.name).join(', ')}`,
      );
    }
  }

  async start(): Promise<void> {
    if (this.initializing) return;
    this.initializing = true;

    this.spawner.start();
    try {
      await this.initConnection();
      const mcpServers = this.resolveMcpServers();
      this.logMcpServersForSession('session/new', mcpServers);
      const result = await this.connection!.newSession({
        cwd: this.cwd,
        mcpServers,
        additionalDirectories: this.additionalDirectories.length > 0 ? this.additionalDirectories : undefined,
      });
      this.acpSessionId = result.sessionId;
      this.initializing = false;

      const initialized = this.buildInitializedPayload(result);
      // 工作流节点配置的初始 mode/model：在首条 prompt 前应用，而非使用 harness 默认设置
      await this.applyInitialModeModel();
      this.emit('acp:initialized', initialized);
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
      const mcpServers = this.resolveMcpServers();
      this.logMcpServersForSession('session/resume', mcpServers);
      const result = await this.connection!.resumeSession({
        sessionId: externalSessionId,
        cwd: this.cwd,
        mcpServers,
        additionalDirectories: this.additionalDirectories.length > 0 ? this.additionalDirectories : undefined,
      });
      this.acpSessionId = externalSessionId;
      this.initializing = false;

      this.emit('acp:initialized', this.buildInitializedPayload(result));
    } catch (error) {
      // resumeSession may fail if agent doesn't support session.resume
      // fallback to newSession
      try {
        const result = await this.connection!.newSession({
          cwd: this.cwd,
          mcpServers: this.resolveMcpServers(),
          additionalDirectories: this.additionalDirectories.length > 0 ? this.additionalDirectories : undefined,
        });
        this.acpSessionId = result.sessionId;
        this.initializing = false;

        this.emit('acp:initialized', this.buildInitializedPayload(result));
      } catch (fallbackError) {
        this.initializing = false;
        this.handleError(fallbackError);
      }
    }
  }

  async stop(): Promise<void> {
    try {
      if (this.acpSessionId && this.connection) {
        // 5s timeout for cancel/closeSession to prevent hanging
        await Promise.race([
          (async () => {
            await this.connection!.cancel({ sessionId: this.acpSessionId! });
            await this.connection!.closeSession({ sessionId: this.acpSessionId! });
          })(),
          new Promise<void>((resolve) => setTimeout(resolve, 5000)),
        ]);
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
    const modeConfig = findConfigByCategory(this.configOptions, 'mode');
    if (modeConfig) {
      // 配置项通道：Agent 提供 configOptions 时以配置项为准
      await this.connection.setSessionConfigOption({
        sessionId: this.acpSessionId,
        configId: modeConfig.id,
        value: modeId,
      });
      return;
    }
    await this.connection.setSessionMode({
      sessionId: this.acpSessionId,
      modeId,
    });
  }

  async setModel(modelId: string): Promise<void> {
    if (!this.connection || !this.acpSessionId) return;
    const modelConfig = findConfigByCategory(this.configOptions, 'model');
    if (modelConfig) {
      await this.connection.setSessionConfigOption({
        sessionId: this.acpSessionId,
        configId: modelConfig.id,
        value: modelId,
      });
      return;
    }
    // SDK 1.x 已移除 unstable_setSessionModel：无 configOptions 的旧 Agent 无法走配置项通道。
    // 模型切换暂不支持，由上层提示（不保留 unstable 调用）。
    throw new Error('Model switching is not supported: agent does not expose a model config option');
  }

  /** 会话初始化（session/new 之后、首条 prompt 之前）应用工作流节点配置的初始 mode/model */
  private async applyInitialModeModel(): Promise<void> {
    if (this.initialModeId) {
      try {
        await this.setMode(this.initialModeId);
        console.log(`[ACP bridge] session ${this.sessionId}: applied initial mode=${this.initialModeId}`);
      } catch (err) {
        // 应用初始 mode 失败不阻断会话：回退 harness 默认，仅记录日志
        console.warn(`[ACP bridge] session ${this.sessionId}: failed to apply initial mode: ${(err as Error).message}`);
      }
    }
    if (this.initialModelId) {
      try {
        await this.setModel(this.initialModelId);
        console.log(`[ACP bridge] session ${this.sessionId}: applied initial model=${this.initialModelId}`);
      } catch (err) {
        console.warn(`[ACP bridge] session ${this.sessionId}: failed to apply initial model: ${(err as Error).message}`);
      }
    }
  }

  async setConfigOption(configId: string, value: string | boolean): Promise<acp.SetSessionConfigOptionResponse> {
    if (!this.connection || !this.acpSessionId) {
      throw new Error('ACP bridge is not initialized');
    }
    const response = await this.connection.setSessionConfigOption({
      sessionId: this.acpSessionId,
      configId,
      ...(typeof value === 'boolean' ? { value, type: 'boolean' as const } : { value }),
    });
    if (response.configOptions) {
      // SDK 1.3.0：set_config_option 响应携带全量快照，与 config_option_update 通知同源
      this.configOptions = extractConfigOptions(response.configOptions);
      this.socket.emit('acp:config-options', {
        sessionId: this.sessionId,
        configOptions: this.configOptions,
      });
    }
    return response;
  }

  async authenticate(methodId: string): Promise<void> {
    if (!this.connection) {
      throw new Error('ACP bridge is not initialized');
    }
    await this.connection.authenticate({ methodId });
  }

  async logout(): Promise<void> {
    if (!this.connection) {
      throw new Error('ACP bridge is not initialized');
    }
    await this.connection.logout({});
  }

  async deleteSession(): Promise<void> {
    if (!this.connection || !this.acpSessionId) {
      throw new Error('ACP bridge is not initialized');
    }
    await this.connection.deleteSession({ sessionId: this.acpSessionId });
  }

  getConfigOptions(): SessionConfigOptionData[] {
    return this.configOptions;
  }

  getSupportsAdditionalDirectories(): boolean {
    return this.supportsAdditionalDirectories;
  }

  sendInput(message: { type: string; content: string; attachments?: Array<Record<string, unknown>> }): void {
    if (this.activePrompt) {
      this.inputQueue.push(message);
      return;
    }
    this.processPrompt(message);
  }

  private async processPrompt(message: QueuedInput & { attachments?: Array<Record<string, unknown>> }): Promise<void> {
    if (!this.connection || !this.acpSessionId || this.stopped) return;

    const prompt: acp.ContentBlock[] = [];
    for (const attachment of message.attachments ?? []) {
      prompt.push(attachment as acp.ContentBlock);
    }
    prompt.push({ type: 'text' as const, text: message.content });

    this.activePrompt = this.connection.prompt({
      sessionId: this.acpSessionId,
      prompt,
    });

    this.socket.emit('acp:prompt:start', { sessionId: this.sessionId });

    let stopReason = 'end_turn';
    try {
      const result = await this.activePrompt;
      stopReason = result?.stopReason ?? 'end_turn';
    } catch {
      stopReason = 'error';
    } finally {
      this.activePrompt = null;
      if (!this.stopped) {
        this.socket.emit('acp:prompt:complete', {
          sessionId: this.sessionId,
          stopReason,
        });
      }
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
    const result = await this.connection.initialize({
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        session: {
          configOptions: { boolean: {} },
        },
        elicitation: { form: {}, url: {} },
      },
      clientInfo: {
        name: 'agent-gear',
        version: '1.1.5',
      },
    });

    this.agentProtocolVersion = result.protocolVersion ?? null;
    if (result.protocolVersion != null && result.protocolVersion !== ACP_PROTOCOL_VERSION) {
      // 版本不兼容：不断连，由上层提示用户
      this.socket.emit('acp:protocol-version-mismatch', {
        sessionId: this.sessionId,
        expectedVersion: ACP_PROTOCOL_VERSION,
        agentVersion: result.protocolVersion,
      });
    }

    this.promptCapabilities = result.agentCapabilities?.promptCapabilities
      ? {
          image: result.agentCapabilities.promptCapabilities.image ?? false,
          audio: result.agentCapabilities.promptCapabilities.audio ?? false,
          embeddedContext: result.agentCapabilities.promptCapabilities.embeddedContext ?? false,
        }
      : null;
    this.agentInfo = result.agentInfo
      ? { name: result.agentInfo.name, version: result.agentInfo.version ?? null }
      : null;
    this.authMethods = toAuthMethods(result.authMethods);
    this.agentMcpCapabilities = result.agentCapabilities?.mcpCapabilities ?? null;
    console.log(
      `[ACP bridge] session ${this.sessionId}: agent capabilities: ` +
      `protocolVersion=${result.protocolVersion ?? 'n/a'} mcp=${JSON.stringify(this.agentMcpCapabilities)} ` +
      `agent=${this.agentInfo ? `${this.agentInfo.name}@${this.agentInfo.version ?? 'n/a'}` : 'n/a'}`,
    );
    this.supportsAdditionalDirectories =
      result.agentCapabilities?.sessionCapabilities?.additionalDirectories !== undefined &&
      result.agentCapabilities?.sessionCapabilities?.additionalDirectories !== null;

    if (this.authMethods.length > 0) {
      this.socket.emit('acp:auth:required', {
        sessionId: this.sessionId,
        authMethods: this.authMethods,
      });
    }
  }

  private buildInitializedPayload(
    result: acp.NewSessionResponse | acp.ResumeSessionResponse,
  ): AcpInitializedPayload {
    const configOptions = extractConfigOptions(result.configOptions);
    this.configOptions = configOptions.length > 0 ? configOptions : this.configOptions;

    // 协议要求：响应含 configOptions 时以其为准（忽略 modes）
    const configModes = extractConfigModes(this.configOptions);
    const configModels = extractConfigModels(this.configOptions);

    let modes: Array<{ id: string; name: string; description?: string }> = [];
    let currentModeId: string | null = null;
    if (configModes) {
      modes = configModes.modes;
      currentModeId = configModes.currentModeId;
    } else if (result.modes?.availableModes) {
      modes = result.modes.availableModes.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description ?? undefined,
      }));
      currentModeId = result.modes.currentModeId ?? null;
    }

    let currentModel: AcpInitializedPayload['currentModel'] = null;
    let availableModels: Array<{ id: string; name: string; provider?: string }> = [];
    let currentModelId: string | null = null;
    if (configModels) {
      availableModels = configModels.availableModels;
      currentModelId = configModels.currentModelId;
      currentModel = configModels.currentModel;
    }

    return {
      sessionId: this.sessionId,
      acpSessionId: this.acpSessionId,
      modes,
      currentModeId,
      currentModel,
      availableModels,
      currentModelId,
      configOptions: this.configOptions,
      promptCapabilities: this.promptCapabilities,
      agentInfo: this.agentInfo,
      authMethods: this.authMethods,
      supportsAdditionalDirectories: this.supportsAdditionalDirectories,
      protocolVersion: this.agentProtocolVersion,
    };
  }

  private flushInputQueue(): void {
    while (this.inputQueue.length > 0) {
      this.processPrompt(this.inputQueue.shift()!);
    }
  }

  // ── acp.Client implementation ──

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') {
          if (this.textChunkBuffer && this.textChunkMessageId !== update.messageId) {
            // messageId 边界：不同消息立即 flush
            this.flushTextBuffer();
          }
          this.textChunkBuffer += update.content.text;
          this.textChunkMessageId = update.messageId;
          if (update.messageId) {
            // 有 messageId 时跳过 50ms debounce 猜测，按 ID 边界 flush
            this.flushTextBuffer();
          } else {
            this.scheduleTextFlush();
          }
        } else {
          // 非 text chunk（image/audio/resource）原样透传
          this.flushTextBuffer();
          this.sendUpdate(update);
        }
        break;
      case 'tool_call':
      case 'tool_call_update':
      case 'plan':
      case 'agent_thought_chunk':
        this.flushTextBuffer();
        this.sendUpdate(update);
        break;
      case 'config_option_update':
        this.flushTextBuffer();
        this.configOptions = extractConfigOptions(update.configOptions);
        this.socket.emit('acp:config-options', {
          sessionId: this.sessionId,
          configOptions: this.configOptions,
        });
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
    const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        resolve({ outcome: { outcome: 'cancelled' } });
      }, 65_000);

      this.pendingPermissions.set(requestId, { resolve, timeout });

      this.socket.emit('acp:permission', {
        requestId,
        sessionId: this.sessionId,
        toolCall: params.toolCall,
        options: params.options,
      });

      this.emit('permission:sent', requestId);
    });
  }

  handlePermissionResponse(requestId: string, outcome: acp.RequestPermissionOutcome): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      console.warn(`Permission request ${requestId} not found`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingPermissions.delete(requestId);
    pending.resolve({ outcome });
  }

  async unstable_createElicitation(
    params: acp.CreateElicitationRequest,
  ): Promise<acp.CreateElicitationResponse> {
    // custom/未知模式不支持：立即取消，避免挂起 Agent
    if (!acp.CreateElicitationRequest.isForm(params) && !acp.CreateElicitationRequest.isUrl(params)) {
      return { action: 'cancel' };
    }

    const requestId = `elic_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const toolCallId = 'toolCallId' in params ? params.toolCallId : undefined;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingElicitations.delete(requestId);
        resolve({ action: 'cancel' });
      }, 65_000);

      this.pendingElicitations.set(requestId, { resolve, timeout });

      if (acp.CreateElicitationRequest.isForm(params)) {
        this.socket.emit('acp:elicitation', {
          requestId,
          sessionId: this.sessionId,
          mode: 'form',
          message: params.message,
          ...(toolCallId != null ? { toolCallId } : {}),
          requestedSchema: params.requestedSchema,
        });
      } else {
        this.socket.emit('acp:elicitation', {
          requestId,
          sessionId: this.sessionId,
          mode: 'url',
          message: params.message,
          ...(toolCallId != null ? { toolCallId } : {}),
          elicitationId: params.elicitationId,
          url: params.url,
        });
      }

      this.emit('elicitation:sent', requestId);
    });
  }

  handleElicitationResponse(
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
  ): void {
    const pending = this.pendingElicitations.get(requestId);
    if (!pending) {
      console.warn(`Elicitation request ${requestId} not found`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingElicitations.delete(requestId);
    pending.resolve({
      action,
      ...(action === 'accept' && content
        ? { content: content as Record<string, acp.ElicitationContentValue> }
        : {}),
    });
  }

  async unstable_completeElicitation(params: acp.CompleteElicitationNotification): Promise<void> {
    this.socket.emit('acp:elicitation:complete', {
      sessionId: this.sessionId,
      elicitationId: params.elicitationId,
    });
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
        ...(this.textChunkMessageId ? { messageId: this.textChunkMessageId } : {}),
      } as acp.SessionUpdate);
      this.textChunkBuffer = '';
      this.textChunkMessageId = undefined;
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
    console.log(`[ACP bridge] session ${this.sessionId} stopped: reason=${reason} exitCode=${exitCode ?? 'n/a'}`);
    this.stopped = true;
    this.socket.emit('acp:stopped', { sessionId: this.sessionId, reason, exitCode });
    this.emit('acp:stopped', { sessionId: this.sessionId, reason, exitCode });
  }

  private handleError(error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error(`[ACP bridge] session ${this.sessionId} failed: ${msg}${stack ? `\n${stack}` : ''}`);
    this.stopped = true;
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
