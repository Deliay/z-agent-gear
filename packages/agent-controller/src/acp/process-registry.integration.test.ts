import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Real-filesystem integration test: no fs mock. REGISTRY_DIR is redirected to a
// unique temp dir via the os mock so the module-level constant picks it up at
// import time. The dir itself is created lazily by the registry's ensureDir.
const TEST_HOME = vi.hoisted(() =>
  `${process.env.TMPDIR ?? '/tmp'}/zag-registry-it-${process.pid}-${Math.random().toString(36).slice(2)}`);

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

import { ProcessRegistry } from './process-registry.js';

const REGISTRY_DIR = join(TEST_HOME, '.zag');
const REGISTRY_FILE = join(REGISTRY_DIR, 'processes.json');

describe('ProcessRegistry (real fs integration)', () => {
  beforeEach(() => {
    rmSync(REGISTRY_DIR, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('persists registered entries to disk and reloads them', () => {
    const registry = new ProcessRegistry();
    registry.register('s1', { pid: process.pid, cwd: '/tmp/project', acpServerType: 'opencode' });

    expect(existsSync(REGISTRY_FILE)).toBe(true);
    const onDisk = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.processes).toHaveLength(1);
    expect(onDisk.processes[0].sessionId).toBe('s1');

    const reloaded = new ProcessRegistry();
    expect(reloaded.get('s1')).toBeDefined();
    expect(reloaded.get('s1')!.pid).toBe(process.pid);
  });

  it('deregister removes the entry from disk', () => {
    const registry = new ProcessRegistry();
    registry.register('s1', { pid: process.pid, cwd: '/tmp', acpServerType: 'opencode' });
    registry.deregister('s1');

    const onDisk = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
    expect(onDisk.processes).toHaveLength(0);
    expect(new ProcessRegistry().get('s1')).toBeUndefined();
  });

  it('prunes dead PIDs on load', () => {
    const registry = new ProcessRegistry();
    registry.register('alive', { pid: process.pid, cwd: '/tmp', acpServerType: 'opencode' });
    // PID beyond common pid_max values, must not exist
    registry.register('dead', { pid: 4194304 + 12345, cwd: '/tmp', acpServerType: 'opencode' });

    const reloaded = new ProcessRegistry();
    expect(reloaded.get('alive')).toBeDefined();
    expect(reloaded.get('dead')).toBeUndefined();
  });
});
