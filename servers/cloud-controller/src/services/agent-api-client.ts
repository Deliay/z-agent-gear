/**
 * cloud-controller → agent-api 内部回调客户端（契约 §5.1 / 裁决 A19）。
 *
 * 仅发送生命周期事实，不携带 secret：
 * - `POST /internal/cloud-hosts/:hostId/ready`：容器首次就绪（幂等，服务端已 RUNNING 不重复建会话）；
 * - `POST /internal/cloud-hosts/:hostId/terminal`：容器终态（`status: stopped|failed`）。
 *
 * 超时由 AbortController 控制；失败抛错交给调用方告警（不阻断容器生命周期），
 * 错误消息只包含 HTTP 状态/方法，不含请求头或 secret。
 */
export interface AgentApiClientOptions {
  /** agent-api 内部地址；为空表示未配置，所有调用为 no-op。 */
  baseUrl: string;
  /** 内部 API Bearer token（与 `INTERNAL_API_TOKEN` 一致）。 */
  token: string;
  /** 请求超时（默认 5000ms）。 */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** 存储回调重试退避（默认 0/250/1000/3000ms，共 4 次；单测可缩短）。 */
  storageRetryDelaysMs?: readonly number[];
}

export type TerminalStatus = 'stopped' | 'failed';

/** terminal 回调附带的存储归档状态（契约 A.2.10；未挂载存储时不携带）。 */
export interface TerminalStorageState {
  id: string;
  archiveStatus: 'pending' | 'running' | 'succeeded' | 'failed' | null;
  /** 本次归档 id（契约 A.2.10 扩展；新周期占位/旧回调判定）。 */
  archiveId?: string | null;
  /** 本次销毁显式跳过归档（destroy storageArchive:false）；仅 true 时携带。 */
  archiveSkipped?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_STORAGE_RETRY_DELAYS_MS = [0, 250, 1000, 3000] as const;

export class AgentApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly storageRetryDelaysMs: readonly number[];

  constructor(options: AgentApiClientOptions) {
    this.baseUrl = (options.baseUrl ?? '').trim().replace(/\/+$/, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.storageRetryDelaysMs =
      options.storageRetryDelaysMs ?? DEFAULT_STORAGE_RETRY_DELAYS_MS;
  }

  /** 是否已配置 agent-api 地址（未配置时回调 no-op）。 */
  get configured(): boolean {
    return this.baseUrl.length > 0;
  }

  async notifyReady(hostId: string): Promise<void> {
    await this.post(hostId, 'ready');
  }

  async notifyTerminal(
    hostId: string,
    status: TerminalStatus,
    reason?: string,
    storage?: TerminalStorageState | null,
  ): Promise<void> {
    const body: Record<string, unknown> = { status };
    if (reason !== undefined) body.reason = reason;
    // 契约 A.2.10：仅挂载存储时携带，未挂载时保持既有报文形状。
    if (storage) body.storage = storage;
    await this.post(hostId, 'terminal', body);
  }

  /** 归档状态回调（`POST /internal/cloud-storages/:id/archives`，4 次退避重试）。 */
  async notifyStorageArchive(storageId: string, body: object): Promise<void> {
    await this.postWithRetry(
      `/internal/cloud-storages/${encodeURIComponent(storageId)}/archives`,
      body,
      'storage archive',
    );
  }

  /** 用量回调（`POST /internal/cloud-storages/:id/usage`，4 次退避重试）。 */
  async notifyStorageUsage(storageId: string, body: object): Promise<void> {
    await this.postWithRetry(
      `/internal/cloud-storages/${encodeURIComponent(storageId)}/usage`,
      body,
      'storage usage',
    );
  }

  /** 复原回调（`POST /internal/cloud-storages/:id/restores`，4 次退避重试）。 */
  async notifyStorageRestore(storageId: string, body: object): Promise<void> {
    await this.postWithRetry(
      `/internal/cloud-storages/${encodeURIComponent(storageId)}/restores`,
      body,
      'storage restore',
    );
  }

  private async postWithRetry(
    path: string,
    body: object,
    label: string,
  ): Promise<void> {
    if (!this.configured) return;
    const delays = this.storageRetryDelaysMs;
    let lastError: unknown;
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (delays[attempt]! > 0) {
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
      try {
        await this.request(path, body, label);
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  private async post(
    hostId: string,
    action: 'ready' | 'terminal',
    body?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.configured) return;
    const path = `/internal/cloud-hosts/${encodeURIComponent(hostId)}/${action}`;
    if (body) {
      await this.request(path, body, action);
    } else {
      await this.request(path, undefined, action);
    }
  }

  private async request(
    path: string,
    body: object | undefined,
    label: string,
  ): Promise<void> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`agent-api ${label} failed: HTTP ${response.status}`);
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw new Error(`agent-api ${label} timeout after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
