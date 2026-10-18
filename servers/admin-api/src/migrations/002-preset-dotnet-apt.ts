import { CloudWorkload } from '../models/cloud-workload.js';
import { DOTNET_SCRIPT } from './001-preset-workloads.js';

/**
 * 002-preset-dotnet-apt：把存量预制 .NET 工作负载的初始化脚本从旧的
 * `dotnet-install.sh` 版**一次性保守升级**为 apt 版（裁决 11/12）。
 *
 * 口径：
 * - 按 `presetKey='dotnet'` 查，回退精确 `name='.NET'`；
 * - 仅当现存 `initScript` **逐字节等于**旧版脚本（即管理员未改动）时更新为 apt 版；
 * - 仅改 `initScript`，不动 `postScript`/`paramSchema`/`dependsOnWorkloadIds`/`name`；
 * - 已改动（不等）或预制项不存在时 `warn` 跳过，不重建、不报错；
 * - 迁移执行成功由 runner 写入 `admin_migrations` 账本，故天然幂等（只跑一次）。
 */
export const name = '002-preset-dotnet-apt';

/**
 * 旧版预制 .NET 脚本（`dotnet-install.sh` 版），逐字节复制自 001 的历史内容，
 * 仅用于等值比对；升级时复用 001 导出的 `DOTNET_SCRIPT`（apt 版）。
 */
export const LEGACY_DOTNET_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

if command -v dotnet >/dev/null 2>&1 && dotnet --list-sdks | grep -q .; then
  echo ".NET SDK 已安装"
  exit 0
fi

INSTALL_URL="\${DOTNET_INSTALL_URL:-https://dot.net/v1/dotnet-install.sh}"
INSTALL_DIR="\${DOTNET_INSTALL_DIR:-/usr/local/dotnet}"

curl -sSL "$INSTALL_URL" -o /tmp/dotnet-install.sh
bash /tmp/dotnet-install.sh --channel LTS --install-dir "$INSTALL_DIR"

ln -sfn "$INSTALL_DIR/dotnet" /usr/local/bin/dotnet
printf '%s\\n' \\
  'export DOTNET_ROOT=/usr/local/dotnet' \\
  'export PATH=$DOTNET_ROOT:$PATH' \\
  'export DOTNET_CLI_TELEMETRY_OPTOUT=1' \\
  > /etc/profile.d/dotnet.sh
chmod +x /etc/profile.d/dotnet.sh

export DOTNET_ROOT="$INSTALL_DIR"
export PATH="$INSTALL_DIR:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
dotnet --info
`;

/** 查找存量预制 .NET（presetKey 优先，回退精确 name）。 */
async function findExistingDotnet(): Promise<{ id: string; initScript: unknown } | null> {
  const byKey = await CloudWorkload.findOne({ presetKey: 'dotnet' });
  const found = byKey ?? (await CloudWorkload.findOne({ name: '.NET' }));
  if (!found) return null;
  const doc = found as unknown as { _id: unknown; initScript?: unknown };
  return { id: String(doc._id), initScript: doc.initScript };
}

export async function run(): Promise<void> {
  const existing = await findExistingDotnet();
  if (!existing) {
    console.warn('[Migration 002] preset .NET workload not found, skipping');
    return;
  }

  if (existing.initScript !== LEGACY_DOTNET_SCRIPT) {
    console.warn(
      '[Migration 002] preset .NET initScript has been customized, skipping (not overwriting)',
    );
    return;
  }

  await CloudWorkload.updateOne({ _id: existing.id }, { $set: { initScript: DOTNET_SCRIPT } });
  console.log('[Migration 002] preset .NET workload upgraded to apt-based init script');
}
