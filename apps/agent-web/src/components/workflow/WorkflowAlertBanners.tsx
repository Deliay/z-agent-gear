import { AlertTriangle, MessageSquare, PanelRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { WorkflowInstanceData, WorkflowNodeData } from '@/graphql/workflow';

export interface WorkflowAlertBannersProps {
  instance: WorkflowInstanceData;
  blockedNodes: WorkflowNodeData[];
  onOpenContinue: () => void;
  onSelectNode: (nodeId: string) => void;
  onOpenSession: (node: WorkflowNodeData) => void;
}

/**
 * 工作流实例异常与阻断警示横幅：
 * - 控制器离线/已删除横幅：提供「接续」主入口
 * - 节点失败/重试用尽阻断横幅：使用规范警示图标，支持点击节点直达详情或会话
 */
export default function WorkflowAlertBanners({
  instance,
  blockedNodes,
  onOpenContinue,
  onSelectNode,
  onOpenSession,
}: WorkflowAlertBannersProps) {
  if (!instance.unavailableReason && blockedNodes.length === 0) {
    return null;
  }

  const retryFailedCount = blockedNodes.filter((node) => node.status === 'RETRY_FAILED').length;
  const failedCount = blockedNodes.length - retryFailedCount;

  return (
    <div className="shrink-0 space-y-2 px-4 pt-3 md:px-6">
      {instance.unavailableReason && (
        <div
          role="alert"
          data-testid="workflow-unavailable-notice"
          data-reason={instance.unavailableReason}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3"
        >
          <div className="flex min-w-0 flex-1 items-start gap-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive-text" aria-hidden="true" />
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-semibold text-destructive-text">
                {instance.unavailableReason === 'CONTROLLER_DELETED'
                  ? '控制器已删除，实例当前不可用'
                  : '控制器离线，实例当前不可用'}
              </p>
              <p className="text-xs text-destructive-text">
                已完成节点与产物保留；接续后可选择新控制器与工作路径继续流转。
                原控制器上的残留 Worktree 平台不做远程清理，请自行处理。
              </p>
            </div>
          </div>
          <Button size="sm" variant="default" onClick={onOpenContinue}>
            接续
          </Button>
        </div>
      )}

      {blockedNodes.length > 0 && (
        <div
          role="alert"
          data-testid="workflow-blocked-notice"
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-3"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0 text-destructive-text" aria-hidden="true" />
            <p className="text-sm font-semibold text-destructive-text">
              <span className="tabular-nums">{blockedNodes.length}</span> 个节点
              {retryFailedCount > 0 && failedCount > 0
                ? `（${failedCount} 个失败 / ${retryFailedCount} 个重试用尽）`
                : retryFailedCount > 0
                  ? '中断自动重试用尽'
                  : '失败'}
              ，流程已阻断，需要人工介入
            </p>
          </div>
          <ul className="mt-2 space-y-1.5 pl-6 text-xs text-destructive-text">
            {blockedNodes.map((node) => (
              <li key={node.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 flex-1 wrap-anywhere">
                  「{node.name}」：
                  {node.status === 'RETRY_FAILED'
                    ? '中断自动重试已用尽，可重启节点，或在会话中给出指示后恢复'
                    : node.failInfo?.reason || '未提供失败原因'}
                  {node.status === 'FAILED' && '（打开节点会话给出处理指示，AI 确认后会恢复节点运行）'}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => onSelectNode(node.id)}
                  >
                    <PanelRight className="size-3" />
                    查看详情
                  </Button>
                  {node.sessionId && (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => onOpenSession(node)}
                    >
                      <MessageSquare className="size-3" />
                      打开会话
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
