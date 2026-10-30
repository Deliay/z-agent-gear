import { GithubWebhookPayloadError } from './github-webhook-payload.js';

/** 受理的 issues 事件 action（其余安全忽略） */
export const SUPPORTED_ISSUE_ACTIONS = new Set(['opened', 'labeled', 'edited', 'reopened']);

export interface IssuesEventPayload {
  action: string;
  repoFullName: string;
  /** GitHub issue 数字 ID（幂等键组成部分） */
  issueId: string;
  issueNumber: number;
  title: string;
  body?: string;
  issueUrl: string;
  author?: string;
  /** 事件触发人（`labeled` 的 sender = 加触发标签者）；缺失/非法时省略（老 payload 兼容） */
  sender?: { id: number; login: string };
  /** 当前标签名（原始大小写；匹配时归一小写） */
  labels: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, detail: string, maxLength?: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GithubWebhookPayloadError(detail);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new GithubWebhookPayloadError(detail);
  }
  return value;
}

function optionalString(value: unknown, detail: string, maxLength?: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new GithubWebhookPayloadError(detail);
  if (maxLength !== undefined && value.length > maxLength) {
    throw new GithubWebhookPayloadError(detail);
  }
  return value;
}

function requirePositiveInt(value: unknown, detail: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new GithubWebhookPayloadError(detail);
  }
  return value;
}

function requireFullName(value: unknown): string {
  const fullName = requireString(value, 'repository.full_name', 512);
  const segments = fullName.split('/');
  if (
    segments.length !== 2 ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new GithubWebhookPayloadError('repository.full_name');
  }
  return fullName;
}

/**
 * GitHub `issues` 事件 → 归一化载荷（纯函数）。
 * - action 不在受理集合：返回 null（安全忽略，响应 UNSUPPORTED_EVENT）；
 * - 必填字段缺失/非法：抛 GithubWebhookPayloadError（响应 400，detail 为字段路径）。
 * 判定以**当前** labels 为准：`edited` 摘掉标签即不再命中。
 */
export function parseGithubIssuesEvent(raw: Buffer | string): IssuesEventPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    throw new GithubWebhookPayloadError('json');
  }
  if (!isRecord(parsed)) throw new GithubWebhookPayloadError('body');

  const action = requireString(parsed.action, 'action', 64);
  if (!SUPPORTED_ISSUE_ACTIONS.has(action)) return null;

  if (!isRecord(parsed.issue)) throw new GithubWebhookPayloadError('issue');
  const issue = parsed.issue;
  const issueId = String(requirePositiveInt(issue.id, 'issue.id'));
  const issueNumber = requirePositiveInt(issue.number, 'issue.number');
  const title = requireString(issue.title, 'issue.title', 256);
  const issueUrl = requireString(issue.html_url, 'issue.html_url', 2048);
  const body = optionalString(issue.body, 'issue.body', 64_000);

  if (!Array.isArray(issue.labels)) throw new GithubWebhookPayloadError('issue.labels');
  const labels: string[] = [];
  for (const label of issue.labels) {
    if (!isRecord(label)) throw new GithubWebhookPayloadError('issue.labels');
    const name = optionalString(label.name, 'issue.labels.name', 256);
    if (name && name.trim()) labels.push(name.trim());
  }

  let author: string | undefined;
  if (issue.user !== undefined && issue.user !== null) {
    if (!isRecord(issue.user)) throw new GithubWebhookPayloadError('issue.user');
    author = optionalString(issue.user.login, 'issue.user.login', 256);
  }

  // 触发人（加标签者）：缺失或字段非法 → 省略，不影响事件受理（老 payload 兼容）。
  let sender: { id: number; login: string } | undefined;
  if (isRecord(parsed.sender)) {
    const rawSender = parsed.sender;
    const login =
      typeof rawSender.login === 'string' && rawSender.login.trim()
        ? rawSender.login.trim().slice(0, 256)
        : undefined;
    const id =
      typeof rawSender.id === 'number' && Number.isInteger(rawSender.id) && rawSender.id > 0
        ? rawSender.id
        : undefined;
    if (login && id !== undefined) sender = { id, login };
  }

  if (!isRecord(parsed.repository)) throw new GithubWebhookPayloadError('repository');
  const repoFullName = requireFullName(parsed.repository.full_name);

  return {
    action,
    repoFullName,
    issueId,
    issueNumber,
    title,
    ...(body !== undefined ? { body } : {}),
    issueUrl,
    ...(author ? { author } : {}),
    ...(sender ? { sender } : {}),
    labels,
  };
}
