#!/usr/bin/env bash
# 默认工作容器入口：启动容器内 dockerd，装配镜像引用规范化 shim，更新 agent-gear，
# 然后 exec agent-gear 回连 cloud-controller。
#
# 连接参数来自注入的环境变量：
#   ZAG_SERVER_ENDPOINT  形如 wss://<cloud-controller>/worker（不含 token）
#   ZAG_CONTROLLER_KEY   一次性容器 token（agent-gear 连接时经 Socket.IO 握手 auth.token 携带，不进 URL）
# 可选开关：
#   ZAG_SKIP_AGENT_GEAR_UPDATE=1  跳过启动时的 `npm install -g agent-gear`（离线/排障）
set -euo pipefail

HARBOR_PROXY="core.harbor.internal.fffdan.com"

log() { echo "[worker] $*"; }

# ---------------------------------------------------------------------------
# 镜像引用规范化 shim：ubuntu:latest → docker-hub-proxy/ubuntu:latest；
# ghcr.io/x → ghcr/x；其余含 registry host 的原样。写为 /usr/local/bin/docker 包装器。
# ---------------------------------------------------------------------------
install_docker_shim() {
  cat > /usr/local/bin/docker <<'SHIM'
#!/usr/bin/env bash
HARBOR_PROXY="core.harbor.internal.fffdan.com"

normalize_image() {
  local img="$1"
  case "$img" in
    ghcr.io/*) echo "${HARBOR_PROXY}/ghcr/${img#ghcr.io/}" ;;
    lscr.io/*) echo "${HARBOR_PROXY}/docker-hub-proxy/${img#lscr.io/}" ;;
    docker.io/*) echo "${HARBOR_PROXY}/docker-hub-proxy/${img#docker.io/}" ;;
    registry-1.docker.io/*) echo "${HARBOR_PROXY}/docker-hub-proxy/${img#registry-1.docker.io/}" ;;
    "${HARBOR_PROXY}"/*) echo "$img" ;;
    */*)
      local first="${img%%/*}"
      case "$first" in
        *.*|*:*|localhost) echo "$img" ;;
        *) echo "${HARBOR_PROXY}/docker-hub-proxy/${img}" ;;
      esac ;;
    *) echo "${HARBOR_PROXY}/docker-hub-proxy/${img}" ;;
  esac
}

cmd="${1:-}"
case "$cmd" in
  pull|run|create)
    args=("$cmd"); shift; normalized=0
    for a in "$@"; do
      if [ "$normalized" -eq 0 ] && [ "${a#-}" = "$a" ]; then
        args+=("$(normalize_image "$a")"); normalized=1
      else
        args+=("$a")
      fi
    done
    exec /usr/bin/docker "${args[@]}" ;;
  *) exec /usr/bin/docker "$@" ;;
esac
SHIM
  chmod +x /usr/local/bin/docker
}

# ---------------------------------------------------------------------------
# 启动容器内 dockerd（sysbox 环境下运行 Docker；无 sysbox 的普通环境亦可 dind）
# ---------------------------------------------------------------------------
start_dockerd() {
  if [ ! -S /var/run/docker.sock ]; then
    log "starting dockerd"
    dockerd >/var/log/dockerd.log 2>&1 &
    for _ in $(seq 1 30); do
      /usr/bin/docker info >/dev/null 2>&1 && break
      sleep 1
    done
  fi
}

# ---------------------------------------------------------------------------
# 更新 agent-gear：启动时执行 `npm install -g agent-gear`（走镜像内置的内网 npm 代理）。
# 失败**不阻断**启动：镜像内已预装可用的 agent-gear，避免代理抖动/离线时容器起不来。
# 设 ZAG_SKIP_AGENT_GEAR_UPDATE=1 可跳过（离线或排障时）。
# ---------------------------------------------------------------------------
update_agent_gear() {
  if [ "${ZAG_SKIP_AGENT_GEAR_UPDATE:-0}" = "1" ]; then
    log "skipping agent-gear update (ZAG_SKIP_AGENT_GEAR_UPDATE=1)"
    return 0
  fi
  log "updating agent-gear via npm (registry=$(npm config get registry 2>/dev/null || echo unknown))"
  if npm install -g agent-gear --no-fund --no-audit; then
    log "agent-gear updated: $(agent-gear --version 2>/dev/null || echo 'version unknown')"
  else
    log "WARN: agent-gear update failed; continuing with the pre-installed version ($(agent-gear --version 2>/dev/null || echo 'version unknown'))"
  fi
}

shutdown() {
  log "shutdown requested, exiting"
  exit 0
}
trap shutdown SIGTERM SIGINT

install_docker_shim
start_dockerd
update_agent_gear

if [ -z "${ZAG_SERVER_ENDPOINT:-}" ]; then
  log "ZAG_SERVER_ENDPOINT is not set; cannot connect to cloud-controller"
  exit 1
fi

log "connecting to cloud-controller: ${ZAG_SERVER_ENDPOINT%%\?*}"
exec agent-gear
