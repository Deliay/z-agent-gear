import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_CONFIG_DIR = join(tmpdir(), 'zag-test-config');
const TEST_CONFIG_FILE = join(TEST_CONFIG_DIR, 'config.toml');

vi.mock('smol-toml', () => ({
  parse: vi.fn(),
  stringify: vi.fn(),
}));

describe('Config', () => {
  beforeEach(() => {
    if (existsSync(TEST_CONFIG_DIR)) {
      rmSync(TEST_CONFIG_DIR, { recursive: true });
    }
    mkdirSync(TEST_CONFIG_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_CONFIG_DIR)) {
      rmSync(TEST_CONFIG_DIR, { recursive: true });
    }
  });

  it('should read and write config', async () => {
    const { parse, stringify } = await import('smol-toml');
    const configContent = '[key]\nvalue = "zag_k_1_abc123"\n\n[server]\nendpoint = "http://localhost:4001"\n';
    vi.mocked(parse).mockReturnValue({
      key: { value: 'zag_k_1_abc123' },
      server: { endpoint: 'http://localhost:4001' },
    });
    vi.mocked(stringify).mockReturnValue(configContent);

    writeFileSync(TEST_CONFIG_FILE, configContent, 'utf-8');
    const content = readFileSync(TEST_CONFIG_FILE, 'utf-8');
    const parsed = parse(content);

    expect(parsed).toEqual({
      key: { value: 'zag_k_1_abc123' },
      server: { endpoint: 'http://localhost:4001' },
    });
  });

  it('should handle empty config', async () => {
    const { parse } = await import('smol-toml');
    vi.mocked(parse).mockReturnValue({});

    const config = parse('');
    expect(config).toEqual({});
  });
});

describe('Config functions', () => {
  describe('resolveKey', () => {
    it('should return cli key when provided', async () => {
      const { resolveKey } = await import('../src/config.js');
      expect(resolveKey('cli-key')).toBe('cli-key');
    });

    it('should return env key when cli key not provided', async () => {
      process.env.ZAG_CONTROLLER_KEY = 'env-key';
      const { resolveKey } = await import('../src/config.js');
      expect(resolveKey()).toBe('env-key');
      delete process.env.ZAG_CONTROLLER_KEY;
    });
  });

  describe('resolveEndpoint', () => {
    it('should return cli endpoint when provided', async () => {
      const { resolveEndpoint } = await import('../src/config.js');
      expect(resolveEndpoint('http://cli:4001')).toBe('http://cli:4001');
    });

    it('should return env endpoint when cli endpoint not provided', async () => {
      process.env.ZAG_SERVER_ENDPOINT = 'http://env:4001';
      const { resolveEndpoint } = await import('../src/config.js');
      expect(resolveEndpoint()).toBe('http://env:4001');
      delete process.env.ZAG_SERVER_ENDPOINT;
    });
  });
});

describe('Heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should start and stop heartbeat', async () => {
    const { Heartbeat } = await import('../src/heartbeat.js');
    const heartbeat = new Heartbeat();
    const sendFn = vi.fn();

    heartbeat.start(sendFn);
    vi.advanceTimersByTime(30_000);

    expect(sendFn).toHaveBeenCalled();
    heartbeat.stop();
  });

  it('should not call sendFn before interval', async () => {
    const { Heartbeat } = await import('../src/heartbeat.js');
    const heartbeat = new Heartbeat();
    const sendFn = vi.fn();

    heartbeat.start(sendFn);
    vi.advanceTimersByTime(29_999);

    expect(sendFn).not.toHaveBeenCalled();
    heartbeat.stop();
  });

  it('should stop calling after stop', async () => {
    const { Heartbeat } = await import('../src/heartbeat.js');
    const heartbeat = new Heartbeat();
    const sendFn = vi.fn();

    heartbeat.start(sendFn);
    heartbeat.stop();
    vi.advanceTimersByTime(60_000);

    expect(sendFn).not.toHaveBeenCalled();
  });
});

describe('Daemon', () => {
  it('should write and read pid', async () => {
    const { writePid, readPid, removePid } = await import('../src/daemon.js');
    writePid();
    expect(readPid()).toBe(process.pid);
    removePid();
  });

  it('should return null when no pid file', async () => {
    const { readPid, removePid } = await import('../src/daemon.js');
    removePid();
    expect(readPid()).toBeNull();
  });

  it('should remove pid file', async () => {
    const { writePid, readPid, removePid } = await import('../src/daemon.js');
    writePid();
    expect(readPid()).toBe(process.pid);
    removePid();
    expect(readPid()).toBeNull();
  });

  it('should detect running process', async () => {
    const { writePid, isRunning, removePid } = await import('../src/daemon.js');
    writePid();
    expect(isRunning()).toBe(true);
    removePid();
  });

  it('should detect non-running process', async () => {
    const { isRunning, removePid } = await import('../src/daemon.js');
    removePid();
    expect(isRunning()).toBe(false);
  });
});
