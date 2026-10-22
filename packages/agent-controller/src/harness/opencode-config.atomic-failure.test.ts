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

import { OpencodeConfigError, writeOpencodeConfig } from './opencode-config.js';

const ENV = {
  modelBaseUrl: 'http://admin-api:8002/v1',
  modelApiKey: 'zag_sk_super_secret',
  modelIds: ['model-a'],
};

describe('R2-16 opencode config atomic write failure cleanup', () => {
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

    await expect(
      writeOpencodeConfig({ env: ENV, configDir: '/tmp/opencode-r2-16' }),
    ).rejects.toBeInstanceOf(OpencodeConfigError);

    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\/tmp\/opencode-r2-16\/\.opencode-config\..*\.tmp$/),
      expect.any(String),
      { encoding: 'utf-8', mode: 0o600 },
    );
    expect(fs.rm).toHaveBeenCalledWith(
      expect.stringMatching(/\/tmp\/opencode-r2-16\/\.opencode-config\..*\.tmp$/),
      { force: true },
    );
  });
});
