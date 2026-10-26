import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/cloud-workload.js', () => ({
  CloudWorkload: { findOne: vi.fn(), create: vi.fn() },
}));

import { CloudWorkload } from '../models/cloud-workload.js';
import * as migration from './012-worker-user-scripts';
import { HARNESS_OPENCODE_INIT_SCRIPT } from './006-preset-harness-opencode.js';
import { DOCKER_SCRIPT_V3 } from './003-docker-apt-source.js';

const finder = (docs: Record<string, unknown | null>) =>
  (CloudWorkload.findOne as any).mockImplementation((filter: { presetKey?: string; name?: string }) =>
    Promise.resolve(docs[filter.presetKey ?? filter.name ?? ''] ?? null),
  );

describe('migration 012-worker-user-scripts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    (CloudWorkload.create as any).mockResolvedValue({ _id: 'created' });
  });

  it('exposes the 012 migration name', () => {
    expect(migration.name).toBe('012-worker-user-scripts');
  });

  it('scripts use sudo fallback, worker paths and dockerd -G worker', () => {
    const docker = migration.DOCKER_SCRIPT_V4;
    expect(docker).toContain('SUDO=sudo; command -v sudo >/dev/null || SUDO=');
    expect(docker).toContain('${SUDO} apt-get');
    expect(docker).toContain("${SUDO} sh -c 'nohup dockerd -G worker");
    expect(migration.DOTNET_SCRIPT_V2).toContain('${SUDO} apt-get');
    expect(migration.GITHUB_SCRIPT_V2).toContain('${SUDO} apt-get install -y gh');
  });

  it('harness scripts create the worker workspace by default', () => {
    for (const script of [
      migration.HARNESS_OPENCODE_SCRIPT_V2,
      migration.HARNESS_KIMI_CODE_SCRIPT_V2,
      migration.HARNESS_DEEPSEEK_SCRIPT_V2,
    ]) {
      expect(script).toContain('${ZAG_DEFAULT_WORKSPACE:-/home/worker/workspace}');
      expect(script).not.toContain('ZAG_DEFAULT_WORKSPACE:-/root/workspace');
    }
  });

  it('refreshes stock docker script v3 to v4 and is idempotent', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const doc = { presetKey: 'docker', initScript: DOCKER_SCRIPT_V3, save };
    finder({ docker: doc });
    await migration.run();
    expect(doc.initScript).toBe(migration.DOCKER_SCRIPT_V4);
    await migration.run();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('never overwrites admin-customized scripts', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const doc = { presetKey: 'docker', initScript: '#!/bin/bash\necho custom\n', save };
    finder({ docker: doc });
    await migration.run();
    expect(doc.initScript).toContain('custom');
    expect(save).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('refreshes a stock harness script path to /home/worker/workspace', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const doc = { presetKey: 'harness-opencode', initScript: HARNESS_OPENCODE_INIT_SCRIPT, save };
    finder({ 'harness-opencode': doc });
    await migration.run();
    expect(doc.initScript).toBe(migration.HARNESS_OPENCODE_SCRIPT_V2);
  });

  it('migrates github targetPath from /root/workspace and legacy pattern', async () => {
    for (const [from, to] of [
      ['/root/workspace', '/home/worker/workspace'],
      ['/root/workspaces/{repo}', '/home/worker/workspaces/{repo}'],
    ]) {
      const save = vi.fn().mockResolvedValue(undefined);
      const doc = {
        presetKey: 'github',
        initScript: migration.GITHUB_SCRIPT_V2,
        paramSchema: [{ key: 'targetPath', defaultValue: from }],
        markModified: vi.fn(),
        save,
      };
      finder({ github: doc });
      await migration.run();
      expect(doc.paramSchema[0].defaultValue).toBe(to);
      expect(save).toHaveBeenCalled();
    }
  });

  it('creates missing harness presets with the refreshed script', async () => {
    finder({});
    await migration.run();
    const created = (CloudWorkload.create as any).mock.calls.map((c: unknown[]) => c[0] as any);
    expect(created).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ presetKey: 'harness-opencode', harnessType: 'opencode' }),
        expect.objectContaining({ presetKey: 'harness-kimi-code', harnessType: 'kimi_code' }),
        expect.objectContaining({ presetKey: 'harness-deepseek-harness', harnessType: 'deepseek_harness' }),
      ]),
    );
  });
});



describe('012 root-write anchors', () => {
  const bare = /^\s*(install|curl|chmod|rm|mkdir|ln|cat) .*(\/etc\/|\/usr\/local|\$SHIM_PATH)|\s> \/etc\//m;
  it('docker v4 has no bare root-requiring writes', () => {
    const lines = migration.DOCKER_SCRIPT_V4.split('\n').filter((l) => !l.includes('${SUDO}'));
    expect(lines.join('\n')).not.toMatch(bare);
    expect(migration.DOCKER_SCRIPT_V4).toContain('${SUDO} install -m 0755 -d /etc/apt/keyrings');
    expect(migration.DOCKER_SCRIPT_V4).toContain('${SUDO} tee "$SHIM_PATH"');
    expect(migration.DOCKER_SCRIPT_V4).toContain('${SUDO} chmod +x "$SHIM_PATH"');
    expect(migration.DOCKER_SCRIPT_V4).toContain("${SUDO} sh -c 'nohup dockerd -G worker");
  });
  it('github v2 falls back with sudo', () => {
    expect(migration.GITHUB_SCRIPT_V2).toContain('${SUDO} install -m 0755 -d /etc/apt/keyrings');
    expect(migration.GITHUB_SCRIPT_V2).toContain('${SUDO} curl ');
    expect(migration.GITHUB_SCRIPT_V2).toContain('| ${SUDO} tee /etc/apt/sources.list.d/github-cli.list');
  });
  it('aspire v3 elevates link and profile writes', () => {
    expect(migration.ASPIRE_SCRIPT_V3).toContain('${SUDO} ln -sfn "$HOME/.aspire/bin/aspire" /usr/local/bin/aspire');
    expect(migration.ASPIRE_SCRIPT_V3).toContain('${SUDO} ln -sfn "$ASPIRE_BIN" /usr/local/bin/aspire');
    expect(migration.ASPIRE_SCRIPT_V3).toContain('| ${SUDO} tee /etc/profile.d/aspire.sh');
    expect(migration.ASPIRE_SCRIPT_V3).toContain('${SUDO} chmod +x /etc/profile.d/aspire.sh');
  });
});
