import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../models/harness-config.js', () => ({
  HarnessConfig: {
    findOne: vi.fn(),
  },
}));

import { HarnessConfig } from '../models/harness-config.js';
import { HARNESS_ACP_TYPES, HARNESS_TYPES } from '../models/cloud-host.js';
import {
  ACP_SERVER_TO_HARNESS,
  DEFAULT_COMPACT_COMMAND,
  _clearCompactCommandCache,
  resolveCompactCommand,
} from './harness-config.js';

function leanQuery(result: unknown) {
  return { lean: vi.fn().mockResolvedValue(result) } as never;
}

describe('resolveCompactCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearCompactCommandCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('T-HCR1: opcode/kimi_code/deepseek_harness 映射命中并读只读镜像值', async () => {
    vi.mocked(HarnessConfig.findOne).mockReturnValue(leanQuery({ compactCommand: '/compact-kimi' }));

    for (const acp of ['opencode', 'kimi_code', 'deepseek_harness']) {
      _clearCompactCommandCache();
      vi.mocked(HarnessConfig.findOne).mockReturnValue(
        leanQuery({ compactCommand: `/compact-${acp}` }),
      );
      await expect(resolveCompactCommand(acp)).resolves.toBe(`/compact-${acp}`);
      expect(HarnessConfig.findOne).toHaveBeenCalledWith({
        harnessType: ACP_SERVER_TO_HARNESS[acp],
      });
    }
  });

  it('T-HCR2: 未映射 acpServerType → 默认 /compact 且不查库', async () => {
    await expect(resolveCompactCommand('claude_code')).resolves.toBe(DEFAULT_COMPACT_COMMAND);
    expect(DEFAULT_COMPACT_COMMAND).toBe('/compact');
    expect(HarnessConfig.findOne).not.toHaveBeenCalled();
  });

  it('T-HCR2b: 镜像无配置行 → 默认 /compact', async () => {
    vi.mocked(HarnessConfig.findOne).mockReturnValue(leanQuery(null));
    await expect(resolveCompactCommand('opencode')).resolves.toBe(DEFAULT_COMPACT_COMMAND);
  });

  it('T-HCR3: 60s 缓存：第二次调用无 DB 查询；过期后重新查询', async () => {
    vi.mocked(HarnessConfig.findOne).mockReturnValue(leanQuery({ compactCommand: '/cached' }));

    await resolveCompactCommand('opencode');
    await resolveCompactCommand('opencode');
    expect(HarnessConfig.findOne).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_001);
    vi.mocked(HarnessConfig.findOne).mockReturnValue(leanQuery({ compactCommand: '/fresh' }));
    await expect(resolveCompactCommand('opencode')).resolves.toBe('/fresh');
    expect(HarnessConfig.findOne).toHaveBeenCalledTimes(2);
  });

  it('T-HCR3b: 查询失败不缓存（下次重试）', async () => {
    vi.mocked(HarnessConfig.findOne).mockReturnValueOnce({
      lean: vi.fn().mockRejectedValue(new Error('mongo down')),
    } as never);
    await expect(resolveCompactCommand('opencode')).resolves.toBe(DEFAULT_COMPACT_COMMAND);

    vi.mocked(HarnessConfig.findOne).mockReturnValue(leanQuery({ compactCommand: '/recovered' }));
    await expect(resolveCompactCommand('opencode')).resolves.toBe('/recovered');
    expect(HarnessConfig.findOne).toHaveBeenCalledTimes(2);
  });

  it('T-HCR4: ACP_SERVER_TO_HARNESS 与 HARNESS_ACP_TYPES 互为逆映射且覆盖 HARNESS_TYPES 全集', () => {
    for (const harness of HARNESS_TYPES) {
      expect(ACP_SERVER_TO_HARNESS[HARNESS_ACP_TYPES[harness]]).toBe(harness);
    }
    expect(Object.keys(ACP_SERVER_TO_HARNESS)).toHaveLength(HARNESS_TYPES.length);
  });
});
