import { config } from '../config/index.js';

export interface StartHarnessInput {
  hostId: string;
  /** 标准连接使用的 ControllerKey ID（作为内部请求 `refId` 下发）。 */
  controllerKeyId: string;
  containerApiKeyId: string;
  userId: string;
  hostName: string;
  harnessTypes: string[];
  expiresAt: Date;
  billingAccountId: string;
  agentGearMinVersion: string;
  workloadPlan: Array<{
    workloadId: string;
    params: Record<string, unknown>;
    implicit: boolean;
    required: boolean;
  }>;
  secrets: {
    hostEndpoint: string;
    hostKey: string;
    modelApiKey: string;
    modelBaseUrl: string;
    modelIds: string;
    defaultWorkspace: string;
  };
}

export interface CloudContainerSummary {
  id: string;
  status: string;
}

export class CloudControllerUnavailableError extends Error {
  constructor(message = 'control plane unavailable') {
    super(message);
    this.name = 'CloudControllerUnavailableError';
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** cloud-controller 内部管理 API 客户端（原生 fetch + 超时 + Bearer 内部 token）。 */
export class CloudControllerClient {
  constructor(
    private readonly baseUrl: string = config.cloudControllerUrl,
    private readonly token: string = config.internalApiToken,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.baseUrl || !this.token) {
      throw new CloudControllerUnavailableError();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
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
      throw new CloudControllerUnavailableError();
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new CloudControllerUnavailableError();
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new CloudControllerUnavailableError();
    }
  }

  async startHarness(input: StartHarnessInput): Promise<CloudContainerSummary> {
    const body = {
      purpose: 'harness',
      hostId: input.hostId,
      refId: input.controllerKeyId,
      userId: input.userId,
      hostName: input.hostName,
      harnessTypes: input.harnessTypes,
      expiresAt: input.expiresAt.toISOString(),
      billingAccountId: input.billingAccountId,
      agentGearMinVersion: input.agentGearMinVersion,
      containerApiKeyId: input.containerApiKeyId,
      secrets: input.secrets,
      workloadPlan: input.workloadPlan,
    };
    const result = await this.request<{ id?: string; status?: string }>('/internal/containers', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!result || typeof result.id !== 'string' || result.id.length === 0) {
      throw new CloudControllerUnavailableError();
    }
    return { id: result.id, status: result.status ?? 'creating' };
  }

  async listContainers(filter: { hostId?: string; userId?: string } = {}): Promise<CloudContainerSummary[]> {
    const params = new URLSearchParams();
    if (filter.hostId) params.set('hostId', filter.hostId);
    if (filter.userId) params.set('userId', filter.userId);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.request<CloudContainerSummary[]>(`/internal/containers${suffix}`);
  }

  async destroyContainer(id: string): Promise<void> {
    await this.request<{ success: boolean }>(`/internal/containers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
}

export const cloudControllerClient = new CloudControllerClient();
