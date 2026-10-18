import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/cloud-workload.js', () => ({
  CloudWorkload: { findOne: vi.fn(), updateOne: vi.fn() },
}));

import { CloudWorkload } from '../models/cloud-workload.js';
import { DOTNET_SCRIPT } from './001-preset-workloads';
import * as migration from './002-preset-dotnet-apt';

function existing(initScript: unknown, id = 'dotnet-id') {
  return { _id: id, initScript };
}

describe('migration 002-preset-dotnet-apt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    (CloudWorkload.updateOne as any).mockResolvedValue({ modifiedCount: 1 });
  });

  it('exposes the migration name', () => {
    expect(migration.name).toBe('002-preset-dotnet-apt');
  });

  it('T-MIG2-1: upgrades an unmodified preset .NET initScript to the apt version (only initScript)', async () => {
    (CloudWorkload.findOne as any).mockResolvedValue(
      existing(migration.LEGACY_DOTNET_SCRIPT),
    );

    await migration.run();

    expect(CloudWorkload.findOne).toHaveBeenCalledWith({ presetKey: 'dotnet' });
    expect(CloudWorkload.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = (CloudWorkload.updateOne as any).mock.calls[0];
    expect(filter).toEqual({ _id: 'dotnet-id' });
    expect(update).toEqual({ $set: { initScript: DOTNET_SCRIPT } });
    // 升级后的脚本为 apt 版（不含 dotnet-install.sh）
    expect(DOTNET_SCRIPT).toContain('apt-get install');
    expect(DOTNET_SCRIPT).not.toContain('dotnet-install.sh');
  });

  it('T-MIG2-2: keeps a customized preset script and skips (with a warning)', async () => {
    (CloudWorkload.findOne as any).mockResolvedValue(existing('#!/usr/bin/env bash\necho custom\n'));

    await migration.run();

    expect(CloudWorkload.updateOne).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('T-MIG2-3: skips (with a warning) when the preset .NET does not exist (no rebuild, no error)', async () => {
    (CloudWorkload.findOne as any).mockResolvedValue(null);

    await expect(migration.run()).resolves.toBeUndefined();
    expect(CloudWorkload.updateOne).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('falls back to the exact name when presetKey is absent', async () => {
    (CloudWorkload.findOne as any).mockImplementation((filter: { presetKey?: string; name?: string }) => {
      if (filter.presetKey) return Promise.resolve(null);
      if (filter.name === '.NET') return Promise.resolve(existing(migration.LEGACY_DOTNET_SCRIPT));
      return Promise.resolve(null);
    });

    await migration.run();

    expect(CloudWorkload.findOne).toHaveBeenCalledWith({ name: '.NET' });
    expect(CloudWorkload.updateOne).toHaveBeenCalledTimes(1);
  });

  it('T-MIG2-4: a second run after upgrade does not overwrite again', async () => {
    // 首次：旧脚本 → 升级
    (CloudWorkload.findOne as any).mockResolvedValueOnce(existing(migration.LEGACY_DOTNET_SCRIPT));
    await migration.run();
    expect(CloudWorkload.updateOne).toHaveBeenCalledTimes(1);

    // 再次（模拟已升级后）：initScript 已是 apt 版，不再等值 → 跳过
    (CloudWorkload.findOne as any).mockResolvedValueOnce(existing(DOTNET_SCRIPT));
    await migration.run();
    expect(CloudWorkload.updateOne).toHaveBeenCalledTimes(1);
  });
});
