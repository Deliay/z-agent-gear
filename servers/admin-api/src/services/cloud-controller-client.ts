import { config } from '../config/index.js';

/** 契约 `CloudContainer` 的服务端形态（枚举已大写、时间为 ISO 字符串） */
export interface CloudContainerDTO {
  id: string;
  name: string;
  status: string;
  purpose: string;
  refId: string | null;
  createdAt: string;
  connectedAt: string | null;
  exitedAt: string | null;
  exitReason: string | null;
  /** 启动时挂载的工作负载 ID，按选择顺序（缺省为 []） */
  workloadIds: string[];
  /** 初始化中当前正在执行的工作负载脚本名称；非初始化中为 null */
  currentWorkloadName: string | null;
}

/** 控制面（cloud-controller）不可达时对外统一错误码（裁决 12） */
export const CONTROL_PLANE_UNAVAILABLE = 'CONTROL_PLANE_UNAVAILABLE';

/** 控制面不可达：网络错误、超时、或地址/令牌未配置。写操作在此错误下不降级。 */
export class ControlPlaneUnavailableError extends Error {
  readonly code = CONTROL_PLANE_UNAVAILABLE;

  constructor(message = 'cloud-controller 不可达') {
    super(message);
    this.name = 'ControlPlaneUnavailableError';
  }
}

const DEFAULT_TIMEOUT_MS = 5000;
/**
 * 强制销毁专用超时兜底（裁决 9）：默认 180s，显著大于 cloud-controller 的
 * post 预算（90s）+ shutdown 宽限（10s）+ 删 Job 重试，避免「服务端已销毁但客户端超时误报」。
 * 实际取值优先 `CLOUD_CONTROLLER_DESTROY_TIMEOUT_MS`，再回落到本常量。
 */
const DEFAULT_DESTROY_TIMEOUT_MS = 180000;

/** 内部 API 的小写状态 → GraphQL 大写枚举（裁决 18：initializing ↔ INITIALIZING） */
const STATUS_TO_GQL: Record<string, string> = {
  creating: 'CREATING',
  connecting: 'CONNECTING',
  initializing: 'INITIALIZING',
  online: 'ONLINE',
  destroying: 'DESTROYING',
  exited: 'EXITED',
  failed: 'FAILED',
};

/** 内部 API 的小写用途 → GraphQL 大写枚举 */
const PURPOSE_TO_GQL: Record<string, string> = {
  idle: 'IDLE',
  'admin-task': 'ADMIN_TASK',
  workflow: 'WORKFLOW',
  session: 'SESSION',
};

/** GraphQL 大写用途 → 内部 API 小写用途 */
const GQL_TO_PURPOSE: Record<string, string> = {
  IDLE: 'idle',
  ADMIN_TASK: 'admin-task',
  WORKFLOW: 'workflow',
  SESSION: 'session',
};

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** 归一 `workloadIds`：非数组/缺失 → []，元素一律转字符串 */
function normalizeWorkloadIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((id) => String(id));
}

/** GraphQL 用途枚举 → 内部 API 小写字符串（未知值原样小写透传，交由 cloud-controller 校验） */
export function toInternalPurpose(purpose: string): string {
  return GQL_TO_PURPOSE[purpose] ?? purpose.toLowerCase();
}

/**
 * 将 cloud-controller 内部 API 响应（A.3 JSON）或降级读取的 Mongo 文档（Date + `_id`）
 * 归一为契约 `CloudContainer` 形态（枚举大写、时间 ISO 字符串、可空字段归一）。
 */
export function mapCloudContainer(raw: Record<string, unknown>): CloudContainerDTO {
  const rawId = raw.id ?? (raw._id as { toString(): string } | undefined);
  const status = raw.status as string | undefined;
  const purpose = raw.purpose as string | undefined;

  return {
    id: rawId === undefined || rawId === null ? '' : String(rawId),
    name: (raw.name as string | undefined) ?? '',
    // 未知状态回落 FAILED（问题 23）：避免映射出非法 GraphQL 枚举值打挂整条查询
    status: status ? (STATUS_TO_GQL[status] ?? 'FAILED') : 'FAILED',
    // 未知用途同样回落到安全值 IDLE，避免非法枚举
    purpose: purpose ? (PURPOSE_TO_GQL[purpose] ?? 'IDLE') : 'IDLE',
    refId: (raw.refId as string | null | undefined) ?? null,
    createdAt: toIso(raw.createdAt) ?? new Date(0).toISOString(),
    connectedAt: toIso(raw.connectedAt),
    exitedAt: toIso(raw.exitedAt),
    exitReason: (raw.exitReason as string | null | undefined) ?? null,
    workloadIds: normalizeWorkloadIds(raw.workloadIds),
    currentWorkloadName: (raw.currentWorkloadName as string | null | undefined) ?? null,
  };
}

/** 下发给 cloud-controller 的执行计划条目（契约 §3.2.1） */
export interface WorkloadPlanItemDTO {
  workloadId: string;
  params: Record<string, unknown>;
  implicit: boolean;
}

export interface CloudControllerClientOptions {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  /** 强制销毁专用超时（默认取 `CLOUD_CONTROLLER_DESTROY_TIMEOUT_MS`，180s，需大于 post 预算 + shutdown 宽限 + 删 Job 重试） */
  destroyTimeoutMs?: number;
}

async function extractErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    const detail = body.error || body.message;
    // 同时保留 error 与 message 细节（问题 22），避免丢弃 body.message 的真实排障信息
    if (body.error && body.message && body.error !== body.message) {
      return `${body.error}: ${body.message}`;
    }
    return detail || fallback;
  } catch {
    return fallback;
  }
}

export class CloudControllerClient {
  private readonly baseUrlOverride?: string;
  private readonly tokenOverride?: string;
  private readonly timeoutMs: number;
  private readonly destroyTimeoutMs: number;

  constructor(options: CloudControllerClientOptions = {}) {
    this.baseUrlOverride = options.baseUrl;
    this.tokenOverride = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.destroyTimeoutMs =
      options.destroyTimeoutMs ?? config.cloudControllerDestroyTimeoutMs ?? DEFAULT_DESTROY_TIMEOUT_MS;
  }

  /** 内部 API 列表（含 K8s 实时状态合并） */
  async list(): Promise<CloudContainerDTO[]> {
    const res = await this.request('/internal/containers');
    if (!res.ok) {
      throw new Error(`cloud-controller list failed: ${res.status}`);
    }
    const data = (await res.json()) as unknown;
    const items = Array.isArray(data) ? data : [];
    return items.map((item) => mapCloudContainer(item as Record<string, unknown>));
  }

  /**
   * 启动容器（purpose 为 GraphQL 大写枚举，转换为内部小写）。
   * - `workloadPlan`：已展开、已排序、已去重的最终执行计划（含参数），随请求下发；
   *   与派生的 `workloadIds` 同时携带，保持旧版 cloud-controller 可用（滚动升级兼容）。
   * - `workloadIds`：兼容旧调用；缺省为 []。仅走 `workloadIds` 时不携带 `workloadPlan`，
   *   由 cloud-controller 以只读定义兜底展开（行为与现状一致）。
   */
  async start(
    purpose: string,
    workloadPlan?: WorkloadPlanItemDTO[],
    workloadIds: string[] = [],
  ): Promise<CloudContainerDTO> {
    const body: Record<string, unknown> = {
      purpose: toInternalPurpose(purpose),
      workloadIds: workloadIds ?? [],
    };
    if (workloadPlan) body.workloadPlan = workloadPlan;
    const res = await this.request('/internal/containers', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(await extractErrorMessage(res, `cloud-controller start failed: ${res.status}`));
    }
    return mapCloudContainer((await res.json()) as Record<string, unknown>);
  }

  /**
   * 查询某容器的工作负载执行记录（内部 API，按执行顺序升序）。
   * 返回原始 JSON 记录（枚举小写、时间 ISO 字符串），由调用方经 `mapWorkloadLog` 归一。
   * 控制面不可达时抛 `ControlPlaneUnavailableError`，供上层降级直读 Mongo。
   */
  async listWorkloadLogs(containerId: string): Promise<Array<Record<string, unknown>>> {
    const res = await this.request(
      `/internal/containers/${encodeURIComponent(containerId)}/workload-logs`,
    );
    if (!res.ok) {
      throw new Error(
        await extractErrorMessage(res, `cloud-controller workload logs failed: ${res.status}`),
      );
    }
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  }

  /** 强制销毁容器；404（不存在）返回 false，终态容器幂等返回 true */
  async destroy(id: string): Promise<boolean> {
    const res = await this.request(
      `/internal/containers/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      this.destroyTimeoutMs,
    );
    if (res.status === 404) return false;
    if (!res.ok) {
      throw new Error(await extractErrorMessage(res, `cloud-controller destroy failed: ${res.status}`));
    }
    return true;
  }

  private resolveBaseUrl(): string {
    return (this.baseUrlOverride || config.cloudControllerUrl || '').replace(/\/+$/, '');
  }

  private resolveToken(): string {
    return this.tokenOverride || config.internalApiToken || '';
  }

  private async request(path: string, init: RequestInit = {}, timeoutMs: number = this.timeoutMs): Promise<Response> {
    const baseUrl = this.resolveBaseUrl();
    const token = this.resolveToken();
    if (!baseUrl) {
      throw new ControlPlaneUnavailableError('CLOUD_CONTROLLER_URL 未配置');
    }
    if (!token) {
      throw new ControlPlaneUnavailableError('INTERNAL_API_TOKEN 未配置');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
    } catch (err) {
      throw new ControlPlaneUnavailableError(`cloud-controller 不可达: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export const cloudControllerClient = new CloudControllerClient();
