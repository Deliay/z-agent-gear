import { Controller } from '../../models/controller.js';

/** 工作流实例不可用原因（null = 可用）；与契约 `WorkflowInstanceUnavailableReason` 对齐 */
export type WorkflowInstanceUnavailableReason = 'CONTROLLER_OFFLINE' | 'CONTROLLER_DELETED' | null;

/**
 * 纯判定：控制器文档缺失 → CONTROLLER_DELETED；
 * `status !== 'online'`（offline/registering/unbound）→ CONTROLLER_OFFLINE；否则可用（null）。
 */
export function resolveUnavailableReasonFromController(
  controller: { status?: string | null } | null,
): WorkflowInstanceUnavailableReason {
  if (!controller) return 'CONTROLLER_DELETED';
  return controller.status === 'online' ? null : 'CONTROLLER_OFFLINE';
}

/**
 * 按实例 controllerId 惰性加载控制器并判定（加载器由调用方注入，字段 resolver 注入请求级缓存）。
 * 实例缺 controllerId 视同控制器已删除（防御式）。
 */
export async function resolveInstanceUnavailableReason(
  instanceLike: { controllerId?: unknown },
  loadController: (controllerId: string) => Promise<{ status?: string | null } | null>,
): Promise<WorkflowInstanceUnavailableReason> {
  const controllerId = instanceLike.controllerId ? String(instanceLike.controllerId) : '';
  if (!controllerId) return 'CONTROLLER_DELETED';
  const controller = await loadController(controllerId);
  return resolveUnavailableReasonFromController(controller);
}

/**
 * 默认加载器：只读控制器存在性与状态（不带 actorFilter —— 实例已完成归属校验，
 * 仅判定可用性，无数据面泄漏）。
 */
export async function loadControllerStatus(
  controllerId: string,
): Promise<{ status?: string | null } | null> {
  const controller = await Controller.findById(controllerId).select('status').lean();
  if (!controller) return null;
  return { status: (controller as { status?: string | null }).status ?? null };
}
