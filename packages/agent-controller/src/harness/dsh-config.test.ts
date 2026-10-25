import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { DshConfigError, defaultDshHome, writeDshConfig } from './dsh-config.js';

const TMP_BASE = '/tmp/opencode';
const API_KEY = 'zag_sk_dsh_super_secret';

const ENV = {
  modelBaseUrl: 'http://admin-api:8002/v1',
  modelApiKey: API_KEY,
  modelIds: ['model-a', 'model-b'],
  modelContextLengths: { 'model-a': 128000 },
};

async function makeHome(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  return mkdtemp(join(TMP_BASE, 'dsh-'));
}

async function readYaml(path: string): Promise<unknown> {
  return parse(await readFile(path, 'utf-8'));
}

describe('writeDshConfig (T-DSH*)', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('defaultDshHome 优先 DSH_HOME，否则 ~/.dsh', () => {
    expect(defaultDshHome({ DSH_HOME: '  /custom/dsh  ' })).toBe('/custom/dsh');
    expect(defaultDshHome({})).toMatch(/\/\.dsh$/);
  });

  it('T-DSH1: 新建 patch 写入 4 个条目与 ZAG provider，并新建 credentials', async () => {
    const home = await makeHome();
    dirs.push(home);

    const result = await writeDshConfig({ env: ENV, dshHome: home });

    expect(result).toMatchObject({
      patchCreated: true,
      credentialsCreated: true,
      modelCount: 2,
      entryCount: 4,
    });
    expect(result.patchPath).toBe(join(home, 'profiles', 'acp', 'cordis.patch.yml'));
    expect(result.credentialsPath).toBe(join(home, '.credentials.yaml'));

    const patch = (await readYaml(result.patchPath)) as Array<Record<string, any>>;
    expect(patch.map((entry) => entry.id)).toEqual([
      'llm-deepseek',
      'llm-pi-ai',
      'agent-default-model',
      'acp',
    ]);
    expect(patch[0]).toEqual({ id: 'llm-deepseek', disabled: true });
    expect(patch[1].config.providers.zag).toMatchObject({
      displayName: 'ZAG',
      apiKeyEnv: 'ZAG_MODEL_API_KEY',
      api: 'openai-completions',
      baseURL: 'http://admin-api:8002/v1',
      models: [
        { id: 'model-a', name: 'model-a', contextWindow: 128000 },
        { id: 'model-b', name: 'model-b' },
      ],
    });
    expect(patch[2]).toEqual({
      id: 'agent-default-model',
      config: { provider: 'zag', model: 'model-a' },
    });
    expect(patch[3]).toEqual({
      id: 'acp',
      name: '@deepseek-ai/dsh-acp',
      config: { provider: 'zag', model: 'model-a' },
    });

    const credentials = (await readYaml(result.credentialsPath)) as Record<string, any>;
    expect(credentials).toEqual({ version: 1, refs: { ZAG_MODEL_API_KEY: API_KEY } });
  });

  it('T-DSH2/T-DSH3: 合并时只替换我方条目（models 整体替换），其他条目与注释保留', async () => {
    const home = await makeHome();
    dirs.push(home);
    const profilesDir = join(home, 'profiles', 'acp');
    await mkdir(profilesDir, { recursive: true });
    const patchPath = join(profilesDir, 'cordis.patch.yml');
    await writeFile(
      patchPath,
      [
        '# top comment',
        '- id: other',
        '  value: 1 # keep inline',
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      zag:',
        '        models:',
        '          - id: old-model',
        '- id: agent-default-model',
        '  config: { provider: old, model: old-model }',
        '',
      ].join('\n'),
      'utf-8',
    );

    await writeDshConfig({ env: ENV, dshHome: home });

    const text = await readFile(patchPath, 'utf-8');
    expect(text).toContain('# top comment');
    expect(text).toContain('value: 1 # keep inline');
    const patch = parse(text) as Array<Record<string, any>>;
    expect(patch[0]).toEqual({ id: 'other', value: 1 });
    const zag = patch.find((entry) => entry.id === 'llm-pi-ai')!.config.providers.zag;
    expect(zag.models.map((model: { id: string }) => model.id)).toEqual(['model-a', 'model-b']);
    expect(patch.filter((entry) => entry.id === 'llm-pi-ai')).toHaveLength(1);
    expect(patch.filter((entry) => entry.id === 'llm-deepseek')).toHaveLength(1);
    expect(patch.filter((entry) => entry.id === 'acp')).toHaveLength(1);
  });

  it('T-DSH4: contextWindow 仅在正整数时写入', async () => {
    const home = await makeHome();
    dirs.push(home);

    await writeDshConfig({
      env: {
        ...ENV,
        modelContextLengths: {
          'model-a': 0,
          'model-b': -1,
        },
      },
      dshHome: home,
    });

    const patch = (await readYaml(join(home, 'profiles', 'acp', 'cordis.patch.yml'))) as Array<
      Record<string, any>
    >;
    const models = patch.find((entry) => entry.id === 'llm-pi-ai')!.config.providers.zag.models;
    expect(models).toEqual([
      { id: 'model-a', name: 'model-a' },
      { id: 'model-b', name: 'model-b' },
    ]);
  });

  it('T-DSH5: credentials 合并只替换 refs.ZAG_MODEL_API_KEY，保留其它 refs/records 与注释', async () => {
    const home = await makeHome();
    dirs.push(home);
    await mkdir(home, { recursive: true });
    const credentialsPath = join(home, '.credentials.yaml');
    await writeFile(
      credentialsPath,
      [
        '# credentials comment',
        'version: 1',
        'refs:',
        '  OTHER: keep-me',
        'records:',
        '  github: token # keep record',
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = await writeDshConfig({ env: ENV, dshHome: home });

    expect(result.credentialsCreated).toBe(false);
    const text = await readFile(credentialsPath, 'utf-8');
    expect(text).toContain('# credentials comment');
    expect(text).toContain('token # keep record');
    const credentials = parse(text) as Record<string, any>;
    expect(credentials.version).toBe(1);
    expect(credentials.refs).toEqual({ OTHER: 'keep-me', ZAG_MODEL_API_KEY: API_KEY });
    expect(credentials.records).toEqual({ github: 'token' });
  });

  it('T-DSH6: 目录 0700、两文件 0600', async () => {
    const home = await makeHome();
    dirs.push(home);

    const result = await writeDshConfig({ env: ENV, dshHome: home });

    expect((await stat(join(home, 'profiles', 'acp'))).mode & 0o777).toBe(0o700);
    expect((await stat(result.patchPath)).mode & 0o777).toBe(0o600);
    expect((await stat(result.credentialsPath)).mode & 0o777).toBe(0o600);
  });

  it('T-DSH8: 非法 YAML 抛错且不覆盖既有文件', async () => {
    const home = await makeHome();
    dirs.push(home);
    const profilesDir = join(home, 'profiles', 'acp');
    await mkdir(profilesDir, { recursive: true });
    const patchPath = join(profilesDir, 'cordis.patch.yml');
    const broken = '- id: broken\n  config: [unclosed\n';
    await writeFile(patchPath, broken, 'utf-8');

    await expect(writeDshConfig({ env: ENV, dshHome: home })).rejects.toBeInstanceOf(DshConfigError);
    expect(await readFile(patchPath, 'utf-8')).toBe(broken);
  });

  it('T-DSH8b: credentials 结构非法时抛错且不写 patch', async () => {
    const home = await makeHome();
    dirs.push(home);
    await mkdir(home, { recursive: true });
    const credentialsPath = join(home, '.credentials.yaml');
    const broken = 'version: 1\nrefs: not-a-map\n';
    await writeFile(credentialsPath, broken, 'utf-8');

    await expect(writeDshConfig({ env: ENV, dshHome: home })).rejects.toBeInstanceOf(DshConfigError);
    expect(await readFile(credentialsPath, 'utf-8')).toBe(broken);
    await expect(stat(join(home, 'profiles', 'acp', 'cordis.patch.yml'))).rejects.toThrow();
  });

  it('T-DSH9: 空模型清单不写 model 字段、modelCount=0、不抛错', async () => {
    const home = await makeHome();
    dirs.push(home);

    const result = await writeDshConfig({
      env: { ...ENV, modelIds: [], modelContextLengths: {} },
      dshHome: home,
    });

    expect(result.modelCount).toBe(0);
    const patch = (await readYaml(result.patchPath)) as Array<Record<string, any>>;
    expect(patch.find((entry) => entry.id === 'agent-default-model')!.config).toEqual({
      provider: 'zag',
    });
    expect(patch.find((entry) => entry.id === 'acp')!.config).toEqual({ provider: 'zag' });
    const zag = patch.find((entry) => entry.id === 'llm-pi-ai')!.config.providers.zag;
    expect(zag.models).toEqual([]);
  });

  it('T-DSH10: 二次执行结果等价（条目不重复、权限不漂移）', async () => {
    const home = await makeHome();
    dirs.push(home);

    const first = await writeDshConfig({ env: ENV, dshHome: home });
    const firstPatch = await readFile(first.patchPath, 'utf-8');
    const firstCredentials = await readFile(first.credentialsPath, 'utf-8');

    const second = await writeDshConfig({ env: ENV, dshHome: home });

    expect(second.patchCreated).toBe(false);
    expect(second.credentialsCreated).toBe(false);
    expect(await readFile(second.patchPath, 'utf-8')).toBe(firstPatch);
    expect(await readFile(second.credentialsPath, 'utf-8')).toBe(firstCredentials);
    const patch = parse(firstPatch) as Array<Record<string, any>>;
    expect(patch).toHaveLength(4);
    expect((await stat(second.patchPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, 'profiles', 'acp'))).mode & 0o777).toBe(0o700);
  });

  it('T-DSH11: 返回值/错误信息不含 API Key', async () => {
    const home = await makeHome();
    dirs.push(home);

    const result = await writeDshConfig({ env: ENV, dshHome: home });
    expect(JSON.stringify(result)).not.toContain(API_KEY);

    const brokenHome = await makeHome();
    dirs.push(brokenHome);
    const profilesDir = join(brokenHome, 'profiles', 'acp');
    await mkdir(profilesDir, { recursive: true });
    await writeFile(join(profilesDir, 'cordis.patch.yml'), '- broken: [\n', 'utf-8');
    try {
      await writeDshConfig({ env: ENV, dshHome: brokenHome });
      expect.unreachable();
    } catch (error) {
      expect(JSON.stringify((error as Error).message)).not.toContain(API_KEY);
    }
  });
});
