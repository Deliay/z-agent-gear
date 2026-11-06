import { exec, type ExecException } from 'child_process';
import { chmodSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { logger as rootLogger, type ObservationLogger } from './observability/logger.js';

function expandTilde(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function execAsync(command: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, (error: ExecException | null, stdout: string, stderr: string) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * shell 单引号转义：值整体被单引号包裹，内嵌 `'` 转义为 `'\''`。
 * name/email 来自用户设置（经 agent-api 透传），拼接进 `execAsync` 前必须转义。
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface WorktreeAddResult {
  success: boolean;
  worktreePath?: string;
  branch?: string;
  error?: string;
}

/**
 * Worktree 级提交人（`git:worktree:add` 可选载荷，缺省 = 不写身份）。
 * `coAuthorName/coAuthorEmail` 成对出现时，后续提交自动追加 `Co-authored-by` trailer。
 */
export interface WorktreeCommitter {
  name: string;
  email: string;
  coAuthorName?: string;
  coAuthorEmail?: string;
}

/** 共同作者 hook 的受管标记：文件内容固定，不含用户数据。 */
export const CO_AUTHOR_HOOK_MARKER = '# zag-managed';
export const CO_AUTHOR_HOOK_DIR = 'zag-hooks';
export const CO_AUTHOR_HOOK_NAME = 'prepare-commit-msg';

/** 共同作者 hook：从当前 worktree 生效配置读取 trailer，缺省（无配置）直接放行。 */
export function renderCoAuthorHook(): string {
  return [
    '#!/bin/sh',
    `${CO_AUTHOR_HOOK_MARKER}: append Co-authored-by trailer from worktree config (idempotent)`,
    'MSG="$1"',
    '[ -n "$MSG" ] || exit 0',
    'NAME=$(git config --get zag.coAuthorName 2>/dev/null) || exit 0',
    'EMAIL=$(git config --get zag.coAuthorEmail 2>/dev/null) || exit 0',
    '[ -n "$NAME" ] && [ -n "$EMAIL" ] || exit 0',
    'TRAILER="Co-authored-by: $NAME <$EMAIL>"',
    'grep -qF "$TRAILER" "$MSG" 2>/dev/null && exit 0',
    'git interpret-trailers --in-place --trailer "$TRAILER" "$MSG" 2>/dev/null \\',
    "  || printf '\\n%s\\n' \"$TRAILER\" >> \"$MSG\"",
    'exit 0',
    '',
  ].join('\n');
}

function isControlFree(value: string): boolean {
  return !/[\r\n\0]/.test(value);
}

/** 共同作者成对净化：只有两个字段都合法时才启用，否则整体忽略。 */
function normalizeCoAuthor(
  committer: Partial<WorktreeCommitter>,
): { coAuthorName: string; coAuthorEmail: string } | undefined {
  const { coAuthorName, coAuthorEmail } = committer;
  if (typeof coAuthorName !== 'string' || typeof coAuthorEmail !== 'string') return undefined;
  const name = coAuthorName.trim();
  const email = coAuthorEmail.trim();
  if (!name || !email) return undefined;
  if (!isControlFree(name) || !isControlFree(email)) return undefined;
  return { coAuthorName: name, coAuthorEmail: email };
}

/**
 * 载荷净化：仅接受 name/email 均为非空字符串的对象（载荷来自服务端 JSON，运行时不可信）。
 * 非法形态一律视为「未提供 committer」→ 不写身份、沿用容器级 bot，而不是让 worktree 创建失败。
 */
function normalizeCommitter(committer?: WorktreeCommitter): WorktreeCommitter | undefined {
  if (!committer || typeof committer !== 'object') return undefined;
  const { name, email } = committer as Partial<WorktreeCommitter>;
  if (typeof name !== 'string' || name.trim().length === 0) return undefined;
  if (typeof email !== 'string' || email.trim().length === 0) return undefined;
  const coAuthor = normalizeCoAuthor(committer as Partial<WorktreeCommitter>);
  return coAuthor ? { name, email, ...coAuthor } : { name, email };
}

export interface WorktreeCoAuthorResult {
  success: boolean;
  error?: string;
}

export interface WorktreeRemoveResult {
  success: boolean;
  error?: string;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string;
}

export interface WorktreeListResult {
  success: boolean;
  worktrees?: WorktreeInfo[];
  error?: string;
}

export interface GitStatusResult {
  isClean: boolean;
  error?: string;
}

export interface GitCommitResult {
  success: boolean;
  commitHash?: string;
  error?: string;
}

export class WorktreeHandler {
  private log: ObservationLogger;

  constructor(logger?: ObservationLogger) {
    this.log = logger ?? rootLogger.child({ component: 'worktree-handler' });
  }

  async add(
    repoPath: string,
    worktreePath: string,
    branch: string,
    committer?: WorktreeCommitter,
  ): Promise<WorktreeAddResult> {
    try {
      const resolvedPath = expandTilde(worktreePath);
      const parentDir = dirname(resolvedPath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
      const { stderr } = await execAsync(
        `git -C "${repoPath}" worktree add -b "${branch}" "${resolvedPath}"`,
      );
      if (stderr && !stderr.includes('already exists') && !stderr.includes('done') && !stderr.includes('Preparing')) {
        return { success: false, error: stderr.trim() };
      }
      if (committer) {
        const normalized = normalizeCommitter(committer);
        if (normalized) {
          await this.applyWorktreeCommitter(resolvedPath, normalized);
        }
      }
      return { success: true, worktreePath: resolvedPath, branch };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * 向 worktree 写入 worktree 级 git 身份（仅作用于该 worktree，主仓与兄弟 worktree 不受影响）。
   *
   * - `extensions.worktreeConfig true` 落在共享配置（幂等，重复 set 同值无副作用）；
   * - `--worktree user.name/user.email` 落在 `.git/worktrees/<name>/config.worktree`；
   * - name/email 为**用户可控值**，一律经 `shellQuote` 转义后拼接；
   * - 单条失败仅 `this.log.warn`，不阻断 worktree 创建（身份缺失可接受）。
   */
  private async applyWorktreeCommitter(worktreePath: string, committer: WorktreeCommitter): Promise<void> {
    const pathArg = shellQuote(worktreePath);
    const commands = [
      `git -C ${pathArg} config extensions.worktreeConfig true`,
      `git -C ${pathArg} config --worktree user.name ${shellQuote(committer.name)}`,
      `git -C ${pathArg} config --worktree user.email ${shellQuote(committer.email)}`,
    ];
    for (const command of commands) {
      try {
        await execAsync(command);
      } catch (err) {
        // 不输出 name/email 值（用户数据），仅记录失败步骤与原因
        this.log.warn({ err }, '写入 worktree 提交人配置失败（忽略）');
      }
    }

    if (committer.coAuthorName && committer.coAuthorEmail) {
      await this.applyWorktreeCoAuthor(
        worktreePath,
        committer.coAuthorName,
        committer.coAuthorEmail,
      );
    }
  }

  /**
   * 更新已有 Worktree 的共同作者配置（不改变作者身份）。
   *
   * 设置页勾选/取消只影响「之后创建的 Worktree」时，用户在旧 Worktree 上提交会看不到变化；
   * 本方法在已有 Worktree 上重新同步：`coAuthor` 缺省 = 移除受管 trailer 配置（仅清理本平台写入的值）。
   */
  async configureCoAuthor(
    worktreePath: string,
    coAuthor?: { name: string; email: string },
  ): Promise<WorktreeCoAuthorResult> {
    try {
      const resolvedPath = expandTilde(worktreePath);
      const normalized = coAuthor
        ? normalizeCoAuthor({
            coAuthorName: coAuthor.name,
            coAuthorEmail: coAuthor.email,
          })
        : undefined;
      if (normalized) {
        await this.applyWorktreeCoAuthor(
          resolvedPath,
          normalized.coAuthorName,
          normalized.coAuthorEmail,
        );
      } else {
        await this.clearWorktreeCoAuthor(resolvedPath);
      }
      return { success: true };
    } catch (err) {
      this.log.warn({ err }, '更新 worktree 共同作者配置失败（忽略）');
      return { success: false, error: (err as Error).message };
    }
  }

  /** Worktree 共享 git 目录下的受管 hook 目录（多 worktree 共用同一份 hook 文件）。 */
  private async resolveHookDir(worktreePath: string): Promise<string> {
    const pathArg = shellQuote(worktreePath);
    const { stdout } = await execAsync(
      `git -C ${pathArg} rev-parse --path-format=absolute --git-common-dir`,
    );
    const commonDir = stdout.trim();
    if (!commonDir) throw new Error('git-common-dir is empty');
    // `--path-format=absolute` 保证绝对路径；兼容旧 git 的相对输出时以 worktree 为基准解析。
    return join(resolve(worktreePath, commonDir), CO_AUTHOR_HOOK_DIR);
  }

  /**
   * 安装 worktree 级共同作者 hook（仅作用于该 worktree）。
   *
   * - 通过 `rev-parse --path-format=absolute --git-common-dir` 定位共享 git 目录，
   *   在 `<common>/zag-hooks/` 写单一受管 hook（多 worktree 共用，行为由各自 config.worktree 决定）；
   * - `core.hooksPath` / `zag.coAuthorName` / `zag.coAuthorEmail` 一律 `--worktree` 写入；
   * - 任一步失败只告警，不阻断 worktree 创建。
   */
  private async applyWorktreeCoAuthor(
    worktreePath: string,
    coAuthorName: string,
    coAuthorEmail: string,
  ): Promise<void> {
    const pathArg = shellQuote(worktreePath);
    let hookDir: string;
    try {
      hookDir = await this.resolveHookDir(worktreePath);
      mkdirSync(hookDir, { recursive: true });
      const hookPath = join(hookDir, CO_AUTHOR_HOOK_NAME);
      writeFileSync(hookPath, renderCoAuthorHook(), { mode: 0o755 });
      chmodSync(hookPath, 0o755);
    } catch (err) {
      // 不输出路径/用户数据，仅记录失败原因
      this.log.warn({ err }, '写入 worktree 共同作者 hook 失败（忽略）');
      return;
    }

    const commands = [
      // 已有 Worktree 可能由旧版本/手工创建，补齐 worktree config 开关后 `--worktree` 才生效。
      `git -C ${pathArg} config extensions.worktreeConfig true`,
      `git -C ${pathArg} config --worktree core.hooksPath ${shellQuote(hookDir)}`,
      `git -C ${pathArg} config --worktree zag.coAuthorName ${shellQuote(coAuthorName)}`,
      `git -C ${pathArg} config --worktree zag.coAuthorEmail ${shellQuote(coAuthorEmail)}`,
    ];
    for (const command of commands) {
      try {
        await execAsync(command);
      } catch (err) {
        // 不输出共同作者值（服务端数据），仅记录失败步骤与原因
        this.log.warn({ err }, '写入 worktree 共同作者配置失败（忽略）');
      }
    }
  }

  /**
   * 移除 worktree 级共同作者配置（幂等）。
   *
   * - 仅当该 worktree 的 `core.hooksPath` 恰为受管目录时才 unset，用户自建 hooks 零触碰；
   * - 共享 hook 文件保留（其他 worktree 可能仍在引用），仅移除本 worktree 的配置。
   */
  private async clearWorktreeCoAuthor(worktreePath: string): Promise<void> {
    const pathArg = shellQuote(worktreePath);
    let hookDir: string;
    try {
      hookDir = await this.resolveHookDir(worktreePath);
    } catch (err) {
      this.log.warn({ err }, '读取 worktree 共同作者配置失败（忽略）');
      return;
    }

    try {
      const { stdout } = await execAsync(`git -C ${pathArg} config --worktree --get core.hooksPath`);
      if (stdout.trim() === hookDir) {
        await execAsync(`git -C ${pathArg} config --worktree --unset core.hooksPath`);
      }
    } catch {
      // key 不存在（git 退出码 1）或未启用 worktree config：本就没有可清理的受管路径。
    }

    for (const key of ['zag.coAuthorName', 'zag.coAuthorEmail']) {
      try {
        await execAsync(`git -C ${pathArg} config --worktree --unset ${key}`);
      } catch {
        // key 不存在 = 已清理，无需告警
      }
    }
  }

  async list(workspacePath: string): Promise<WorktreeListResult> {
    try {
      const resolvedPath = expandTilde(workspacePath);
      const { stdout } = await execAsync(`git -C "${resolvedPath}" worktree list --porcelain`);
      const worktrees: WorktreeInfo[] = [];
      const blocks = stdout.trim().split('\n\n');
      for (const block of blocks) {
        if (!block.trim()) continue;
        const lines = Object.fromEntries(
          block.split('\n').map(line => {
            const idx = line.indexOf(' ');
            return [line.slice(0, idx), line.slice(idx + 1)];
          }),
        );
        worktrees.push({
          path: lines['worktree'] || '',
          branch: lines['branch']?.replace('refs/heads/', '') ?? null,
          head: lines['HEAD'] || '',
        });
      }
      return { success: true, worktrees };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async remove(repoPath: string, worktreePath: string, force = false): Promise<WorktreeRemoveResult> {
    try {
      const resolvedPath = expandTilde(worktreePath);
      const forceFlag = force ? ' --force' : '';
      const { stderr } = await execAsync(`git -C "${repoPath}" worktree remove${forceFlag} "${resolvedPath}"`);
      if (stderr) return { success: false, error: stderr.trim() };
      try {
        if (existsSync(resolvedPath)) {
          rmSync(resolvedPath, { recursive: true });
        }
      } catch { }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async status(path: string): Promise<GitStatusResult> {
    try {
      const resolvedPath = expandTilde(path);
      const { stdout } = await execAsync(`git -C "${resolvedPath}" status --porcelain`);
      return { isClean: stdout.trim().length === 0 };
    } catch (err) {
      return { isClean: true, error: (err as Error).message };
    }
  }

  async commit(path: string, message: string): Promise<GitCommitResult> {
    try {
      const resolvedPath = expandTilde(path);
      await execAsync(`git -C "${resolvedPath}" add -A`);
      const { stdout, stderr } = await execAsync(`git -C "${resolvedPath}" commit -m "${message}"`);
      if (stderr && !stdout) return { success: false, error: stderr.trim() };
      const hash = stdout.match(/\[[\w\/]+ ([a-f0-9]+)\]/)?.[1];
      return { success: true, commitHash: hash };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
}

export const worktreeHandler = new WorktreeHandler();