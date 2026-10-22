import { describe, it, expect } from 'vitest';
import {
  MIN_HARNESS_WORKER_VERSION,
  MIN_WORKER_VERSION,
  SUPPORTED_MAJOR,
  isSupportedHarnessWorkerVersion,
  isSupportedWorkerVersion,
  maxWorkerVersion,
  parseWorkerVersion,
  sanitizeVersionForLog,
} from './worker-version.js';

describe('worker-version constants', () => {
  it('T-V0: 最低版本与 supported major 是代码常量', () => {
    expect(MIN_WORKER_VERSION).toBe('2.2.0');
    expect(MIN_HARNESS_WORKER_VERSION).toBe('2.6.0');
    expect(SUPPORTED_MAJOR).toBe(2);
  });
});

describe('parseWorkerVersion', () => {
  it('T-V1: 合法三段数字被解析为数字段（2.10.0 不被字典序误判）', () => {
    expect(parseWorkerVersion('2.2.0')).toEqual({
      ok: true,
      major: 2,
      minor: 2,
      patch: 0,
      raw: '2.2.0',
    });
    expect(parseWorkerVersion('2.10.0')).toMatchObject({ ok: true, major: 2, minor: 10, patch: 0 });
    expect(parseWorkerVersion('2.2.1')).toMatchObject({ ok: true, major: 2, minor: 2, patch: 1 });
    expect(parseWorkerVersion('0.0.0')).toMatchObject({ ok: true, major: 0, minor: 0, patch: 0 });
  });

  it('T-V4a: 缺失版本与非法版本分别归类为 missing / malformed', () => {
    for (const raw of [undefined, null, '']) {
      const parsed = parseWorkerVersion(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toBe('missing');
    }

    for (const raw of [
      ' 2.2.0',
      '2.2.0 ',
      'v2.2.0',
      '2.2',
      '2.2.0.0',
      '2.2.0-beta.1',
      '2.2.0+build',
      '02.2.0',
      '2.02.0',
      'a.b.c',
      2.2,
      {},
      ['2.2.0'],
      `${'1'.repeat(65)}`,
      `2.2.0${'x'.repeat(60)}`,
    ]) {
      const parsed = parseWorkerVersion(raw);
      expect(parsed.ok, `expected malformed for ${JSON.stringify(raw)}`).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toBe('malformed');
    }
  });
});

describe('isSupportedWorkerVersion', () => {
  it('T-V1: >=2.2.0 且 major=2 的版本被接受', () => {
    for (const version of ['2.2.0', '2.2.1', '2.10.0', '2.100.0']) {
      const result = isSupportedWorkerVersion(version);
      expect(result.supported, version).toBe(true);
      expect(result.reason).toBe('supported');
      expect(result.parsed).toMatchObject({ ok: true, raw: version });
    }
  });

  it('T-V2: 低于最低版本的版本被拒绝（含自定义 minimum 生效）', () => {
    for (const version of ['2.1.9', '2.1.0', '2.0.0']) {
      expect(isSupportedWorkerVersion(version).supported, version).toBe(false);
      expect(isSupportedWorkerVersion(version).reason).toBe('below-minimum');
    }

    expect(isSupportedWorkerVersion('2.5.0', '2.6.0')).toMatchObject({
      supported: false,
      reason: 'below-minimum',
    });
    expect(isSupportedWorkerVersion('2.6.0', '2.6.0').supported).toBe(true);
  });

  it('T-V3: major 不在兼容范围时被拒绝（含自定义 supportedMajor 生效）', () => {
    for (const version of ['3.0.0', '1.2.3', '0.9.9']) {
      expect(isSupportedWorkerVersion(version)).toMatchObject({
        supported: false,
        reason: 'unsupported-major',
      });
    }

    expect(isSupportedWorkerVersion('3.2.0', '2.2.0', 3).supported).toBe(true);
    expect(isSupportedWorkerVersion('2.2.0', '2.2.0', 3)).toMatchObject({
      supported: false,
      reason: 'unsupported-major',
    });
  });

  it('T-V4b: 缺失/非法版本被拒绝且 reason 可区分', () => {
    expect(isSupportedWorkerVersion(undefined)).toMatchObject({
      supported: false,
      reason: 'missing',
    });
    expect(isSupportedWorkerVersion('')).toMatchObject({ supported: false, reason: 'missing' });
    expect(isSupportedWorkerVersion('x.y.z')).toMatchObject({
      supported: false,
      reason: 'malformed',
    });
    expect(isSupportedWorkerVersion(' 2.2.0')).toMatchObject({
      supported: false,
      reason: 'malformed',
    });
  });
});

describe('isSupportedHarnessWorkerVersion', () => {
  it('T-CC9: harness 门禁为 >=2.6.0 且 major=2（不影响普通容器）', () => {
    for (const version of ['2.4.9', '2.2.0', '2.1.0']) {
      expect(isSupportedHarnessWorkerVersion(version).supported, version).toBe(false);
      expect(isSupportedHarnessWorkerVersion(version).reason).toBe('below-minimum');
    }
    for (const version of ['2.6.0', '2.10.0']) {
      expect(isSupportedHarnessWorkerVersion(version).supported, version).toBe(true);
    }
    expect(isSupportedHarnessWorkerVersion('3.0.0')).toMatchObject({
      supported: false,
      reason: 'unsupported-major',
    });
    expect(isSupportedHarnessWorkerVersion(undefined)).toMatchObject({
      supported: false,
      reason: 'missing',
    });
    // 普通容器门禁不被上调
    expect(isSupportedWorkerVersion('2.2.0').supported).toBe(true);
  });
});

describe('maxWorkerVersion (C-4)', () => {
  it('取常量与请求值的较大者（数字段比较，非字典序）', () => {
    expect(maxWorkerVersion('2.1.0', '2.5.0')).toBe('2.5.0');
    expect(maxWorkerVersion('2.5.0', '2.5.0')).toBe('2.5.0');
    expect(maxWorkerVersion('2.6.0', '2.5.0')).toBe('2.6.0');
    expect(maxWorkerVersion('2.5.0', '2.10.0')).toBe('2.10.0');
    expect(maxWorkerVersion('2.10.0', '2.9.0')).toBe('2.10.0');
    // 非法输入回退到合法一侧
    expect(maxWorkerVersion('bad', '2.5.0')).toBe('2.5.0');
    expect(maxWorkerVersion('2.6.0', 'bad')).toBe('2.6.0');
    expect(maxWorkerVersion('bad', 'bad')).toBe(MIN_HARNESS_WORKER_VERSION);
  });
});

describe('sanitizeVersionForLog', () => {
  it('T-V5: 去除控制字符、截断到 64，缺失/非法回退 unknown', () => {
    expect(sanitizeVersionForLog('2.2.0')).toBe('2.2.0');
    expect(sanitizeVersionForLog('2.1.0\u0000')).toBe('2.1.0');
    expect(sanitizeVersionForLog('2.1.0\nINJECTED\tlog')).toBe('2.1.0INJECTEDlog');
    expect(sanitizeVersionForLog('a'.repeat(100))).toHaveLength(64);
    expect(sanitizeVersionForLog(undefined)).toBe('unknown');
    expect(sanitizeVersionForLog(null)).toBe('unknown');
    expect(sanitizeVersionForLog('')).toBe('unknown');
    expect(sanitizeVersionForLog({})).toBe('unknown');
    expect(sanitizeVersionForLog('\u0001\u0002')).toBe('unknown');
  });
});
