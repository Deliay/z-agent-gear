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
}

export type TerminalStatus = 'stopped' | 'failed';

const DEFAULT_TIMEOUT_MS = 5000;

export class AgentApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AgentApiClientOptions) {
    this.baseUrl = (options.baseUrl ?? '').trim().replace(/\/+$/, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
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
  ): Promise<void> {
    const body: Record<string, unknown> = { status };
    if (reason !== undefined) body.reason = reason;
    await this.post(hostId, 'terminal', body);
  }

  private async post(
    hostId: string,
    action: 'ready' | 'terminal',
    body?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.configured) return;

    const url = `${this.baseUrl}/internal/cloud-hosts/${encodeURIComponent(hostId)}/${action}`;
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
        throw new Error(`agent-api ${action} failed: HTTP ${response.status}`);
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw new Error(`agent-api ${action} timeout after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
