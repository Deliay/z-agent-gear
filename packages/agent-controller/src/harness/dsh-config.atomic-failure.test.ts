import { describe, it, expect, vi, beforeEach } from 'vitest';

const fs = vi.hoisted(() => ({
  chmod: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => fs);

import { DshConfigError, writeDshConfig } from './dsh-config.js';

const ENV = {
  modelBaseUrl: 'http://admin-api:8002/v1',
  modelApiKey: 'zag_sk_super_secret',
  modelIds: ['model-a'],
};

describe('T-DSH7 dsh config atomic write failure cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.mkdir.mockResolvedValue(undefined);
    fs.chmod.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
    fs.rm.mockResolvedValue(undefined);
    // 目标文件不存在 → 走新建分支
    fs.stat.mockRejectedValue(new Error('ENOENT'));
  });

  it('removes the temp file when rename fails and preserves the original error surface', async () => {
    fs.rename.mockRejectedValue(new Error('rename failed'));

    await expect(writeDshConfig({ env: ENV, dshHome: '/tmp/opencode-dsh-atomic' })).rejects.toBeInstanceOf(
      DshConfigError,
    );

    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\/tmp\/opencode-dsh-atomic\/profiles\/acp\/\.cordis\.patch\..*\.tmp$/),
      expect.any(String),
      { encoding: 'utf-8', mode: 0o600 },
    );
    expect(fs.rm).toHaveBeenCalledWith(
      expect.stringMatching(/\/tmp\/opencode-dsh-atomic\/profiles\/acp\/\.cordis\.patch\..*\.tmp$/),
      { force: true },
    );
  });

  it('T-MASQ9: insert 条目与扁平条目在同一次原子写中落盘', async () => {
    fs.rename.mockResolvedValue(undefined);

    await writeDshConfig({ env: ENV, dshHome: '/tmp/opencode-dsh-atomic' });

    const patchWrite = fs.writeFile.mock.calls.find(
      ([path]) => typeof path === 'string' && /\.cordis\.patch\..*\.tmp$/.test(path),
    );
    expect(patchWrite).toBeDefined();
    const content = String(patchWrite![1]);
    expect(content).toContain('- insert:');
    expect(content).toContain('id: header-masq');
    expect(content).toContain('name: dsh-header-masq');
    expect(content).toContain('x-opencode-session');
    expect(content).not.toContain('hosts:');
  });
});
