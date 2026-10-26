import * as acp from '@agentclientprotocol/sdk';
import { EventEmitter } from 'events';
import type { Socket } from 'socket.io-client';
import { AcpSpawner } from './spawner.js';
import {
  CLIENT_CAPABILITIES,
  normalizeCapabilities,
  type AgentCapabilitySnapshot,
} from './capabilities.js';

const ACP_PROTOCOL_VERSION = 1;

/** 初始 mode/model 应用后回读确认失败时的重试间隔 */
const INITIAL_CONFIG_RETRY_DELAY_MS = 300;

function initialConfigPendingTimeoutMs(): number {
  const raw = Number(process.env.INITIAL_CONFIG_PENDING_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
}

export interface AcpBridgeOptions {
  sessionId: string;
  cwd: string;
  additionalDirectories?: string[];
  mcpServers?: Array<{ name: string; command: string; args?: string[]; env?: Array<{ name: string; value: string }> }>;
  mcpEndpoint?: { token: string; serverNames: string[] };
  /** 本机回环 MCP 端点共享端口（由 local-server 注册时提供） */
  mcpPort?: number;
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
  /** 能力快照（Agent 声明 × 平台支持归一化结果） */
  capabilities: AgentCapabilitySnapshot;
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

function toMcpEndpointServers(
  mcpEndpoint: NonNullable<AcpBridgeOptions['mcpEndpoint']>,
  sessionId: string,
  port: number,
): acp.McpServer[] {
  // Fail loudly with a diagnosable message instead of a raw TypeError when the
  // upstream payload drifts from the contract (serverNames is required).
  if (!Array.isArray(mcpEndpoint.serverNames) || mcpEndpoint.serverNames.length === 0) {
    throw new Error(
      `Invalid mcpEndpoint payload: "serverNames" must be a non-empty array ` +
      `(received: ${JSON.stringify(mcpEndpoint.serverNames)})`,
    );
  }
  // Never emit a loopback URL with a zero/negative port (invalid): fail loudly so
  // the launch fails diagnosably instead of silently wiring a broken MCP address.
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `Invalid MCP loopback port: ${JSON.stringify(port)}. The local MCP endpoint must be listening before session launch.`,
    );
  }
  const headers: acp.HttpHeader[] = [{ name: 'Authorization', value: `Bearer ${mcpEndpoint.token}` }];
  // Each assembled server gets its own loopback URL so the entry point can
  // route standard MCP clients (which never send a serverName param) correctly.
  return mcpEndpoint.serverNames.map((name) => ({
    type: 'http' as const,
    name,
    url: `http://127.0.0.1:${port}/mcp/${sessionId}/${encodeURIComponent(name)}`,
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
  private mcpPort: number | undefined;
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
  private processExitSubscribed = false;
  /** silent stop（同 sessionId 替换/对账）：后续迟到的 handleError 不得再向服务端发 stopped */
  private silentStop = false;
  private pendingPermissions = new Map<string, {
    resolve: (response: acp.RequestPermissionResponse) => void;
    timeout: NodeJS.Timeout;
  }>();
  private pendingElicitations = new Map<string, {
    resolve: (response: acp.CreateElicitationResponse) => void;
    timeout: NodeJS.Timeout;
    /** url 模式的 elicitationId：用于 Agent 自发 complete 时精确定位 pending 请求 */
    elicitationId?: string;
  }>();
  /** 初始 mode/model 应用确认结果（契约 §2.39；仅请求过 modeId/modelId 时非空） */
  private initialConfigResult: {
    modeId?: string;
    modelId?: string;
    modeStatus?: 'applied' | 'failed';
    modelStatus?: 'applied' | 'failed';
    error?: string;
  } | null = null;
  /** apply 时缺少可用通道（configOptions 未随 session/new 到达）而挂起等待 config_option_update 的类目 */
  private pendingInitialConfigKinds: Array<'mode' | 'model'> = [];
  private initialConfigPendingTimer: ReturnType<typeof setTimeout> | null = null;
  private initialConfigRetrying = false;
  private initialConfigEmitted = false;

  // Capability snapshot from initialize / session/new / resume
  private configOptions: SessionConfigOptionData[] = [];
  private promptCapabilities: AcpInitializedPayload['promptCapabilities'] = null;
  private agentInfo: AcpInitializedPayload['agentInfo'] = null;
  private authMethods: AcpAuthMethodData[] = [];
  /** initialize 返回的 authMethods 原文（契约要求快照 raw 保留对端声明原文，不能存转换后产物） */
  private authMethodsRaw: unknown = null;
  private supportsAdditionalDirectories = false;
  private agentProtocolVersion: number | null = null;
  private agentMcpCapabilities: { http?: boolean | null; sse?: boolean | null } | null = null;
  private agentCapabilitiesRaw: unknown = null;
  private clientCapabilitiesRaw: unknown = CLIENT_CAPABILITIES;

  constructor(socket: Socket, options: AcpBridgeOptions, spawner?: AcpSpawner) {
    super();
    this.socket = socket;
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.additionalDirectories = options.additionalDirectories ?? [];
    this.mcpServers = options.mcpServers;
    this.mcpEndpoint = options.mcpEndpoint;
    this.mcpPort = options.mcpPort;
    this.initialModeId = options.initialModeId;
    this.initialModelId = options.initialModelId;
    this.spawner = spawner ?? new AcpSpawner({ sessionId: options.sessionId, cwd: options.cwd });
  }

  private resolveMcpServers(): acp.McpServer[] {
    if (this.mcpEndpoint) {
      return toMcpEndpointServers(this.mcpEndpoint, this.sessionId, this.mcpPort ?? 0);
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
    this.subscribeToProcessExit();
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

      this.absorbSessionConfigOptions(result);
      // 工作流节点配置的初始 mode/model：在首条 prompt 前应用，而非使用 harness 默认设置；
      // initialized payload 须在应用之后构造，携带确认后的生效值而非默认值
      await this.applyInitialModeModel();
      this.emit('acp:initialized', this.buildInitializedPayload(result));
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
    this.subscribeToProcessExit();
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

      this.absorbSessionConfigOptions(result);
      // 初始 mode/model 在 acp:initialized 之前应用（时序同 start：initialized → resume:result → prompt 补发）
      await this.applyInitialModeModel();
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

        this.absorbSessionConfigOptions(result);
        await this.applyInitialModeModel();
        this.emit('acp:initialized', this.buildInitializedPayload(result));
      } catch (fallbackError) {
        this.initializing = false;
        this.handleError(fallbackError);
      }
    }
  }

  async stop(options: { silent?: boolean } = {}): Promise<void> {
    if (options.silent) this.silentStop = true;
    this.activePrompt = null;
    this.inputQueue = [];
    // 会话关闭：所有在途问询/授权必须先同步收敛（在 cancel/closeSession 的 5s race 之前），
    // 否则 race 窗口内 65s timer 仍可能迟到发 timeout。
    this.settlePendingRequests('session stopped by user');
    this.clearPendingInitialConfig();
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.acpSessionId && this.connection) {
        // 5s timeout for cancel/closeSession to prevent hanging（结束后清理 timer，避免拖住事件循环）
        await Promise.race([
          (async () => {
            await this.connection!.cancel({ sessionId: this.acpSessionId! });
            await this.connection!.closeSession({ sessionId: this.acpSessionId! });
          })(),
          new Promise<void>((resolve) => { stopTimer = setTimeout(resolve, 5000); }),
        ]);
      }
    } catch { /* ignore */ } finally {
      if (stopTimer) clearTimeout(stopTimer);
    }
    this.spawner.stop();
    this.emitStopped('user_close', undefined, options.silent);
  }

  /**
   * 清空 pending 请求：clearTimeout + resolve(cancel) + delete。
   * 问询额外回发 resolved(cancelled)，让服务端待办收敛为 cancelled 而不是等 65s 超时误标 expired。
   * 同时发出 settled 事件，供 socketio-client 清理 requestId → bridge 映射（避免 Map 单调增长/阻止 GC）。
   */
  private settlePendingRequests(detail: string): void {
    for (const [requestId, pending] of this.pendingElicitations) {
      clearTimeout(pending.timeout);
      this.pendingElicitations.delete(requestId);
      pending.resolve({ action: 'cancel' });
      this.emit('elicitation:settled', requestId);
      this.socket.emit('acp:elicitation:resolved', {
        requestId,
        sessionId: this.sessionId,
        reason: 'cancelled',
        detail: detail.slice(0, 100),
      });
    }

    for (const [requestId, pending] of this.pendingPermissions) {
      clearTimeout(pending.timeout);
      this.pendingPermissions.delete(requestId);
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      this.emit('permission:settled', requestId);
    }
  }

  /** 进程退出（不可恢复）：收敛所有 pending；socket 仍连接时服务端据 cancelled 收敛待办 */
  private subscribeToProcessExit(): void {
    if (this.processExitSubscribed) return;
    this.processExitSubscribed = true;
    this.spawner.closed.then(() => {
      if (this.stopped) return;
      console.warn(`[ACP bridge] session ${this.sessionId}: process exited, settling pending requests`);
      this.settlePendingRequests('process exited');
    }).catch(() => { /* ignore */ });
  }

  /** 连接断开（可能自动重连）：只收敛 pending，不停止会话进程；重连后可继续使用 */
  settlePendingOnDisconnect(): void {
    if (this.stopped) return;
    this.settlePendingRequests('connection lost');
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
      // 配置项通道：Agent 提供 configOptions 时以配置项为准；复用 setConfigOption
      // 以获得响应快照刷新 + acp:config-options 回发（与 acp:set-config-option 行为一致）
      await this.setConfigOption(modeConfig.id, modeId);
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
      await this.setConfigOption(modelConfig.id, modelId);
      return;
    }
    // SDK 1.x 已移除 unstable_setSessionModel：无 configOptions 的旧 Agent 无法走配置项通道。
    // 模型切换暂不支持，由上层提示（不保留 unstable 调用）。
    throw new Error('Model switching is not supported: agent does not expose a model config option');
  }

  /**
   * 会话初始化（session/new 之后、首条 prompt 之前）应用工作流节点配置的初始 mode/model。
   * 契约 §2.4「初始模式/模型应用确认」：应用 → 回读确认 → 重试一次 → 结果上报；
   * apply 时缺少可用通道（configOptions 未随响应到达）则挂起，待 config_option_update 补应用。
   */
  private async applyInitialModeModel(): Promise<void> {
    if (!this.initialModeId && !this.initialModelId) return;
    this.initialConfigResult = {
      ...(this.initialModeId ? { modeId: this.initialModeId } : {}),
      ...(this.initialModelId ? { modelId: this.initialModelId } : {}),
    };

    if (this.initialModeId) {
      const error = await this.confirmInitialConfig('mode', this.initialModeId);
      this.recordInitialConfigStatus('mode', error ? 'failed' : 'applied', error);
    }
    if (this.initialModelId) {
      if (findConfigByCategory(this.configOptions, 'model')) {
        const error = await this.confirmInitialConfig('model', this.initialModelId);
        this.recordInitialConfigStatus('model', error ? 'failed' : 'applied', error);
      } else {
        // model 无旧通道可走：不判失败，挂起等待 config_option_update 补应用
        this.pendingInitialConfigKinds.push('model');
      }
    }

    if (this.pendingInitialConfigKinds.length > 0) {
      // 挂起不阻塞会话：initialized 照常发出，结果事件在补确认/超时收敛后补发
      this.armInitialConfigPendingTimeout();
      return;
    }
    this.emitInitialConfigResult();
  }

  /**
   * 应用并回读确认单个初始配置项，失败重试一次；返回 null 表示 confirmed，否则为失败原因。
   * config-option 通道以 set_config_option 响应快照回读（currentValue === 请求值）；
   * 旧 session/setMode 通道（无 config-option）无协议级回读，不抛错即视为 applied。
   */
  private async confirmInitialConfig(kind: 'mode' | 'model', requested: string): Promise<string | null> {
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, INITIAL_CONFIG_RETRY_DELAY_MS));
      }
      try {
        if (kind === 'mode') await this.setMode(requested);
        else await this.setModel(requested);
        const config = findConfigByCategory(this.configOptions, kind);
        if (!config || config.currentValue === requested) {
          console.log(`[ACP bridge] session ${this.sessionId}: applied initial ${kind}=${requested}`);
          return null;
        }
        lastError = `agent confirmed "${config.currentValue ?? 'null'}" instead of "${requested}"`;
      } catch (err) {
        lastError = (err as Error).message;
      }
    }
    console.warn(
      `[ACP bridge] session ${this.sessionId}: failed to apply initial ${kind}: ` +
      `requested=${requested}, ${lastError}`,
    );
    return `requested "${requested}": ${lastError}`;
  }

  private recordInitialConfigStatus(
    kind: 'mode' | 'model',
    status: 'applied' | 'failed',
    error?: string | null,
  ): void {
    if (!this.initialConfigResult) return;
    if (kind === 'mode') this.initialConfigResult.modeStatus = status;
    else this.initialConfigResult.modelStatus = status;
    if (status === 'failed' && error) {
      this.initialConfigResult.error = this.initialConfigResult.error
        ? `${this.initialConfigResult.error}; ${kind}: ${error}`
        : `${kind}: ${error}`;
    }
  }

  /** 挂起等待上限：超时后未确认的类目按 failed 收敛（契约 §2.4） */
  private armInitialConfigPendingTimeout(): void {
    if (this.initialConfigPendingTimer) return;
    const timeoutMs = initialConfigPendingTimeoutMs();
    this.initialConfigPendingTimer = setTimeout(() => {
      this.initialConfigPendingTimer = null;
      for (const kind of this.pendingInitialConfigKinds.splice(0)) {
        const requested = kind === 'mode' ? this.initialModeId : this.initialModelId;
        const error = `agent did not expose a ${kind} config option within ${timeoutMs}ms`;
        console.warn(
          `[ACP bridge] session ${this.sessionId}: failed to apply initial ${kind}: ` +
          `requested=${requested}, ${error}`,
        );
        this.recordInitialConfigStatus(kind, 'failed', `requested "${requested}": ${error}`);
      }
      this.emitInitialConfigResult();
    }, timeoutMs);
  }

  /** config_option_update 到达后对挂起的类目补应用 + 回读确认；全部收敛时上报结果 */
  private async retryPendingInitialConfig(): Promise<void> {
    if (
      this.initialConfigEmitted ||
      this.initialConfigRetrying ||
      this.pendingInitialConfigKinds.length === 0
    ) return;
    this.initialConfigRetrying = true;
    try {
      for (const kind of this.pendingInitialConfigKinds.splice(0)) {
        const requested = kind === 'mode' ? this.initialModeId : this.initialModelId;
        if (!requested) continue;
        if (!findConfigByCategory(this.configOptions, kind)) {
          // 本次通知仍未暴露对应 category：继续挂起，等待后续通知或超时收敛
          this.pendingInitialConfigKinds.push(kind);
          continue;
        }
        const error = await this.confirmInitialConfig(kind, requested);
        this.recordInitialConfigStatus(kind, error ? 'failed' : 'applied', error);
      }
      if (this.pendingInitialConfigKinds.length === 0) {
        this.emitInitialConfigResult();
      }
    } finally {
      this.initialConfigRetrying = false;
    }
  }

  /** 确认收敛时恰好发送一次 acp:initial-config:result（契约 §2.39） */
  private emitInitialConfigResult(): void {
    if (this.initialConfigEmitted || !this.initialConfigResult) return;
    this.initialConfigEmitted = true;
    if (this.initialConfigPendingTimer) {
      clearTimeout(this.initialConfigPendingTimer);
      this.initialConfigPendingTimer = null;
    }
    const result = this.initialConfigResult;
    this.socket.emit('acp:initial-config:result', {
      sessionId: this.sessionId,
      ...(result.modeId ? { modeId: result.modeId, modeStatus: result.modeStatus } : {}),
      ...(result.modelId ? { modelId: result.modelId, modelStatus: result.modelStatus } : {}),
      ...(result.error ? { error: result.error.slice(0, 200) } : {}),
    });
  }

  /** 会话关闭/初始化失败后不再补发确认结果（语义同 settlePendingRequests） */
  private clearPendingInitialConfig(): void {
    if (this.initialConfigPendingTimer) {
      clearTimeout(this.initialConfigPendingTimer);
      this.initialConfigPendingTimer = null;
    }
    this.pendingInitialConfigKinds = [];
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
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: {
        name: 'agent-gear',
        version: '1.1.5',
      },
    });

    this.agentProtocolVersion = result.protocolVersion ?? null;
    this.agentCapabilitiesRaw = result.agentCapabilities ?? null;
    this.clientCapabilitiesRaw = CLIENT_CAPABILITIES;
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
    // 原文留存与归一化分离：authMethods 用于下发/展示，authMethodsRaw 只进能力快照 raw
    this.authMethodsRaw = result.authMethods ?? null;
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

  /** session/new 与 session/resume 响应携带的 configOptions 是全量快照：非空时以其刷新本地状态 */
  private absorbSessionConfigOptions(
    result: acp.NewSessionResponse | acp.ResumeSessionResponse,
  ): void {
    const configOptions = extractConfigOptions(result.configOptions);
    if (configOptions.length > 0) this.configOptions = configOptions;
  }

  private buildInitializedPayload(
    result: acp.NewSessionResponse | acp.ResumeSessionResponse,
  ): AcpInitializedPayload {
    // this.configOptions 已由 absorbSessionConfigOptions（start/resume 在 apply 前）装载，
    // apply 阶段的 set_config_option 响应快照也已刷新，此处不得再用 session/new 旧快照覆盖

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
      capabilities: normalizeCapabilities({
        protocolVersion: this.agentProtocolVersion,
        agentInfo: this.agentInfo
          ? { name: this.agentInfo.name, version: this.agentInfo.version ?? null }
          : null,
        agentCapabilities: this.agentCapabilitiesRaw,
        authMethods: this.authMethodsRaw,
        clientCapabilities: this.clientCapabilitiesRaw,
        configOptions: this.configOptions,
        modes,
      }),
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
        // session/new 未携带 configOptions 时挂起的初始 mode/model 在此补应用（契约 §2.4）
        await this.retryPendingInitialConfig();
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
        this.emit('permission:settled', requestId);
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
    this.emit('permission:settled', requestId);
    pending.resolve({ outcome });
  }

  async unstable_createElicitation(
    params: acp.CreateElicitationRequest,
  ): Promise<acp.CreateElicitationResponse> {
    // 先分配 requestId：unsupported_mode 事件同样需要可定位的请求 id，
    // 否则接收端只能按 sessionId 兜底或静默丢弃。
    const requestId = `elic_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // custom/未知模式不支持：立即取消，避免挂起 Agent。必须留下日志与 resolved 事件，
    // 否则「Agent 发起问询但用户从未看到弹窗」无法从日志/待办侧定位。
    if (!acp.CreateElicitationRequest.isForm(params) && !acp.CreateElicitationRequest.isUrl(params)) {
      const mode = (params as { mode?: unknown }).mode ?? 'unknown';
      console.warn('[ACP bridge] session %s: unsupported elicitation mode=%j', this.sessionId, mode);
      this.socket.emit('acp:elicitation:resolved', {
        requestId,
        sessionId: this.sessionId,
        reason: 'unsupported_mode',
        // Agent 可控字符串：截断后再入事件/日志，避免无限放大
        detail: String(mode).slice(0, 100),
      });
      return { action: 'cancel' };
    }

    const toolCallId = 'toolCallId' in params ? params.toolCallId : undefined;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingElicitations.delete(requestId);
        this.emit('elicitation:settled', requestId);
        console.warn(
          '[ACP bridge] session %s: elicitation %s timed out after 65s, auto-cancelling',
          this.sessionId,
          requestId,
        );
        this.socket.emit('acp:elicitation:resolved', {
          requestId,
          sessionId: this.sessionId,
          reason: 'timeout',
          detail: 'bridge timeout (65s)',
        });
        resolve({ action: 'cancel' });
      }, 65_000);

      this.pendingElicitations.set(requestId, {
        resolve,
        timeout,
        ...('elicitationId' in params && params.elicitationId
          ? { elicitationId: String(params.elicitationId) }
          : {}),
      });

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
    this.emit('elicitation:settled', requestId);
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

    // Agent 自行完成/取消：对匹配的 pending 就地收敛，避免悬挂到 65s 被误标 expired。
    // 契约 reason:'cancelled' 的产生路径之一（另一处为会话关闭 settle）。
    const entry = [...this.pendingElicitations.entries()]
      .find(([, pending]) => pending.elicitationId === params.elicitationId);
    if (!entry) return;

    const [requestId, pending] = entry;
    clearTimeout(pending.timeout);
    this.pendingElicitations.delete(requestId);
    this.emit('elicitation:settled', requestId);
    pending.resolve({ action: 'cancel' });
    this.socket.emit('acp:elicitation:resolved', {
      requestId,
      sessionId: this.sessionId,
      reason: 'cancelled',
      detail: 'agent completed elicitation',
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

  private emitStopped(reason: string, exitCode?: number, silent = false): void {
    console.log(`[ACP bridge] session ${this.sessionId} stopped: reason=${reason} exitCode=${exitCode ?? 'n/a'}${silent ? ' (silent)' : ''}`);
    this.stopped = true;
    if (this.textChunkTimer) {
      clearTimeout(this.textChunkTimer);
      this.textChunkTimer = null;
    }
    // silent：同 sessionId 被替换/对账杀掉时，旧 bridge 的迟到 stopped 不得删除新会话映射。
    // silentStop 为 once-silent-always-silent：非 silent stop 在 5s race 在途时被替换路径
    // 的 stop({silent:true}) 接管，迟到的 emitStopped 同样必须抑制（R6a）。
    if (silent || this.silentStop) return;
    this.socket.emit('acp:stopped', { sessionId: this.sessionId, reason, exitCode });
    this.emit('acp:stopped', { sessionId: this.sessionId, reason, exitCode });
  }

  private handleError(error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error(`[ACP bridge] session ${this.sessionId} failed: ${msg}${stack ? `\n${stack}` : ''}`);
    const wasStopped = this.stopped || this.silentStop;
    this.stopped = true;
    // 进程崩溃同样必须收敛 pending：否则 65s timer 泄漏且迟发 timeout 事件
    this.settlePendingRequests('session failed');
    this.clearPendingInitialConfig();
    // 已停止（含 silent 替换/对账）后迟到的初始化失败：不得再发 stopped，
    // 否则内联监听器/服务端会按 sessionId 删除新会话的注册与映射。
    if (wasStopped) return;
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
