import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger as rootLogger } from '../observability/logger.js';
import { createTestLogger } from '../observability/testing.js';

vi.mock('../models/cloud-workload.js', () => ({
  CloudWorkload: { findOne: vi.fn(), create: vi.fn() },
}));

import { CloudWorkload } from '../models/cloud-workload.js';
import { DOCKER_SCRIPT_V1 } from './001-preset-workloads';
import { DOCKER_SCRIPT_V2 } from './002-refresh-docker-preset-script';
import { DOCKER_SCRIPT_V3 } from './003-docker-apt-source';
import { DOCKER_SCRIPT_V4 } from './012-worker-user-scripts';

const testLog = createTestLogger();
const childSpy = vi
  .spyOn(rootLogger, 'child')
  .mockImplementation((bindings) => testLog.logger.child(bindings));
const migration = await import('./020-docker-shim-value-options.js');
childSpy.mockRestore();

type MockDoc = {
  presetKey?: string | null;
  initScript?: string | null;
  markModified?: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
};

/** 从工作负载脚本中抽出 `<<'SHIM' ... SHIM` heredoc 内容。 */
function extractShim(script: string): string {
  const marker = "<<'SHIM'\n";
  const start = script.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = start + marker.length;
  const end = script.indexOf('\nSHIM\n', bodyStart);
  expect(end).toBeGreaterThanOrEqual(0);
  return script.slice(bodyStart, end + 1);
}

/** 执行 shim（把真实 docker 替换为 argv 捕获器），返回最终传给 docker 的参数。 */
function runShim(args: string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'zag-mig020-'));
  try {
    const fakeDocker = join(dir, 'fake-docker');
    writeFileSync(
      fakeDocker,
      '#!/usr/bin/env bash\nprintf \'%s\\0\' "$@"\n',
    );
    chmodSync(fakeDocker, 0o755);

    const shimPath = join(dir, 'docker');
    writeFileSync(
      shimPath,
      extractShim(migration.DOCKER_SCRIPT_V5).replaceAll('/usr/bin/docker', fakeDocker),
    );

    const output = execFileSync('bash', [shimPath, ...args], { encoding: 'utf8' });
    return output.split('\0').filter((value) => value !== '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PROXY = 'core.harbor.internal.fffdan.com';
const proxied = (image: string) => `${PROXY}/docker-hub-proxy/${image}`;

describe('migration 020-docker-shim-value-options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testLog.reset();
    (CloudWorkload.findOne as any).mockResolvedValue(null);
    (CloudWorkload.create as any).mockResolvedValue({ _id: 'docker' });
  });

  function mockExistingDoc(overrides: Partial<MockDoc>): MockDoc {
    const doc: MockDoc = {
      presetKey: 'docker',
      initScript: DOCKER_SCRIPT_V4,
      markModified: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    (CloudWorkload.findOne as any).mockResolvedValue(doc);
    return doc;
  }

  it('T-MIG20: exposes the migration name', () => {
    expect(migration.name).toBe('020-docker-shim-value-options');
  });

  it.each([
    ['v1', DOCKER_SCRIPT_V1],
    ['v2', DOCKER_SCRIPT_V2],
    ['v3', DOCKER_SCRIPT_V3],
    ['v4', DOCKER_SCRIPT_V4],
  ])('T-MIG21: refreshes an unmodified %s docker script to v5', async (_label, script) => {
    const doc = mockExistingDoc({ initScript: script });

    await migration.run();

    expect(doc.initScript).toBe(migration.DOCKER_SCRIPT_V5);
    expect(doc.markModified).toHaveBeenCalledWith('initScript');
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(CloudWorkload.create).not.toHaveBeenCalled();
  });

  it('T-MIG22: is idempotent when the script is already v5', async () => {
    const doc = mockExistingDoc({ initScript: migration.DOCKER_SCRIPT_V5 });

    await migration.run();

    expect(doc.initScript).toBe(migration.DOCKER_SCRIPT_V5);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('T-MIG23: never overwrites an admin-customized script', async () => {
    const custom = '#!/usr/bin/env bash\necho my-custom-docker-setup\n';
    const doc = mockExistingDoc({ initScript: custom });

    await migration.run();

    expect(doc.initScript).toBe(custom);
    expect(doc.save).not.toHaveBeenCalled();
    expect(testLog.records.some((record) => record.level === 'warn')).toBe(true);
  });

  it('T-MIG24: does not recreate a preset deleted by an admin', async () => {
    await migration.run();

    expect(CloudWorkload.create).not.toHaveBeenCalled();
  });

  it('T-MIG25: DOCKER_SCRIPT_V5 is valid bash and keeps the install invariants', () => {
    const script = migration.DOCKER_SCRIPT_V5;

    expect(script).toContain('nohup dockerd');
    expect(script).toContain('docker buildx version');
    expect(script).toContain('VALUE_LONG_OPTS=');

    const dir = mkdtempSync(join(tmpdir(), 'zag-mig020-syntax-'));
    const file = join(dir, 'docker-v5.sh');
    try {
      writeFileSync(file, script);
      expect(() => execFileSync('bash', ['-n', file])).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T-MIG26: create/run skip values of value-taking options before normalizing the image', () => {
    expect(runShim(['create', '--name', 'test-create-repro', 'redis:8.6'])).toEqual([
      'create',
      '--name',
      'test-create-repro',
      proxied('redis:8.6'),
    ]);

    expect(
      runShim([
        'run',
        '-d',
        '--name',
        'test-redis',
        '-e',
        'FOO=bar',
        '-p',
        '8080:80',
        '-v',
        '/a:/b',
        '--platform',
        'linux/amd64',
        'redis:8.6',
      ]),
    ).toEqual([
      'run',
      '-d',
      '--name',
      'test-redis',
      '-e',
      'FOO=bar',
      '-p',
      '8080:80',
      '-v',
      '/a:/b',
      '--platform',
      'linux/amd64',
      proxied('redis:8.6'),
    ]);
  });

  it('T-MIG27: equals-form and concatenated short options are passed through untouched', () => {
    expect(
      runShim([
        'run',
        '-it',
        '--rm',
        '--name=eq-form',
        '-eFOO=bar',
        '-p8080:80',
        'redis:8.6',
        'sh',
        '-c',
        'echo hi',
      ]),
    ).toEqual([
      'run',
      '-it',
      '--rm',
      '--name=eq-form',
      '-eFOO=bar',
      '-p8080:80',
      proxied('redis:8.6'),
      'sh',
      '-c',
      'echo hi',
    ]);
  });

  it('T-MIG28: pull treats -a/-q as booleans and only skips --platform values', () => {
    expect(runShim(['pull', '--platform', 'linux/amd64', 'redis:8.6'])).toEqual([
      'pull',
      '--platform',
      'linux/amd64',
      proxied('redis:8.6'),
    ]);
    expect(runShim(['pull', '-a', 'redis:8.6'])).toEqual(['pull', '-a', proxied('redis:8.6')]);
    expect(runShim(['pull', '-q', 'ghcr.io/acme/app:1.0'])).toEqual([
      'pull',
      '-q',
      `${PROXY}/ghcr/acme/app:1.0`,
    ]);
  });

  it('T-MIG29: unknown long options are treated as boolean so the image is still normalized', () => {
    expect(runShim(['run', '--brand-new-flag', 'redis:8.6'])).toEqual([
      'run',
      '--brand-new-flag',
      proxied('redis:8.6'),
    ]);
  });

  it('T-MIG30: other subcommands pass through unchanged', () => {
    expect(runShim(['ps', '-a'])).toEqual(['ps', '-a']);
  });

  it('T-MIG31: options terminator still normalizes the first positional afterwards', () => {
    expect(runShim(['run', '-d', '--', 'redis:8.6', 'sh', '-c', 'echo hi'])).toEqual([
      'run',
      '-d',
      '--',
      proxied('redis:8.6'),
      'sh',
      '-c',
      'echo hi',
    ]);
    expect(runShim(['pull', '--', 'redis:8.6'])).toEqual(['pull', '--', proxied('redis:8.6')]);
  });
});
