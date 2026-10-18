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
import * as migration from './002-refresh-docker-preset-script';

type CreateArg = {
  name: string;
  initScript: string;
  postScript: null | string;
  paramSchema: Array<Record<string, unknown>>;
  dependsOnWorkloadIds: unknown[];
  presetKey: string;
  isPreset: boolean;
};

describe('migration 002-refresh-docker-preset-script', () => {
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

  it('exposes the migration name', () => {
    expect(migration.name).toBe('002-refresh-docker-preset-script');
  });

  it('T-MIG9: creates the Docker preset when neither presetKey nor name exists', async () => {
    await migration.run();

    expect(CloudWorkload.create).toHaveBeenCalledTimes(1);
    const arg = (CloudWorkload.create as any).mock.calls[0][0] as CreateArg;
    expect(arg).toMatchObject({
      name: 'Docker',
      initScript: migration.DOCKER_SCRIPT_V2,
      postScript: null,
      paramSchema: [],
      dependsOnWorkloadIds: [],
      presetKey: 'docker',
      isPreset: true,
    });
  });

  it('T-MIG5: refreshes an unmodified v1 script to v2', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const doc = { presetKey: 'docker', initScript: DOCKER_SCRIPT_V1, save };
    (CloudWorkload.findOne as any).mockResolvedValue(doc);

    await migration.run();

    expect(doc.initScript).toBe(migration.DOCKER_SCRIPT_V2);
    expect(save).toHaveBeenCalledTimes(1);
    expect(CloudWorkload.create).not.toHaveBeenCalled();
  });

  it('T-MIG6: is idempotent — an already refreshed v2 script is left untouched', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const doc = { presetKey: 'docker', initScript: migration.DOCKER_SCRIPT_V2, save };
    (CloudWorkload.findOne as any).mockResolvedValue(doc);

    await migration.run();

    expect(doc.initScript).toBe(migration.DOCKER_SCRIPT_V2);
    expect(save).not.toHaveBeenCalled();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
  });

  it('T-MIG7: never overwrites an admin-customized script (warns instead)', async () => {
    const custom = '#!/usr/bin/env bash\necho my-custom-docker-setup\n';
    const save = vi.fn().mockResolvedValue(undefined);
    const doc = { presetKey: 'docker', initScript: custom, save };
    (CloudWorkload.findOne as any).mockResolvedValue(doc);

    await migration.run();

    expect(doc.initScript).toBe(custom);
    expect(save).not.toHaveBeenCalled();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('T-MIG8: warns and skips when only an exact-named "Docker" workload exists', async () => {
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

  it('T-MIG10: DOCKER_SCRIPT_V2 is valid bash, installs dockerd, starts it and verifies', () => {
    const script = migration.DOCKER_SCRIPT_V2;

    // 安装包列表必须包含提供 dockerd 的 docker-ce（docker-ce-cli 仅客户端，不含守护进程）
    expect(script).toContain(
      'apt-get install -y --no-install-recommends docker-ce docker-ce-cli docker-buildx-plugin containerd.io',
    );
    // 幂等锚点同时覆盖 CLI 与 dockerd，收敛半安装状态
    expect(script).toContain('[ ! -x /usr/bin/dockerd ]');
    expect(script).toContain('nohup dockerd');
    expect(script).toContain('docker buildx version');

    // 默认安装来源走内网 Nexus 代理，不回退公网
    expect(script).toContain('nexus.internal.fffdan.com/repository/docker-ce-proxy');
    expect(script).not.toContain('mirrors.ustc.edu.cn');
    expect(script).not.toContain('download.docker.com');

    const dir = mkdtempSync(join(tmpdir(), 'zag-mig002-'));
    const file = join(dir, 'docker-v2.sh');
    try {
      writeFileSync(file, script);
      expect(() => execFileSync('bash', ['-n', file])).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
