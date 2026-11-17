import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseYaml } from 'yaml';
import {
  applyModelProvision,
  ModelProvisionError,
  normalizeProvision,
  parseModelProvision,
  projectToLegacy,
  resolveProvision,
  ZAG_DISPLAY_NAME,
  ZAG_VENDOR_ID,
  type ModelProvision,
} from './model-providers.js';

const TMP_BASE = '/tmp/opencode';

const VALID = {
  providers: [
    {
      vendorId: 'zag',
      displayName: 'Agent Gear',
      models: [{ id: 'kimi-k2', contextLength: 262144 }, { id: 'model-b' }],
    },
    { vendorId: '65f0a1b2c3d4e5f60718293a', displayName: '我的 OpenAI', models: [{ id: 'gpt-5.1' }] },
  ],
};

async function makeDir(): Promise<string> {
  await mkdir(TMP_BASE, { recursive: true });
  return mkdtemp(join(TMP_BASE, 'model-providers-'));
}

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected an error');
}

describe('parseModelProvision (T-AG-MP1)', () => {
  it('accepts a valid payload (object or JSON string)', () => {
    expect(parseModelProvision(VALID)).toEqual(VALID);
    expect(parseModelProvision(JSON.stringify(VALID))).toEqual(VALID);
  });

  it('drops unknown fields and trims ids/names', () => {
    const parsed = parseModelProvision({
      extra: true,
      providers: [
        {
          vendorId: ' zag ',
          displayName: ' Agent Gear ',
          models: [{ id: ' m1 ', contextLength: 1000, name: 'ignored' }],
        },
      ],
    });
    expect(parsed).toEqual({
      providers: [{ vendorId: 'zag', displayName: 'Agent Gear', models: [{ id: 'm1', contextLength: 1000 }] }],
    });
  });

  it('accepts an empty providers array (business invariants are the server’s job)', () => {
    expect(parseModelProvision({ providers: [] })).toEqual({ providers: [] });
  });

  it('rejects invalid JSON / non-object payloads without echoing the raw value', () => {
    const invalidJson = capture(() => parseModelProvision('not-json-secret-value'));
    expect(invalidJson).toBeInstanceOf(ModelProvisionError);
    expect((invalidJson as Error).message).not.toContain('not-json-secret-value');

    expect(() => parseModelProvision(null)).toThrowError(/expected a JSON object/);
    expect(() => parseModelProvision([])).toThrowError(/expected a JSON object/);
    expect(() => parseModelProvision({ providers: {} })).toThrowError(/providers must be an array/);
  });

  it('rejects empty vendorId / displayName / models by field + index only', () => {
    const badVendor = capture(() =>
      parseModelProvision({ providers: [{ vendorId: '  ', displayName: 'x', models: [] }] }),
    );
    expect((badVendor as Error).message).toContain('providers[0].vendorId');
    expect((badVendor as Error).message).not.toContain('displayName');

    expect(() =>
      parseModelProvision({ providers: [{ vendorId: 'p', displayName: '', models: [] }] }),
    ).toThrowError(/providers\[0\]\.displayName/);

    expect(() =>
      parseModelProvision({ providers: [{ vendorId: 'p', displayName: 'P', models: 'nope' }] }),
    ).toThrowError(/providers\[0\]\.models must be an array/);

    expect(() =>
      parseModelProvision({ providers: [{ vendorId: 'p', displayName: 'P', models: [{}] }] }),
    ).toThrowError(/providers\[0\]\.models\[0\]\.id/);
  });

  it('rejects a non-positive-integer contextLength', () => {
    for (const contextLength of [0, -1, 1.5, '128000', Number.NaN]) {
      expect(() =>
        parseModelProvision({
          providers: [{ vendorId: 'p', displayName: 'P', models: [{ id: 'm', contextLength }] }],
        }),
      ).toThrowError(/providers\[0\]\.models\[0\]\.contextLength must be a positive integer/);
    }
  });

  it('rejects duplicate vendorIds by index only', () => {
    const error = capture(() =>
      parseModelProvision({
        providers: [
          { vendorId: 'p', displayName: 'P', models: [] },
          { vendorId: 'p', displayName: 'P2', models: [] },
        ],
      }),
    );
    expect(error).toBeInstanceOf(ModelProvisionError);
    expect((error as Error).message).toContain('providers[1].vendorId');
    expect((error as Error).message).not.toContain('P2');
  });
});

describe('projectToLegacy (T-AG-MP1)', () => {
  it('flattens ids in group order and keeps only positive context lengths', () => {
    const provision: ModelProvision = {
      providers: [
        {
          vendorId: 'zag',
          displayName: ZAG_DISPLAY_NAME,
          models: [{ id: 'a', contextLength: 1000 }, { id: 'b' }],
        },
        { vendorId: 'p1', displayName: 'P1', models: [{ id: 'c' }, { id: 'a', contextLength: 5 }] },
      ],
    };
    expect(projectToLegacy(provision)).toEqual({
      modelIds: ['a', 'b', 'c'],
      modelContextLengths: { a: 1000 },
    });
  });
});

describe('resolveProvision (T-AG-MP1)', () => {
  it('prefers modelProviders when present', () => {
    const env = { modelIds: ['ignored'], modelProviders: VALID as ModelProvision };
    const provision = resolveProvision(env);
    expect(provision.providers.map((item) => item.vendorId)).toEqual([
      'zag',
      '65f0a1b2c3d4e5f60718293a',
    ]);
  });

  it('falls back to a single zag group with contextLength mapping', () => {
    expect(
      resolveProvision({ modelIds: ['a', 'b'], modelContextLengths: { a: 128000, b: 0 } }),
    ).toEqual({
      providers: [
        {
          vendorId: 'zag',
          displayName: 'Agent Gear',
          models: [{ id: 'a', contextLength: 128000 }, { id: 'b' }],
        },
      ],
    });
  });

  it('synthesizes an empty zag group without modelIds', () => {
    expect(resolveProvision({})).toEqual({
      providers: [{ vendorId: ZAG_VENDOR_ID, displayName: ZAG_DISPLAY_NAME, models: [] }],
    });
  });

  it('normalizes group order and forces the zag display name', () => {
    const normalized = normalizeProvision({
      providers: [
        { vendorId: 'p1', displayName: 'P1', models: [] },
        { vendorId: 'zag', displayName: 'ZAG', models: [] },
      ],
    });
    expect(normalized.providers.map((item) => item.vendorId)).toEqual(['zag', 'p1']);
    expect(normalized.providers[0].displayName).toBe('Agent Gear');
  });
});

describe('applyModelProvision (T-AG-MP1)', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  const ENV = { modelBaseUrl: 'http://admin-api:8002/v1', modelApiKey: 'zag_sk_super_secret' };

  it('rewrites opencode and dsh without touching the CLI checks', async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const configDir = join(dir, 'config');
    const dshHome = join(dir, 'dsh');

    const result = await applyModelProvision({
      provision: VALID as ModelProvision,
      env: ENV,
      types: ['opencode', 'deepseek_harness'],
      configDir,
      dshHome,
      statePath: join(dir, 'state.json'),
    });

    expect(result).toEqual({ appliedTypes: ['opencode', 'deepseek_harness'], errors: [] });

    const config = parseJsonc(await readFile(join(configDir, 'opencode.jsonc'), 'utf-8'));
    expect(config.providers.zag.name).toBe('Agent Gear');
    expect(config.providers['65f0a1b2c3d4e5f60718293a'].name).toBe('我的 OpenAI');

    const patch = parseYaml(
      await readFile(join(dshHome, 'profiles', 'acp', 'cordis.patch.yml'), 'utf-8'),
    ) as Array<Record<string, any>>;
    const providers = patch.find((entry) => entry.id === 'llm-pi-ai')!.config.providers;
    expect(Object.keys(providers)).toEqual(['zag', '65f0a1b2c3d4e5f60718293a']);
  });

  it('returns no applied types when there is no harness type', async () => {
    const dir = await makeDir();
    dirs.push(dir);

    const result = await applyModelProvision({
      provision: VALID as ModelProvision,
      env: ENV,
      types: [],
      configDir: join(dir, 'config'),
      dshHome: join(dir, 'dsh'),
    });

    expect(result).toEqual({ appliedTypes: [], errors: [] });
  });

  it('reports per-type errors but keeps the other types applied', async () => {
    const dir = await makeDir();
    dirs.push(dir);
    const dshHome = join(dir, 'dsh');
    await mkdir(join(dshHome, 'profiles', 'acp'), { recursive: true });
    await writeFile(join(dshHome, 'profiles', 'acp', 'cordis.patch.yml'), '- broken: [\n', 'utf-8');

    const result = await applyModelProvision({
      provision: VALID as ModelProvision,
      env: ENV,
      types: ['opencode', 'deepseek_harness'],
      configDir: join(dir, 'config'),
      dshHome,
      statePath: join(dir, 'state.json'),
    });

    expect(result.appliedTypes).toEqual(['opencode']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].type).toBe('deepseek_harness');
    expect(result.errors[0].message).not.toContain(ENV.modelApiKey);
  });

  it('fails every type when the gateway credentials are missing', async () => {
    const dir = await makeDir();
    dirs.push(dir);

    const result = await applyModelProvision({
      provision: VALID as ModelProvision,
      env: { modelBaseUrl: '', modelApiKey: '' },
      types: ['opencode', 'deepseek_harness'],
      configDir: join(dir, 'config'),
      dshHome: join(dir, 'dsh'),
    });

    expect(result.appliedTypes).toEqual([]);
    expect(result.errors.map((item) => item.type)).toEqual(['opencode', 'deepseek_harness']);
    expect(result.errors[0].message).toContain('ZAG_MODEL_BASE_URL');
  });
});
