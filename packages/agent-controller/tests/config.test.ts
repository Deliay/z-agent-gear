import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_CONFIG_DIR = join(tmpdir(), 'zag-test');
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
});
