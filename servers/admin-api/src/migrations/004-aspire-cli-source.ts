import { CloudWorkload } from '../models/cloud-workload.js';
import { ASPIRE_SCRIPT_V1 } from './001-preset-workloads.js';

/**
 * 004-aspire-cli-source：把存量（管理员未定制过的）「Aspire」预制工作负载脚本从 v1（经官方安装脚本
 * `curl | bash` 安装）刷新为 v2（直连内网缓存代理安装包下载解压安装），并补齐 `aspire_cli_url`
 * 参数（默认值 = 内网缓存代理安装包直链）。
 *
 * 背景：v1 经官方安装脚本安装，安装包默认从公网官方地址下载，与平台「统一走内网代理」策略不一致，
 * 出网受限时初始化失败。本期把内网代理地址做成工作负载参数默认值，脚本 v2 直接消费该参数。
 *
 * 刷新口径（提案 §5.2 实现点 2、计划期裁决 8/9/10）：
 * - 未定制判定严格相等：`initScript ∈ {V1, V2}` 才处理；其余视为管理员定制，`console.warn`
 *   且不覆盖、不补参数（定制脚本不消费该参数）。
 * - `initScript` 非 V2 则刷新为 V2；`paramSchema` 缺 `aspire_cli_url`（只按 key 判定）则追加参数；
 *   有变更才 `save()`，参数已存在则完全不动（含管理员改过的默认值）。
 * - 防御路径：`presetKey='aspire'` 不存在时按精确 `name='Aspire'` 再查一次，存在则告警跳过（避免创建
 *   重名项）；两者都不存在才按 v2 + 参数创建。
 *
 * 迁移随启动自动执行、失败不阻断（沿用 `admin_migrations` runner 语义）。
 */
export const name = '004-aspire-cli-source';

const ASPIRE_PRESET_KEY = 'aspire';
const ASPIRE_PRESET_NAME = 'Aspire';
const ASPIRE_CLI_URL_KEY = 'aspire_cli_url';

/** 内网缓存代理安装包直链默认地址（实测 200/gzip；见提案 §6.1 决策 5）。 */
export const ASPIRE_CLI_URL_DEFAULT =
  'https://nexus.internal.fffdan.com/repository/misc-cache/dotnet/aspire-cli-linux-x64.tar.gz';

interface WorkloadParamDefinition {
  key: string;
  label: string;
  type: 'select' | 'multi_select' | 'text' | 'boolean';
  options: string[];
  defaultValue: unknown;
}

/** 「Aspire」工作负载的下载地址参数定义（默认值唯一来源）。 */
export const ASPIRE_CLI_PARAM: WorkloadParamDefinition = {
  key: ASPIRE_CLI_URL_KEY,
  label: 'Aspire CLI 下载地址',
  type: 'text',
  options: [],
  defaultValue: ASPIRE_CLI_URL_DEFAULT,
};

/**
 * Aspire 预制工作负载脚本 v2（自包含）：在 v1 基础上仅置换「安装段」——弃用官方安装脚本
 * `curl | bash`，改为按下载地址直连内网缓存代理安装包 → `tar -xzf` 解压到 `$HOME/.aspire/bin`。
 *
 * 前置检查（.NET / Docker 就绪）、「已安装」幂等分支（`command -v aspire` 或
 * `$HOME/.aspire/bin/aspire` → 补软链 → `aspire --version` → `exit 0`）、PATH 集成与结尾
 * `aspire --version` 校验逐字保留（安装布局与校验口径不变）。
 *
 * 下载地址取值优先级：显式环境变量 `ASPIRE_CLI_URL`（最高）> 工作负载参数
 * `WORKLOAD_PARAM_ASPIRE_CLI_URL` > 空（需安装时快速失败，`exit 2` + 含地址形态的指引）。
 * 取值与空检查放在「已安装」幂等分支之后：已安装但地址为空时直接校验通过（幂等）。
 *
 * 脚本内不内置任何具体来源地址（默认值唯一来源是 `ASPIRE_CLI_PARAM`），也不再引用已退役的
 * `ASPIRE_INSTALL_URL`；指引文案中的地址形态使用占位形态。
 */
export const ASPIRE_SCRIPT_V2 = `#!/usr/bin/env bash
set -euo pipefail

export DOTNET_ROOT="\${DOTNET_ROOT:-/usr/local/dotnet}"
export PATH="$DOTNET_ROOT:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1

command -v dotnet >/dev/null 2>&1 || {
  echo ".NET 未就绪，Aspire 无法初始化" >&2
  exit 1
}

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker 未就绪，Aspire 无法初始化" >&2
  exit 1
fi

# 已安装过（PATH 或安装目录）则跳过下载，直接校验版本
if ! command -v aspire >/dev/null 2>&1 && [ -x "$HOME/.aspire/bin/aspire" ]; then
  ln -sfn "$HOME/.aspire/bin/aspire" /usr/local/bin/aspire
fi
if command -v aspire >/dev/null 2>&1; then
  aspire --version
  exit 0
fi

# 下载地址取值优先级：显式环境变量 ASPIRE_CLI_URL（最高）> 工作负载参数 WORKLOAD_PARAM_ASPIRE_CLI_URL > 空（需安装时快速失败）
ASPIRE_CLI_URL="\${ASPIRE_CLI_URL:-\${WORKLOAD_PARAM_ASPIRE_CLI_URL:-}}"
if [ -z "$ASPIRE_CLI_URL" ]; then
  echo "Aspire CLI 下载地址未设置：请在「Aspire」工作负载参数中填写 aspire_cli_url（形如 https://<nexus-host>/repository/misc-cache/dotnet/aspire-cli-linux-x64.tar.gz）后重试" >&2
  exit 2
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
curl -fsSL "$ASPIRE_CLI_URL" -o "$TMP_DIR/aspire-cli.tar.gz"

install -m 0755 -d "$HOME/.aspire/bin"
tar -xzf "$TMP_DIR/aspire-cli.tar.gz" -C "$HOME/.aspire/bin"
chmod +x "$HOME/.aspire/bin/aspire"

ASPIRE_BIN="$HOME/.aspire/bin/aspire"
[ -x "$ASPIRE_BIN" ] || {
  echo "Aspire CLI 安装后未找到 $ASPIRE_BIN" >&2
  exit 1
}

# 让非登录 shell / 后续工作负载也能直接使用 aspire
ln -sfn "$ASPIRE_BIN" /usr/local/bin/aspire
printf '%s\\n' 'export PATH="$HOME/.aspire/bin:$PATH"' > /etc/profile.d/aspire.sh
chmod +x /etc/profile.d/aspire.sh
export PATH="$HOME/.aspire/bin:$PATH"

# 必须校验成功，避免“下载安装返回 0 但实际不可用”
aspire --version
`;

interface MutableAspireWorkload {
  initScript?: string | null;
  paramSchema?: Array<{ key?: string }> | null;
  save: () => Promise<unknown>;
}

export async function run(): Promise<void> {
  const wl = await CloudWorkload.findOne({ presetKey: ASPIRE_PRESET_KEY });
  if (!wl) {
    // 防御：001 可能因同名冲突跳过，这里按精确 name 再查一次，避免创建重名项。
    const byName = await CloudWorkload.findOne({ name: ASPIRE_PRESET_NAME });
    if (byName) {
      console.warn(
        `[Migration 004] workload named "${ASPIRE_PRESET_NAME}" already exists without presetKey, skipping`,
      );
      return;
    }
    await CloudWorkload.create({
      name: ASPIRE_PRESET_NAME,
      initScript: ASPIRE_SCRIPT_V2,
      postScript: null,
      paramSchema: [ASPIRE_CLI_PARAM],
      dependsOnWorkloadIds: [],
      presetKey: ASPIRE_PRESET_KEY,
      isPreset: true,
    });
    console.log('[Migration 004] aspire preset workload created (v2)');
    return;
  }

  const doc = wl as unknown as MutableAspireWorkload;
  const script = doc.initScript;
  const isStock = script === ASPIRE_SCRIPT_V1 || script === ASPIRE_SCRIPT_V2;
  if (!isStock) {
    console.warn('[Migration 004] aspire preset script modified by admin, skipping');
    return;
  }

  let changed = false;
  if (script !== ASPIRE_SCRIPT_V2) {
    doc.initScript = ASPIRE_SCRIPT_V2;
    changed = true;
  }

  const paramSchema = doc.paramSchema ?? [];
  const hasParam = paramSchema.some((p) => p.key === ASPIRE_CLI_URL_KEY);
  if (!hasParam) {
    doc.paramSchema = [...paramSchema, ASPIRE_CLI_PARAM];
    changed = true;
  }

  if (changed) {
    await doc.save();
    console.log('[Migration 004] aspire preset script refreshed to v2 / aspire_cli_url ensured');
  } else {
    console.log('[Migration 004] aspire preset already up-to-date, skipping');
  }
}
