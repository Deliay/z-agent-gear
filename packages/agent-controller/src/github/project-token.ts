import { spawn } from 'node:child_process';

/** 成功：已向 stdout 输出单行 token。 */
export const EXIT_OK = 0;
/** 当前目录不是 Github 项目（wrapper 需静默降级）。 */
export const EXIT_NOT_PROJECT = 3;
/** 项目未在平台初始化 / 云主机无绑定。 */
export const EXIT_NOT_BOUND = 4;
/** 当前账号无该项目权限。 */
export const EXIT_UNAUTHORIZED = 5;
/** 其它失败（env 缺失、平台不可达、超时、回显不匹配、非法响应）。 */
export const EXIT_FAILED = 6;

/** 申请接口超时（10 秒）。 */
export const REQUEST_TIMEOUT_MS = 10_000;

/** token 长度硬上限（防御异常响应污染 wrapper 的 env）。 */
export const MAX_TOKEN_LENGTH = 4096;

const GITHUB_HOST = 'github.com';
const REPO_SEGMENT = /^[\w.-]+$/;

/**
 * 把 `git remote get-url origin` 的输出归一为 `owner/repo`（保留原大小写）。
 *
 * 支持 `https://`、`http://`、`ssh://`、`git://`、`git@github.com:owner/repo.git`、
 * 带 userinfo 的 URL、尾部 `/` 与 `.git`；host 大小写不敏感。非 Github / 段数不为 2 /
 * 含非法字符时返回 `null`。
 */
export function normalizeGitHubRemote(remote: string): string | null {
  if (typeof remote !== 'string') return null;
  let value = remote.trim();
  if (!value) return null;

  for (const prefix of ['https://', 'http://', 'ssh://', 'git://']) {
    if (value.toLowerCase().startsWith(prefix)) {
      value = value.slice(prefix.length);
      break;
    }
  }
  // 剥 userinfo（`user:pass@host/...` 与 `git@host:...`）
  const at = value.indexOf('@');
  if (at >= 0) value = value.slice(at + 1);

  // scp-like 形态 `github.com:owner/repo` → `github.com/owner/repo`
  const colon = value.indexOf(':');
  if (colon >= 0 && !value.slice(0, colon).includes('/')) {
    value = `${value.slice(0, colon)}/${value.slice(colon + 1)}`;
  }

  value = value.replace(/\/+$/, '');
  if (value.toLowerCase().endsWith('.git')) value = value.slice(0, -4);
  value = value.replace(/\/+$/, '');
  if (!value) return null;

  const segments = value.split('/');
  if (segments.length !== 3) return null;
  const [host, owner, repo] = segments as [string, string, string];
  if (host.toLowerCase() !== GITHUB_HOST) return null;
  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(repo)) return null;
  return `${owner}/${repo}`;
}

export interface GitCommandResult {
  code: number;
  stdout: string;
}

/** git 子命令执行器（测试注入；生产使用 `node:child_process.spawn`）。 */
export type GitRunner = (args: string[], cwd: string) => Promise<GitCommandResult | null>;

const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (value: GitCommandResult | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.on('error', () => finish(null));
    child.on('close', (code: number | null) => finish({ code: code ?? -1, stdout }));
  });

export type GitProjectResolution =
  | { kind: 'project'; repoFullName: string }
  | { kind: 'not-project' };

export interface ResolveGitProjectDeps {
  runGit?: GitRunner;
}

/**
 * 解析 `cwd` 所属 Git 项目的 Github 仓库（`owner/repo`）。
 * 不是 Git 仓库 / 无 origin / origin 非 Github 形态一律 `not-project`。
 */
export async function resolveGitProject(
  cwd: string,
  deps: ResolveGitProjectDeps = {},
): Promise<GitProjectResolution> {
  const runGit = deps.runGit ?? defaultGitRunner;
  try {
    const topLevel = await runGit(['rev-parse', '--show-toplevel'], cwd);
    if (!topLevel || topLevel.code !== 0) return { kind: 'not-project' };
    const root = topLevel.stdout.trim();
    if (!root) return { kind: 'not-project' };

    const origin = await runGit(['remote', 'get-url', 'origin'], root);
    if (!origin || origin.code !== 0) return { kind: 'not-project' };

    const repoFullName = normalizeGitHubRemote(origin.stdout);
    if (!repoFullName) return { kind: 'not-project' };
    return { kind: 'project', repoFullName };
  } catch {
    return { kind: 'not-project' };
  }
}

export type ProjectTokenResult =
  | { kind: 'token'; token: string }
  | { kind: 'error'; code: 4 | 5 | 6; message: string };

export interface RequestProjectTokenInput {
  repoFullName: string;
  env: NodeJS.ProcessEnv;
  /** 注入 fetch（测试用）；生产使用全局 fetch。 */
  fetch?: typeof fetch;
  /** 注入超时（测试或用例需要时）。 */
  timeoutMs?: number;
}

const MISSING_ENV_KEYS = ['ZAG_AGENT_API_ENDPOINT', 'ZAG_CONTROLLER_ID', 'ZAG_HOST_KEY'] as const;

function missingEnvKeys(env: NodeJS.ProcessEnv): string[] {
  return MISSING_ENV_KEYS.filter((key) => {
    const value = env[key];
    return typeof value !== 'string' || value.trim().length === 0;
  });
}

function isValidToken(token: unknown): token is string {
  return (
    typeof token === 'string' &&
    token.length > 0 &&
    token.length <= MAX_TOKEN_LENGTH &&
    !/\s/.test(token)
  );
}

function sameRepo(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 向 agent-api 申请项目级 Github token。
 *
 * 错误信息只含可读文案，不含 token / 响应体原文；退出码语义见 D6。
 */
export async function requestProjectToken(
  input: RequestProjectTokenInput,
): Promise<ProjectTokenResult> {
  const missing = missingEnvKeys(input.env);
  if (missing.length > 0) {
    return { kind: 'error', code: 6, message: `缺少环境变量：${missing.join('、')}` };
  }

  const endpoint = input.env.ZAG_AGENT_API_ENDPOINT!.trim().replace(/\/+$/, '');
  const controllerId = input.env.ZAG_CONTROLLER_ID!.trim();
  const hostKey = input.env.ZAG_HOST_KEY!.trim();
  const url = `${endpoint}/internal/cloud-hosts/${encodeURIComponent(controllerId)}/github-credential`;
  const fetchFn = input.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? REQUEST_TIMEOUT_MS);
  timer.unref?.();

  let status: number;
  let text: string;
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${hostKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ repoFullName: input.repoFullName }),
      signal: controller.signal,
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const message = /abort/i.test(reason)
      ? 'Github 凭据申请超时'
      : 'Github 凭据申请失败（平台不可达）';
    return { kind: 'error', code: 6, message };
  } finally {
    clearTimeout(timer);
  }

  const payload = text ? parseJson(text) : null;
  const errorCode = typeof payload?.error === 'string' ? payload.error : '';

  if (status === 200) {
    const token = payload?.token;
    const echoed = payload?.repoFullName;
    if (typeof echoed !== 'string' || !sameRepo(echoed, input.repoFullName)) {
      return { kind: 'error', code: 6, message: 'Github 凭据响应与请求项目不一致' };
    }
    if (!isValidToken(token)) {
      return { kind: 'error', code: 6, message: 'Github 凭据响应缺少合法 token' };
    }
    return { kind: 'token', token };
  }

  if (status === 404) {
    return {
      kind: 'error',
      code: 4,
      message:
        errorCode === 'PROJECT_NOT_BOUND'
          ? '该项目尚未在平台初始化'
          : '云主机未绑定 Github 项目',
    };
  }
  if (status === 403) {
    return {
      kind: 'error',
      code: 5,
      message:
        errorCode === 'REPO_NOT_AUTHORIZED' ? '当前账号无该项目权限' : 'Github 凭据申请被拒绝',
    };
  }
  return { kind: 'error', code: 6, message: `Github 凭据申请失败（HTTP ${status}）` };
}

export interface RunGithubTokenCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  resolveGitProject?: typeof resolveGitProject;
  requestProjectToken?: typeof requestProjectToken;
  /** 输出通道（测试注入）；生产为 `process.stdout.write`。 */
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/**
 * `agent-gear github-token` 的完整编排。
 *
 * 纪律（D5）：**零 logger**；成功时 stdout 只有一行 token，失败时 stdout 为空、stderr 一行。
 * 返回退出码（不调用 `process.exit`，便于测试）。
 */
export async function runGithubTokenCommand(
  options: RunGithubTokenCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const writeStdout = options.stdout ?? ((text: string) => void process.stdout.write(text));
  const writeStderr = options.stderr ?? ((text: string) => void process.stderr.write(text));
  const resolve = options.resolveGitProject ?? resolveGitProject;
  const request = options.requestProjectToken ?? requestProjectToken;

  const project = await resolve(cwd);
  if (project.kind !== 'project') return EXIT_NOT_PROJECT;

  const result = await request({ repoFullName: project.repoFullName, env });
  if (result.kind === 'token') {
    writeStdout(`${result.token}\n`);
    return EXIT_OK;
  }
  writeStderr(`${result.message}\n`);
  return result.code;
}
