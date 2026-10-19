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

  constructor(message: string) {
    super(message);
    this.name = 'BillingServiceUnavailableError';
  }
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
    } catch (err) {
      throw new BillingServiceUnavailableError(
        `费用服务不可达：${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      let detail = `费用服务返回 ${response.status}`;
      try {
        const body = (await response.json()) as { error?: string; message?: string };
        detail = body.message || body.error || detail;
      } catch {
        // ignore
      }
      throw new BillingServiceUnavailableError(detail);
    }
    return (await response.json()) as T;
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
    if (!/^[0-9a-fA-F]{24}$/.test(invoiceId)) return null;
    const list = await this.request<BillingReceiptWire[]>(
      `/internal/billing/receipts?${this.params({ accountId, invoiceId, pageSize: 1 })}`,
    );
    const receipt = list[0] ?? null;
    // 归属校验：命中项必须是同一 invoiceId，否则视为无收据
    return receipt && receipt.invoiceId === invoiceId ? receipt : null;
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
