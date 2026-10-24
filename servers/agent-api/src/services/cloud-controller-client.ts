import { config } from '../config/index.js';

export interface StartHarnessInput {
  hostId: string;
  /** 云电脑 controllerId（Job env `ZAG_CONTROLLER_ID`）。 */
  controllerId?: string | null;
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
    /** 模型 ID → 最长上下文（token）JSON object 字符串（无有效条目时为 `{}`）。 */
    modelContextLengths: string;
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

/** 内部 API 明确返回非 2xx（保留状态码与错误码，供上层映射可读文案）。 */
export class CloudControllerRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'CloudControllerRequestError';
  }
}

export interface StartRuntimeWorkloadInput {
  containerId: string;
  workloadId: string;
  params?: Record<string, unknown>;
  source?: 'user' | 'mcp';
}

export interface StartRuntimeScriptInput {
  containerId: string;
  workloadId: string;
  workloadName: string;
  script: string;
  params?: Record<string, unknown>;
  source?: 'user' | 'mcp' | 'system';
  githubAuth?: boolean;
}

export interface RuntimeBatchResponse {
  batchId: string;
  items: Array<{ logId: string; workloadId: string; workloadName: string }>;
}

export interface CloudWorkloadLogSummary {
  id: string;
  workloadName: string;
  status: string;
  log: string;
  exitCode: number | null;
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
      controllerId: input.controllerId ?? undefined,
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

  private async requestWithError<T>(path: string, init: RequestInit = {}): Promise<T> {
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
      let code = `HTTP_${response.status}`;
      let message: string | undefined;
      try {
        const body = (await response.json()) as { error?: unknown; message?: unknown };
        if (typeof body.error === 'string') code = body.error;
        if (typeof body.message === 'string') message = body.message;
      } catch {
        // 非 JSON 响应保留状态码
      }
      throw new CloudControllerRequestError(response.status, code, message);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new CloudControllerUnavailableError();
    }
  }

  async startRuntimeWorkload(input: StartRuntimeWorkloadInput): Promise<RuntimeBatchResponse> {
    return this.requestWithError<RuntimeBatchResponse>(
      `/internal/containers/${encodeURIComponent(input.containerId)}/workloads`,
      {
        method: 'POST',
        body: JSON.stringify({
          workloadId: input.workloadId,
          params: input.params ?? {},
          source: input.source ?? 'user',
        }),
      },
    );
  }

  async startRuntimeScript(
    input: StartRuntimeScriptInput,
  ): Promise<{ batchId: string; logId: string }> {
    return this.requestWithError<{ batchId: string; logId: string }>(
      `/internal/containers/${encodeURIComponent(input.containerId)}/runtime-scripts`,
      {
        method: 'POST',
        body: JSON.stringify({
          workloadId: input.workloadId,
          workloadName: input.workloadName,
          script: input.script,
          params: input.params ?? {},
          source: input.source ?? 'system',
          githubAuth: input.githubAuth === true,
        }),
      },
    );
  }

  async getWorkloadLogs(containerId: string): Promise<CloudWorkloadLogSummary[]> {
    return this.requestWithError<CloudWorkloadLogSummary[]>(
      `/internal/containers/${encodeURIComponent(containerId)}/workload-logs`,
    );
  }
}

export const cloudControllerClient = new CloudControllerClient();
