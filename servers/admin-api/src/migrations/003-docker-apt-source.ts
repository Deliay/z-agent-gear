import { CloudWorkload } from '../models/cloud-workload.js';
import { DOCKER_SCRIPT_V1 } from './001-preset-workloads.js';
import { DOCKER_SCRIPT_V2 } from './002-refresh-docker-preset-script.js';

/**
 * 003-docker-apt-source：把存量（管理员未定制过的）「Docker」预制工作负载脚本从自包含 v2 刷新为
 * v3，并补齐 `docker_apt_url` 参数（默认值 = 内网 Docker CE 软件源代理地址）。
 *
 * 背景：四期把安装来源下沉到脚本、要求运行环境注入 `DOCKER_APT_URL`，但注入链路并不存在，导致
 * 初始化必然失败。本期把内网代理地址做成工作负载参数默认值，脚本 v3 直接消费该参数。
 *
 * 刷新口径：
 * - 未定制判定严格相等：`initScript ∈ {V1, V2, V3}` 才处理；其余视为管理员定制，`console.warn`
 *   且不覆盖、不补参数（定制脚本不消费该参数）。
 * - `initScript` 非 V3 则刷新为 V3；`paramSchema` 缺 `docker_apt_url`（只按 key 判定）则追加参数；
 *   有变更才 `save()`，参数已存在则完全不动（含管理员改过的默认值）。
 * - 防御路径：`presetKey='docker'` 不存在时按精确 `name='Docker'` 再查一次，存在则告警跳过（避免创建
 *   重名项）；两者都不存在才按 v3 + 参数创建。
 *
 * 迁移随启动自动执行、失败不阻断（沿用 `admin_migrations` runner 语义）。
 */
export const name = '003-docker-apt-source';

const DOCKER_PRESET_KEY = 'docker';
const DOCKER_PRESET_NAME = 'Docker';
const DOCKER_APT_URL_KEY = 'docker_apt_url';

/** 内网 Docker CE 软件源代理默认地址（无尾斜杠；实测该仓库根即 apt 源根，见提案 §6.1 决策 5）。 */
export const DOCKER_APT_URL_DEFAULT =
  'https://nexus.internal.fffdan.com/repository/docker-ce-apt';

interface WorkloadParamDefinition {
  key: string;
  label: string;
  type: 'select' | 'multi_select' | 'text' | 'boolean';
  options: string[];
  defaultValue: unknown;
}

/** 「Docker」工作负载的软件源地址参数定义（默认值唯一来源）。 */
export const DOCKER_APT_PARAM: WorkloadParamDefinition = {
  key: DOCKER_APT_URL_KEY,
  label: 'Docker CE 软件源地址',
  type: 'text',
  options: [],
  defaultValue: DOCKER_APT_URL_DEFAULT,
};

/**
 * Docker 预制工作负载脚本 v3（自包含）：在 v2 基础上仅两处变化——
 * 1) 安装来源取值优先级：显式环境变量 `DOCKER_APT_URL`（最高，兼容四期注入用法）>
 *    工作负载参数 `WORKLOAD_PARAM_DOCKER_APT_URL` > 空（需安装时快速失败），并对尾斜杠归一；
 * 2) 失败指引中的地址形态示例修正为 `https://<nexus-host>/repository/<docker-ce-apt>/`
 *    （实测 `/linux/ubuntu` 子路径 404，仓库根即 apt 源根）。
 *
 * 脚本内不内置任何具体来源地址（默认值唯一来源是 `DOCKER_APT_PARAM`）；安装包列表、幂等锚点、
 * shim 文本、`nohup dockerd` 就绪等待与 `docker version` / `docker buildx version` 校验逐字不变。
 */
export const DOCKER_SCRIPT_V3 = `#!/usr/bin/env bash
set -euo pipefail

# Docker 工作负载初始化脚本 v3（自包含）：apt 安装 → 装配镜像代理 shim → 启动并就绪 dockerd → 校验。
# 安装来源取值优先级：环境变量 DOCKER_APT_URL（最高）> 工作负载参数 WORKLOAD_PARAM_DOCKER_APT_URL > 空（需安装时快速失败）。
DOCKER_APT_URL="\${DOCKER_APT_URL:-\${WORKLOAD_PARAM_DOCKER_APT_URL:-}}"
while [ "\${DOCKER_APT_URL%/}" != "\$DOCKER_APT_URL" ]; do DOCKER_APT_URL="\${DOCKER_APT_URL%/}"; done
SHIM_PATH="\${ZAG_DOCKER_SHIM_PATH:-/usr/local/bin/docker}"

# 1) 安装 Docker CE（含 dockerd/docker-proxy）+ CLI + buildx + containerd 及运行时依赖
#    幂等锚点：CLI 与 dockerd 任一缺失都执行安装，收敛半安装状态（裁决 11）。
#    注意：docker-ce 包提供 /usr/bin/dockerd，docker-ce-cli 仅提供客户端，二者都必须安装。
if [ ! -x /usr/bin/docker ] || [ ! -x /usr/bin/dockerd ]; then
  if [ -z "\$DOCKER_APT_URL" ]; then
    echo "DOCKER_APT_URL 未设置：请配置内网 Docker CE apt 代理地址（形如 https://<nexus-host>/repository/<docker-ce-apt>/）后重试" >&2
    exit 2
  fi
  apt-get update
  apt-get install -y --no-install-recommends \\
    iptables iproute2 fuse-overlayfs libseccomp2 conntrack
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "\$DOCKER_APT_URL/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] %s %s stable\\n' \\
    "\$(dpkg --print-architecture)" "\$DOCKER_APT_URL" \\
    "\$(. /etc/os-release && echo "\$VERSION_CODENAME")" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y --no-install-recommends docker-ce docker-ce-cli docker-buildx-plugin containerd.io
  rm -rf /var/lib/apt/lists/*
  mkdir -p /usr/local/lib/docker/cli-plugins
  ln -sf /usr/libexec/docker/cli-plugins/docker-buildx \\
    /usr/local/lib/docker/cli-plugins/docker-buildx 2>/dev/null || true
fi

# 2) 装配镜像引用规范化 shim（逻辑同一期 entrypoint 版本；exec /usr/bin/docker，故须在 CLI 安装之后）
cat > "\$SHIM_PATH" <<'SHIM'
#!/usr/bin/env bash
HARBOR_PROXY="core.harbor.internal.fffdan.com"

normalize_image() {
  local img="\$1"
  case "\$img" in
    ghcr.io/*) echo "\${HARBOR_PROXY}/ghcr/\${img#ghcr.io/}" ;;
    lscr.io/*) echo "\${HARBOR_PROXY}/docker-hub-proxy/\${img#lscr.io/}" ;;
    docker.io/*) echo "\${HARBOR_PROXY}/docker-hub-proxy/\${img#docker.io/}" ;;
    registry-1.docker.io/*) echo "\${HARBOR_PROXY}/docker-hub-proxy/\${img#registry-1.docker.io/}" ;;
    "\${HARBOR_PROXY}"/*) echo "\$img" ;;
    */*)
      local first="\${img%%/*}"
      case "\$first" in
        *.*|*:*|localhost) echo "\$img" ;;
        *) echo "\${HARBOR_PROXY}/docker-hub-proxy/\${img}" ;;
      esac ;;
    *) echo "\${HARBOR_PROXY}/docker-hub-proxy/\${img}" ;;
  esac
}

cmd="\${1:-}"
case "\$cmd" in
  pull|run|create)
    args=("\$cmd"); shift; normalized=0
    for a in "\$@"; do
      if [ "\$normalized" -eq 0 ] && [ "\${a#-}" = "\$a" ]; then
        args+=("\$(normalize_image "\$a")"); normalized=1
      else
        args+=("\$a")
      fi
    done
    exec /usr/bin/docker "\${args[@]}" ;;
  *) exec /usr/bin/docker "\$@" ;;
esac
SHIM
chmod +x "\$SHIM_PATH"

# 3) 启动 dockerd 并等待就绪（已就绪则跳过）
if /usr/bin/docker info >/dev/null 2>&1; then
  echo "dockerd 已在运行"
else
  nohup dockerd >/var/log/dockerd.log 2>&1 &
  for _ in \$(seq 1 30); do
    if /usr/bin/docker info >/dev/null 2>&1; then
      echo "dockerd 已就绪"
      break
    fi
    sleep 1
  done
fi
if ! /usr/bin/docker info >/dev/null 2>&1; then
  echo "dockerd 未在 30s 内就绪" >&2
  tail -n 50 /var/log/dockerd.log >&2 || true
  exit 1
fi

# 4) 校验 CLI 与构建能力
docker version
docker buildx version
`;

interface MutableDockerWorkload {
  initScript?: string | null;
  paramSchema?: Array<{ key?: string }> | null;
  save: () => Promise<unknown>;
}

export async function run(): Promise<void> {
  const wl = await CloudWorkload.findOne({ presetKey: DOCKER_PRESET_KEY });
  if (!wl) {
    // 防御（沿用 002）：001 可能因同名冲突跳过，这里按精确 name 再查一次，避免创建重名项。
    const byName = await CloudWorkload.findOne({ name: DOCKER_PRESET_NAME });
    if (byName) {
      console.warn(
        `[Migration 003] workload named "${DOCKER_PRESET_NAME}" already exists without presetKey, skipping`,
      );
      return;
    }
    await CloudWorkload.create({
      name: DOCKER_PRESET_NAME,
      initScript: DOCKER_SCRIPT_V3,
      postScript: null,
      paramSchema: [DOCKER_APT_PARAM],
      dependsOnWorkloadIds: [],
      presetKey: DOCKER_PRESET_KEY,
      isPreset: true,
    });
    console.log('[Migration 003] docker preset workload created (v3)');
    return;
  }

  const doc = wl as unknown as MutableDockerWorkload;
  const script = doc.initScript;
  const isStock =
    script === DOCKER_SCRIPT_V1 || script === DOCKER_SCRIPT_V2 || script === DOCKER_SCRIPT_V3;
  if (!isStock) {
    console.warn('[Migration 003] docker preset script modified by admin, skipping');
    return;
  }

  let changed = false;
  if (script !== DOCKER_SCRIPT_V3) {
    doc.initScript = DOCKER_SCRIPT_V3;
    changed = true;
  }

  const paramSchema = doc.paramSchema ?? [];
  const hasParam = paramSchema.some((p) => p.key === DOCKER_APT_URL_KEY);
  if (!hasParam) {
    doc.paramSchema = [...paramSchema, DOCKER_APT_PARAM];
    changed = true;
  }

  if (changed) {
    await doc.save();
    console.log('[Migration 003] docker preset script refreshed to v3 / docker_apt_url ensured');
  } else {
    console.log('[Migration 003] docker preset already up-to-date, skipping');
  }
}
