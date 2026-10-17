import { CloudWorkload } from '../models/cloud-workload.js';

/**
 * 001-preset-workloads：一次性写入 Docker / Node.js / .NET / Aspire 四个预制工作负载
 * （§计划期裁决 2/3、提案 §5.3）。
 *
 * 写入口径：每项先按 `presetKey` 查、再按精确 `name` 查；已存在则跳过并打 `warn`，**不覆盖**。
 * Aspire 的 `dependsOnWorkloadIds` 分别解析为「本次插入或同名已存在的 Docker / .NET」，
 * 顺序固定 `[Docker, .NET]`；任一依赖缺失则记录告警并保留空依赖（不阻断）。
 */
export const name = '001-preset-workloads';

// 脚本为初始版本，写库后归管理员所有、后台可编辑（提案 §5.3）。
const DOCKER_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

if /usr/bin/docker info >/dev/null 2>&1; then
  echo "dockerd 已在运行"
  exit 0
fi

nohup dockerd >/var/log/dockerd.log 2>&1 &

for _ in $(seq 1 30); do
  if /usr/bin/docker info >/dev/null 2>&1; then
    echo "dockerd 已就绪"
    exit 0
  fi
  sleep 1
done

echo "dockerd 未在 30s 内就绪" >&2
tail -n 50 /var/log/dockerd.log >&2 || true
exit 1
`;

const NODEJS_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

export NVM_DIR="\${NVM_DIR:-/usr/local/nvm}"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

VERSION="\${WORKLOAD_PARAM_VERSION:-22}"
if ! [[ "$VERSION" =~ ^[A-Za-z0-9._/*-]{1,32}$ ]]; then
  echo "非法的 Node.js 版本: $VERSION" >&2
  exit 2
fi

nvm install "$VERSION" --default
nvm alias default "$VERSION"
nvm use default

NODE_PREFIX="$(dirname "$(dirname "$(nvm which default)")")"
ln -sfn "$NODE_PREFIX" "$NVM_DIR/current"

REGISTRY="\${NPM_REGISTRY:-https://nexus.internal.fffdan.com/repository/npm-proxy/}"
npm config set registry "$REGISTRY"

PACKAGE_MANAGERS="\${WORKLOAD_PARAM_PACKAGE_MANAGER:-[]}"
while IFS= read -r pm; do
  [ -z "$pm" ] && continue
  case "$pm" in
    npm) ;;
    pnpm|yarn|bun) npm install -g "$pm" ;;
    *) echo "未知包管理器: $pm" >&2; exit 2 ;;
  esac
done < <(node -e 'const v = JSON.parse(process.argv[1] || "[]"); for (const x of v) console.log(x)' "$PACKAGE_MANAGERS")

node -v
npm -v
npm config get registry
`;

const DOTNET_SCRIPT = `#!/usr/bin/env bash
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

const ASPIRE_SCRIPT = `#!/usr/bin/env bash
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

# 已安装过（PATH 或安装脚本默认目录）则跳过下载，直接校验版本
if ! command -v aspire >/dev/null 2>&1 && [ -x "$HOME/.aspire/bin/aspire" ]; then
  ln -sfn "$HOME/.aspire/bin/aspire" /usr/local/bin/aspire
fi
if command -v aspire >/dev/null 2>&1; then
  aspire --version
  exit 0
fi

INSTALL_URL="\${ASPIRE_INSTALL_URL:-https://aspire.dev/install.sh}"
curl -sSL "$INSTALL_URL" | bash

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

# 必须校验成功，避免“安装脚本返回 0 但实际不可用”
aspire --version
`;

interface PresetParam {
  key: string;
  label: string;
  type: 'select' | 'multi_select' | 'text' | 'boolean';
  options: string[];
  defaultValue: unknown;
}

interface PresetDefinition {
  presetKey: string;
  name: string;
  initScript: string;
  paramSchema: PresetParam[];
  /** 依赖的同名预制项（顺序即初始化顺序） */
  dependsOnNames: string[];
}

const PRESETS: PresetDefinition[] = [
  {
    presetKey: 'docker',
    name: 'Docker',
    initScript: DOCKER_SCRIPT,
    paramSchema: [],
    dependsOnNames: [],
  },
  {
    presetKey: 'nodejs',
    name: 'Node.js',
    initScript: NODEJS_SCRIPT,
    paramSchema: [
      {
        key: 'version',
        label: 'Node.js 版本',
        type: 'text',
        options: [],
        defaultValue: '22',
      },
      {
        key: 'package_manager',
        label: '包管理器',
        type: 'multi_select',
        options: ['npm', 'pnpm', 'bun', 'yarn'],
        defaultValue: ['npm'],
      },
    ],
    dependsOnNames: [],
  },
  {
    presetKey: 'dotnet',
    name: '.NET',
    initScript: DOTNET_SCRIPT,
    paramSchema: [],
    dependsOnNames: [],
  },
  {
    presetKey: 'aspire',
    name: 'Aspire',
    initScript: ASPIRE_SCRIPT,
    paramSchema: [],
    dependsOnNames: ['Docker', '.NET'],
  },
];

/** 按 presetKey / 精确 name 查已存在项（presetKey 优先）；返回其 ID 字符串。 */
async function findExistingId(preset: PresetDefinition): Promise<string | null> {
  const byKey = await CloudWorkload.findOne({ presetKey: preset.presetKey });
  if (byKey) {
    console.warn(
      `[Migration 001] preset workload "${preset.presetKey}" already exists (by presetKey), skipping`,
    );
    return String((byKey as { _id: unknown })._id);
  }
  const byName = await CloudWorkload.findOne({ name: preset.name });
  if (byName) {
    console.warn(`[Migration 001] workload named "${preset.name}" already exists, skipping`);
    return String((byName as { _id: unknown })._id);
  }
  return null;
}

export async function run(): Promise<void> {
  const idByName = new Map<string, string>();

  for (const preset of PRESETS) {
    const existingId = await findExistingId(preset);
    if (existingId) {
      idByName.set(preset.name, existingId);
      continue;
    }

    const dependsOnWorkloadIds: string[] = [];
    for (const dependencyName of preset.dependsOnNames) {
      const dependencyId = idByName.get(dependencyName);
      if (dependencyId) {
        dependsOnWorkloadIds.push(dependencyId);
      } else {
        console.warn(
          `[Migration 001] dependency "${dependencyName}" for "${preset.name}" not found, leaving it out`,
        );
      }
    }

    const created = await CloudWorkload.create({
      name: preset.name,
      initScript: preset.initScript,
      postScript: null,
      paramSchema: preset.paramSchema,
      dependsOnWorkloadIds,
      presetKey: preset.presetKey,
      isPreset: true,
    });
    idByName.set(preset.name, String((created as { _id: unknown })._id));
    console.log(`[Migration 001] preset workload "${preset.presetKey}" created`);
  }
}
