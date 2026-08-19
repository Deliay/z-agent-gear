import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FsHandler } from '../src/fs-handler.js';

// 真实 fs 集成测试（不 mock）：removeDir 的安全语义只有真实文件系统能覆盖
// （验收报告建议项 #31：isPathSafe/removeDir 零用例）

describe('FsHandler.removeDir（真实 fs）', () => {
  const created: string[] = [];

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'fs-handler-test-'));
    created.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('拒绝删除 .git 为目录的路径（git 主工作区），目录保持完整', async () => {
    const handler = new FsHandler();
    const repoRoot = makeDir();
    mkdirSync(join(repoRoot, '.git'));
    writeFileSync(join(repoRoot, 'index.ts'), 'export {}');
    handler.registerAllowedPath(repoRoot);

    const result = await handler.removeDir(repoRoot);

    expect(result.success).toBe(false);
    expect(result.error).toContain('main working tree');
    expect(existsSync(join(repoRoot, '.git'))).toBe(true);
    expect(existsSync(join(repoRoot, 'index.ts'))).toBe(true);
  });

  it('允许删除 .git 为文件的已注册路径（linked worktree）', async () => {
    const handler = new FsHandler();
    const worktreeDir = makeDir();
    // linked worktree 的 .git 是指向主仓库 gitdir 的普通文件
    writeFileSync(join(worktreeDir, '.git'), 'gitdir: /repo/.git/worktrees/feat-1');
    writeFileSync(join(worktreeDir, 'index.ts'), 'export {}');
    handler.registerAllowedPath(worktreeDir);

    const result = await handler.removeDir(worktreeDir);

    expect(result.success).toBe(true);
    expect(existsSync(worktreeDir)).toBe(false);
  });

  it('拒绝删除未注册的路径', async () => {
    const handler = new FsHandler();
    const dir = makeDir();

    const result = await handler.removeDir(dir);

    expect(result.success).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });
});
