import { mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

const BLOCKED_PATHS = ['/etc', '/usr', '/bin', '/sbin', '/var', '/proc', '/sys', homedir()];

function isPathSafe(targetPath: string): boolean {
  const resolved = resolve(targetPath);
  return !BLOCKED_PATHS.some(blocked => resolved === blocked || resolved.startsWith(blocked + '/'));
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
  async mkdir(parentPath: string, folderName: string): Promise<FsMkdirResult> {
    try {
      const fullPath = join(parentPath, folderName);
      if (!isPathSafe(fullPath)) {
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
      if (!isPathSafe(path)) {
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