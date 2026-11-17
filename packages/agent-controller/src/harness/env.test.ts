import { describe, it, expect } from 'vitest';
import {
  HarnessEnvError,
  parseModelContextLengths,
  parseModelIds,
  readHarnessEnv,
  resolvePrepareTypes,
} from './env.js';

const VALID_ENV: NodeJS.ProcessEnv = {
  ZAG_MODEL_BASE_URL: 'http://admin-api:8002/v1',
  ZAG_MODEL_API_KEY: 'zag_sk_super_secret',
  ZAG_MODEL_IDS: '["model-a","model-b"]',
  ZAG_DEFAULT_WORKSPACE: '/home/worker/workspace',
};

describe('readHarnessEnv (T-AG7/T-AG11)', () => {
  it('reads a valid harness env', () => {
    expect(readHarnessEnv(VALID_ENV)).toEqual({
      modelBaseUrl: 'http://admin-api:8002/v1',
      modelApiKey: 'zag_sk_super_secret',
      modelIds: ['model-a', 'model-b'],
      modelContextLengths: {},
      defaultWorkspace: '/home/worker/workspace',
    });
  });

  it('parses optional ZAG_MODEL_CONTEXT_LENGTHS when present', () => {
    const env = readHarnessEnv({
      ...VALID_ENV,
      ZAG_MODEL_CONTEXT_LENGTHS: '{"model-a":128000," model-b ":64000}',
    });
    expect(env.modelContextLengths).toEqual({ 'model-a': 128000, 'model-b': 64000 });
  });

  it('lists all missing variables by name and never leaks secret values', () => {
    let error: unknown;
    try {
      readHarnessEnv({ ZAG_MODEL_API_KEY: 'zag_sk_super_secret' });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(HarnessEnvError);
    const message = (error as Error).message;
    expect(message).toContain('ZAG_MODEL_BASE_URL');
    expect(message).toContain('ZAG_MODEL_IDS');
    expect(message).toContain('ZAG_DEFAULT_WORKSPACE');
    expect(message).not.toContain('ZAG_MODEL_API_KEY');
    expect(message).not.toContain('zag_sk_super_secret');
  });

  it('trims values', () => {
    const env = readHarnessEnv({
      ...VALID_ENV,
      ZAG_MODEL_BASE_URL: '  http://admin-api:8002/v1  ',
    } as NodeJS.ProcessEnv);
    expect(env.modelBaseUrl).toBe('http://admin-api:8002/v1');
  });

  it('rejects a missing default workspace', () => {
    expect(() => readHarnessEnv({ ...VALID_ENV, ZAG_DEFAULT_WORKSPACE: '' })).toThrowError(
      /ZAG_DEFAULT_WORKSPACE/,
    );
  });
});

describe('readHarnessEnv ZAG_MODEL_PROVIDERS（T-AG-MP1）', () => {
  const PROVISION = {
    providers: [
      {
        vendorId: 'zag',
        displayName: 'Agent Gear',
        models: [{ id: 'kimi-k2', contextLength: 262144 }],
      },
      { vendorId: 'p1', displayName: '我的 OpenAI', models: [{ id: 'gpt-5.1' }] },
    ],
  };

  it('accepts ZAG_MODEL_PROVIDERS without ZAG_MODEL_IDS and projects legacy fields', () => {
    const env = readHarnessEnv({
      ...VALID_ENV,
      ZAG_MODEL_IDS: undefined,
      ZAG_MODEL_PROVIDERS: JSON.stringify(PROVISION),
    } as NodeJS.ProcessEnv);

    expect(env.modelProviders).toEqual(PROVISION);
    expect(env.modelIds).toEqual(['kimi-k2', 'gpt-5.1']);
    expect(env.modelContextLengths).toEqual({ 'kimi-k2': 262144 });
  });

  it('keeps explicit ZAG_MODEL_IDS/modelContextLengths when both are provided', () => {
    const env = readHarnessEnv({
      ...VALID_ENV,
      ZAG_MODEL_PROVIDERS: JSON.stringify(PROVISION),
    });

    expect(env.modelProviders).toEqual(PROVISION);
    expect(env.modelIds).toEqual(['model-a', 'model-b']);
    expect(env.modelContextLengths).toEqual({});
  });

  it('rejects an invalid ZAG_MODEL_PROVIDERS without echoing the raw value', () => {
    let error: unknown;
    try {
      readHarnessEnv({ ...VALID_ENV, ZAG_MODEL_PROVIDERS: 'not-json-secret-value' });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(HarnessEnvError);
    const message = (error as Error).message;
    expect(message).toContain('ZAG_MODEL_PROVIDERS');
    expect(message).not.toContain('not-json-secret-value');
  });

  it('rejects structurally invalid providers (field/index only in the message)', () => {
    let error: unknown;
    try {
      readHarnessEnv({
        ...VALID_ENV,
        ZAG_MODEL_PROVIDERS: JSON.stringify({
          providers: [{ vendorId: '', displayName: 'x', models: [] }],
        }),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(HarnessEnvError);
    expect((error as Error).message).toContain('providers[0].vendorId');
    expect((error as Error).message).not.toContain('displayName');
  });

  it('still requires ZAG_MODEL_IDS when ZAG_MODEL_PROVIDERS is absent', () => {
    expect(() =>
      readHarnessEnv({ ...VALID_ENV, ZAG_MODEL_IDS: '' } as NodeJS.ProcessEnv),
    ).toThrowError(/ZAG_MODEL_IDS/);
  });
});

describe('parseModelIds (T-AG11)', () => {
  it('dedupes and drops empty/whitespace entries while preserving order', () => {
    expect(parseModelIds('["b"," a ","b","","   ","c","a"]')).toEqual(['b', 'a', 'c']);
  });

  it('accepts an empty array', () => {
    expect(parseModelIds('[]')).toEqual([]);
  });

  it('rejects invalid JSON without echoing the raw value', () => {
    let error: unknown;
    try {
      parseModelIds('not-json');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HarnessEnvError);
    expect((error as Error).message).toContain('ZAG_MODEL_IDS');
    expect((error as Error).message).not.toContain('not-json');
  });

  it('rejects non-array and non-string elements', () => {
    expect(() => parseModelIds('{"a":1}')).toThrowError(/JSON array of strings/);
    expect(() => parseModelIds('["a",1]')).toThrowError(/non-string element/);
    expect(() => parseModelIds('null')).toThrowError(/JSON array of strings/);
  });
});

describe('parseModelContextLengths', () => {
  it('parses a JSON object of positive integers and drops blank keys', () => {
    expect(parseModelContextLengths('{"model-a":128000,"":1,"model-b":32000}')).toEqual({
      'model-a': 128000,
      'model-b': 32000,
    });
  });

  it('accepts an empty object', () => {
    expect(parseModelContextLengths('{}')).toEqual({});
  });

  it('rejects invalid JSON without echoing the raw value', () => {
    let error: unknown;
    try {
      parseModelContextLengths('not-json');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HarnessEnvError);
    expect((error as Error).message).toContain('ZAG_MODEL_CONTEXT_LENGTHS');
    expect((error as Error).message).not.toContain('not-json');
  });

  it('rejects non-object and non-positive-integer values', () => {
    expect(() => parseModelContextLengths('["a"]')).toThrowError(/JSON object of positive integers/);
    expect(() => parseModelContextLengths('null')).toThrowError(/JSON object of positive integers/);
    expect(() => parseModelContextLengths('{"a":"128000"}')).toThrowError(/invalid value/);
    expect(() => parseModelContextLengths('{"a":0}')).toThrowError(/invalid value/);
    expect(() => parseModelContextLengths('{"a":-1}')).toThrowError(/invalid value/);
    expect(() => parseModelContextLengths('{"a":1.5}')).toThrowError(/invalid value/);
  });
});

describe('resolvePrepareTypes (T-PREP2)', () => {
  it('未设置/空串 → 回退 opencode', () => {
    expect(resolvePrepareTypes({})).toEqual(['opencode']);
    expect(resolvePrepareTypes({ ZAG_HARNESS_TYPES: '   ' })).toEqual(['opencode']);
  });

  it('解析逗号分隔、去空去重并保持顺序', () => {
    expect(resolvePrepareTypes({ ZAG_HARNESS_TYPES: 'opencode, deepseek_harness ,opencode' })).toEqual([
      'opencode',
      'deepseek_harness',
    ]);
    expect(resolvePrepareTypes({ ZAG_HARNESS_TYPES: 'deepseek_harness,opencode' })).toEqual([
      'deepseek_harness',
      'opencode',
    ]);
  });

  it('白名单过滤 kimi_code / 未知类型；过滤后为空回退 opencode', () => {
    expect(resolvePrepareTypes({ ZAG_HARNESS_TYPES: 'kimi_code,deepseek_harness' })).toEqual([
      'deepseek_harness',
    ]);
    expect(resolvePrepareTypes({ ZAG_HARNESS_TYPES: 'kimi_code,bogus' })).toEqual(['opencode']);
  });
});
