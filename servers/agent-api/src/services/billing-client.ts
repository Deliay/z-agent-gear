import { config } from '../config/index.js';

/** 计费 wire DTO（金额已由 admin-api 换算为 credits）。 */
export interface BillingAccountWire {
  id: string;
  ownerType: 'front_user' | 'admin_user';
  ownerId: string;
  ownerName: string;
  cashBalance: number;
  giftBalance: number;
  creditLimit: number;
  frozenAmount: number;
  availableBalance: number;
  status: string;
  insufficientSince: string | null;
  ledgerCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BillingInvoiceWire {
  id: string;
  accountId: string;
  seq: number;
  type: string;
  category: string;
  amount: number;
  balanceAfter: number;
  refType: string | null;
  refId: string | null;
  description: string;
  items: Array<{
    productId: string;
    quantity: number;
    unitPrice: number;
    amount: number;
    meteringRef: string | null;
    segment?: string | null;
  }>;
  receiptId: string | null;
  createdAt: string;
}

export interface BillingReceiptWire {
  id: string;
  receiptNo: string;
  invoiceId: string;
  accountId: string;
  amount: number;
  balanceAfter: number;
  issuedAt: string;
}

export interface BillingRollupWire {
  bucketStart: string;
  chargeTotal: number;
  rechargeTotal: number;
  chargeCount: number;
}

export interface BillingApiCallWire {
  id: string;
  requestId: string;
  accountId: string;
  modelId: string;
  modelName: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cost: number;
  status: string;
  estimated: boolean;
  invoiceSeq: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface BillingApiKeyWire {
  id: string;
  name: string;
  keyPrefix: string;
  status: string;
  scope?: 'account' | 'cloud_host';
  cloudHostId?: string | null;
  expiresAt?: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface BillingApiKeyPayloadWire {
  apiKey: BillingApiKeyWire;
  secret: string;
}

const TIMEOUT_MS = 10_000;

export class BillingServiceUnavailableError extends Error {
  readonly code = 'BILLING_SERVICE_UNAVAILABLE';

  constructor(
    message: string,
    /** 上游 HTTP 状态码（如有），供上层区分「参数错误」与「服务不可用」。 */
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'BillingServiceUnavailableError';
  }
}

/** 创建云电脑扣费被拒（admin-api 409）；`available` 为 credits。 */
export class InsufficientBalanceError extends Error {
  readonly code = 'INSUFFICIENT_BALANCE';

  constructor(readonly available?: number) {
    super('insufficient balance');
    this.name = 'InsufficientBalanceError';
  }
}

/** C2：按 HTTP 状态码映射稳定、脱敏的错误文案，绝不回传服务端内部 message。 */
function stableErrorMessage(status: number): string {
  if (status === 400) return '费用请求参数不合法';
  if (status === 404) return '费用记录不存在';
  if (status === 401 || status === 403) return '费用服务鉴权失败';
  if (status >= 500) return '费用服务暂时不可用，请稍后重试';
  return '费用服务请求失败';
}

/**
 * admin-api `/internal/billing/*` 客户端（参照 CloudControllerClient 模式）：
 * 原生 fetch + AbortController 超时 + Bearer INTERNAL_API_TOKEN。
 * 配置缺失/不可达时返回明确错误，不静默空值。
 */
export class BillingClient {
  constructor(
    private readonly baseUrl: string = config.adminApiUrl,
    private readonly token: string = config.internalApiToken,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.baseUrl) {
      throw new BillingServiceUnavailableError('ADMIN_API_URL 未配置，费用服务不可用');
    }
    if (!this.token) {
      throw new BillingServiceUnavailableError('INTERNAL_API_TOKEN 未配置，费用服务不可用');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
    } catch {
      // C2：不回传底层网络错误详情（可能含内部主机/端口信息）。
      throw new BillingServiceUnavailableError('费用服务不可达，请稍后重试');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      if (response.status === 409) {
        let available: number | undefined;
        try {
          const body = (await response.json()) as { available?: unknown };
          if (typeof body.available === 'number') available = body.available;
        } catch {
          // 非 JSON 409 仍按余额不足上抛（调用方按错误码处理）
        }
        throw new InsufficientBalanceError(available);
      }
      throw new BillingServiceUnavailableError(stableErrorMessage(response.status), response.status);
    }
    try {
      return (await response.json()) as T;
    } catch {
      // C2：响应体非法（非 JSON）时抛稳定错误，不透传解析异常。
      throw new BillingServiceUnavailableError('费用服务响应异常', response.status);
    }
  }

  async getAccount(
    ownerType: 'front_user' | 'admin_user',
    ownerId: string,
    ownerName?: string,
  ): Promise<BillingAccountWire> {
    const params = new URLSearchParams({ ownerType, ownerId });
    if (ownerName) params.set('ownerName', ownerName);
    return this.request<BillingAccountWire>(`/internal/billing/account?${params.toString()}`);
  }

  async listInvoices(
    accountId: string,
    query: { from?: string; to?: string; type?: string; category?: string; page?: number; pageSize?: number } = {},
  ): Promise<BillingInvoiceWire[]> {
    return this.request<BillingInvoiceWire[]>(
      `/internal/billing/invoices?${this.params({ accountId, ...query })}`,
    );
  }

  async listReceipts(
    accountId: string,
    query: { page?: number; pageSize?: number } = {},
  ): Promise<BillingReceiptWire[]> {
    return this.request<BillingReceiptWire[]>(
      `/internal/billing/receipts?${this.params({ accountId, ...query })}`,
    );
  }

  /** 按账单直查收据：避免前端依赖收据列表分页而误报「无收据」。 */
  async getReceiptByInvoice(accountId: string, invoiceId: string): Promise<BillingReceiptWire | null> {
    // 输入自卫：空串/非 ObjectId 形态直接返回 null（不发请求，杜绝退化为「最新一张收据」而错配归属）
    const normalized = invoiceId.toLowerCase();
    if (!/^[0-9a-f]{24}$/.test(normalized)) return null;
    const list = await this.request<BillingReceiptWire[]>(
      `/internal/billing/receipts?${this.params({ accountId, invoiceId: normalized, pageSize: 1 })}`,
    );
    const receipt = list[0] ?? null;
    // 归属校验 + 大小写归一（C6）：命中项必须是同一 invoiceId，否则视为无收据
    return receipt && receipt.invoiceId.toLowerCase() === normalized ? receipt : null;
  }

  async listRollups(
    accountId: string,
    granularity: 'minute' | 'hour' | 'day',
    from: string,
    to: string,
  ): Promise<BillingRollupWire[]> {
    return this.request<BillingRollupWire[]>(
      `/internal/billing/rollups?${this.params({ accountId, granularity, from, to })}`,
    );
  }

  async listApiCalls(
    accountId: string,
    query: { status?: string; page?: number; pageSize?: number } = {},
  ): Promise<BillingApiCallWire[]> {
    return this.request<BillingApiCallWire[]>(
      `/internal/billing/api-calls?${this.params({ accountId, ...query })}`,
    );
  }

  async listApiKeys(
    ownerType: 'front_user' | 'admin_user',
    ownerId: string,
  ): Promise<BillingApiKeyWire[]> {
    return this.request<BillingApiKeyWire[]>(
      `/internal/billing/api-keys?${this.params({ ownerType, ownerId })}`,
    );
  }

  async createApiKey(
    ownerType: 'front_user' | 'admin_user',
    ownerId: string,
    name: string,
  ): Promise<BillingApiKeyPayloadWire> {
    return this.request<BillingApiKeyPayloadWire>('/internal/billing/api-keys', {
      method: 'POST',
      body: JSON.stringify({ ownerType, ownerId, name }),
    });
  }

  async revokeApiKey(
    id: string,
    ownerType: 'front_user' | 'admin_user',
    ownerId: string,
  ): Promise<{ success: boolean; apiKey: BillingApiKeyWire }> {
    return this.request<{ success: boolean; apiKey: BillingApiKeyWire }>(
      `/internal/billing/api-keys/${encodeURIComponent(id)}?${this.params({ ownerType, ownerId })}`,
      { method: 'DELETE' },
    );
  }

  /** 云电脑运行专用 Key：`scope=cloud_host`，绑定 hostId；无固定有效期，随容器回收。 */
  async createCloudHostApiKey(input: {
    accountId: string;
    ownerType: 'front_user' | 'admin_user';
    ownerId: string;
    name: string;
    cloudHostId: string;
  }): Promise<BillingApiKeyPayloadWire> {
    return this.request<BillingApiKeyPayloadWire>('/internal/billing/api-keys', {
      method: 'POST',
      body: JSON.stringify({
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        name: input.name,
        scope: 'cloud_host',
        cloudHostId: input.cloudHostId,
        accountId: input.accountId,
      }),
    });
  }

  /** 按 Key ID 内部撤销（不要求 owner，幂等）。 */
  async revokeApiKeyById(id: string): Promise<void> {
    await this.request<{ success: boolean }>(
      `/internal/billing/api-keys/${encodeURIComponent(id)}/revoke`,
      { method: 'POST' },
    );
  }

  /** 按云电脑撤销全部 active 运行 Key（幂等）。 */
  async revokeApiKeysByHost(cloudHostId: string): Promise<void> {
    await this.request<{ success: boolean }>('/internal/billing/api-keys/revoke-by-host', {
      method: 'POST',
      body: JSON.stringify({ cloudHostId }),
    });
  }

  /** 一次性扣费（云电脑创建）；409 抛 InsufficientBalanceError。 */
  async createCharge(input: {
    accountId: string;
    productId: string;
    quantity: number;
    idempotentKey: string;
    refType: string;
    refId: string;
    description: string;
  }): Promise<{ charged: boolean; invoice: unknown; receipt: unknown }> {
    return this.request<{ charged: boolean; invoice: unknown; receipt: unknown }>('/internal/billing/charges', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /** 一次性扣费退款（幂等；调用方 best-effort 处理失败）。 */
  async refundCharge(input: {
    idempotentKey: string;
    refundKey: string;
    reason: string;
  }): Promise<{ invoice: unknown; receipt: unknown }> {
    return this.request<{ invoice: unknown; receipt: unknown }>('/internal/billing/refunds', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /** 价目报价（credits）。 */
  async getPriceQuote(
    productIds: string[],
  ): Promise<Array<{ productId: string; unitPrice: number; currency: string }>> {
    const params = new URLSearchParams({ productIds: productIds.join(',') });
    return this.request<Array<{ productId: string; unitPrice: number; currency: string }>>(
      `/internal/billing/price-quote?${params.toString()}`,
    );
  }

  private params(values: Record<string, unknown>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
    return params.toString();
  }
}

export const billingClient = new BillingClient();
