import { Router, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import {
  STARTABLE_PURPOSES,
  SUPPORTED_HARNESS_TYPES,
  type WorkloadPlanEntry,
} from '../models/cloud-container.js';
import type { CloudContainerEntity } from '../repositories/container-repository.js';
import {
  InMemoryWorkloadLogRepository,
  type CloudWorkloadLogEntity,
  type WorkloadLogRepository,
} from '../repositories/workload-log-repository.js';
import {
  InMemoryWorkloadRepository,
  type WorkloadRepository,
} from '../repositories/workload-repository.js';
import {
  ContainerNotFoundError,
  UnsupportedPurposeError,
  dedupeWorkloadIds,
  type ContainerService,
  type StartHarnessOptions,
} from '../services/container-service.js';
import type { HarnessSecrets } from '../services/secret-store.js';
import { resolveGlobalWorkspaceId } from '../services/workspace-resolver.js';
import {
  harnessMinVersion,
  maxWorkerVersion,
  MIN_HARNESS_WORKER_VERSION,
} from '../services/worker-version.js';
import {
  WorkloadPlanError,
  collectWorkloadDefinitions,
  resolveFallbackWorkloadPlan,
  resolveRuntimeWorkloadPlan,
} from '../services/workload-plan.js';
import {
  ContainerBusyError,
  ContainerNotOnlineError,
  InvalidRuntimeBatchError,
  RuntimeContainerNotFoundError,
  type WorkloadDispatcher,
} from '../services/workload-dispatcher.js';

/** 单次启动可挂载的工作负载上限（契约 A.2.2 / 裁决 12）。 */
export const MAX_WORKLOAD_IDS = 10;

export interface CloudContainerJson {
  id: string;
  name: string;
  namespace: string;
  status: string;
  purpose: string;
  refId: string | null;
  userId: string | null;
  image: string;
  createdAt: string;
  connectedAt: string | null;
  exitedAt: string | null;
  exitReason: string | null;
  workloadIds: string[];
  workloadPlan: WorkloadPlanEntry[];
  currentWorkloadName: string | null;
  installedWorkloads: Array<{
    workloadId: string;
    name: string;
    installedAt: string;
    source: string;
  }>;
  billingAccountId: string | null;
  billingStartedAt: string | null;
  hostId: string | null;
  hostName: string | null;
  harnessTypes: string[];
  controllerKeyId: string | null;
  containerApiKeyId: string | null;
  expiresAt: string | null;
}

/** 严格对齐契约附录 A.3 的 JSON 结构。 */
export function toCloudContainerJson(entity: CloudContainerEntity): CloudContainerJson {
  return {
    id: entity.id,
    name: entity.name,
    namespace: entity.namespace,
    status: entity.status,
    purpose: entity.purpose,
    refId: entity.refId ?? null,
    userId: entity.userId ?? null,
    image: entity.image,
    createdAt: entity.createdAt.toISOString(),
    connectedAt: entity.connectedAt ? entity.connectedAt.toISOString() : null,
    exitedAt: entity.exitedAt ? entity.exitedAt.toISOString() : null,
    exitReason: entity.exitReason ?? null,
    workloadIds: entity.workloadIds ?? [],
    workloadPlan: (entity.workloadPlan ?? []).map((entry) => ({
      workloadId: entry.workloadId,
      params: entry.params ?? {},
      implicit: entry.implicit === true,
      required: entry.required === true,
    })),
    currentWorkloadName: entity.currentWorkloadName ?? null,
    installedWorkloads: (entity.installedWorkloads ?? []).map((item) => ({
      workloadId: item.workloadId,
      name: item.name,
      installedAt: item.installedAt.toISOString(),
      source: item.source,
    })),
    billingAccountId: entity.billingAccountId ?? null,
    billingStartedAt: entity.billingStartedAt ? entity.billingStartedAt.toISOString() : null,
    // 云电脑字段（secrets 永不返回）
    hostId: entity.hostId ?? null,
    hostName: entity.hostName ?? null,
    harnessTypes: entity.harnessTypes ?? [],
    controllerKeyId: entity.controllerKeyId ?? null,
    containerApiKeyId: entity.containerApiKeyId ?? null,
    expiresAt: entity.expiresAt ? entity.expiresAt.toISOString() : null,
  };
}

/** 严格对齐契约附录 A.6 的 JSON 结构（枚举小写）。 */
export function toCloudWorkloadLogJson(entity: CloudWorkloadLogEntity): Record<string, unknown> {
  return {
    id: entity.id,
    containerId: entity.containerId,
    workloadId: entity.workloadId,
    workloadName: entity.workloadName,
    phase: entity.phase,
    status: entity.status,
    script: entity.script,
    params: entity.params ?? {},
    required: entity.required === true,
    trigger: entity.trigger ?? 'start',
    source: entity.source ?? 'admin',
    exitCode: entity.exitCode ?? null,
    log: entity.log,
    startedAt: entity.startedAt ? entity.startedAt.toISOString() : null,
    finishedAt: entity.finishedAt ? entity.finishedAt.toISOString() : null,
    createdAt: entity.createdAt.toISOString(),
  };
}

export interface InternalRouterDeps {
  workloadRepository?: WorkloadRepository;
  workloadLogRepository?: WorkloadLogRepository;
  workloadDispatcher?: WorkloadDispatcher;
  /**
   * harness 请求缺失 `workspaceId` 时的全局工作区解析器（默认同库 `workspaces{tenantId,type:'global'}`）。
   * 可注入用于单测（无需真库）。
   */
  resolveGlobalWorkspaceId?: (tenantId: string) => Promise<string | null>;
}

/**
 * 解析并校验 `workloadIds`：必须为字符串数组、≤10、去重保序、且全部存在。
 * 返回 `null` 表示非法（调用方返回 400 `INVALID_WORKLOAD`）。
 */
async function resolveWorkloadIds(
  raw: unknown,
  workloadRepository: WorkloadRepository,
): Promise<string[] | null> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.some((value) => typeof value !== 'string' || value.length === 0)) return null;
  if (raw.length > MAX_WORKLOAD_IDS) return null;
  const deduped = dedupeWorkloadIds(raw as string[]);
  const found = await workloadRepository.findByIds(deduped);
  if (found.length !== deduped.length) return null;
  return deduped;
}

/**
 * 解析并校验 `workloadPlan`（契约 A.2.2）：数组、≤10、`workloadId` 去重且全部存在、
 * `params` 为对象、`implicit` 为布尔。返回 `null` 表示非法（调用方 400 `INVALID_WORKLOAD`）；
 * 未携带（`undefined`/`null`）返回空数组表示「无计划」。
 *
 * 缺省的 `params`/`implicit` 归一为 `{}` / `false`（与模型默认值及各读取层一致，
 * 避免「写入层宽松、读取层有默认、路由层却必填」的口径分裂）；类型错误仍 400。
 */
async function resolveWorkloadPlan(
  raw: unknown,
  workloadRepository: WorkloadRepository,
): Promise<WorkloadPlanEntry[] | null> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_WORKLOAD_IDS) return null;

  const entries: WorkloadPlanEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const { workloadId, params, implicit, required } = item as Record<string, unknown>;
    if (typeof workloadId !== 'string' || workloadId.length === 0) return null;
    if (seen.has(workloadId)) return null;
    if (params !== undefined && params !== null) {
      if (typeof params !== 'object' || Array.isArray(params)) return null;
    }
    if (implicit !== undefined && typeof implicit !== 'boolean') return null;
    // required：缺省/null 归一 false；非布尔 400（与 implicit 同口径，裁决 2）。
    if (required !== undefined && required !== null && typeof required !== 'boolean') return null;
    seen.add(workloadId);
    entries.push({
      workloadId,
      params: params ? { ...(params as Record<string, unknown>) } : {},
      implicit: implicit === true,
      required: required === true,
    });
  }

  if (entries.length > 0) {
    const found = await workloadRepository.findByIds(entries.map((entry) => entry.workloadId));
    if (found.length !== entries.length) return null;
  }
  return entries;
}

interface ParsedHarnessRequest {
  hostId: string;
  refId: string;
  userId: string;
  /** 租户归属（多租户一期）：与 `userId` 同值；旧版调用方缺省时回退 `userId`。 */
  tenantId: string;
  /**
   * 租户工作区归属（多租户二期）：请求显式下发优先；缺失时按 `tenantId` 解析同库
   * `workspaces{type:'global'}` 回退，解析不到为 `null`。
   */
  workspaceId: string | null;
  hostName: string;
  harnessTypes: string[];
  controllerKeyId: string | null;
  containerApiKeyId: string | null;
  agentGearMinVersion: string;
  controllerId: string | null;
  expiresAt: Date;
  secrets: HarnessSecrets;
}

/** `parseHarnessRequest` 的可注入依赖（单测免真库）。 */
export interface ParseHarnessRequestDeps {
  resolveGlobalWorkspaceId?: (tenantId: string) => Promise<string | null>;
}

/**
 * 解析 harness 请求的 `workspaceId`（多租户二期 / 契约附录 A.2.2）：
 * - 缺失 → 按 `tenantId` 解析全局工作区回退，解析不到置 `null` 并 warn（不阻断创建）；
 * - 解析异常（Mongo 不可用等）同样降级为 `null` + warn（容器仍可创建，迁移 002 可事后回填）。
 */
async function resolveHarnessWorkspaceId(
  tenantId: string,
  resolver: (tenantId: string) => Promise<string | null>,
): Promise<string | null> {
  try {
    const resolved = await resolver(tenantId);
    if (resolved) return resolved;
    console.warn(
      `[internal-api] harness 请求缺少 workspaceId 且未解析到全局工作区（tenantId=${tenantId}），已置 workspaceId=null`,
    );
  } catch (err) {
    console.warn(
      `[internal-api] harness 请求缺少 workspaceId，解析全局工作区失败（tenantId=${tenantId}）：${
        err instanceof Error ? err.message : String(err)
      }，已置 workspaceId=null`,
    );
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isStartablePurpose(value: unknown): value is (typeof STARTABLE_PURPOSES)[number] {
  return (
    typeof value === 'string' && (STARTABLE_PURPOSES as readonly string[]).includes(value)
  );
}

/**
 * 校验 `purpose=harness` 的必填字段（契约 A.2.2 / T-CC5）。非法返回 `null`
 * （调用方 400 `INVALID_HARNESS`，且不创建 Job）。`workloadPlan` 在解析计划后单独校验。
 *
 * 多租户二期：额外解析可选 `workspaceId`（显式下发但非法 → `null` → 400；缺失按 `tenantId`
 * 解析全局工作区回退，解析不到置 `null` 并 warn）。
 */
export async function parseHarnessRequest(
  body: Record<string, unknown>,
  deps: ParseHarnessRequestDeps = {},
): Promise<ParsedHarnessRequest | null> {
  const hostId = nonEmptyString(body.hostId);
  const refId = nonEmptyString(body.refId);
  const userId = nonEmptyString(body.userId);
  const hostName = nonEmptyString(body.hostName);
  // 契约 A.2.2：refId 即标准连接 ControllerKey ID（不再单独下发 controllerKeyId）。
  const controllerKeyId = refId;
  const containerApiKeyId = body.containerApiKeyId === undefined || body.containerApiKeyId === null
    ? null
    : nonEmptyString(body.containerApiKeyId);
  const agentGearMinVersion = nonEmptyString(body.agentGearMinVersion);
  if (!hostId || !refId || !userId || !hostName) return null;

  // 多租户一期（契约 A.2.2 / F8）：`tenantId` 与 `userId` 同值（个人专属租户 _id 复用 userId）。
  // 滚动升级兼容：旧版 agent-api 未下发 tenantId 时回退 `tenantId = userId` 并 warn
  //（发布顺序已保证新版 agent-api 先上线，回退仅兜底）；显式下发但非法（空串/非字符串）
  // 仍按 `400 INVALID_HARNESS` 处理，避免静默写入错误归属。
  const rawTenantId = body.tenantId;
  let tenantId: string;
  if (rawTenantId === undefined || rawTenantId === null) {
    tenantId = userId;
    console.warn(
      `[internal-api] harness 请求缺少 tenantId（userId=${userId}），已回退 tenantId=userId（一期恒等）`,
    );
  } else {
    const parsedTenantId = nonEmptyString(rawTenantId);
    if (!parsedTenantId) return null;
    tenantId = parsedTenantId;
  }

  // 多租户二期（契约 A.2.2 / F2）：`workspaceId` 可选（String 口径）。显式下发时按非空字符串校验
  //（空串/非字符串 → 400 `INVALID_HARNESS`）；缺失时按 `tenantId` 解析同库全局工作区回退，
  // 解析不到置 `null` 并 warn（不阻断容器创建）。
  const rawWorkspaceId = body.workspaceId;
  let workspaceId: string | null;
  if (rawWorkspaceId === undefined || rawWorkspaceId === null) {
    workspaceId = await resolveHarnessWorkspaceId(
      tenantId,
      deps.resolveGlobalWorkspaceId ?? resolveGlobalWorkspaceId,
    );
  } else {
    const parsedWorkspaceId = nonEmptyString(rawWorkspaceId);
    if (!parsedWorkspaceId) return null;
    workspaceId = parsedWorkspaceId;
  }

  if (!agentGearMinVersion || !/^\d+\.\d+\.\d+$/.test(agentGearMinVersion)) {
    return null;
  }
  if (
    body.containerApiKeyId !== undefined &&
    body.containerApiKeyId !== null &&
    !containerApiKeyId
  ) {
    return null;
  }

  const harnessTypes = body.harnessTypes;
  if (
    !Array.isArray(harnessTypes) ||
    harnessTypes.length === 0 ||
    harnessTypes.some(
      (value) =>
        typeof value !== 'string' ||
        !(SUPPORTED_HARNESS_TYPES as readonly string[]).includes(value),
    )
  ) {
    return null;
  }

  const rawExpiresAt = body.expiresAt;
  const expiresAt =
    typeof rawExpiresAt === 'string' && rawExpiresAt.trim().length > 0
      ? new Date(rawExpiresAt)
      : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) return null;

  const rawSecrets = body.secrets;
  if (!rawSecrets || typeof rawSecrets !== 'object' || Array.isArray(rawSecrets)) return null;
  const record = rawSecrets as Record<string, unknown>;
  const secrets: HarnessSecrets = {
    hostEndpoint: nonEmptyString(record.hostEndpoint) ?? '',
    hostKey: nonEmptyString(record.hostKey) ?? '',
    modelApiKey: nonEmptyString(record.modelApiKey) ?? '',
    modelBaseUrl: nonEmptyString(record.modelBaseUrl) ?? '',
    modelIds: nonEmptyString(record.modelIds) ?? '',
    defaultWorkspace: nonEmptyString(record.defaultWorkspace) ?? '',
  };
  // 可选字段（滚动升级期间旧调用方不下发）：非空字符串才透传，不参与必填校验。
  const modelContextLengths = nonEmptyString(record.modelContextLengths);
  if (modelContextLengths) secrets.modelContextLengths = modelContextLengths;
  if (Object.values(secrets).some((value) => value.length === 0)) return null;

  const controllerId = nonEmptyString(body.controllerId);

  return {
    hostId,
    refId,
    userId,
    tenantId,
    workspaceId,
    hostName,
    harnessTypes: [...new Set(harnessTypes as string[])],
    controllerKeyId,
    containerApiKeyId,
    // C-4 / A7：落库下限恒为 MIN_HARNESS_WORKER_VERSION（2.10.0）；按类型常量为能力引入历史，
    // 与 2.10.0 取 max 后不再改变落库值，注册门禁按落库值生效。
    agentGearMinVersion: maxWorkerVersion(
      maxWorkerVersion(agentGearMinVersion, harnessMinVersion(harnessTypes as string[])),
      MIN_HARNESS_WORKER_VERSION,
    ),
    controllerId,
    expiresAt,
    secrets,
  };
}

export function createInternalRouter(
  containerService: ContainerService,
  deps: InternalRouterDeps = {},
): Router {
  const router = Router();
  const workloadRepository = deps.workloadRepository ?? new InMemoryWorkloadRepository();
  const workloadLogRepository = deps.workloadLogRepository ?? new InMemoryWorkloadLogRepository();
  const workloadDispatcher = deps.workloadDispatcher;
  const globalWorkspaceResolver = deps.resolveGlobalWorkspaceId;

  router.get('/containers', async (req: Request, res: Response) => {
    try {
      const hostId = typeof req.query.hostId === 'string' ? req.query.hostId : undefined;
      const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
      const containers = await containerService.list();
      // 可选过滤（契约 A.2.1）：无参数保持全量，admin 兼容。
      const filtered = containers.filter(
        (container) =>
          (hostId === undefined || container.hostId === hostId) &&
          (userId === undefined || container.userId === userId),
      );
      res.json(filtered.map(toCloudContainerJson));
    } catch (err) {
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.post('/containers', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const purpose = body.purpose;
    if (!isStartablePurpose(purpose)) {
      res.status(400).json({
        error: 'UNSUPPORTED_PURPOSE',
        message: '该任务类型暂未开放',
      });
      return;
    }
    const isHarness = purpose === 'harness';
    const harness = isHarness
      ? await parseHarnessRequest(
          body,
          globalWorkspaceResolver ? { resolveGlobalWorkspaceId: globalWorkspaceResolver } : {},
        )
      : null;
    if (isHarness && !harness) {
      res.status(400).json({
        error: 'INVALID_HARNESS',
        message: '云电脑参数非法（缺少必填字段、harnessTypes 非白名单或 secrets 不完整）',
      });
      return;
    }
    // harness 的 refId 语义为 controllerKeyId（裁决 A7）；idle 保持自由字符串。
    const refId = harness
      ? harness.refId
      : typeof body.refId === 'string'
        ? body.refId
        : null;
    const rawBillingAccountId = body.billingAccountId;
    if (
      rawBillingAccountId !== undefined &&
      rawBillingAccountId !== null &&
      (typeof rawBillingAccountId !== 'string' || rawBillingAccountId.length === 0)
    ) {
      res.status(400).json({
        error: 'INVALID_BILLING_ACCOUNT',
        message: 'billingAccountId 非法（须为非空字符串）',
      });
      return;
    }
    const billingAccountId =
      typeof rawBillingAccountId === 'string' ? rawBillingAccountId : null;

    let workloadIds: string[];
    let plan: WorkloadPlanEntry[];
    try {
      const resolved = await resolveWorkloadIds(body.workloadIds, workloadRepository);
      if (resolved === null) {
        res.status(400).json({
          error: 'INVALID_WORKLOAD',
          message: `workloadIds 非法（须为已存在、去重且不超过 ${MAX_WORKLOAD_IDS} 个的工作负载 ID）`,
        });
        return;
      }
      workloadIds = resolved;

      const resolvedPlan = await resolveWorkloadPlan(body.workloadPlan, workloadRepository);
      if (resolvedPlan === null) {
        res.status(400).json({
          error: 'INVALID_WORKLOAD',
          message: `workloadPlan 非法（须为已展开、去重且不超过 ${MAX_WORKLOAD_IDS} 个条目的数组）`,
        });
        return;
      }
      plan = resolvedPlan;
    } catch (err) {
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // 优先使用请求下发的 plan；无 plan 且仅有 workloadIds（旧版 admin-api）时按只读定义兜底展开。
    const hadExplicitPlan = plan.length > 0;
    let effectivePlan: WorkloadPlanEntry[] = plan;
    if (effectivePlan.length === 0 && workloadIds.length > 0) {
      try {
        const definitions = await collectWorkloadDefinitions(workloadIds, (ids) =>
          workloadRepository.findByIds(ids),
        );
        effectivePlan = resolveFallbackWorkloadPlan(workloadIds, definitions);
      } catch (err) {
        if (err instanceof WorkloadPlanError) {
          res.status(400).json({ error: 'INVALID_WORKLOAD', message: err.message });
          return;
        }
        res.status(500).json({
          error: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }

    // 契约 A.2.2：harness 的 workloadPlan 必填（缺失/展开为空均 400 INVALID_HARNESS）。
    if (isHarness && (!hadExplicitPlan || effectivePlan.length === 0)) {
      res.status(400).json({
        error: 'INVALID_HARNESS',
        message: '云电脑参数非法（workloadPlan 为空）',
      });
      return;
    }

    const harnessOptions: StartHarnessOptions = harness
      ? {
          hostId: harness.hostId,
          hostName: harness.hostName,
          harnessTypes: harness.harnessTypes,
          controllerKeyId: harness.controllerKeyId,
          containerApiKeyId: harness.containerApiKeyId,
          agentGearMinVersion: harness.agentGearMinVersion,
          userId: harness.userId,
          tenantId: harness.tenantId,
          workspaceId: harness.workspaceId,
          expiresAt: harness.expiresAt,
          controllerId: harness.controllerId,
          secrets: harness.secrets,
        }
      : {};

    try {
      // 契约 A.2.2：显式下发 plan 时由 plan 派生 workloadIds；仅 workloadIds 的旧版请求
      // 按选择顺序落库 workloadIds（兜底展开的 plan 仅用于执行），二者不产生静默偏差。
      const created = await containerService.start(purpose, refId, workloadIds, effectivePlan, {
        deriveWorkloadIdsFromPlan: hadExplicitPlan,
        billingAccountId,
        ...harnessOptions,
      });
      res.status(201).json(toCloudContainerJson(created));
    } catch (err) {
      if (err instanceof UnsupportedPurposeError) {
        res.status(400).json({ error: 'UNSUPPORTED_PURPOSE', message: err.message });
        return;
      }
      res.status(500).json({
        error: 'CREATE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get('/containers/:id/workload-logs', async (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    try {
      const container = await containerService.getById(id);
      if (!container) {
        res.status(404).json({ error: 'NOT_FOUND', message: `Container not found: ${id}` });
        return;
      }
      const logs = await workloadLogRepository.findByContainer(id);
      res.json(logs.map(toCloudWorkloadLogJson));
    } catch (err) {
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  function respondRuntimeError(res: Response, err: unknown): void {
    if (err instanceof RuntimeContainerNotFoundError) {
      res.status(404).json({ error: 'NOT_FOUND', message: err.message });
      return;
    }
    if (err instanceof ContainerNotOnlineError) {
      res.status(409).json({ error: 'CONTAINER_NOT_ONLINE', message: err.message });
      return;
    }
    if (err instanceof ContainerBusyError) {
      res.status(409).json({ error: 'CONTAINER_BUSY', message: err.message });
      return;
    }
    if (err instanceof InvalidRuntimeBatchError) {
      res.status(400).json({ error: 'INVALID_WORKLOAD', message: err.message });
      return;
    }
    if (err instanceof WorkloadPlanError) {
      res.status(400).json({ error: 'INVALID_WORKLOAD', message: err.message });
      return;
    }
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  function parseSource(raw: unknown): 'user' | 'mcp' | 'system' | null {
    if (raw === undefined || raw === null) return 'user';
    return raw === 'user' || raw === 'mcp' || raw === 'system' ? raw : null;
  }

  router.post('/containers/:containerId/workloads', async (req: Request, res: Response) => {
    if (!workloadDispatcher) {
      res.status(503).json({ error: 'UNAVAILABLE', message: 'workload dispatcher not configured' });
      return;
    }
    const containerId = String(req.params.containerId);
    if (!mongoose.isValidObjectId(containerId)) {
      res.status(404).json({ error: 'NOT_FOUND', message: `Container not found: ${containerId}` });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const workloadId = typeof body.workloadId === 'string' ? body.workloadId : '';
    if (!mongoose.isValidObjectId(workloadId)) {
      res.status(400).json({ error: 'INVALID_WORKLOAD', message: 'workloadId 非法' });
      return;
    }
    if (
      body.params !== undefined &&
      body.params !== null &&
      (typeof body.params !== 'object' || Array.isArray(body.params))
    ) {
      res.status(400).json({ error: 'INVALID_WORKLOAD', message: 'params 非法' });
      return;
    }
    const source = parseSource(body.source);
    if (!source || source === 'system') {
      res.status(400).json({ error: 'INVALID_WORKLOAD', message: 'source 非法' });
      return;
    }

    try {
      const definitions = await collectWorkloadDefinitions([workloadId], (ids) =>
        workloadRepository.findByIds(ids),
      );
      const plan = resolveRuntimeWorkloadPlan({
        workloadId,
        params:
          body.params && typeof body.params === 'object' && !Array.isArray(body.params)
            ? (body.params as Record<string, unknown>)
            : {},
        definitions,
      });
      const workloads = await workloadRepository.findByIds(plan.map((entry) => entry.workloadId));
      const byId = new Map(workloads.map((workload) => [workload.id, workload]));
      const entries = plan
        .map((entry) => {
          const workload = byId.get(entry.workloadId);
          if (!workload) return null;
          const script = workload.initScript ?? '';
          if (script.trim().length === 0) return null;
          return {
            workloadId: entry.workloadId,
            workloadName: workload.name,
            script,
            params: entry.params ?? {},
          };
        })
        .filter(
          (entry): entry is NonNullable<typeof entry> => entry !== null,
        );
      if (entries.length === 0) {
        res.status(400).json({ error: 'INVALID_WORKLOAD', message: '工作负载无初始化脚本' });
        return;
      }
      const result = await workloadDispatcher.startRuntimeBatch(containerId, {
        entries,
        source,
      });
      res.status(200).json(result);
    } catch (err) {
      respondRuntimeError(res, err);
    }
  });

  router.post('/containers/:containerId/runtime-scripts', async (req: Request, res: Response) => {
    if (!workloadDispatcher) {
      res.status(503).json({ error: 'UNAVAILABLE', message: 'workload dispatcher not configured' });
      return;
    }
    const containerId = String(req.params.containerId);
    if (!mongoose.isValidObjectId(containerId)) {
      res.status(404).json({ error: 'NOT_FOUND', message: `Container not found: ${containerId}` });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const workloadId = typeof body.workloadId === 'string' ? body.workloadId : '';
    const workloadName =
      typeof body.workloadName === 'string' ? body.workloadName.trim() : '';
    const script = typeof body.script === 'string' ? body.script : '';
    if (
      !mongoose.isValidObjectId(workloadId) ||
      !workloadName ||
      script.trim().length === 0 ||
      Buffer.byteLength(script, 'utf8') > 16 * 1024
    ) {
      res.status(400).json({ error: 'INVALID_SCRIPT', message: '脚本参数非法' });
      return;
    }
    if (
      body.params !== undefined &&
      body.params !== null &&
      (typeof body.params !== 'object' || Array.isArray(body.params))
    ) {
      res.status(400).json({ error: 'INVALID_SCRIPT', message: 'params 非法' });
      return;
    }
    if (
      body.githubAuth !== undefined &&
      body.githubAuth !== null &&
      typeof body.githubAuth !== 'boolean'
    ) {
      res.status(400).json({ error: 'INVALID_SCRIPT', message: 'githubAuth 非法' });
      return;
    }
    const source = parseSource(body.source);
    if (!source) {
      res.status(400).json({ error: 'INVALID_SCRIPT', message: 'source 非法' });
      return;
    }

    try {
      const result = await workloadDispatcher.startRuntimeBatch(containerId, {
        entries: [
          {
            workloadId,
            workloadName,
            script,
            params:
              body.params && typeof body.params === 'object' && !Array.isArray(body.params)
                ? (body.params as Record<string, unknown>)
                : {},
          },
        ],
        source,
        githubAuth: body.githubAuth === true,
      });
      res.status(200).json({ batchId: result.batchId, logId: result.items[0]?.logId ?? null });
    } catch (err) {
      respondRuntimeError(res, err);
    }
  });

  router.delete('/containers/:id', async (req: Request, res: Response) => {
    try {
      const bodyReason = req.body?.reason;
      const queryReason = Array.isArray(req.query.reason) ? req.query.reason[0] : req.query.reason;
      const rawReason = typeof bodyReason === 'string' ? bodyReason : queryReason;
      const reason =
        typeof rawReason === 'string' && rawReason.trim().length > 0
          ? rawReason.trim()
          : undefined;
      const result = await containerService.destroy(
        Array.isArray(req.params.id) ? req.params.id[0] : req.params.id,
        reason ? { reason } : undefined,
      );
      // 契约 A.2.3：透出 deletedJob，调用方可观察本次是否真实回收了残留 Job（问题 50）。
      res.json({ success: result.success, deletedJob: result.deletedJob });
    } catch (err) {
      if (err instanceof ContainerNotFoundError) {
        res.status(404).json({ error: 'NOT_FOUND', message: err.message });
        return;
      }
      res.status(500).json({
        error: 'DESTROY_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
