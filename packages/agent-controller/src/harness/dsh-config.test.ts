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

/** 需求给定四键（`hosts` 缺省不写）。 */
const HEADER_MASQ_ENTRY = {
  id: 'header-masq',
  name: 'dsh-header-masq',
  config: {
    source: 'x-deepseek-harness-session-id',
    targets: ['x-opencode-session'],
    fallbackToSessionId: true,
    debug: false,
  },
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

  it('T-DSH1: 新建 patch 写入 4 个扁平条目 + insert header-masq 与 ZAG provider，并新建 credentials', async () => {
    const home = await makeHome();
    dirs.push(home);

    const result = await writeDshConfig({ env: ENV, dshHome: home });

    expect(result).toMatchObject({
      patchCreated: true,
      credentialsCreated: true,
      modelCount: 2,
      entryCount: 5,
    });
    expect(result.patchPath).toBe(join(home, 'profiles', 'acp', 'cordis.patch.yml'));
    expect(result.credentialsPath).toBe(join(home, '.credentials.yaml'));

    const patch = (await readYaml(result.patchPath)) as Array<Record<string, any>>;
    expect(patch.map((entry) => entry.id)).toEqual([
      'llm-deepseek',
      'llm-pi-ai',
      'agent-default-model',
      'acp',
      undefined,
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
    expect(patch[4]).toEqual({ insert: [HEADER_MASQ_ENTRY] });

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
    expect(patch).toHaveLength(5);
    expect(patch.filter((entry) => entry.id === 'header-masq')).toHaveLength(0);
    expect(patch.filter((entry) => entry.insert !== undefined)).toHaveLength(1);
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

describe('writeDshConfig insert 受管条目（T-MASQ*）', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function writePatch(home: string, text: string): Promise<string> {
    const profilesDir = join(home, 'profiles', 'acp');
    await mkdir(profilesDir, { recursive: true });
    const patchPath = join(profilesDir, 'cordis.patch.yml');
    await writeFile(patchPath, text, 'utf-8');
    return patchPath;
  }

  it('T-MASQ1: 无 patch / 无 insert 块时在末尾追加单条目 insert 块（四键、hosts 不写）', async () => {
    const home = await makeHome();
    dirs.push(home);

    const result = await writeDshConfig({ env: ENV, dshHome: home });

    const text = await readFile(result.patchPath, 'utf-8');
    const patch = parse(text) as Array<Record<string, any>>;
    expect(patch).toHaveLength(5);
    expect(patch[4]).toEqual({ insert: [HEADER_MASQ_ENTRY] });
    expect(patch[4].insert[0].config).not.toHaveProperty('hosts');
    expect(text).toContain('- insert:\n    - id: header-masq\n      name: dsh-header-masq\n');
  });

  it('T-MASQ2: 既有 insert 块含 header-masq 时整体替换为我方单条目块（config 全量覆盖）', async () => {
    const home = await makeHome();
    dirs.push(home);
    const patchPath = await writePatch(
      home,
      [
        '# top comment',
        '- id: other',
        '  value: 1',
        '- insert:',
        '    - id: header-masq',
        '      name: dsh-header-masq',
        '      config:',
        '        source: stale-source',
        '        targets:',
        '          - x-stale',
        '        debug: true',
        '- insert:',
        '    - id: unrelated-plugin',
        '      name: unrelated',
        '',
      ].join('\n'),
    );

    await writeDshConfig({ env: ENV, dshHome: home });

    const text = await readFile(patchPath, 'utf-8');
    const patch = parse(text) as Array<Record<string, any>>;
    const headerBlocks = patch.filter(
      (entry) =>
        Array.isArray(entry.insert) &&
        entry.insert.some((inner: { id?: string }) => inner?.id === 'header-masq'),
    );
    expect(headerBlocks).toHaveLength(1);
    expect(headerBlocks[0]).toEqual({ insert: [HEADER_MASQ_ENTRY] });
    expect(text).not.toContain('stale-source');
    expect(text).not.toContain('x-stale');
    // 他插件 insert 块原样保留
    expect(patch).toContainEqual({ insert: [{ id: 'unrelated-plugin', name: 'unrelated' }] });
  });

  it('T-MASQ3: 连续两次写入逐字一致，不产生重复 insert 块', async () => {
    const home = await makeHome();
    dirs.push(home);

    const first = await writeDshConfig({ env: ENV, dshHome: home });
    const firstText = await readFile(first.patchPath, 'utf-8');
    await writeDshConfig({ env: ENV, dshHome: home });
    const secondText = await readFile(first.patchPath, 'utf-8');

    expect(secondText).toBe(firstText);
    const patch = parse(secondText) as Array<Record<string, any>>;
    expect(patch).toHaveLength(5);
    expect(secondText.match(/id: header-masq/g)).toHaveLength(1);
  });

  it('T-MASQ4: insert 合并保留他条目、他插件条目与注释', async () => {
    const home = await makeHome();
    dirs.push(home);
    const patchPath = await writePatch(
      home,
      [
        '# top comment',
        '- id: other',
        '  value: 1 # keep inline',
        '- id: acp',
        '  name: "@deepseek-ai/dsh-acp"',
        '  config: { provider: old }',
        '- insert:',
        '    - id: unrelated-plugin',
        '      name: unrelated',
        '',
      ].join('\n'),
    );

    await writeDshConfig({ env: ENV, dshHome: home });

    const text = await readFile(patchPath, 'utf-8');
    expect(text).toContain('# top comment');
    expect(text).toContain('value: 1 # keep inline');
    const patch = parse(text) as Array<Record<string, any>>;
    expect(patch[0]).toEqual({ id: 'other', value: 1 });
    expect(patch.filter((entry) => entry.id === 'acp')).toHaveLength(1);
    expect(patch).toContainEqual({ insert: [{ id: 'unrelated-plugin', name: 'unrelated' }] });
    expect(patch).toContainEqual({ insert: [HEADER_MASQ_ENTRY] });
  });

  it('T-MASQ6: insert 块含多个内层条目时整体替换（共块他条目被丢弃，已登记风险）', async () => {
    const home = await makeHome();
    dirs.push(home);
    const patchPath = await writePatch(
      home,
      [
        '- insert:',
        '    - id: shared-plugin',
        '      name: shared',
        '    - id: header-masq',
        '      name: dsh-header-masq',
        '      config: { source: stale }',
        '',
      ].join('\n'),
    );

    await writeDshConfig({ env: ENV, dshHome: home });

    const patch = (await readYaml(patchPath)) as Array<Record<string, any>>;
    const headerBlock = patch.find(
      (entry) =>
        Array.isArray(entry.insert) &&
        entry.insert.some((inner: { id?: string }) => inner?.id === 'header-masq'),
    )!;
    expect(headerBlock.insert).toEqual([HEADER_MASQ_ENTRY]);
    expect(JSON.stringify(patch)).not.toContain('shared-plugin');
  });

  it('T-MASQ8: insert 路径下非法 YAML 抛错且不覆盖既有文件', async () => {
    const home = await makeHome();
    dirs.push(home);
    const broken = '- insert: [\n';
    const patchPath = await writePatch(home, broken);

    await expect(writeDshConfig({ env: ENV, dshHome: home })).rejects.toBeInstanceOf(DshConfigError);
    expect(await readFile(patchPath, 'utf-8')).toBe(broken);
  });
});
