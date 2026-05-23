import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface GitCheckResult {
  isGitRepo: boolean;
  currentBranch?: string;
  branches?: string[];
  defaultBranch?: string;
  error?: string;
}

export interface GitInitResult {
  success: boolean;
  error?: string;
}

export class GitHandler {
  async check(path: string): Promise<GitCheckResult> {
    try {
      const { stdout: gitDir } = await execAsync('git rev-parse --git-dir', { cwd: path });
      if (!gitDir.trim()) {
        return { isGitRepo: false };
      }
    } catch {
      return { isGitRepo: false };
    }

    try {
      const { stdout: currentBranch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: path });
      const { stdout: branchesOutput } = await execAsync('git branch --format="%(refname:short)"', { cwd: path });

      const branches = branchesOutput.trim().split('\n').filter(Boolean);
      const current = currentBranch.trim();

      let defaultBranch: string;
      if (branches.includes('main')) {
        defaultBranch = 'main';
      } else if (branches.includes('master')) {
        defaultBranch = 'master';
      } else {
        const sorted = [...branches].sort();
        defaultBranch = sorted[0] || current;
      }

      return {
        isGitRepo: true,
        currentBranch: current,
        branches,
        defaultBranch,
      };
    } catch (err) {
      return {
        isGitRepo: true,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  async init(path: string): Promise<GitInitResult> {
    try {
      await execAsync('git init', { cwd: path });
      await execAsync('git branch -m main', { cwd: path });
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }
}

export const gitHandler = new GitHandler();
