import { CloudWorkload } from '../models/cloud-workload.js';
import { DOCKER_SCRIPT_V1 } from './001-preset-workloads.js';

/**
 * 002-refresh-docker-preset-script：把存量（管理员未定制过的）「Docker」预制工作负载脚本
 * 从一期初版 v1 刷新为自包含 v2（工作负载四期）。
 *
 * 刷新口径（裁决 3/4）：
 * - 未定制判定严格相等：`initScript === DOCKER_SCRIPT_V2` 直接返回（已刷新）；
 *   `initScript === DOCKER_SCRIPT_V1` 才刷新；其余视为管理员定制，`console.warn` 且不覆盖。
 * - 防御路径：`presetKey='docker'` 不存在时先按精确 `name='Docker'` 再查一次；两者都不存在才按 v2
 *   创建；同名项已存在则告警跳过，不创建重名项。
 *
 * 迁移随启动自动执行、失败不阻断（沿用 `admin_migrations` runner 语义）。
 */
export const name = '002-refresh-docker-preset-script';

const DOCKER_PRESET_KEY = 'docker';
const DOCKER_PRESET_NAME = 'Docker';

/**
 * Docker 预制工作负载脚本 v2（自包含）：安装 Docker CE（docker-ce/docker-ce-cli）+
 * docker-buildx-plugin + containerd.io 及运行时依赖 →
 * 装配镜像代理 shim → 启动并就绪 dockerd → 校验。幂等：以 `/usr/bin/docker` 与 `/usr/bin/dockerd`
 * 是否同时存在判定安装、`docker info` 判定就绪。安装源 `DOCKER_APT_URL` 与 shim 路径
 * `ZAG_DOCKER_SHIM_PATH` 均可经环境覆盖。
 *
 * 安装来源必须由环境注入：当前内网 Nexus **未提供** docker-ce apt 代理仓库，故脚本不留任何未经证实的
 * 默认值；未注入 `DOCKER_APT_URL` 且需安装时快速失败并打印明确指引（已安装完成则跳过、不校验该变量）。
 * 待运维提供真实可达的内网 docker-ce 代理后，可将其设为默认值（见提案 §9.3 发布前置）。
 */
export const DOCKER_SCRIPT_V2 = `#!/usr/bin/env bash
set -euo pipefail

# Docker 工作负载初始化脚本 v2（自包含）：apt 安装 → 装配镜像代理 shim → 启动并就绪 dockerd → 校验。
# 安装来源由环境注入（DOCKER_APT_URL），不设未经证实的默认值；未注入且需安装时快速失败。
DOCKER_APT_URL="\${DOCKER_APT_URL:-}"
SHIM_PATH="\${ZAG_DOCKER_SHIM_PATH:-/usr/local/bin/docker}"

# 1) 安装 Docker CE（含 dockerd/docker-proxy）+ CLI + buildx + containerd 及运行时依赖
#    幂等锚点：CLI 与 dockerd 任一缺失都执行安装，收敛半安装状态（裁决 11）。
#    注意：docker-ce 包提供 /usr/bin/dockerd，docker-ce-cli 仅提供客户端，二者都必须安装。
if [ ! -x /usr/bin/docker ] || [ ! -x /usr/bin/dockerd ]; then
  if [ -z "\$DOCKER_APT_URL" ]; then
    echo "DOCKER_APT_URL 未设置：请配置内网 Docker CE apt 代理地址（形如 https://<nexus-host>/repository/<docker-ce-apt-proxy>/linux/ubuntu/）后重试" >&2
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

export async function run(): Promise<void> {
  const wl = await CloudWorkload.findOne({ presetKey: DOCKER_PRESET_KEY });
  if (!wl) {
    // 防御（裁决 4）：001 可能因同名冲突跳过，这里按精确 name 再查一次，避免创建重名项。
    const byName = await CloudWorkload.findOne({ name: DOCKER_PRESET_NAME });
    if (byName) {
      console.warn(
        `[Migration 002] workload named "${DOCKER_PRESET_NAME}" already exists without presetKey, skipping`,
      );
      return;
    }
    await CloudWorkload.create({
      name: DOCKER_PRESET_NAME,
      initScript: DOCKER_SCRIPT_V2,
      postScript: null,
      paramSchema: [],
      dependsOnWorkloadIds: [],
      presetKey: DOCKER_PRESET_KEY,
      isPreset: true,
    });
    console.log('[Migration 002] docker preset workload created (v2)');
    return;
  }

  const initScript = (wl as { initScript?: string | null }).initScript;
  if (initScript === DOCKER_SCRIPT_V2) {
    console.log('[Migration 002] docker preset script already refreshed, skipping');
    return;
  }
  if (initScript === DOCKER_SCRIPT_V1) {
    (wl as { initScript: string }).initScript = DOCKER_SCRIPT_V2;
    await (wl as { save: () => Promise<unknown> }).save();
    console.log('[Migration 002] docker preset script refreshed to v2');
    return;
  }
  console.warn('[Migration 002] docker preset script modified by admin, skipping');
}
