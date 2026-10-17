import { Router, type Request, type Response } from 'express';
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
    } catch (err) {
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    try {
      const created = await containerService.start('idle', refId, workloadIds);
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
