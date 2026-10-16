export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 将毫秒时长格式化为「X小时Y分」「X分Y秒」「X秒」。 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分`;
  if (minutes > 0) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

export interface OnlineDurationInput {
  connectedAt: string | null;
  exitedAt: string | null;
}

/**
 * 在线时长（裁决 15）：
 * - 在线中（`exitedAt` 为空）= now − `connectedAt`
 * - 已退出（`exitedAt` 存在）= `exitedAt` − `connectedAt`
 * - 未回连（`connectedAt` 为空）或时间非法 => `-`
 */
export function formatOnlineDuration(
  input: OnlineDurationInput,
  now: number = Date.now(),
): string {
  if (!input.connectedAt) return '-';
  const start = new Date(input.connectedAt).getTime();
  if (Number.isNaN(start)) return '-';
  const end = input.exitedAt ? new Date(input.exitedAt).getTime() : now;
  if (Number.isNaN(end)) return '-';
  const diff = end - start;
  if (diff < 0) return '-';
  return formatDuration(diff);
}
