/**
 * T-OBS1 记录 schema / T-OBS2 级别过滤 / T-OBS3 脱敏 / T-OBS3b 审计例外边界 /
 * T-OBS4 错误序列化 / T-OBS6 pretty 开关（生产仍 JSON + 只 warn 一次）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger, parseLogLevel, REDACT_PATHS, type LogLevel } from './logger.js';
import { createTestLogger } from './testing.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('T-OBS1 记录 schema', () => {
  it('单行 JSON，level/time/service/serviceVersion/env/hostname/pid/msg 齐备', () => {
    const { logger, records } = createTestLogger();
    logger.info({ component: 'demo', answer: 42 }, 'hello');
    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec.msg).toBe('hello');
    expect(rec.component).toBe('demo');
    expect(rec.answer).toBe(42);
    expect(typeof rec.level).toBe('string');
    expect(['debug', 'info', 'warn', 'error', 'fatal']).toContain(rec.level);
    expect(Number.isNaN(Date.parse(rec.time))).toBe(false);
    for (const key of ['service', 'serviceVersion', 'env', 'hostname']) {
      expect(typeof rec[key]).toBe('string');
      expect((rec[key] as string).length).toBeGreaterThan(0);
    }
    expect(typeof rec.pid).toBe('number');
  });
});

describe('T-OBS2 级别过滤', () => {
  it('warn 级别下 info/debug 不输出', () => {
    const { logger, records } = createTestLogger(undefined, 'warn');
    logger.debug({}, 'd');
    logger.info({}, 'i');
    logger.warn({}, 'w');
    logger.error({}, 'e');
    expect(records.map((r) => r.msg)).toEqual(['w', 'e']);
  });

  it('parseLogLevel 非法值回落 info（表驱动）', () => {
    const cases: Array<[string | undefined, LogLevel]> = [
      [undefined, 'info'],
      ['', 'info'],
      ['debug', 'debug'],
      ['WARN', 'warn'],
      ['  Error  ', 'error'],
      ['verbose', 'info'],
      ['1', 'info'],
    ];
    for (const [input, expected] of cases) {
      expect(parseLogLevel(input), `input=${String(input)}`).toBe(expected);
    }
  });
});

describe('T-OBS3 脱敏', () => {
  it('名单键与一层嵌套键 → [REDACTED]', () => {
    const { logger, records } = createTestLogger();
    logger.info(
      {
        authorization: 'Bearer secret-a',
        cookie: 'sid=secret-b',
        token: 'secret-c',
        password: 'secret-d',
        secret: 'secret-e',
        apiKey: 'secret-f',
        nested: { token: 'secret-g', password: 'secret-h', secret: 'secret-i', apiKey: 'secret-j', authorization: 'Bearer secret-k' },
      },
      'redact me',
    );
    const rec = records[0];
    for (const key of ['authorization', 'cookie', 'token', 'password', 'secret', 'apiKey']) {
      expect(rec[key], key).toBe('[REDACTED]');
    }
    const nested = rec.nested as Record<string, string>;
    for (const key of ['token', 'password', 'secret', 'apiKey', 'authorization']) {
      expect(nested[key], `nested.${key}`).toBe('[REDACTED]');
    }
    expect(JSON.stringify(rec)).not.toContain('secret-');
  });

  it('err.config.headers.authorization 脱敏', () => {
    const { logger, records } = createTestLogger();
    const err = new Error('request failed') as Error & { config: { headers: { authorization: string; accept: string } } };
    err.config = { headers: { authorization: 'Bearer secret-x', accept: 'application/json' } };
    logger.error({ err }, 'boom');
    expect(JSON.stringify(records[0])).not.toContain('secret-x');
  });

  it('REDACT_PATHS 名单与契约一致', () => {
    for (const p of ['authorization', 'cookie', 'token', 'password', 'secret', 'apiKey', '*.token', 'secrets.*', 'err.config.headers.authorization']) {
      expect(REDACT_PATHS).toContain(p);
    }
  });
});

describe('T-OBS3b 审计例外边界', () => {
  it('bootstrapAdminPassword 明文可见、同结构 password 必脱敏', () => {
    const { logger, records } = createTestLogger();
    logger.warn(
      { bootstrapAdminPassword: 'plain-pass', password: 'must-hide', userId: 'u1' },
      '初始管理员密码（仅首次初始化输出一次，请立即修改；审计例外）',
    );
    const rec = records[0];
    expect(rec.bootstrapAdminPassword).toBe('plain-pass');
    expect(rec.password).toBe('[REDACTED]');
    expect(rec.msg).toContain('审计例外');
    expect(REDACT_PATHS).not.toContain('bootstrapAdminPassword');
  });
});

describe('T-OBS4 错误序列化', () => {
  it('err 含 type/message/stack 且 code 透传', () => {
    const { logger, records } = createTestLogger();
    const err = new Error('boom') as Error & { code: string };
    err.code = 'E_BOOM';
    logger.error({ err }, 'failed');
    const rec = records[0].err as Record<string, unknown>;
    expect(rec.type).toBe('Error');
    expect(rec.message).toBe('boom');
    expect(typeof rec.stack).toBe('string');
    expect(rec.code).toBe('E_BOOM');
  });

  it('循环引用不抛', () => {
    const { logger, records } = createTestLogger();
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => logger.info({ a }, 'circular ok')).not.toThrow();
    expect(records).toHaveLength(1);
  });
});

describe('T-OBS6 pretty 开关', () => {
  it('生产 + LOG_PRETTY=1 → 仍 JSON 且只 warn 一次', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LOG_PRETTY', '1');
    const { logger, records } = createTestLogger();
    logger.info({}, 'still json');
    const warns = records.filter((r) => r.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(String(warns[0].msg)).toContain('LOG_PRETTY ignored in production');
    const infos = records.filter((r) => r.level === 'info');
    expect(infos).toHaveLength(1);
    expect(infos[0].msg).toBe('still json'); // 可解析为 JSON（内存 sink 即单行 JSON）
  });

  it('注入 destination 时输出仍为单行 JSON（开发 + LOG_PRETTY=1 亦然）', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOG_PRETTY', '1');
    const { logger, records } = createTestLogger();
    logger.info({}, 'json line');
    expect(records.map((r) => r.msg)).toContain('json line');
  });

  it('createLogger 支持 pretty 构造（开发环境 transport 路径不抛）', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOG_PRETTY', '1');
    expect(() => createLogger({ pretty: true })).not.toThrow();
  });
});
