#!/usr/bin/env bash
# 默认工作容器入口：启动容器内 dockerd，装配镜像引用规范化 shim，然后 exec agent-gear 回连 cloud-controller。
#
# 连接参数来自注入的环境变量：
#   ZAG_SERVER_ENDPOINT  形如 wss://<cloud-controller>/worker?token=<one-time-token>
#   ZAG_CONTROLLER_KEY   同一 token（agent-gear 参数体系兜底）
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

shutdown() {
  log "shutdown requested, exiting"
  exit 0
}
trap shutdown SIGTERM SIGINT

install_docker_shim
start_dockerd

if [ -z "${ZAG_SERVER_ENDPOINT:-}" ]; then
  log "ZAG_SERVER_ENDPOINT is not set; cannot connect to cloud-controller"
  exit 1
fi

log "connecting to cloud-controller: ${ZAG_SERVER_ENDPOINT%%\?*}"
exec agent-gear
