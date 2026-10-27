import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rmdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 提交身份模式（与 agent-api 内部端点响应一致）。 */
export type CommitIdentityMode = 'agent_only' | 'co_author' | 'human_only' | 'unset';

/** 托管提交身份（`co_author` 模式额外携带 bot 署名）。 */
export interface CommitIdentityInfo {
  name: string;
  email: string;
  coAuthorName?: string;
  coAuthorEmail?: string;
}

/** 单次 `git` 子进程执行结果（非零退出码不抛错，由调用方判断）。 */
export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `git` 命令执行器（测试注入；生产使用 `node:child_process.spawn`）。 */
export type GitRunner = (args: string[]) => Promise<GitRunResult>;

export interface CommitIdentityOptions {
  /** 容器主目录（测试注入临时目录）；缺省 `os.homedir()`。 */
  home?: string;
  /** 注入 git 执行器（测试用）；缺省真实 spawn `git`。 */
  runGit?: GitRunner;
}

/** 托管文件相对 `~/.zag` 的路径约定（唯一事实源）。 */
export const MANAGED_ZAG_DIR = '.zag';
export const MANAGED_GITCONFIG_NAME = 'commit-identity.gitconfig';
export const MANAGED_HOOKS_DIR_NAME = 'git-hooks';
export const MANAGED_HOOK_NAME = 'prepare-commit-msg';
/** 托管 hook 标记：仅带此标记的文件才会被移除（用户文件零触碰）。 */
export const MANAGED_HOOK_MARKER = '# zag-managed';

/** 缺省 git 执行器：`HOME` 指向注入的主目录，保证 `--global` 落点一致。 */
function createGitRunner(home: string): GitRunner {
  return (args) =>
    new Promise<GitRunResult>((resolve, reject) => {
      const child = spawn('git', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: home },
      });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (result: GitRunResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on('error', (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.on('close', (code: number | null) => {
        finish({ code: code ?? -1, stdout, stderr });
      });
    });
}

function isControlFree(value: string): boolean {
  return !/[\r\n\0]/.test(value);
}

function requireText(value: string | undefined, label: string): string {
  if (typeof value !== 'string') throw new Error(`提交身份缺少 ${label}`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`提交身份 ${label} 为空`);
  if (!isControlFree(trimmed)) throw new Error(`提交身份 ${label} 含非法控制字符`);
  return trimmed;
}

function normalizeIdentity(mode: CommitIdentityMode, identity: CommitIdentityInfo): CommitIdentityInfo {
  const name = requireText(identity?.name, 'name');
  const email = requireText(identity?.email, 'email');
  if (mode !== 'co_author') return { name, email };
  return {
    name,
    email,
    coAuthorName: requireText(identity?.coAuthorName, 'coAuthorName'),
    coAuthorEmail: requireText(identity?.coAuthorEmail, 'coAuthorEmail'),
  };
}

/** git config 值转义：仅在含引号 / 反斜杠 / 行首注释符时使用双引号包裹。 */
function formatConfigValue(value: string): string {
  if (/["\\\t]/.test(value) || /^[#;]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\t/g, '\\t')}"`;
  }
  return value;
}

/** shell 单引号转义（hook 中的 trailer 字面量）。 */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 容器内托管提交身份（实现点 1/2）。
 *
 * - `apply()`：写 `~/.zag/commit-identity.gitconfig`（0600，`[user] name/email`）并幂等保证
 *   `include.path` 只设置一次；`co_author` 额外写 `~/.zag/git-hooks/prepare-commit-msg`（0755，
 *   `# zag-managed` 标记，trailer 固化为字面量）并设置 `core.hooksPath`；其他模式移除托管 hook。
 * - `remove()`：仅当全局配置值**恰为**托管路径时才 `--unset`（include.path 支持多值，逐值 exact-match），
 *   再删除托管文件；用户其他 git 配置零触碰。
 * - 所有错误可读；错误信息不包含身份值以外的任何配置内容（本模块无 secret）。
 */
export class CommitIdentity {
  readonly home: string;
  readonly zagDir: string;
  readonly gitConfigPath: string;
  readonly hooksDir: string;
  readonly hookPath: string;

  private readonly runGit: GitRunner;

  constructor(options: CommitIdentityOptions = {}) {
    this.home = options.home ?? homedir();
    this.zagDir = join(this.home, MANAGED_ZAG_DIR);
    this.gitConfigPath = join(this.zagDir, MANAGED_GITCONFIG_NAME);
    this.hooksDir = join(this.zagDir, MANAGED_HOOKS_DIR_NAME);
    this.hookPath = join(this.hooksDir, MANAGED_HOOK_NAME);
    this.runGit = options.runGit ?? createGitRunner(this.home);
  }

  /** 应用（或按 `unset` 移除）托管提交身份；重复调用幂等。 */
  async apply(mode: CommitIdentityMode, identity: CommitIdentityInfo): Promise<void> {
    if (mode === 'unset') {
      await this.remove();
      return;
    }
    if (mode !== 'agent_only' && mode !== 'co_author' && mode !== 'human_only') {
      throw new Error(`未知的提交身份模式：${String(mode)}`);
    }

    const normalized = normalizeIdentity(mode, identity);
    await mkdir(this.zagDir, { recursive: true, mode: 0o700 });
    await writeFile(this.gitConfigPath, this.renderGitConfig(normalized), { mode: 0o600 });
    await chmod(this.gitConfigPath, 0o600);
    await this.ensureIncludePath();

    if (mode === 'co_author') {
      await this.writeHook(normalized);
      await this.ensureHooksPath();
    } else {
      await this.removeManagedHook();
      await this.removeHooksPath();
    }
  }

  /** 移除全部托管配置 / 文件（「未设置 = 上线前行为」）。 */
  async remove(): Promise<void> {
    await this.removeIncludePath();
    await this.removeHooksPath();
    await rm(this.gitConfigPath, { force: true });
    await this.removeManagedHook();
  }

  private renderGitConfig(identity: CommitIdentityInfo): string {
    return `[user]\n\tname = ${formatConfigValue(identity.name)}\n\temail = ${formatConfigValue(identity.email)}\n`;
  }

  private async gitConfig(args: string[], tolerateCodes: number[] = []): Promise<GitRunResult> {
    let result: GitRunResult;
    try {
      result = await this.runGit(['config', '--global', ...args]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`执行 git config ${args.join(' ')} 失败：${reason}`);
    }
    if (result.code !== 0 && !tolerateCodes.includes(result.code)) {
      const detail = result.stderr.trim();
      throw new Error(
        `git config ${args.join(' ')} 失败（退出码 ${result.code}）${detail ? `：${detail}` : ''}`,
      );
    }
    return result;
  }

  /** 全局 include.path 多值读取（key 不存在时 git 退出码为 1）。 */
  private async getIncludePaths(): Promise<string[]> {
    const result = await this.gitConfig(['--get-all', 'include.path'], [1]);
    if (result.code !== 0) return [];
    return result.stdout
      .split('\n')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  /** 全局 core.hooksPath 读取（key 不存在时 git 退出码为 1）。 */
  private async getHooksPath(): Promise<string | null> {
    const result = await this.gitConfig(['--get', 'core.hooksPath'], [1]);
    if (result.code !== 0) return null;
    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  }

  private async ensureIncludePath(): Promise<void> {
    const values = await this.getIncludePaths();
    // 已存在（含多值中的任意一项）即视为已设置：重复 apply 不追加。
    if (values.includes(this.gitConfigPath)) return;
    await this.gitConfig(['--add', 'include.path', this.gitConfigPath]);
  }

  private async removeIncludePath(): Promise<void> {
    const values = await this.getIncludePaths();
    // exact-match：仅当存在与托管路径完全相等的值时移除该项（其余值原样保留）。
    if (!values.includes(this.gitConfigPath)) return;
    // `--fixed-value` 保证路径按字面量匹配（避免 `.` 等被当作正则）；退出码 5 = 并发下已无匹配。
    await this.gitConfig(
      ['--fixed-value', '--unset-all', 'include.path', this.gitConfigPath],
      [5],
    );
  }

  private async ensureHooksPath(): Promise<void> {
    const current = await this.getHooksPath();
    if (current === this.hooksDir) return;
    await this.gitConfig(['core.hooksPath', this.hooksDir]);
  }

  private async removeHooksPath(): Promise<void> {
    const current = await this.getHooksPath();
    // exact-match：用户已把 core.hooksPath 改走时零触碰。
    if (current !== this.hooksDir) return;
    await this.gitConfig(['--unset', 'core.hooksPath'], [5]);
  }

  private renderHook(identity: CommitIdentityInfo): string {
    const trailer = `Co-authored-by: ${identity.coAuthorName} <${identity.coAuthorEmail}>`;
    return [
      '#!/bin/sh',
      `${MANAGED_HOOK_MARKER}: append Co-authored-by trailer (idempotent)`,
      'MSG="$1"',
      '[ -n "$MSG" ] || exit 0',
      `TRAILER=${shellSingleQuote(trailer)}`,
      'grep -qF "$TRAILER" "$MSG" 2>/dev/null && exit 0',
      'git interpret-trailers --in-place --trailer "$TRAILER" "$MSG" 2>/dev/null \\',
      "  || printf '\\n%s\\n' \"$TRAILER\" >> \"$MSG\"",
      'exit 0',
      '',
    ].join('\n');
  }

  private async writeHook(identity: CommitIdentityInfo): Promise<void> {
    await mkdir(this.hooksDir, { recursive: true, mode: 0o700 });
    await writeFile(this.hookPath, this.renderHook(identity), { mode: 0o755 });
    await chmod(this.hookPath, 0o755);
  }

  /** 仅删除带 `# zag-managed` 标记的 hook 文件；空目录一并清理（非空则保留）。 */
  private async removeManagedHook(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.hookPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!content.includes(MANAGED_HOOK_MARKER)) return;
    await rm(this.hookPath, { force: true });
    try {
      await rmdir(this.hooksDir);
    } catch {
      // 目录不存在或非空（用户文件）：保留。
    }
  }
}
