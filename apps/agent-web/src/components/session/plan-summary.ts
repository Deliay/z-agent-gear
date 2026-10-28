/**
 * 计划摘要口径（对齐 zed plan_summary_label）：
 * - 全部完成 → 全部完成
 * - 部分完成 → x/y
 * - 未开始 → N 项任务
 */
export function planSummaryLabel(completed: number, total: number): string {
  if (total > 0 && completed >= total) return '全部完成';
  if (completed > 0) return `${completed}/${total}`;
  return `${total} 项任务`;
}
