import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfiguredCredentials } from './model-credentials.js';

/**
 * 运行期模型下发的凭据兜底读取（计划 Phase 4 / 返工 P2-4）：
 * 进程 env 优先；缺失项从已写入的 opencode/dsh 配置逐项回读；
 * 文件缺失/损坏一律收敛为空串，不抛错、不回显原值。
 */
describe('resolveConfiguredCredentials', () => {
  let root: string;
  let configDir: string;
  let dshHome: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'zag-model-credentials-'));
    configDir = join(root, 'opencode');
    dshHome = join(root, 'dsh');
    await mkdir(configDir, { recursive: true });
    await mkdir(join(dshHome, 'profiles', 'acp'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('env 同时具备时短路，不读取任何文件', async () => {
    const result = await resolveConfiguredCredentials({
      env: { ZAG_MODEL_BASE_URL: 'https://env.example.com/v1', ZAG_MODEL_API_KEY: 'sk-env' },
      configDir,
      dshHome,
    });
    expect(result).toEqual({
      modelBaseUrl: 'https://env.example.com/v1',
      modelApiKey: 'sk-env',
    });
  });

  it('逐项兜底：env 仅 baseURL，apiKey 从已写入的 opencode 配置回读', async () => {
    await writeFile(
      join(configDir, 'opencode.jsonc'),
      JSON.stringify(
        { providers: { zag: { settings: { baseURL: 'https://file.example.com/v1', apiKey: 'sk-file' } } } },
        null,
        2,
      ),
      'utf-8',
    );

    const result = await resolveConfiguredCredentials({
      env: { ZAG_MODEL_BASE_URL: 'https://env.example.com/v1' },
      configDir,
      dshHome,
    });
    expect(result).toEqual({
      modelBaseUrl: 'https://env.example.com/v1',
      modelApiKey: 'sk-file',
    });
  });

  it('无 env 时优先 opencode（jsonc 缺失 → 同名 .json）', async () => {
    await writeFile(
      join(configDir, 'opencode.json'),
      JSON.stringify(
        { providers: { zag: { settings: { baseURL: 'https://json.example.com/v1', apiKey: 'sk-json' } } } },
        null,
        2,
      ),
      'utf-8',
    );

    await expect(
      resolveConfiguredCredentials({ env: {}, configDir, dshHome }),
    ).resolves.toEqual({
      modelBaseUrl: 'https://json.example.com/v1',
      modelApiKey: 'sk-json',
    });
  });

  it('opencode 不可用/损坏时回退 dsh（cordis baseURL + credentials refs），逐项补齐', async () => {
    await writeFile(join(configDir, 'opencode.jsonc'), '{ not valid jsonc', 'utf-8');
    await writeFile(
      join(dshHome, 'profiles', 'acp', 'cordis.patch.yml'),
      ['- id: llm-pi-ai', '  config:', '    providers:', '      zag:', '        baseURL: https://dsh.example.com/v1'].join('\n'),
      'utf-8',
    );
    await writeFile(
      join(dshHome, '.credentials.yaml'),
      ['version: 1', 'refs:', '  ZAG_MODEL_API_KEY: sk-dsh'].join('\n'),
      'utf-8',
    );

    await expect(
      resolveConfiguredCredentials({ env: {}, configDir, dshHome }),
    ).resolves.toEqual({
      modelBaseUrl: 'https://dsh.example.com/v1',
      modelApiKey: 'sk-dsh',
    });
  });

  it('全部缺失/损坏时收敛为空串（不抛错）', async () => {
    await writeFile(join(dshHome, '.credentials.yaml'), 'refs: [unexpected, list]', 'utf-8');

    await expect(
      resolveConfiguredCredentials({ env: {}, configDir, dshHome }),
    ).resolves.toEqual({ modelBaseUrl: '', modelApiKey: '' });
  });

  it('trim 后为空的环境变量视为缺失，回读配置', async () => {
    await writeFile(
      join(configDir, 'opencode.jsonc'),
      JSON.stringify(
        { providers: { zag: { settings: { baseURL: 'https://file.example.com/v1', apiKey: 'sk-file' } } } },
        null,
        2,
      ),
      'utf-8',
    );

    await expect(
      resolveConfiguredCredentials({
        env: { ZAG_MODEL_BASE_URL: '   ', ZAG_MODEL_API_KEY: '' },
        configDir,
        dshHome,
      }),
    ).resolves.toEqual({
      modelBaseUrl: 'https://file.example.com/v1',
      modelApiKey: 'sk-file',
    });
  });
});
