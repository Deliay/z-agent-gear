import { Router, type Request, type Response } from 'express';
import type { WorkloadPlanEntry } from '../models/cloud-container.js';
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
} from '../services/container-service.js';
import {
  WorkloadPlanError,
  collectWorkloadDefinitions,
  resolveFallbackWorkloadPlan,
} from '../services/workload-plan.js';

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

export function createInternalRouter(
  containerService: ContainerService,
  deps: InternalRouterDeps = {},
): Router {
  const router = Router();
  const workloadRepository = deps.workloadRepository ?? new InMemoryWorkloadRepository();
  const workloadLogRepository = deps.workloadLogRepository ?? new InMemoryWorkloadLogRepository();

  router.get('/containers', async (_req: Request, res: Response) => {
    try {
      const containers = await containerService.list();
      res.json(containers.map(toCloudContainerJson));
    } catch (err) {
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.post('/containers', async (req: Request, res: Response) => {
    const purpose = req.body?.purpose;
    const refId = typeof req.body?.refId === 'string' ? req.body.refId : null;

    if (purpose !== 'idle') {
      res.status(400).json({
        error: 'UNSUPPORTED_PURPOSE',
        message: '该任务类型暂未开放',
      });
      return;
    }

    let workloadIds: string[];
    let plan: WorkloadPlanEntry[];
    try {
      const resolved = await resolveWorkloadIds(req.body?.workloadIds, workloadRepository);
      if (resolved === null) {
        res.status(400).json({
          error: 'INVALID_WORKLOAD',
          message: `workloadIds 非法（须为已存在、去重且不超过 ${MAX_WORKLOAD_IDS} 个的工作负载 ID）`,
        });
        return;
      }
      workloadIds = resolved;

      const resolvedPlan = await resolveWorkloadPlan(req.body?.workloadPlan, workloadRepository);
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

    try {
      // 契约 A.2.2：显式下发 plan 时由 plan 派生 workloadIds；仅 workloadIds 的旧版请求
      // 按选择顺序落库 workloadIds（兜底展开的 plan 仅用于执行），二者不产生静默偏差。
      const created = await containerService.start('idle', refId, workloadIds, effectivePlan, {
        deriveWorkloadIdsFromPlan: hadExplicitPlan,
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

  router.delete('/containers/:id', async (req: Request, res: Response) => {
    try {
      const result = await containerService.destroy(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
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
