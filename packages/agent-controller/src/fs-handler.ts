import { mkdirSync, rmSync } from 'fs';
import { join, parse, resolve, sep } from 'path';
import { homedir } from 'os';

// Security model for destructive operations (removeDir): whitelist.
// Only paths the controller itself manages may be deleted — worktree/session
// directories registered via registerAllowedPath (acp:start/acp:resume cwd,
// git:worktree:add worktreePath, fs:mkdir results, ProcessRegistry entries).
// Explicit denies (filesystem root, home dir, cwd and their ancestors,
// Windows system paths) act as defense-in-depth on top of the whitelist.
//
// mkdir is non-destructive and stays on the legacy blacklist: worktree
// creation needs to mkdir parents that are not registered yet.
const BLOCKED_PATHS = ['/etc', '/usr', '/bin', '/sbin', '/var', '/proc', '/sys'];

const WINDOWS_DENIED_PATTERNS = [
  /^[a-zA-Z]:[\\/]*$/, // drive root, e.g. C:\
  /^[a-zA-Z]:[\\/]+windows[\\/]*$/i, // C:\Windows
  /^[a-zA-Z]:[\\/]+users[\\/]*$/i, // C:\Users root
];

function isSameOrAncestor(candidate: string, target: string): boolean {
  return target === candidate || target.startsWith(candidate + sep);
}

function isExplicitlyDenied(rawPath: string, resolved: string): boolean {
  if (WINDOWS_DENIED_PATTERNS.some((re) => re.test(rawPath.trim()))) return true;
  if (resolved === parse(resolved).root) return true;
  return isSameOrAncestor(resolved, homedir()) || isSameOrAncestor(resolved, process.cwd());
}

function isBlacklisted(targetPath: string): boolean {
  const resolved = resolve(targetPath);
  return BLOCKED_PATHS.some((blocked) => resolved === blocked || resolved.startsWith(blocked + '/'));
}

export interface FsMkdirResult {
  success: boolean;
  name?: string;
  path?: string;
  error?: string;
}

export interface FsRemoveDirResult {
  success: boolean;
  error?: string;
}

export class FsHandler {
  private allowedRoots = new Set<string>();

  /** Register a controller-managed directory; it and its subpaths become removable. */
  registerAllowedPath(path: string): void {
    const resolved = resolve(path);
    if (isExplicitlyDenied(path, resolved)) return;
    this.allowedRoots.add(resolved);
  }

  /** Drop a previously registered directory (e.g. after it was removed). */
  unregisterAllowedPath(path: string): void {
    this.allowedRoots.delete(resolve(path));
  }

  private isPathSafe(targetPath: string): boolean {
    const resolved = resolve(targetPath);
    if (isExplicitlyDenied(targetPath, resolved)) return false;
    for (const root of this.allowedRoots) {
      if (resolved === root || resolved.startsWith(root + sep)) return true;
    }
    return false;
  }

  async mkdir(parentPath: string, folderName: string): Promise<FsMkdirResult> {
    try {
      const fullPath = join(parentPath, folderName);
      if (isBlacklisted(fullPath)) {
        return { success: false, error: `Path not allowed: ${fullPath}` };
      }
      mkdirSync(fullPath, { recursive: true });
      return { success: true, name: folderName, path: fullPath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async removeDir(path: string): Promise<FsRemoveDirResult> {
    try {
      if (!this.isPathSafe(path)) {
        return { success: false, error: `Path not allowed: ${path}` };
      }
      rmSync(path, { recursive: true, force: true });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
}

export const fsHandler = new FsHandler();
