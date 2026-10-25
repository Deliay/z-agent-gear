import { config } from '../../config/index.js';

/**
 * GitHub Checks REST 封装（出站调用）。
 *
 * 约束：
 * - 统一 `Accept: application/vnd.github+json` + `X-GitHub-Api-Version` + Bearer token；
 * - 10s 超时（AbortController）；
 * - 非 2xx / 网络错误收敛为 `GitHubChecksError`（只带 code 与英文短句）；
 * - **响应体不进日志、不进错误文案**（避免泄露凭据与上游细节）。
 */
export type GitHubChecksErrorCode =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UPSTREAM'
  | 'INVALID_PAYLOAD';

export class GitHubChecksError extends Error {
  constructor(
    public readonly code: GitHubChecksErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubChecksError';
  }
}

export type CheckRunStatus = 'queued' | 'in_progress' | 'completed';
/**
 * 应用可写结论。
 *
 * 注意：`stale` 是 GitHub 保留结论（仅 GitHub 在 PR 有新提交后可自行设置），
 * 应用侧 PATCH/POST `conclusion: 'stale'` 会被 422 拒绝，故不纳入可写联合类型。
 * 旧提交上的检查项由 GitHub 自动置 stale；本服务只 PATCH 允许写入的 `output` 字段。
 */
export type CheckRunConclusion =
  | 'action_required'
  | 'cancelled'
  | 'failure'
  | 'neutral'
  | 'success'
  | 'skipped'
  | 'timed_out';

export interface CheckRunOutput {
  title: string;
  summary: string;
  text?: string;
}

export interface CreateCheckRunPayload {
  name: string;
  head_sha: string;
  external_id?: string;
  status: CheckRunStatus;
  conclusion?: CheckRunConclusion;
  started_at?: string;
  completed_at?: string;
  output?: CheckRunOutput;
}

export interface UpdateCheckRunPayload {
  status?: CheckRunStatus;
  conclusion?: CheckRunConclusion;
  completed_at?: string;
  output?: CheckRunOutput;
}

export interface CheckRunResult {
  id: number;
  htmlUrl: string | null;
}

export interface PullRequestHead {
  sha: string;
  state: string;
  merged: boolean;
}

const REQUEST_TIMEOUT_MS = 10_000;
const GITHUB_API_VERSION = '2026-03-10';

function apiBase(): string {
  return config.githubApiBaseUrl || 'https://api.github.com';
}

function toError(status: number): GitHubChecksError {
  switch (status) {
    case 403:
      return new GitHubChecksError('FORBIDDEN', 'github checks forbidden');
    case 404:
      return new GitHubChecksError('NOT_FOUND', 'github repository or pull request not found');
    case 422:
      return new GitHubChecksError('INVALID_PAYLOAD', 'github checks payload rejected');
    case 429:
      return new GitHubChecksError('RATE_LIMITED', 'github rate limited');
    default:
      return new GitHubChecksError('UPSTREAM', 'github upstream error');
  }
}

async function request<T>(
  token: string,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${apiBase()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw toError(response.status);
    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof GitHubChecksError) throw err;
    // 网络错误 / 超时 / 非法 JSON：不透出上游原文
    throw new GitHubChecksError('UPSTREAM', 'github request failed');
  } finally {
    clearTimeout(timer);
  }
}

function repoPath(repo: string): string {
  return `/repos/${repo}`;
}

function mapCheckRun(data: { id?: unknown; html_url?: unknown }): CheckRunResult {
  if (typeof data.id !== 'number') {
    throw new GitHubChecksError('UPSTREAM', 'github check run response invalid');
  }
  return { id: data.id, htmlUrl: typeof data.html_url === 'string' ? data.html_url : null };
}

/** 创建 check-run（POST /repos/{owner}/{repo}/check-runs） */
export async function createCheckRun(
  token: string,
  repo: string,
  payload: CreateCheckRunPayload,
): Promise<CheckRunResult> {
  const data = await request<{ id?: unknown; html_url?: unknown }>(
    token,
    'POST',
    `${repoPath(repo)}/check-runs`,
    payload,
  );
  return mapCheckRun(data);
}

/** 更新 check-run（PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}） */
export async function updateCheckRun(
  token: string,
  repo: string,
  checkRunId: number,
  payload: UpdateCheckRunPayload,
): Promise<CheckRunResult> {
  const data = await request<{ id?: unknown; html_url?: unknown }>(
    token,
    'PATCH',
    `${repoPath(repo)}/check-runs/${checkRunId}`,
    payload,
  );
  return mapCheckRun(data);
}

/** 读取 PR 最新 head（GET /repos/{owner}/{repo}/pulls/{pull_number}） */
export async function getPullRequestHead(
  token: string,
  repo: string,
  pullNumber: number,
): Promise<PullRequestHead> {
  const data = await request<{
    head?: { sha?: unknown };
    state?: unknown;
    merged?: unknown;
  }>(token, 'GET', `${repoPath(repo)}/pulls/${pullNumber}`);
  const sha = typeof data.head?.sha === 'string' ? data.head.sha : null;
  if (!sha) throw new GitHubChecksError('UPSTREAM', 'github pull request response invalid');
  return {
    sha,
    state: typeof data.state === 'string' ? data.state : 'unknown',
    merged: data.merged === true,
  };
}
