import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/cloud-workload.js', () => ({
  CloudWorkload: { findOne: vi.fn(), create: vi.fn() },
}));

import { CloudWorkload } from '../models/cloud-workload.js';
import * as migration from './011-refresh-harness-prepare-scope';
import {
  HARNESS_OPENCODE_INIT_SCRIPT,
  HARNESS_OPENCODE_INIT_SCRIPT_V1,
} from './006-preset-harness-opencode';
import {
  HARNESS_DEEPSEEK_INIT_SCRIPT,
  HARNESS_DEEPSEEK_INIT_SCRIPT_V1,
} from './010-preset-harness-deepseek';

type Doc = {
  presetKey: string;
  initScript: string;
  save: ReturnType<typeof vi.fn>;
};

function doc(presetKey: string, initScript: string): Doc {
  return { presetKey, initScript, save: vi.fn().mockResolvedValue(undefined) };
}

/** 按 presetKey 路由 findOne 结果。 */
function mockFindOne(docs: Record<string, Doc | null>): void {
  (CloudWorkload.findOne as any).mockImplementation((filter: { presetKey?: string }) =>
    Promise.resolve(filter.presetKey ? (docs[filter.presetKey] ?? null) : null),
  );
}

describe('migration 011-refresh-harness-prepare-scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('exposes the migration name', () => {
    expect(migration.name).toBe('011-refresh-harness-prepare-scope');
  });

  it('V1/V2 常量锚定：V1 为裸 prepare，V2 按类型限定', () => {
    expect(HARNESS_OPENCODE_INIT_SCRIPT_V1).toMatch(/^agent-gear harness prepare$/m);
    expect(HARNESS_DEEPSEEK_INIT_SCRIPT_V1).toMatch(/^agent-gear harness prepare$/m);
    expect(HARNESS_OPENCODE_INIT_SCRIPT).toContain(
      'ZAG_HARNESS_TYPES=opencode agent-gear harness prepare',
    );
    expect(HARNESS_DEEPSEEK_INIT_SCRIPT).toContain(
      'ZAG_HARNESS_TYPES=deepseek_harness agent-gear harness prepare',
    );
  });

  it('T-MIG11a: 未定制的存量脚本（V1）刷新为按类型限定的 V2', async () => {
    const opencode = doc('harness-opencode', HARNESS_OPENCODE_INIT_SCRIPT_V1);
    const deepseek = doc('harness-deepseek-harness', HARNESS_DEEPSEEK_INIT_SCRIPT_V1);
    mockFindOne({ 'harness-opencode': opencode, 'harness-deepseek-harness': deepseek });

    await migration.run();

    expect(opencode.initScript).toBe(HARNESS_OPENCODE_INIT_SCRIPT);
    expect(opencode.save).toHaveBeenCalledTimes(1);
    expect(deepseek.initScript).toBe(HARNESS_DEEPSEEK_INIT_SCRIPT);
    expect(deepseek.save).toHaveBeenCalledTimes(1);
  });

  it('T-MIG11b: 已是 V2 时幂等跳过', async () => {
    const opencode = doc('harness-opencode', HARNESS_OPENCODE_INIT_SCRIPT);
    const deepseek = doc('harness-deepseek-harness', HARNESS_DEEPSEEK_INIT_SCRIPT);
    mockFindOne({ 'harness-opencode': opencode, 'harness-deepseek-harness': deepseek });

    await migration.run();

    expect(opencode.save).not.toHaveBeenCalled();
    expect(deepseek.save).not.toHaveBeenCalled();
  });

  it('T-MIG11c: 管理员定制过的脚本不覆盖（告警跳过）', async () => {
    const custom = '#!/usr/bin/env bash\necho custom\nagent-gear harness prepare\n';
    const opencode = doc('harness-opencode', custom);
    const deepseek = doc('harness-deepseek-harness', custom);
    mockFindOne({ 'harness-opencode': opencode, 'harness-deepseek-harness': deepseek });

    await migration.run();

    expect(opencode.initScript).toBe(custom);
    expect(opencode.save).not.toHaveBeenCalled();
    expect(deepseek.save).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('T-MIG11d: 预置项不存在时跳过（由各自 preset 迁移负责创建）', async () => {
    mockFindOne({});

    await expect(migration.run()).resolves.toBeUndefined();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
  });
});
