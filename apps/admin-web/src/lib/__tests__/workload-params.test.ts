import { describe, it, expect } from 'vitest';
import {
  buildDefaultParams,
  isParamFilled,
  resolveParamValue,
  validateParamValues,
  formatParams,
} from '@/lib/workload-params';
import type { CloudWorkloadParamFieldData } from '@/graphql/types';

const schema: CloudWorkloadParamFieldData[] = [
  { key: 'version', label: '版本', type: 'TEXT', options: [], defaultValue: '22' },
  {
    key: 'package_manager',
    label: '包管理器',
    type: 'MULTI_SELECT',
    options: ['npm', 'pnpm'],
    defaultValue: ['npm'],
  },
  { key: 'enabled', label: '启用', type: 'BOOLEAN', options: [], defaultValue: false },
];

describe('param value helpers (verdict 11: key presence, never truthy)', () => {
  it('prefills defaults for every field', () => {
    expect(buildDefaultParams(schema)).toEqual({
      version: '22',
      package_manager: ['npm'],
      enabled: false,
    });
  });

  it('treats false and empty string as filled (key presence)', () => {
    expect(isParamFilled({ enabled: false }, 'enabled')).toBe(true);
    expect(isParamFilled({ version: '' }, 'version')).toBe(true);
    expect(isParamFilled({ package_manager: [] }, 'package_manager')).toBe(true);
    expect(isParamFilled({}, 'version')).toBe(false);
  });

  it('resolves to the filled value, otherwise the default', () => {
    expect(resolveParamValue(schema[2], { enabled: false })).toBe(false);
    expect(resolveParamValue(schema[2], {})).toBe(false);
    expect(resolveParamValue(schema[0], { version: '' })).toBe('');
    expect(resolveParamValue(schema[0], {})).toBe('22');
  });

  it('validates values against the schema', () => {
    expect(validateParamValues(schema, buildDefaultParams(schema))).toEqual([]);
    expect(validateParamValues(schema, { package_manager: ['unknown'] })).toContainEqual(
      expect.objectContaining({ key: 'package_manager' }),
    );
    expect(
      validateParamValues(
        [{ key: 'mode', label: '模式', type: 'SELECT', options: ['a'], defaultValue: 'a' }],
        { mode: 'b' },
      ),
    ).toContainEqual(expect.objectContaining({ key: 'mode' }));
  });
});

describe('formatParams (T-FP9)', () => {
  it('renders "-" for empty params and formats values by type', () => {
    expect(formatParams({})).toBe('-');
    expect(formatParams({ a: 'x', b: true, c: ['y'] })).toBe('a: x\nb: true\nc: ["y"]');
  });
});
