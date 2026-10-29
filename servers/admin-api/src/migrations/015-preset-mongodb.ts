import { CloudWorkload } from '../models/cloud-workload.js';

/**
 * 015-preset-mongodb：写入预制工作负载「MongoDB」（原生 apt 安装 mongodb-org 8.0）。
 *
 * 口径（实现计划 Phase 1 / 提案 v1.1 返工口径）：
 * - `workloadKind='standard'`、`isPreset=true`、`presetKey='mongodb'`；
 * - 仅 `initScript`（012 sudo 正典形态：内网 Nexus GPG + apt 源原生安装），`postScript=null`；
 * - 零参数（`paramSchema=[]`）、零依赖（`dependsOnWorkloadIds=[]`）；
 * - 成功判据仅 `mongod --version` 硬校验，**不拉起 mongod 实例**（服务由用户按需自行启动）；
 * - 已存在（presetKey 或精确 name 命中）则跳过并告警，**不覆盖管理员修改**。
 */
export const name = '015-preset-mongodb';

export const MONGODB_PRESET_KEY = 'mongodb';
export const MONGODB_PRESET_NAME = 'MongoDB';

export const MONGODB_INIT_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
SUDO=sudo
command -v sudo >/dev/null 2>&1 || SUDO=

# 幂等：已安装 → 版本校验通过即直接成功（不重复安装、不动既有环境）
if command -v mongod >/dev/null 2>&1; then
  mongod --version
  exit 0
fi

# 内网 apt 源（需求指定地址；GPG signed-by 校验；不回退公网）
\${SUDO} install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://nexus.internal.fffdan.com/repository/misc-cache/mongodb/server-8.0.asc \\
  | \${SUDO} tee /etc/apt/keyrings/mongodb-server-8.0.asc >/dev/null
\${SUDO} chmod a+r /etc/apt/keyrings/mongodb-server-8.0.asc
. /etc/os-release
printf '%s\\n' \\
  "deb [ signed-by=/etc/apt/keyrings/mongodb-server-8.0.asc ] https://nexus.internal.fffdan.com/repository/mongodb-apt-proxy \${VERSION_CODENAME}/mongodb-org/8.0 multiverse" \\
  | \${SUDO} tee /etc/apt/sources.list.d/mongodb-org-8.0.list >/dev/null

\${SUDO} apt-get update
\${SUDO} apt-get install -y mongodb-org

# 硬校验：版本通过即安装成功（不拉起 mongod 实例，服务由用户按需自行启动）
mongod --version
`;

export async function run(): Promise<void> {
  const byKey = await CloudWorkload.findOne({ presetKey: MONGODB_PRESET_KEY });
  if (byKey) {
    console.warn(
      `[Migration 015] preset workload "${MONGODB_PRESET_KEY}" already exists (by presetKey), skipping`,
    );
    return;
  }
  const byName = await CloudWorkload.findOne({ name: MONGODB_PRESET_NAME });
  if (byName) {
    console.warn(`[Migration 015] workload named "${MONGODB_PRESET_NAME}" already exists, skipping`);
    return;
  }

  await CloudWorkload.create({
    name: MONGODB_PRESET_NAME,
    initScript: MONGODB_INIT_SCRIPT,
    postScript: null,
    paramSchema: [],
    dependsOnWorkloadIds: [],
    presetKey: MONGODB_PRESET_KEY,
    isPreset: true,
    workloadKind: 'standard',
    harnessType: null,
  });
  console.log(`[Migration 015] preset workload "${MONGODB_PRESET_KEY}" created`);
}
