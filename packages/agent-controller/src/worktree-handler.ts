import { exec, type ExecException } from 'child_process';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { dirname } from 'path';

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
      const parentDir = dirname(worktreePath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
      const { stderr } = await execAsync(
        `git -C "${repoPath}" worktree add -b "${branch}" "${worktreePath}"`,
      );
      if (stderr && !stderr.includes('already exists') && !stderr.includes('done')) {
        return { success: false, error: stderr.trim() };
      }
      return { success: true, worktreePath, branch };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async remove(worktreePath: string): Promise<WorktreeRemoveResult> {
    try {
      const { stderr } = await execAsync(`git worktree remove "${worktreePath}"`);
      if (stderr) return { success: false, error: stderr.trim() };
      try {
        if (existsSync(worktreePath)) {
          rmSync(worktreePath, { recursive: true });
        }
      } catch { }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async status(path: string): Promise<GitStatusResult> {
    try {
      const { stdout } = await execAsync(`git -C "${path}" status --porcelain`);
      return { isClean: stdout.trim().length === 0 };
    } catch (err) {
      return { isClean: true, error: (err as Error).message };
    }
  }

  async commit(path: string, message: string): Promise<GitCommitResult> {
    try {
      await execAsync(`git -C "${path}" add -A`);
      const { stdout, stderr } = await execAsync(`git -C "${path}" commit -m "${message}"`);
      if (stderr && !stdout) return { success: false, error: stderr.trim() };
      const hash = stdout.match(/\[[\w\/]+ ([a-f0-9]+)\]/)?.[1];
      return { success: true, commitHash: hash };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
}

export const worktreeHandler = new WorktreeHandler();