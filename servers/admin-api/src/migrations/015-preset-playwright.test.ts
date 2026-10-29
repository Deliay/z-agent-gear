import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../models/cloud-workload.js', () => ({
  CloudWorkload: { findOne: vi.fn(), create: vi.fn() },
}));

import { CloudWorkload } from '../models/cloud-workload.js';
import * as migration from './015-preset-playwright';

type CreateArg = {
  name: string;
  initScript: string;
  postScript: null | string;
  paramSchema: Array<Record<string, unknown>>;
  dependsOnWorkloadIds: unknown[];
  presetKey: string;
  isPreset: boolean;
  workloadKind: string;
  harnessType: string | null;
};

function createdArgs(): CreateArg[] {
  return (CloudWorkload.create as any).mock.calls.map((call: unknown[]) => call[0] as CreateArg);
}

/** 按 filter 分派的 findOne mock：presetKey / name 两个维度。 */
function mockFindOne(byPresetKey: Record<string, unknown>, byName: Record<string, unknown> = {}) {
  (CloudWorkload.findOne as any).mockImplementation(
    (filter: { presetKey?: string; name?: string }) => {
      if (filter.presetKey && filter.presetKey in byPresetKey) {
        return Promise.resolve(byPresetKey[filter.presetKey]);
      }
      if (filter.name && filter.name in byName) {
        return Promise.resolve(byName[filter.name]);
      }
      return Promise.resolve(null);
    },
  );
}

describe('migration 015-preset-playwright', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    (CloudWorkload.create as any).mockImplementation((doc: { name: string }) =>
      Promise.resolve({ _id: `id-${doc.name}` }),
    );
  });

  it('exposes the migration name', () => {
    expect(migration.name).toBe('015-preset-playwright');
  });

  it('T-MIG-PW1: 首次执行播种 Playwright 预制项（标准负载 + 参数 + Node.js 依赖）', async () => {
    mockFindOne({ nodejs: { _id: 'nodejs-id' } });

    await migration.run();

    expect(CloudWorkload.create).toHaveBeenCalledTimes(1);
    const arg = createdArgs()[0];
    expect(arg).toMatchObject({
      name: 'Playwright',
      presetKey: 'playwright',
      isPreset: true,
      workloadKind: 'standard',
      harnessType: null,
      postScript: null,
      paramSchema: [migration.PLAYWRIGHT_DOWNLOAD_HOST_PARAM],
      dependsOnWorkloadIds: ['nodejs-id'],
    });
    expect(arg.initScript).toBe(migration.PLAYWRIGHT_SCRIPT_V1);
    expect(arg.paramSchema).toHaveLength(1);
    expect(arg.paramSchema[0]).toMatchObject({
      key: 'playwright_download_host',
      label: 'Playwright 浏览器下载地址',
      type: 'text',
      options: [],
      defaultValue: 'https://nexus.internal.fffdan.com/repository/playwright-proxy/',
    });
  });

  it('T-MIG-PW1b: Node.js 预制项缺失时告警并以空依赖创建（不阻断）', async () => {
    mockFindOne({});

    await migration.run();

    expect(CloudWorkload.create).toHaveBeenCalledTimes(1);
    expect(createdArgs()[0].dependsOnWorkloadIds).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('preset workload "nodejs" not found'),
    );
  });

  it('T-MIG-PW1c: presetKey 未命中时按精确 name 回退解析 Node.js 依赖', async () => {
    mockFindOne({}, { 'Node.js': { _id: 'nodejs-by-name' } });

    await migration.run();

    expect(createdArgs()[0].dependsOnWorkloadIds).toEqual(['nodejs-by-name']);
  });

  it('T-MIG-PW2: presetKey 命中即告警跳过、不覆盖管理员修改', async () => {
    const existing = {
      _id: 'existing',
      presetKey: 'playwright',
      initScript: '#!/usr/bin/env bash\necho custom\n',
      paramSchema: [],
      save: vi.fn(),
    };
    mockFindOne({ playwright: existing });

    await migration.run();

    expect(CloudWorkload.create).not.toHaveBeenCalled();
    expect(existing.initScript).toContain('echo custom');
    expect(existing.save).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('T-MIG-PW3: 仅精确 name 命中即告警跳过、不产生重名项', async () => {
    mockFindOne({}, { Playwright: { _id: 'by-name' } });

    await migration.run();

    expect(CloudWorkload.create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('T-MIG-PW4: 幂等重跑不重复写入', async () => {
    mockFindOne({ nodejs: { _id: 'nodejs-id' } });
    await migration.run();
    expect(CloudWorkload.create).toHaveBeenCalledTimes(1);

    mockFindOne({ playwright: { _id: 'existing' }, nodejs: { _id: 'nodejs-id' } });
    await migration.run();
    expect(CloudWorkload.create).toHaveBeenCalledTimes(1);
  });

  it('T-MIG-PW5: 脚本含安装/持久化/硬校验不变量，且通过 bash -n', () => {
    const script = migration.PLAYWRIGHT_SCRIPT_V1;

    expect(Buffer.byteLength(script, 'utf8')).toBeLessThan(16 * 1024);
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('command -v node');
    expect(script).toContain('command -v npm');
    expect(script).toContain('BROWSERS_CACHE="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"');

    // npm 包安装与浏览器下载默认仅 Chromium
    expect(script).toContain('npm install -g playwright');
    expect(script).toContain('playwright install chromium');
    expect(script).not.toContain('playwright install --with-deps');
    const executable = script
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(executable).not.toContain('playwright install firefox');
    expect(executable).not.toContain('playwright install webkit');

    // 下载地址三段取值
    expect(script).toContain(
      'PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST:-${WORKLOAD_PARAM_PLAYWRIGHT_DOWNLOAD_HOST:-}}"',
    );
    expect(script).toContain('exit 2');
    expect(script).toContain(
      'https://<nexus-host>/repository/playwright-proxy/',
    );

    // 持久化注入 root 与 worker 用户环境（裁决 16）
    expect(script).toContain('/etc/profile.d/playwright.sh');
    expect(script).toContain('/root/.bashrc');
    expect(script).toContain('/home/worker/.bashrc');
    expect(script).toContain('# >>> playwright download host >>>');
    expect(script).toContain('# <<< playwright download host <<<');
    expect(script).toContain('export PLAYWRIGHT_DOWNLOAD_HOST="$PLAYWRIGHT_DOWNLOAD_HOST"');

    // 结尾硬校验：版本 + Chromium 目录
    const versionIdx = script.lastIndexOf('playwright --version');
    const chromiumIdx = script.lastIndexOf("grep -q '^chromium-'");
    expect(versionIdx).toBeGreaterThan(-1);
    expect(chromiumIdx).toBeGreaterThan(versionIdx);

    // 脚本不内置默认浏览器下载地址（playwright-proxy 仅出现在失败指引的占位形态中）
    expect(script).not.toContain(
      'https://nexus.internal.fffdan.com/repository/playwright-proxy/',
    );
    expect(script.match(/playwright-proxy/g) ?? []).toHaveLength(1);
    // npm 代理默认值属既有约定，允许保留
    expect(script).toContain('NPM_REGISTRY:-https://nexus.internal.fffdan.com/repository/npm-proxy/');

    const dir = mkdtempSync(join(tmpdir(), 'zag-mig015-'));
    const file = join(dir, 'playwright.sh');
    try {
      writeFileSync(file, script);
      expect(() => execFileSync('bash', ['-n', file])).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T-MIG-PW5b: 取值切片遵循 env > 参数 > 快速失败的优先级', () => {
    const lines = migration.PLAYWRIGHT_SCRIPT_V1.split('\n');
    const startIdx = lines.findIndex((line) =>
      line.includes('PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST:-'),
    );
    expect(startIdx).toBeGreaterThanOrEqual(0);
    const guardIdx = lines.findIndex((line, i) => i > startIdx && line.trim() === 'exit 2');
    expect(guardIdx).toBeGreaterThan(startIdx);
    const endIdx = lines.findIndex((line, i) => i > guardIdx && line.trim() === 'fi');
    expect(endIdx).toBeGreaterThan(guardIdx);
    const snippet = lines.slice(startIdx, endIdx + 1).join('\n');

    const run = (envHost: string, paramHost: string) => {
      const env = { ...process.env };
      delete env.PLAYWRIGHT_DOWNLOAD_HOST;
      delete env.WORKLOAD_PARAM_PLAYWRIGHT_DOWNLOAD_HOST;
      return spawnSync(
        'bash',
        ['-c', `${snippet}\nprintf '%s' "$PLAYWRIGHT_DOWNLOAD_HOST"`],
        {
          env: {
            ...env,
            PLAYWRIGHT_DOWNLOAD_HOST: envHost,
            WORKLOAD_PARAM_PLAYWRIGHT_DOWNLOAD_HOST: paramHost,
          },
          encoding: 'utf8',
        },
      );
    };

    const fromEnv = run('https://env.example/playwright/', 'https://param.example/playwright/');
    expect(fromEnv.status).toBe(0);
    expect(fromEnv.stdout).toBe('https://env.example/playwright/');

    const fromParam = run('', 'https://param.example/playwright/');
    expect(fromParam.status).toBe(0);
    expect(fromParam.stdout).toBe('https://param.example/playwright/');

    const empty = run('', '');
    expect(empty.status).toBe(2);
    expect(empty.stdout).toBe('');
    expect(empty.stderr).toContain('Playwright 浏览器下载地址未设置');
    expect(empty.stderr).toContain('https://<nexus-host>/repository/playwright-proxy/');
  });
});
