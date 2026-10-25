import { describe, it, expect, afterEach } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import {
  OpencodeConfigError,
  ZAG_PROVIDER_PACKAGE,
  buildZagProvider,
  resolveOpencodeConfigPath,
  writeOpencodeConfig,
} from './opencode-config.js';

const TMP_BASE = '/tmp/opencode';

const ENV = {
  modelBaseUrl: 'http://admin-api:8002/v1',
  modelApiKey: 'zag_sk_super_secret',
  modelIds: ['model-a', 'model-b'],
};

async function makeDir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  return mkdtemp(join(TMP_BASE, 'opencode-config-'));
}

async function fileMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe('buildZagProvider (T-AG9/T-AG11)', () => {
  it('builds an OpenAI-compatible provider with baseURL/apiKey/models', () => {
    expect(buildZagProvider(ENV)).toEqual({
      package: '@opencode/ai/providers/openai-compatible',
      name: 'ZAG',
      settings: {
        baseURL: 'http://admin-api:8002/v1',
        apiKey: 'zag_sk_super_secret',
      },
      models: {
        'model-a': { name: 'model-a' },
        'model-b': { name: 'model-b' },
      },
    });
    expect(ZAG_PROVIDER_PACKAGE).toBe('@opencode/ai/providers/openai-compatible');
  });

  it('writes models:{} for an empty model list', () => {
    expect(buildZagProvider({ ...ENV, modelIds: [] }).models).toEqual({});
  });

  it('writes limit.context for models with a context length and omits it otherwise', () => {
    const provider = buildZagProvider({
      ...ENV,
      modelIds: ['model-a', 'model-b', 'model-c'],
      modelContextLengths: { 'model-a': 128000, 'model-c': 0 },
    });
    expect(provider.models).toEqual({
      'model-a': { name: 'model-a', limit: { context: 128000 } },
      'model-b': { name: 'model-b' },
      'model-c': { name: 'model-c' },
    });
  });
});

describe('writeOpencodeConfig (T-AG9..T-AG12)', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('T-AG9: creates opencode.jsonc with providers.zag and 0600 permissions', async () => {
    const dir = await makeDir();
    dirs.push(dir);

    const result = await writeOpencodeConfig({ env: ENV, configDir: dir });

    expect(result.path).toBe(join(dir, 'opencode.jsonc'));
    expect(result.created).toBe(true);
    expect(result.modelCount).toBe(2);
    expect(await fileMode(result.path)).toBe(0o600);

    const config = parse(await readFile(result.path, 'utf-8'));
    expect(config.providers.zag.settings.baseURL).toBe('http://admin-api:8002/v1');
    expect(config.providers.zag.settings.apiKey).toBe('zag_sk_super_secret');
    expect(config.providers.zag.models).toEqual({
      'model-a': { name: 'model-a' },
      'model-b': { name: 'model-b' },
    });
  });

  it('T-AG10: merges an existing config, preserving comments and other providers and replacing providers.zag', async () => {
    const dir = await makeDir();
    dirs.push(dir);
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

    await writeOpencodeConfig({ env: ENV, configDir: dir });

    const text = await readFile(target, 'utf-8');
    expect(text).toContain('// keep this comment');
    expect(text).toContain('// existing provider must survive');

    const config = parse(text);
    expect(config.$schema).toBe('https://opencode.ai/config.json');
    expect(config.providers.other).toMatchObject({ package: '@example/other', name: 'Other' });
    expect(config.providers.zag).toMatchObject({
      package: ZAG_PROVIDER_PACKAGE,
      name: 'ZAG',
      settings: { baseURL: 'http://admin-api:8002/v1', apiKey: 'zag_sk_super_secret' },
    });
    // 旧 apiKey/baseURL 已被替换
    expect(text).not.toContain('old-key');
    expect(text).not.toContain('http://old');
  });

  it('T-AG11: writes models:{} when ZAG_MODEL_IDS is an empty array', async () => {
    const dir = await makeDir();
    dirs.push(dir);

    await writeOpencodeConfig({ env: { ...ENV, modelIds: [] }, configDir: dir });

    const config = parse(await readFile(join(dir, 'opencode.jsonc'), 'utf-8'));
    expect(config.providers.zag.models).toEqual({});
  });

  it('T-AG12: merges an existing opencode.json instead of creating a new .jsonc', async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const jsonPath = join(dir, 'opencode.json');
    await writeFile(jsonPath, '{\n  "theme": "dark"\n}\n', 'utf-8');

    const result = await writeOpencodeConfig({ env: ENV, configDir: dir });

    expect(result.path).toBe(jsonPath);
    expect(result.created).toBe(false);
    expect(await fileMode(jsonPath)).toBe(0o600);

    const config = parse(await readFile(jsonPath, 'utf-8'));
    expect(config.theme).toBe('dark');
    expect(config.providers.zag.name).toBe('ZAG');

    // 不创建并存的 .jsonc
    await expect(stat(join(dir, 'opencode.jsonc'))).rejects.toThrow();
  });

  it('T-AG9b: tightens permissions of an existing config to 0600', async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const target = join(dir, 'opencode.jsonc');
    await writeFile(target, '{}\n', 'utf-8');
    await chmod(target, 0o644);

    await writeOpencodeConfig({ env: ENV, configDir: dir });

    expect(await fileMode(target)).toBe(0o600);
  });

  it('C-7: tightens an existing config directory to 0700', async () => {
    const dir = await makeDir();
    dirs.push(dir);
    await chmod(dir, 0o755);

    await writeOpencodeConfig({ env: ENV, configDir: dir });

    expect(await fileMode(dir)).toBe(0o700);
  });

  it('C-7: writes atomically via a temp file and leaves no partial/temp files', async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const target = join(dir, 'opencode.jsonc');
    await writeFile(target, '{\n  "theme": "dark"\n}\n', 'utf-8');

    await writeOpencodeConfig({ env: ENV, configDir: dir });

    // 同目录只应有目标文件（临时文件已 rename 掉）
    expect(await readdir(dir)).toEqual(['opencode.jsonc']);
    expect(await fileMode(target)).toBe(0o600);
    const config = parse(await readFile(target, 'utf-8'));
    expect(config.theme).toBe('dark');
    expect(config.providers.zag.name).toBe('ZAG');
  });

  it('C-7: keeps the original file intact when the write path fails', async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const target = join(dir, 'opencode.jsonc');
    const original = '{\n  "theme": "dark"\n}\n';
    await writeFile(target, original, 'utf-8');
    // 目标文件不可读（解析阶段失败）：不得产生临时文件，原文件保持原样。
    await chmod(target, 0o200);

    await expect(writeOpencodeConfig({ env: ENV, configDir: dir })).rejects.toBeInstanceOf(
      OpencodeConfigError,
    );

    expect(await readdir(dir)).toEqual(['opencode.jsonc']);
    await chmod(target, 0o600);
    expect(await readFile(target, 'utf-8')).toBe(original);
  });

  it('rejects invalid JSONC and leaves the file untouched', async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const target = join(dir, 'opencode.jsonc');
    const original = '{ "provider": ';
    await writeFile(target, original, 'utf-8');

    await expect(writeOpencodeConfig({ env: ENV, configDir: dir })).rejects.toBeInstanceOf(
      OpencodeConfigError,
    );
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
});
