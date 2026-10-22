import { CloudWorkload } from '../models/cloud-workload.js';

/**
 * 007-preset-github：写入预制工作负载「Github」（安装 gh CLI）。
 *
 * 口径（实现计划 Phase 1）：
 * - `workloadKind='standard'`、`isPreset=true`、`presetKey='github'`；
 * - 仅 `initScript`（apt 源指向内部 nexus 代理），`postScript=null`、无依赖；
 * - 参数：`repoFullName`（TEXT，默认空）与 `targetPath`（TEXT，默认 `/root/workspaces/{repo}`）；
 * - 已存在（presetKey 或精确 name 命中）则跳过并告警，**不覆盖管理员修改**。
 */
export const name = '007-preset-github';

export const GITHUB_PRESET_KEY = 'github';
export const GITHUB_PRESET_NAME = 'Github';

export const GITHUB_INIT_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

# 幂等：镜像已预装 gh 时直接成功（旧镜像走内网 apt 代理安装）
if command -v gh >/dev/null 2>&1; then
  gh --version
  exit 0
fi

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://nexus.internal.fffdan.com/repository/github-cli-apt-proxy/githubcli-archive-keyring.gpg \\
  -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
printf '%s\\n' \\
  'deb [signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://nexus.internal.fffdan.com/repository/github-cli-apt-proxy/ stable main' \\
  > /etc/apt/sources.list.d/github-cli.list
apt-get update
apt-get install -y gh
gh --version
`;

export const GITHUB_PARAM_SCHEMA = [
  {
    key: 'repoFullName',
    label: '仓库',
    type: 'text',
    options: [],
    defaultValue: '',
  },
  {
    key: 'targetPath',
    label: 'Clone 目标路径',
    type: 'text',
    options: [],
    defaultValue: '/root/workspaces/{repo}',
  },
] as const;

export async function run(): Promise<void> {
  const byKey = await CloudWorkload.findOne({ presetKey: GITHUB_PRESET_KEY });
  if (byKey) {
    console.warn(
      `[Migration 007] preset workload "${GITHUB_PRESET_KEY}" already exists (by presetKey), skipping`,
    );
    return;
  }
  const byName = await CloudWorkload.findOne({ name: GITHUB_PRESET_NAME });
  if (byName) {
    console.warn(`[Migration 007] workload named "${GITHUB_PRESET_NAME}" already exists, skipping`);
    return;
  }

  await CloudWorkload.create({
    name: GITHUB_PRESET_NAME,
    initScript: GITHUB_INIT_SCRIPT,
    postScript: null,
    paramSchema: GITHUB_PARAM_SCHEMA.map((field) => ({ ...field, options: [...field.options] })),
    dependsOnWorkloadIds: [],
    presetKey: GITHUB_PRESET_KEY,
    isPreset: true,
    workloadKind: 'standard',
    harnessType: null,
  });
  console.log(`[Migration 007] preset workload "${GITHUB_PRESET_KEY}" created`);
}
