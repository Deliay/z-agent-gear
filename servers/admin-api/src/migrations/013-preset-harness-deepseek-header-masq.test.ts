import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/cloud-workload.js', () => ({
  CloudWorkload: { findOne: vi.fn(), create: vi.fn() },
}));

import { CloudWorkload } from '../models/cloud-workload.js';
import * as migration from './013-preset-harness-deepseek-header-masq';
import {
  HARNESS_DEEPSEEK_INIT_SCRIPT,
  HARNESS_DEEPSEEK_INIT_SCRIPT_V1,
} from './010-preset-harness-deepseek.js';
import { HARNESS_DEEPSEEK_SCRIPT_V2 } from './012-worker-user-scripts.js';

const PRESET_KEY = 'harness-deepseek-harness';
const PRESET_NAME = 'DeepSeek Harness（Harness）';

const finder = (docs: Record<string, unknown | null>) =>
  (CloudWorkload.findOne as any).mockImplementation(
    (filter: { presetKey?: string; name?: string }) =>
      Promise.resolve(docs[filter.presetKey ?? filter.name ?? ''] ?? null),
  );

describe('migration 013-preset-harness-deepseek-header-masq', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    (CloudWorkload.create as any).mockResolvedValue({ _id: 'created' });
  });

  it('exposes the 013 migration name and the V4 fixed versions', () => {
    expect(migration.name).toBe('013-preset-harness-deepseek-header-masq');
    expect(migration.DSH_CLI_VERSION_V4).toBe('0.2.1-rc.2');
    expect(migration.DSH_ACP_APP_VERSION_V4).toBe('0.2.1-rc.2');
  });

  it('T-MIG13d: 脚本 V4 含固定版本、硬校验、插件安装与按类型 prepare', () => {
    const script = migration.HARNESS_DEEPSEEK_SCRIPT_V3;

    // 固定版本：双包同装 + 内嵌默认值（插件兼容下限 >=0.2.1-rc.2）
    expect(script).toContain('export DSH_CLI_VERSION="${DSH_CLI_VERSION:-0.2.1-rc.2}"');
    expect(script).toContain('export DSH_ACP_APP_VERSION="${DSH_ACP_APP_VERSION:-0.2.1-rc.2}"');
    expect(script).toContain(
      'npm install -g "@deepseek-ai/dsh@${DSH_CLI_VERSION}" "@deepseek-ai/dsh-acp-app@${DSH_ACP_APP_VERSION}"',
    );
    expect(script).not.toContain('0.1.2-alpha.2');

    // 硬校验
    expect(script).toContain('dsh --version');
    expect(script).toContain('DeepSeek Harness version mismatch');

    // 会话标识插件安装（pnpm 缺失时固定版本装 + profile workspace root 安装校验放开）
    expect(script).toContain('dsh plugin --profile acp add Deliay/dsh-header-masq');
    expect(script).toContain('npm install -g "pnpm@9.15.9"');
    expect(script).toContain('ignore-workspace-root-check=true');

    // 默认工作区 + 按类型限定 prepare
    expect(script).toContain('${ZAG_DEFAULT_WORKSPACE:-/home/worker/workspace}');
    expect(script).toContain('ZAG_HARNESS_TYPES=deepseek_harness agent-gear harness prepare');

    // 安装 → 硬校验 → 插件 → prepare 的顺序
    const order = [
      'npm install -g "@deepseek-ai/dsh@',
      'DeepSeek Harness version mismatch',
      'dsh plugin --profile acp add',
      'agent-gear harness prepare',
    ].map((token) => script.indexOf(token));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('T-MIG13a: V1/V2/V3 三种存量文本刷新为 V4', async () => {
    for (const [label, oldScript] of [
      ['V1', HARNESS_DEEPSEEK_INIT_SCRIPT_V1],
      ['V2', HARNESS_DEEPSEEK_INIT_SCRIPT],
      ['V3', HARNESS_DEEPSEEK_SCRIPT_V2],
    ] as const) {
      vi.clearAllMocks();
      (CloudWorkload.create as any).mockResolvedValue({ _id: 'created' });
      const save = vi.fn().mockResolvedValue(undefined);
      const doc = { presetKey: PRESET_KEY, initScript: oldScript, save };
      finder({ [PRESET_KEY]: doc });

      await migration.run();

      expect(doc.initScript, label).toBe(migration.HARNESS_DEEPSEEK_SCRIPT_V3);
      expect(save, label).toHaveBeenCalledTimes(1);
    }
  });

  it('T-MIG13a: 已是 V4 时跳过（不写库）', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const doc = { presetKey: PRESET_KEY, initScript: migration.HARNESS_DEEPSEEK_SCRIPT_V3, save };
    finder({ [PRESET_KEY]: doc });

    await migration.run();

    expect(save).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('T-MIG13b: 管理员定制脚本告警且不覆盖', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const custom = '#!/usr/bin/env bash\necho custom\n';
    const doc = { presetKey: PRESET_KEY, initScript: custom, save };
    finder({ [PRESET_KEY]: doc });

    await migration.run();

    expect(doc.initScript).toBe(custom);
    expect(save).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('T-MIG13c: 预置项缺失时按 V4 创建（harness 元数据齐全）', async () => {
    finder({});

    await migration.run();

    expect(CloudWorkload.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: PRESET_NAME,
        presetKey: PRESET_KEY,
        initScript: migration.HARNESS_DEEPSEEK_SCRIPT_V3,
        isPreset: true,
        workloadKind: 'harness',
        harnessType: 'deepseek_harness',
        paramSchema: [],
        dependsOnWorkloadIds: [],
        postScript: null,
      }),
    );
  });

  it('T-MIG13e: 二次 run 无变更、不重复创建', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const doc: { presetKey: string; initScript: string; save: () => Promise<void> } = {
      presetKey: PRESET_KEY,
      initScript: HARNESS_DEEPSEEK_SCRIPT_V2,
      save,
    };
    finder({ [PRESET_KEY]: doc });

    await migration.run();
    await migration.run();

    expect(save).toHaveBeenCalledTimes(1);
    expect(CloudWorkload.create).not.toHaveBeenCalled();
    expect(doc.initScript).toBe(migration.HARNESS_DEEPSEEK_SCRIPT_V3);
  });

  it('T-MIG13b: 同名但无 presetKey 且无脚本的工作负载跳过', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    finder({ [PRESET_NAME]: { name: PRESET_NAME, initScript: null, save } });

    await migration.run();

    expect(save).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });
});
