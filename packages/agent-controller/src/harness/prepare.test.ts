import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { formatPrepareSummary, prepareHarness } from './prepare.js';
import { HarnessEnvError } from './env.js';
import { DshCliError } from './dsh-cli.js';
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
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ type: 'opencode', version: '1.2.3', modelCount: 2 });
    expect(result.env).toMatchObject({
      modelBaseUrl: 'http://admin-api:8002/v1',
      defaultWorkspace: workspace,
      modelCount: 2,
      types: ['opencode'],
    });
    expect((await stat(workspace)).isDirectory()).toBe(true);

    const config = parse(await readFile(join(configDir, 'opencode.jsonc'), 'utf-8'));
    expect(Object.keys(config.providers.zag.models)).toEqual(['model-a', 'model-b']);
    expect(config.providers.zag.settings.apiKey).toBe('zag_sk_super_secret');
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
    expect(config.providers.zag.models).toEqual({
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
    expect(summary).toContain('Harness prepared: types=opencode');
    expect(summary).toContain('- opencode: version=1.2.3');
    expect(summary).toContain('models=2');
    expect(summary).toContain('workspace=/root/workspace');
    expect(summary).not.toContain('zag_sk_super_secret');
    expect(summary).not.toContain('admin-api');
  });

  it('T-PREP1: ZAG_HARNESS_TYPES=deepseek_harness 只跑 dsh 校验与写入，不触碰 opencode', async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const configDir = join(dir, 'opencode-config');
    const dshHome = join(dir, 'dsh-home');
    const runner = vi.fn<CommandRunner>(async () => ({ stdout: '0.1.2-alpha.2\n', stderr: '' }));

    const result = await prepareHarness({
      env: { ...VALID_ENV, ZAG_HARNESS_TYPES: 'deepseek_harness' },
      runner,
      configDir,
      dshHome,
      makeDir: async (path: string) => {
        await mkdir(path, { recursive: true });
      },
    });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith('dsh', ['--version']);
    expect(result.env.types).toEqual(['deepseek_harness']);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      type: 'deepseek_harness',
      version: '0.1.2-alpha.2',
      modelCount: 2,
    });
    await expect(stat(configDir)).rejects.toThrow();
    expect((await stat(join(dshHome, 'profiles', 'acp', 'cordis.patch.yml'))).isFile()).toBe(true);
    expect((await stat(join(dshHome, '.credentials.yaml'))).isFile()).toBe(true);
  });

  it('T-PREP2: 未设置/空串/全部非法 → 回退 opencode；kimi_code 被过滤', async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const runner = vi.fn<CommandRunner>(async () => ({ stdout: '1.2.3', stderr: '' }));

    for (const ZAG_HARNESS_TYPES of [undefined, '', 'kimi_code', 'kimi_code,bogus']) {
      const result = await prepareHarness({
        env: { ...VALID_ENV, ZAG_HARNESS_TYPES } as NodeJS.ProcessEnv,
        runner,
        configDir: join(dir, `config-${String(ZAG_HARNESS_TYPES)}`),
        makeDir: async () => {},
      });
      expect(result.env.types).toEqual(['opencode']);
    }
    expect(runner).toHaveBeenCalledWith('opencode', ['--version']);
  });

  it('T-PREP3: opencode,deepseek_harness 两类各执行一次，顺序稳定、摘要两行', async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const runner = vi.fn<CommandRunner>(async (command: string) =>
      command === 'dsh'
        ? { stdout: '0.1.2-alpha.2\n', stderr: '' }
        : { stdout: '1.2.3\n', stderr: '' },
    );

    const result = await prepareHarness({
      env: {
        ...VALID_ENV,
        ZAG_HARNESS_TYPES: 'opencode, deepseek_harness,kimi_code,opencode',
      },
      runner,
      configDir: join(dir, 'config'),
      dshHome: join(dir, 'dsh-home'),
      makeDir: async () => {},
    });

    expect(result.env.types).toEqual(['opencode', 'deepseek_harness']);
    expect(result.items.map((item) => item.type)).toEqual(['opencode', 'deepseek_harness']);
    expect(runner).toHaveBeenNthCalledWith(1, 'opencode', ['--version']);
    expect(runner).toHaveBeenNthCalledWith(2, 'dsh', ['--version']);

    const summary = formatPrepareSummary(result);
    expect(summary.split('\n')).toHaveLength(3);
    expect(summary).toContain('- opencode: version=1.2.3');
    expect(summary).toContain('- deepseek_harness: version=0.1.2-alpha.2');
  });

  it('T-PREP4: 重复执行 deepseek_harness 幂等（文件内容一致）', async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const dshHome = join(dir, 'dsh-home');
    const options = {
      env: { ...VALID_ENV, ZAG_HARNESS_TYPES: 'deepseek_harness' },
      runner: async () => ({ stdout: '0.1.2-alpha.2\n', stderr: '' }),
      dshHome,
      makeDir: async () => {},
    };

    await prepareHarness(options);
    const firstPatch = await readFile(join(dshHome, 'profiles', 'acp', 'cordis.patch.yml'), 'utf-8');
    await prepareHarness(options);
    const secondPatch = await readFile(join(dshHome, 'profiles', 'acp', 'cordis.patch.yml'), 'utf-8');

    expect(secondPatch).toBe(firstPatch);
  });

  it('T-PREP5: dsh 校验失败 → 整体抛错且不写配置（opencode 未执行）', async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const dshHome = join(dir, 'dsh-home');
    const runner = vi.fn<CommandRunner>(async () => {
      throw new Error('spawn dsh ENOENT');
    });

    await expect(
      prepareHarness({
        env: { ...VALID_ENV, ZAG_HARNESS_TYPES: 'deepseek_harness' },
        runner,
        dshHome,
        makeDir: async () => {},
      }),
    ).rejects.toBeInstanceOf(DshCliError);

    expect(runner).toHaveBeenCalledTimes(1);
    await expect(stat(join(dshHome, 'profiles'))).rejects.toThrow();
  });
});
