/**
 * cloud-controller → admin-api 内部计费客户端（裁决 A16：终态撤销运行专用模型 Key）。
 *
 * 按 `cloudHostId` 幂等撤销（admin-api 端幂等）：容器终态时调用；失败由调用方告警，
 * 不阻断容器生命周期。请求/错误均不携带 Key 明文。
 */
export interface AdminBillingClientOptions {
  /** admin-api 内部地址；为空表示未配置，调用为 no-op。 */
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5000;

export class AdminBillingClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AdminBillingClientOptions) {
    this.baseUrl = (options.baseUrl ?? '').trim().replace(/\/+$/, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return this.baseUrl.length > 0;
  }

  async revokeByHost(cloudHostId: string): Promise<void> {
    if (!this.configured) return;

    const url = `${this.baseUrl}/internal/billing/api-keys/revoke-by-host`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cloudHostId }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`admin-api revoke-by-host failed: HTTP ${response.status}`);
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw new Error(`admin-api revoke-by-host timeout after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
