import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_HARNESS_ENABLED = process.env.HARNESS_ENABLED;

async function loadConfig() {
  vi.resetModules();
  const { config } = await import('./index.js');
  return config;
}

afterEach(() => {
  if (ORIGINAL_HARNESS_ENABLED === undefined) delete process.env.HARNESS_ENABLED;
  else process.env.HARNESS_ENABLED = ORIGINAL_HARNESS_ENABLED;
  vi.resetModules();
});

describe('config.harnessEnabled', () => {
  it('未设置 HARNESS_ENABLED 时默认开启', async () => {
    delete process.env.HARNESS_ENABLED;

    const config = await loadConfig();

    expect(config.harnessEnabled).toBe(true);
  });

  it('HARNESS_ENABLED 为空字符串时默认开启', async () => {
    process.env.HARNESS_ENABLED = '  ';

    const config = await loadConfig();

    expect(config.harnessEnabled).toBe(true);
  });

  it('显式 false 时关闭（回滚路径）', async () => {
    process.env.HARNESS_ENABLED = 'false';

    const config = await loadConfig();

    expect(config.harnessEnabled).toBe(false);
  });

  it.each(['true', '1'])('HARNESS_ENABLED=%s 时开启', async (value) => {
    process.env.HARNESS_ENABLED = value;

    const config = await loadConfig();

    expect(config.harnessEnabled).toBe(true);
  });
});
