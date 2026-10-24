import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { formatPrepareSummary, prepareHarness } from './prepare.js';
import { HarnessEnvError } from './env.js';
import { OpencodeCliError } from './opencode-cli.js';
import type { CommandRunner } from './opencode-cli.js';

const TMP_BASE = '/tmp/opencode';

const VALID_ENV: NodeJS.ProcessEnv = {
  ZAG_MODEL_BASE_URL: 'http://admin-api:8002/v1',
  ZAG_MODEL_API_KEY: 'zag_sk_super_secret',
  ZAG_MODEL_IDS: '["model-a","model-a"," model-b ",""]',
  ZAG_DEFAULT_WORKSPACE: '/root/workspace',
};

async function makeDir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  return mkdtemp(join(TMP_BASE, 'prepare-'));
}

describe('prepareHarness (T-AG7..T-AG12)', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('validates env, verifies OpenCode, creates the workspace and writes the config', async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const workspace = join(dir, 'workspace');
    const configDir = join(dir, 'config');
    const runner = vi.fn<CommandRunner>(async () => ({ stdout: '1.2.3\n', stderr: '' }));

    const result = await prepareHarness({
      env: { ...VALID_ENV, ZAG_DEFAULT_WORKSPACE: workspace },
      runner,
      configDir,
      makeDir: async (path: string) => {
        await mkdir(path, { recursive: true });
      },
    });

    expect(runner).toHaveBeenCalledWith('opencode', ['--version']);
    expect(result.opencodeVersion).toBe('1.2.3');
    expect(result.env).toMatchObject({
      modelBaseUrl: 'http://admin-api:8002/v1',
      defaultWorkspace: workspace,
      modelCount: 2,
    });
    expect((await stat(workspace)).isDirectory()).toBe(true);

    const config = parse(await readFile(join(configDir, 'opencode.jsonc'), 'utf-8'));
    expect(Object.keys(config.provider.zag.models)).toEqual(['model-a', 'model-b']);
    expect(config.provider.zag.options.apiKey).toBe('zag_sk_super_secret');
  });

  it('writes limit.context into the config when ZAG_MODEL_CONTEXT_LENGTHS is provided', async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const configDir = join(dir, 'config');

    await prepareHarness({
      env: {
        ...VALID_ENV,
        ZAG_MODEL_CONTEXT_LENGTHS: '{"model-a":128000}',
      },
      runner: async () => ({ stdout: '1.2.3', stderr: '' }),
      configDir,
      makeDir: async () => {},
    });

    const config = parse(await readFile(join(configDir, 'opencode.jsonc'), 'utf-8'));
    expect(config.provider.zag.models).toEqual({
      'model-a': { name: 'model-a', limit: { context: 128000 } },
      'model-b': { name: 'model-b' },
    });
  });

  it('fails on missing env before touching OpenCode or the filesystem', async () => {
    const runner = vi.fn<CommandRunner>(async () => ({ stdout: '1.2.3', stderr: '' }));
    const makeDirSpy = vi.fn(async () => {});

    await expect(
      prepareHarness({
        env: { ...VALID_ENV, ZAG_MODEL_IDS: '' },
        runner,
        makeDir: makeDirSpy,
      }),
    ).rejects.toBeInstanceOf(HarnessEnvError);

    expect(runner).not.toHaveBeenCalled();
    expect(makeDirSpy).not.toHaveBeenCalled();
  });

  it('fails with a version-check error before writing config when OpenCode is unavailable', async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const runner = vi.fn<CommandRunner>(async () => {
      throw new Error('spawn opencode ENOENT');
    });
    const configDir = join(dir, 'config');

    await expect(
      prepareHarness({
        env: VALID_ENV,
        runner,
        configDir,
        makeDir: async (path: string) => {
          await mkdir(path, { recursive: true });
        },
      }),
    ).rejects.toBeInstanceOf(OpencodeCliError);

    await expect(stat(configDir)).rejects.toThrow();
  });

  it('formats a summary without any secret', async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const result = await prepareHarness({
      env: VALID_ENV,
      runner: async () => ({ stdout: '1.2.3', stderr: '' }),
      configDir: join(dir, 'config'),
      makeDir: async () => {},
    });

    const summary = formatPrepareSummary(result);
    expect(summary).toContain('OpenCode harness prepared');
    expect(summary).toContain('version=1.2.3');
    expect(summary).toContain('models=2');
    expect(summary).toContain('workspace=/root/workspace');
    expect(summary).not.toContain('zag_sk_super_secret');
    expect(summary).not.toContain('admin-api');
  });
});
