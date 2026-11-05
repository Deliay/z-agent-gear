import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FsHandler } from './fs-handler.js';

// T-RF1~7：fs:read-file 读取语义（白名单 / 二进制 / 截断 / maxBytes 钳制）。
// 使用真实临时目录（symlink 逃逸与 NUL 检测无法用 mock fs 可信覆盖）。
describe('FsHandler.readFile', () => {
  let root: string;
  let outside: string;
  let handler: FsHandler;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fs-read-root-'));
    outside = mkdtempSync(join(tmpdir(), 'fs-read-outside-'));
    handler = new FsHandler();
    handler.registerAllowedPath(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('T-RF1 白名单内文本文件：内容一致、truncated:false、sizeBytes 正确', async () => {
    const file = join(root, 'a.txt');
    writeFileSync(file, 'hello world');

    const result = await handler.readFile(file);

    expect(result.success).toBe(true);
    expect(result.content).toBe('hello world');
    expect(result.truncated).toBe(false);
    expect(result.sizeBytes).toBe(11);
  });

  it('T-RF2 越界路径（.. 逃逸 / 白名单外绝对路径）按 not found 拒绝，不读盘', async () => {
    const target = join(outside, 'secret.txt');
    writeFileSync(target, 'secret');

    const escapeResult = await handler.readFile(join(root, '..', 'fs-read-outside-secret', 'secret.txt'));
    expect(escapeResult.success).toBe(false);
    expect(escapeResult.error).toBe('not found');

    const outsideResult = await handler.readFile(target);
    expect(outsideResult.success).toBe(false);
    expect(outsideResult.error).toBe('not found');
    expect(outsideResult.content).toBeUndefined();
  });

  it('T-RF3 符号链接逃逸：realpath 后前缀校验拒绝', async () => {
    const target = join(outside, 'linked.txt');
    writeFileSync(target, 'linked');
    const link = join(root, 'link.txt');
    symlinkSync(target, link);

    const result = await handler.readFile(link);

    expect(result.success).toBe(false);
    expect(result.error).toBe('not found');
  });

  it('T-RF4 二进制（前 8KiB 含 NUL）返回 binary file', async () => {
    const file = join(root, 'bin.dat');
    const buf = Buffer.alloc(16);
    buf[8] = 0;
    writeFileSync(file, buf);

    const result = await handler.readFile(file);

    expect(result.success).toBe(false);
    expect(result.error).toBe('binary file');
  });

  it('T-RF5 超 maxBytes 截断返回 truncated:true，sizeBytes 为原始大小', async () => {
    const file = join(root, 'big.txt');
    writeFileSync(file, 'x'.repeat(100));

    const result = await handler.readFile(file, 10);

    expect(result.success).toBe(true);
    expect(result.content).toBe('x'.repeat(10));
    expect(result.truncated).toBe(true);
    expect(result.sizeBytes).toBe(100);
  });

  it('T-RF6 maxBytes 钳制：传 10MiB 按 2MiB 硬上限生效', async () => {
    const file = join(root, 'huge.txt');
    writeFileSync(file, 'y'.repeat(2 * 1024 * 1024 + 1024));

    const result = await handler.readFile(file, 10 * 1024 * 1024);

    expect(result.success).toBe(true);
    expect(result.content?.length).toBe(2 * 1024 * 1024);
    expect(result.truncated).toBe(true);
    expect(result.sizeBytes).toBe(2 * 1024 * 1024 + 1024);
  });

  it('T-RF7 不存在返回 not found；无权限返回 permission denied', async () => {
    const missing = await handler.readFile(join(root, 'nope.txt'));
    expect(missing.success).toBe(false);
    expect(missing.error).toBe('not found');

    const file = join(root, 'locked.txt');
    writeFileSync(file, 'locked');
    chmodSync(file, 0o000);
    try {
      const denied = await handler.readFile(file);
      // root 用户不受权限位限制；仅在真实受限环境断言 permission denied
      if (denied.success) {
        expect(denied.content).toBe('locked');
      } else {
        expect(denied.error).toBe('permission denied');
      }
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it('目录按 not found 拒绝', async () => {
    mkdirSync(join(root, 'dir'));
    const result = await handler.readFile(join(root, 'dir'));
    expect(result.success).toBe(false);
    expect(result.error).toBe('not found');
  });
});
