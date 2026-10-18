import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../models/cloud-workload.js', () => ({
  CloudWorkload: { findOne: vi.fn(), create: vi.fn() },
}));

import { CloudWorkload } from '../models/cloud-workload.js';
import { DOCKER_SCRIPT_V1 } from './001-preset-workloads';
import { DOCKER_SCRIPT_V2 } from './002-refresh-docker-preset-script';
import * as migration from './003-docker-apt-source';

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

describe('migration 003-docker-apt-source', () => {
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
      presetKey: 'docker',
      initScript: null,
      paramSchema: [],
      save: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    (CloudWorkload.findOne as any).mockResolvedValue(doc);
    return doc;
  }

  it('T-MIG11: exposes the migration name', () => {
    expect(migration.name).toBe('003-docker-apt-source');
  });

  it('T-MIG12: refreshes an unmodified v2 script to v3 and appends the docker_apt_url param', async () => {
    const doc = mockExistingDoc({ initScript: DOCKER_SCRIPT_V2, paramSchema: [] });

    await migration.run();

    expect(doc.initScript).toBe(migration.DOCKER_SCRIPT_V3);
    expect(doc.paramSchema).toHaveLength(1);
    expect(doc.paramSchema?.[0]).toMatchObject({
      key: 'docker_apt_url',
      label: 'Docker CE 软件源地址',
      type: 'text',
      options: [],
      defaultValue: migration.DOCKER_APT_URL_DEFAULT,
    });
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(CloudWorkload.create).not.toHaveBeenCalled();
  });

  it('T-MIG13: refreshes an unmodified v1 script to v3 and appends the param', async () => {
    const doc = mockExistingDoc({ initScript: DOCKER_SCRIPT_V1, paramSchema: [] });

    await migration.run();

    expect(doc.initScript).toBe(migration.DOCKER_SCRIPT_V3);
    expect(doc.paramSchema).toHaveLength(1);
    expect(doc.paramSchema?.[0]).toMatchObject({ key: 'docker_apt_url' });
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(CloudWorkload.create).not.toHaveBeenCalled();
  });

  it('T-MIG14: is idempotent — already v3 with the param leaves everything untouched', async () => {
    const existingParam = {
      key: 'docker_apt_url',
      label: '自定义标签',
      type: 'text',
      options: [],
      defaultValue: 'https://admin.example/docker-ce-apt',
    };
    const doc = mockExistingDoc({
      initScript: migration.DOCKER_SCRIPT_V3,
      paramSchema: [existingParam],
    });

    await migration.run();

    expect(doc.initScript).toBe(migration.DOCKER_SCRIPT_V3);
    expect(doc.paramSchema).toEqual([existingParam]);
    expect(doc.save).not.toHaveBeenCalled();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
  });

  it('T-MIG15: already v3 but missing the param only appends the param', async () => {
    const doc = mockExistingDoc({ initScript: migration.DOCKER_SCRIPT_V3, paramSchema: [] });

    await migration.run();

    expect(doc.initScript).toBe(migration.DOCKER_SCRIPT_V3);
    expect(doc.paramSchema).toHaveLength(1);
    expect(doc.paramSchema?.[0]).toMatchObject({ key: 'docker_apt_url' });
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(CloudWorkload.create).not.toHaveBeenCalled();
  });

  it('T-MIG16: never overwrites an admin-customized script (warns instead, no param appended)', async () => {
    const custom = '#!/usr/bin/env bash\necho my-custom-docker-setup\n';
    const doc = mockExistingDoc({ initScript: custom, paramSchema: [] });

    await migration.run();

    expect(doc.initScript).toBe(custom);
    expect(doc.paramSchema).toEqual([]);
    expect(doc.save).not.toHaveBeenCalled();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('T-MIG17a: warns and skips when only an exact-named "Docker" workload exists', async () => {
    (CloudWorkload.findOne as any).mockImplementation(
      (filter: { presetKey?: string; name?: string }) => {
        if (filter.presetKey === 'docker') return Promise.resolve(null);
        if (filter.name === 'Docker') return Promise.resolve({ _id: 'existing-docker' });
        return Promise.resolve(null);
      },
    );

    await migration.run();

    expect(CloudWorkload.create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('T-MIG17b: defensively creates the preset when neither presetKey nor name exists', async () => {
    await migration.run();

    expect(CloudWorkload.create).toHaveBeenCalledTimes(1);
    const arg = (CloudWorkload.create as any).mock.calls[0][0] as CreateArg;
    expect(arg).toMatchObject({
      name: 'Docker',
      initScript: migration.DOCKER_SCRIPT_V3,
      postScript: null,
      paramSchema: [migration.DOCKER_APT_PARAM],
      dependsOnWorkloadIds: [],
      presetKey: 'docker',
      isPreset: true,
    });
  });

  it('T-MIG18: DOCKER_SCRIPT_V3 keeps install invariants, has no hardcoded source and is valid bash', () => {
    const script = migration.DOCKER_SCRIPT_V3;

    // 取值优先级：env 覆盖参数，参数兜底，均缺失则为空
    expect(script).toContain(
      'DOCKER_APT_URL="${DOCKER_APT_URL:-${WORKLOAD_PARAM_DOCKER_APT_URL:-}}"',
    );
    // 尾斜杠归一
    expect(script).toContain(
      'while [ "${DOCKER_APT_URL%/}" != "$DOCKER_APT_URL" ]; do DOCKER_APT_URL="${DOCKER_APT_URL%/}"; done',
    );

    // 失败指引含正确地址形态，不含已废弃的 /linux/ubuntu 形态
    expect(script).toContain('https://<nexus-host>/repository/<docker-ce-apt>/');
    expect(script).not.toContain('/linux/ubuntu');

    // 脚本内不内置任何具体来源（默认值只在参数定义里）
    expect(script).not.toContain('nexus.internal');
    expect(script).not.toContain('download.docker.com');
    expect(script).not.toContain('docker-ce-proxy');

    // 安装与运行时步骤逐字不变
    expect(script).toContain(
      'apt-get install -y --no-install-recommends docker-ce docker-ce-cli docker-buildx-plugin containerd.io',
    );
    expect(script).toContain('[ ! -x /usr/bin/dockerd ]');
    expect(script).toContain('nohup dockerd');
    expect(script).toContain('docker buildx version');

    const dir = mkdtempSync(join(tmpdir(), 'zag-mig003-'));
    const file = join(dir, 'docker-v3.sh');
    try {
      writeFileSync(file, script);
      expect(() => execFileSync('bash', ['-n', file])).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T-MIG19: the extract/trim snippet resolves the source with the documented precedence', () => {
    const lines = migration.DOCKER_SCRIPT_V3.split('\n');
    const startIdx = lines.findIndex((line) =>
      line.includes('DOCKER_APT_URL="${DOCKER_APT_URL:-'),
    );
    expect(startIdx).toBeGreaterThanOrEqual(0);
    const snippet = [lines[startIdx], lines[startIdx + 1]].join('\n');

    const evaluate = (dockerAptUrl: string, workloadParam: string): string =>
      execFileSync('bash', ['-c', `${snippet}\nprintf '%s' "$DOCKER_APT_URL"`], {
        env: {
          ...process.env,
          DOCKER_APT_URL: dockerAptUrl,
          WORKLOAD_PARAM_DOCKER_APT_URL: workloadParam,
        },
      }).toString();

    // env 覆盖参数
    expect(evaluate('https://env.example/docker-ce-apt', 'https://param.example/docker-ce-apt')).toBe(
      'https://env.example/docker-ce-apt',
    );
    // 仅参数生效
    expect(evaluate('', 'https://param.example/docker-ce-apt')).toBe(
      'https://param.example/docker-ce-apt',
    );
    // 两者都空 → 空
    expect(evaluate('', '')).toBe('');
    // 尾斜杠归一为无斜杠
    expect(evaluate('', 'https://param.example/docker-ce-apt/')).toBe(
      'https://param.example/docker-ce-apt',
    );
  });
});
