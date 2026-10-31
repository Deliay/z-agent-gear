import { exec, type ExecException } from 'child_process';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

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

/** Worktree 级提交人（`git:worktree:add` 可选载荷，缺省 = 不写身份）。 */
export interface WorktreeCommitter {
  name: string;
  email: string;
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
  return { name, email };
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
   * - 单条失败仅 `console.warn`，不阻断 worktree 创建（身份缺失可接受）。
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
        console.warn(`[WorktreeHandler] 写入 worktree 提交人配置失败（忽略）：${(err as Error).message}`);
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