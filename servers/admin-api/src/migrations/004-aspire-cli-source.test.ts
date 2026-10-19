import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../models/cloud-workload.js', () => ({
  CloudWorkload: { findOne: vi.fn(), create: vi.fn() },
}));

import { CloudWorkload } from '../models/cloud-workload.js';
import { ASPIRE_SCRIPT_V1 } from './001-preset-workloads';
import * as migration from './004-aspire-cli-source';

type CreateArg = {
  name: string;
  initScript: string;
  postScript: null | string;
  paramSchema: Array<Record<string, unknown>>;
  dependsOnWorkloadIds: unknown[];
  presetKey: string;
  isPreset: boolean;
};

type MockDoc = {
  presetKey?: string | null;
  initScript?: string | null;
  paramSchema?: Array<Record<string, unknown>>;
  save: ReturnType<typeof vi.fn>;
};

describe('migration 004-aspire-cli-source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // 默认：预设项与其同名项都不存在
    (CloudWorkload.findOne as any).mockResolvedValue(null);
    (CloudWorkload.create as any).mockImplementation((doc: { name: string }) =>
      Promise.resolve({ _id: `id-${doc.name}` }),
    );
  });

  function mockExistingDoc(overrides: Partial<MockDoc>): MockDoc {
    const doc: MockDoc = {
      presetKey: 'aspire',
      initScript: null,
      paramSchema: [],
      save: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    (CloudWorkload.findOne as any).mockResolvedValue(doc);
    return doc;
  }

  it('T-MIG20: exposes the migration name', () => {
    expect(migration.name).toBe('004-aspire-cli-source');
  });

  it('T-MIG21: refreshes an unmodified v1 script to v2 and appends the aspire_cli_url param', async () => {
    const doc = mockExistingDoc({ initScript: ASPIRE_SCRIPT_V1, paramSchema: [] });

    await migration.run();

    expect(doc.initScript).toBe(migration.ASPIRE_SCRIPT_V2);
    expect(doc.paramSchema).toHaveLength(1);
    expect(doc.paramSchema?.[0]).toMatchObject({
      key: 'aspire_cli_url',
      label: 'Aspire CLI 下载地址',
      type: 'text',
      options: [],
      defaultValue: migration.ASPIRE_CLI_URL_DEFAULT,
    });
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(CloudWorkload.create).not.toHaveBeenCalled();
  });

  it('T-MIG22: is idempotent — already v2 with the param leaves everything untouched', async () => {
    const existingParam = {
      key: 'aspire_cli_url',
      label: '自定义标签',
      type: 'text',
      options: [],
      defaultValue: 'https://admin.example/aspire-cli.tar.gz',
    };
    const doc = mockExistingDoc({
      initScript: migration.ASPIRE_SCRIPT_V2,
      paramSchema: [existingParam],
    });

    await migration.run();

    expect(doc.initScript).toBe(migration.ASPIRE_SCRIPT_V2);
    expect(doc.paramSchema).toEqual([existingParam]);
    expect(doc.save).not.toHaveBeenCalled();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
  });

  it('T-MIG23: already v2 but missing the param only appends the param', async () => {
    const doc = mockExistingDoc({ initScript: migration.ASPIRE_SCRIPT_V2, paramSchema: [] });

    await migration.run();

    expect(doc.initScript).toBe(migration.ASPIRE_SCRIPT_V2);
    expect(doc.paramSchema).toHaveLength(1);
    expect(doc.paramSchema?.[0]).toMatchObject({ key: 'aspire_cli_url' });
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(CloudWorkload.create).not.toHaveBeenCalled();
  });

  it('T-MIG24: never overwrites an admin-customized script (warns instead, no param appended)', async () => {
    const custom = '#!/usr/bin/env bash\necho my-custom-aspire-setup\n';
    const doc = mockExistingDoc({ initScript: custom, paramSchema: [] });

    await migration.run();

    expect(doc.initScript).toBe(custom);
    expect(doc.paramSchema).toEqual([]);
    expect(doc.save).not.toHaveBeenCalled();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('T-MIG25a: warns and skips when only an exact-named "Aspire" workload exists', async () => {
    (CloudWorkload.findOne as any).mockImplementation(
      (filter: { presetKey?: string; name?: string }) => {
        if (filter.presetKey === 'aspire') return Promise.resolve(null);
        if (filter.name === 'Aspire') return Promise.resolve({ _id: 'existing-aspire' });
        return Promise.resolve(null);
      },
    );

    await migration.run();

    expect(CloudWorkload.create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('T-MIG25b: defensively creates the preset when neither presetKey nor name exists', async () => {
    await migration.run();

    expect(CloudWorkload.create).toHaveBeenCalledTimes(1);
    const arg = (CloudWorkload.create as any).mock.calls[0][0] as CreateArg;
    expect(arg).toMatchObject({
      name: 'Aspire',
      initScript: migration.ASPIRE_SCRIPT_V2,
      postScript: null,
      paramSchema: [migration.ASPIRE_CLI_PARAM],
      dependsOnWorkloadIds: [],
      presetKey: 'aspire',
      isPreset: true,
    });
  });

  it('T-MIG26: ASPIRE_SCRIPT_V2 keeps install invariants, has no hardcoded source and is valid bash', () => {
    const script = migration.ASPIRE_SCRIPT_V2;

    // 取值优先级：env 覆盖参数，参数兜底，均缺失则为空
    expect(script).toContain(
      'ASPIRE_CLI_URL="${ASPIRE_CLI_URL:-${WORKLOAD_PARAM_ASPIRE_CLI_URL:-}}"',
    );

    // 直连下载安装包并解压到官方安装布局
    expect(script).toContain('curl -fsSL');
    expect(script).toContain('tar -xzf');
    expect(script).toContain('install -m 0755 -d "$HOME/.aspire/bin"');
    expect(script).toContain('aspire --version');

    // 保留 v1 的前置检查与幂等锚点
    expect(script).toContain('.NET 未就绪');
    expect(script).toContain('Docker 未就绪');
    expect(script).toContain('$HOME/.aspire/bin/aspire');

    // 失败指引含地址形态示例
    expect(script).toContain(
      'https://<nexus-host>/repository/misc-cache/dotnet/aspire-cli-linux-x64.tar.gz',
    );

    // 脚本内不内置任何具体来源，也不再引用已退役的官方安装脚本变量
    expect(script).not.toContain('nexus.internal');
    expect(script).not.toContain('aka.ms');
    expect(script).not.toContain('aspire.dev');
    expect(script).not.toContain('install.sh');
    expect(script).not.toContain('ASPIRE_INSTALL_URL');

    const dir = mkdtempSync(join(tmpdir(), 'zag-mig004-'));
    const file = join(dir, 'aspire-v2.sh');
    try {
      writeFileSync(file, script);
      expect(() => execFileSync('bash', ['-n', file])).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T-MIG27: the source-resolution/guard snippet follows the documented precedence', () => {
    const lines = migration.ASPIRE_SCRIPT_V2.split('\n');
    const startIdx = lines.findIndex((line) =>
      line.includes('ASPIRE_CLI_URL="${ASPIRE_CLI_URL:-'),
    );
    expect(startIdx).toBeGreaterThanOrEqual(0);
    const guardIdx = lines.findIndex((line, i) => i > startIdx && line.trim() === 'exit 2');
    expect(guardIdx).toBeGreaterThan(startIdx);
    const endIdx = lines.findIndex((line, i) => i > guardIdx && line.trim() === 'fi');
    expect(endIdx).toBeGreaterThan(guardIdx);
    const snippet = lines.slice(startIdx, endIdx + 1).join('\n');

    const run = (envUrl: string, paramUrl: string) =>
      spawnSync('bash', ['-c', `${snippet}\nprintf '%s' "$ASPIRE_CLI_URL"`], {
        env: {
          ...process.env,
          ASPIRE_CLI_URL: envUrl,
          WORKLOAD_PARAM_ASPIRE_CLI_URL: paramUrl,
        },
        encoding: 'utf8',
      });

    // env 覆盖参数
    const fromEnv = run('https://env.example/aspire-cli.tar.gz', 'https://param.example/aspire-cli.tar.gz');
    expect(fromEnv.status).toBe(0);
    expect(fromEnv.stdout).toBe('https://env.example/aspire-cli.tar.gz');

    // 仅参数生效
    const fromParam = run('', 'https://param.example/aspire-cli.tar.gz');
    expect(fromParam.status).toBe(0);
    expect(fromParam.stdout).toBe('https://param.example/aspire-cli.tar.gz');

    // 两者都空 → 快速失败（exit 2）+ 指引
    const empty = run('', '');
    expect(empty.status).toBe(2);
    expect(empty.stdout).toBe('');
    expect(empty.stderr).toContain('Aspire CLI 下载地址未设置');
    expect(empty.stderr).toContain(
      'https://<nexus-host>/repository/misc-cache/dotnet/aspire-cli-linux-x64.tar.gz',
    );
  });
});
