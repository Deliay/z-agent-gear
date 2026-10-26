import { config } from '../../config/index.js';

/** 工作流实例地址（回评文案来源；`FRONTEND_URL` 须为外部可达地址） */
export function buildWorkflowUrl(workflowInstanceId: string): string {
  const base = config.frontendUrl.replace(/\/+$/, '');
  return `${base}/workflows/${workflowInstanceId}`;
}

/**
 * Issue 回评文案（修复点 4）。
 * 失败不影响已创建工作流，调用方只记录 `commentError`。
 */
export function buildIssueTriggerComment(workflowInstanceId: string): string {
  return [
    '工作流已经触发创建，Issue 的后续修改将不会影响工作流的执行。',
    `工作流地址：${buildWorkflowUrl(workflowInstanceId)} ，点击查看。`,
  ].join('\n');
}

export interface IssueNodeInputSource {
  repoFullName: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl?: string | null;
  issueAuthor?: string | null;
  issueBody?: string | null;
}

/**
 * 首个人类节点「输入」产物（纯文本：Issue 标题/正文不解析指令标记）。
 * 标题/正文在归一化层已限长（≤256 / ≤64000），此处不再二次截断。
 */
export function buildIssueNodeInput(source: IssueNodeInputSource): string {
  const author = source.issueAuthor?.trim() || '未知';
  const body = source.issueBody ?? '';
  return [
    `来源：GitHub Issue ${source.repoFullName}#${source.issueNumber}`,
    `标题：${source.issueTitle}`,
    `链接：${source.issueUrl ?? ''}`,
    `提交人：${author}`,
    '',
    body,
  ].join('\n');
}

/** 实例名截断（`owner/repo#12 标题`），默认 64 字 */
export function buildTriggerInstanceName(
  repoFullName: string,
  issueNumber: number,
  issueTitle: string,
  maxLength = 64,
): string {
  const raw = `${repoFullName}#${issueNumber} ${issueTitle}`.trim();
  return raw.length <= maxLength ? raw : raw.slice(0, maxLength);
}
