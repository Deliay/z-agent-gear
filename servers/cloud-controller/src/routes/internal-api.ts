import { Router, type Request, type Response } from 'express';
import type { CloudContainerEntity } from '../repositories/container-repository.js';
import {
  ContainerNotFoundError,
  UnsupportedPurposeError,
  type ContainerService,
} from '../services/container-service.js';

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
  };
}

export function createInternalRouter(containerService: ContainerService): Router {
  const router = Router();

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

    try {
      const created = await containerService.start('idle', refId);
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
