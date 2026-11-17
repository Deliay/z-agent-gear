import { describe, it, expect, afterEach, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import {
  MODEL_PROVIDERS_STATE_FILENAME,
  OpencodeConfigError,
  ZAG_PROVIDER_PACKAGE,
  buildProviders,
  defaultModelProvidersStatePath,
  readModelProvidersState,
  resolveOpencodeConfigPath,
  writeModelProvidersState,
  writeOpencodeConfig,
} from './opencode-config.js';
import { normalizeProvision, resolveProvision, type ModelProvision } from './model-providers.js';

const TMP_BASE = '/tmp/opencode';

const ENV = {
  modelBaseUrl: 'http://admin-api:8002/v1',
  modelApiKey: 'zag_sk_super_secret',
  modelIds: ['model-a', 'model-b'],
};

const MULTI_PROVISION: ModelProvision = {
  providers: [
    {
      vendorId: 'zag',
      displayName: 'Agent Gear',
      models: [{ id: 'model-a', contextLength: 128000 }, { id: 'model-b' }],
    },
    {
      vendorId: '65f0a1b2c3d4e5f60718293a',
      displayName: '我的 OpenAI',
      models: [{ id: 'gpt-5.1' }],
    },
  ],
};

async function makeDir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  return mkdtemp(join(TMP_BASE, 'opencode-config-'));
}

async function fileMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe('buildProviders (T-AG9/T-AG11/T-AG-MP2)', () => {
  it('builds a single zag provider from the legacy env projection', () => {
    const provision = resolveProvision(ENV);
    expect(buildProviders(provision, ENV)).toEqual({
      zag: {
        package: '@opencode/ai/providers/openai-compatible',
        name: 'Agent Gear',
        settings: {
          baseURL: 'http://admin-api:8002/v1',
          apiKey: 'zag_sk_super_secret',
        },
        models: {
          'model-a': { name: 'model-a' },
          'model-b': { name: 'model-b' },
        },
      },
    });
    expect(ZAG_PROVIDER_PACKAGE).toBe('@opencode/ai/providers/openai-compatible');
  });

  it('writes models:{} for an empty model list', () => {
    expect(buildProviders(resolveProvision({ ...ENV, modelIds: [] }), ENV).zag.models).toEqual({});
  });

  it('writes limit.context for models with a context length and omits it otherwise', () => {
    const providers = buildProviders(
      resolveProvision({
        ...ENV,
        modelIds: ['model-a', 'model-b', 'model-c'],
        modelContextLengths: { 'model-a': 128000, 'model-c': 0 },
      }),
      ENV,
    );
    expect(providers.zag.models).toEqual({
      'model-a': { name: 'model-a', limit: { context: 128000 } },
      'model-b': { name: 'model-b' },
      'model-c': { name: 'model-c' },
    });
  });

  it('T-AG-MP2: builds every vendor with name = displayName and keeps zag first', () => {
    const providers = buildProviders(MULTI_PROVISION, ENV);
    expect(Object.keys(providers)).toEqual(['zag', '65f0a1b2c3d4e5f60718293a']);
    expect(providers.zag.name).toBe('Agent Gear');
    expect(providers['65f0a1b2c3d4e5f60718293a']).toMatchObject({
      package: ZAG_PROVIDER_PACKAGE,
      name: '我的 OpenAI',
      settings: { baseURL: 'http://admin-api:8002/v1', apiKey: 'zag_sk_super_secret' },
      models: { 'gpt-5.1': { name: 'gpt-5.1' } },
    });
  });

  it('T-AG-MP2: always writes zag even when the payload omits it', () => {
    const providers = buildProviders(
      { providers: [{ vendorId: 'p1', displayName: 'P1', models: [{ id: 'x' }] }] },
      ENV,
    );
    expect(Object.keys(providers)).toEqual(['zag', 'p1']);
    expect(providers.zag.models).toEqual({});
  });
});

describe('writeOpencodeConfig (T-AG9..T-AG12 / T-AG-MP2)', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeCase(): Promise<{ dir: string; statePath: string }> {
    const dir = await makeDir();
    const stateDir = await makeDir();
    dirs.push(dir, stateDir);
    return { dir, statePath: join(stateDir, MODEL_PROVIDERS_STATE_FILENAME) };
  }

  it('T-AG9: creates opencode.jsonc with providers.zag and 0600 permissions', async () => {
    const { dir, statePath } = await makeCase();

    const result = await writeOpencodeConfig({ env: ENV, configDir: dir, statePath });

    expect(result.path).toBe(join(dir, 'opencode.jsonc'));
    expect(result.created).toBe(true);
    expect(result.modelCount).toBe(2);
    expect(result.vendors).toEqual(['zag']);
    expect(await fileMode(result.path)).toBe(0o600);

    const config = parse(await readFile(result.path, 'utf-8'));
    expect(config.providers.zag.settings.baseURL).toBe('http://admin-api:8002/v1');
    expect(config.providers.zag.settings.apiKey).toBe('zag_sk_super_secret');
    expect(config.providers.zag.name).toBe('Agent Gear');
    expect(config.providers.zag.models).toEqual({
      'model-a': { name: 'model-a' },
      'model-b': { name: 'model-b' },
    });
  });

  it('T-AG10: merges an existing config, preserving comments and other providers and replacing providers.zag', async () => {
    const { dir, statePath } = await makeCase();
    const target = join(dir, 'opencode.jsonc');
    await writeFile(
      target,
      `{
  // keep this comment
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    // existing provider must survive
    "other": {
      "package": "@example/other",
      "name": "Other",
      "settings": { "baseURL": "http://other" },
      "models": { "x": { "name": "x" } }
    },
    "zag": {
      "package": "old-package",
      "name": "Old ZAG",
      "settings": { "baseURL": "http://old", "apiKey": "old-key" },
      "models": {}
    }
  }
}
`,
      'utf-8',
    );

    await writeOpencodeConfig({ env: ENV, configDir: dir, statePath });

    const text = await readFile(target, 'utf-8');
    expect(text).toContain('// keep this comment');
    expect(text).toContain('// existing provider must survive');

    const config = parse(text);
    expect(config.$schema).toBe('https://opencode.ai/config.json');
    expect(config.providers.other).toMatchObject({ package: '@example/other', name: 'Other' });
    expect(config.providers.zag).toMatchObject({
      package: ZAG_PROVIDER_PACKAGE,
      name: 'Agent Gear',
      settings: { baseURL: 'http://admin-api:8002/v1', apiKey: 'zag_sk_super_secret' },
    });
    // 旧 apiKey/baseURL 已被替换
    expect(text).not.toContain('old-key');
    expect(text).not.toContain('http://old');
  });

  it('T-AG11: writes models:{} when ZAG_MODEL_IDS is an empty array', async () => {
    const { dir, statePath } = await makeCase();

    await writeOpencodeConfig({ env: { ...ENV, modelIds: [] }, configDir: dir, statePath });

    const config = parse(await readFile(join(dir, 'opencode.jsonc'), 'utf-8'));
    expect(config.providers.zag.models).toEqual({});
  });

  it('T-AG12: merges an existing opencode.json instead of creating a new .jsonc', async () => {
    const { dir, statePath } = await makeCase();
    const jsonPath = join(dir, 'opencode.json');
    await writeFile(jsonPath, '{\n  "theme": "dark"\n}\n', 'utf-8');

    const result = await writeOpencodeConfig({ env: ENV, configDir: dir, statePath });

    expect(result.path).toBe(jsonPath);
    expect(result.created).toBe(false);
    expect(await fileMode(jsonPath)).toBe(0o600);

    const config = parse(await readFile(jsonPath, 'utf-8'));
    expect(config.theme).toBe('dark');
    expect(config.providers.zag.name).toBe('Agent Gear');

    // 不创建并存的 .jsonc
    await expect(stat(join(dir, 'opencode.jsonc'))).rejects.toThrow();
  });

  it('T-AG-MP2: writes every vendor and records them in the state file (0600)', async () => {
    const { dir, statePath } = await makeCase();

    const result = await writeOpencodeConfig({
      env: ENV,
      provision: MULTI_PROVISION,
      configDir: dir,
      statePath,
    });

    expect(result.vendors).toEqual(['zag', '65f0a1b2c3d4e5f60718293a']);
    expect(result.modelCount).toBe(3);
    const config = parse(await readFile(join(dir, 'opencode.jsonc'), 'utf-8'));
    expect(config.providers.zag.name).toBe('Agent Gear');
    expect(config.providers['65f0a1b2c3d4e5f60718293a']).toMatchObject({
      name: '我的 OpenAI',
      models: { 'gpt-5.1': { name: 'gpt-5.1' } },
    });
    expect(JSON.parse(await readFile(statePath, 'utf-8'))).toEqual({
      version: 1,
      vendors: ['zag', '65f0a1b2c3d4e5f60718293a'],
    });
    expect(await fileMode(statePath)).toBe(0o600);
  });

  it('T-AG-MP2: deletes vendors that disappeared since the last write', async () => {
    const { dir, statePath } = await makeCase();
    await writeOpencodeConfig({
      env: ENV,
      provision: MULTI_PROVISION,
      configDir: dir,
      statePath,
    });

    const next: ModelProvision = {
      providers: [
        { vendorId: 'zag', displayName: 'Agent Gear', models: [{ id: 'model-a' }] },
        { vendorId: 'p2', displayName: 'P2', models: [{ id: 'm2' }] },
      ],
    };
    await writeOpencodeConfig({ env: ENV, provision: next, configDir: dir, statePath });

    const config = parse(await readFile(join(dir, 'opencode.jsonc'), 'utf-8'));
    expect(Object.keys(config.providers).sort()).toEqual(['p2', 'zag']);
    expect(await readModelProvidersState(statePath)).toEqual(['zag', 'p2']);
  });

  it('T-AG-MP2: keeps hand-written providers (package differs) and comments', async () => {
    const { dir, statePath } = await makeCase();
    const target = join(dir, 'opencode.jsonc');
    await writeFile(
      target,
      `{
  "providers": {
    // user owned
    "65f0a1b2c3d4e5f60718293a": {
      "package": "@user/custom",
      "name": "Hand written"
    }
  }
}
`,
      'utf-8',
    );
    // 上次写过该 vendor，但用户后来手写覆盖（package 不同）→ 不删除
    await writeModelProvidersState(statePath, ['zag', '65f0a1b2c3d4e5f60718293a']);

    await writeOpencodeConfig({ env: ENV, configDir: dir, statePath });

    const text = await readFile(target, 'utf-8');
    expect(text).toContain('// user owned');
    const config = parse(text);
    expect(config.providers['65f0a1b2c3d4e5f60718293a']).toMatchObject({
      package: '@user/custom',
      name: 'Hand written',
    });
  });

  it('T-AG-MP2: treats a missing/corrupt state file as an empty set (no deletions)', async () => {
    const { dir, statePath } = await makeCase();
    const target = join(dir, 'opencode.jsonc');
    await writeFile(
      target,
      `{
  "providers": {
    "stale": { "package": "@opencode/ai/providers/openai-compatible", "name": "Stale", "models": {} }
  }
}
`,
      'utf-8',
    );

    expect(await readModelProvidersState(statePath)).toEqual([]);

    await writeOpencodeConfig({ env: ENV, configDir: dir, statePath });

    const config = parse(await readFile(target, 'utf-8'));
    // 无状态文件 → 不误删既有 provider
    expect(config.providers.stale).toBeDefined();
    expect(config.providers.zag.name).toBe('Agent Gear');
  });

  it('T-AG-MP2: a state write failure only warns; the config write still succeeds', async () => {
    const { dir } = await makeCase();
    // 状态文件父路径是常规文件 → 无法创建目录/写文件
    const blocker = join(dir, 'blocked');
    await writeFile(blocker, 'not a directory', 'utf-8');
    const statePath = join(blocker, 'state.json');
    const onStateWriteError = vi.fn();

    const result = await writeOpencodeConfig({
      env: ENV,
      configDir: dir,
      statePath,
      onStateWriteError,
    });

    expect(result.created).toBe(true);
    expect(onStateWriteError).toHaveBeenCalledTimes(1);
    const config = parse(await readFile(result.path, 'utf-8'));
    expect(config.providers.zag.name).toBe('Agent Gear');
  });

  it('T-AG9b: tightens permissions of an existing config to 0600', async () => {
    const { dir, statePath } = await makeCase();
    const target = join(dir, 'opencode.jsonc');
    await writeFile(target, '{}\n', 'utf-8');
    await chmod(target, 0o644);

    await writeOpencodeConfig({ env: ENV, configDir: dir, statePath });

    expect(await fileMode(target)).toBe(0o600);
  });

  it('C-7: tightens an existing config directory to 0700', async () => {
    const { dir, statePath } = await makeCase();
    await chmod(dir, 0o755);

    await writeOpencodeConfig({ env: ENV, configDir: dir, statePath });

    expect(await fileMode(dir)).toBe(0o700);
  });

  it('C-7: writes atomically via a temp file and leaves no partial/temp files', async () => {
    const { dir, statePath } = await makeCase();
    const target = join(dir, 'opencode.jsonc');
    await writeFile(target, '{\n  "theme": "dark"\n}\n', 'utf-8');

    await writeOpencodeConfig({ env: ENV, configDir: dir, statePath });

    // 同目录只应有目标文件（临时文件已 rename 掉；状态文件在独立目录）
    expect(await readdir(dir)).toEqual(['opencode.jsonc']);
    expect(await fileMode(target)).toBe(0o600);
    const config = parse(await readFile(target, 'utf-8'));
    expect(config.theme).toBe('dark');
    expect(config.providers.zag.name).toBe('Agent Gear');
  });

  it('C-7: keeps the original file intact when the write path fails', async () => {
    const { dir, statePath } = await makeCase();
    const target = join(dir, 'opencode.jsonc');
    const original = '{\n  "theme": "dark"\n}\n';
    await writeFile(target, original, 'utf-8');
    // 目标文件不可读（解析阶段失败）：不得产生临时文件，原文件保持原样。
    await chmod(target, 0o200);

    await expect(
      writeOpencodeConfig({ env: ENV, configDir: dir, statePath }),
    ).rejects.toBeInstanceOf(OpencodeConfigError);

    expect(await readdir(dir)).toEqual(['opencode.jsonc']);
    await chmod(target, 0o600);
    expect(await readFile(target, 'utf-8')).toBe(original);
  });

  it('rejects invalid JSONC and leaves the file untouched', async () => {
    const { dir, statePath } = await makeCase();
    const target = join(dir, 'opencode.jsonc');
    const original = '{ "provider": ';
    await writeFile(target, original, 'utf-8');

    await expect(
      writeOpencodeConfig({ env: ENV, configDir: dir, statePath }),
    ).rejects.toBeInstanceOf(OpencodeConfigError);
    expect(await readFile(target, 'utf-8')).toBe(original);
  });

  it('T-AG12b: resolves the target file by precedence', async () => {
    const dir = await makeDir();
    dirs.push(dir);

    expect(await resolveOpencodeConfigPath(dir)).toBe(join(dir, 'opencode.jsonc'));

    await writeFile(join(dir, 'opencode.json'), '{}\n', 'utf-8');
    expect(await resolveOpencodeConfigPath(dir)).toBe(join(dir, 'opencode.json'));

    await writeFile(join(dir, 'opencode.jsonc'), '{}\n', 'utf-8');
    expect(await resolveOpencodeConfigPath(dir)).toBe(join(dir, 'opencode.jsonc'));
  });

  it('T-AG-MP2: default state path lives under ~/.zag', () => {
    expect(defaultModelProvidersStatePath()).toMatch(/\/\.zag\/model-providers-state\.json$/);
    expect(normalizeProvision(MULTI_PROVISION).providers[0].vendorId).toBe('zag');
  });
});
