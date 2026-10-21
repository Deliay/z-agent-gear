import { describe, it, expect } from 'vitest';
import { HarnessEnvError, parseModelIds, readHarnessEnv } from './env.js';

const VALID_ENV: NodeJS.ProcessEnv = {
  ZAG_MODEL_BASE_URL: 'http://admin-api:8002/v1',
  ZAG_MODEL_API_KEY: 'zag_sk_super_secret',
  ZAG_MODEL_IDS: '["model-a","model-b"]',
  ZAG_DEFAULT_WORKSPACE: '/root/workspace',
};

describe('readHarnessEnv (T-AG7/T-AG11)', () => {
  it('reads a valid harness env', () => {
    expect(readHarnessEnv(VALID_ENV)).toEqual({
      modelBaseUrl: 'http://admin-api:8002/v1',
      modelApiKey: 'zag_sk_super_secret',
      modelIds: ['model-a', 'model-b'],
      defaultWorkspace: '/root/workspace',
    });
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
