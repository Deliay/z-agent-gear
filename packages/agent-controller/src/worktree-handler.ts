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

export interface WorktreeAddResult {
  success: boolean;
  worktreePath?: string;
  branch?: string;
  error?: string;
}

export interface WorktreeRemoveResult {
  success: boolean;
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
  async add(repoPath: string, worktreePath: string, branch: string): Promise<WorktreeAddResult> {
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
      return { success: true, worktreePath: resolvedPath, branch };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async remove(repoPath: string, worktreePath: string): Promise<WorktreeRemoveResult> {
    try {
      const resolvedPath = expandTilde(worktreePath);
      const { stderr } = await execAsync(`git -C "${repoPath}" worktree remove "${resolvedPath}"`);
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