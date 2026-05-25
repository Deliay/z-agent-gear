import { mkdirSync } from 'fs';
import { join } from 'path';

export interface FsMkdirResult {
  success: boolean;
  name?: string;
  path?: string;
  error?: string;
}

export class FsHandler {
  async mkdir(parentPath: string, folderName: string): Promise<FsMkdirResult> {
    try {
      const fullPath = join(parentPath, folderName);
      mkdirSync(fullPath, { recursive: true });
      return { success: true, name: folderName, path: fullPath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
}

export const fsHandler = new FsHandler();