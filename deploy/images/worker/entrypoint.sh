#!/usr/bin/env bash
# 默认工作容器入口：更新 agent-gear，然后以「受监督」方式运行 agent-gear 回连 cloud-controller。
#
# 容器内 docker 能力（命令行、镜像代理包装器、Docker 守护进程）全部由「Docker」工作负载的初始化
# 脚本提供：入口不装配包装器、不调用 docker、也不拉起守护进程；未选择该工作负载时容器内没有 docker。
# Docker 脚本见 servers/admin-api/src/migrations/002-refresh-docker-preset-script.ts（v2）。
#
# 监督职责（见 docs/engineering/plan/20261017-feat-controller-version-requirement.md）：
# - stdout/stderr 实时透传；stderr 流式扫描，只记录是否出现稳定错误码 VERSION_MISMATCH；
# - 仅在「非零退出 + 出现 VERSION_MISMATCH + 本轮未升级 + 未设置跳过开关」时执行一次
#   `npm install -g agent-gear`，成功后重启；第二次不匹配/安装失败/普通错误均收敛退出；
# - 作为 PID 1 向当前子进程（agent-gear / npm）转发 SIGTERM/SIGINT 并等待退出，销毁后不重启。
#
# 连接参数来自注入的环境变量：
#   ZAG_SERVER_ENDPOINT  形如 wss://<cloud-controller>/worker（不含 token）
#   ZAG_CONTROLLER_KEY   /worker 一次性容器 token（agent-gear 连接 cloud-controller 时经 Socket.IO
#                        握手 auth.token 携带，不进 URL；**不是** controller-api 的控制器 Key）
#   ZAG_HOST_ENDPOINT    云电脑标准连接地址（controller-api；仅 harness 容器注入）
#   ZAG_HOST_KEY         云电脑标准连接凭据（ControllerKey type=cloud；仅经握手 auth.token 携带，
#                        不进 URL；普通 idle 容器不注入）
# 云电脑容器由 agent-gear 自动进入双连接模式（/worker + controller-api），退出时不发送 unregister；
# 普通容器的连接行为与既有版本完全一致。
# 可选开关：
#   ZAG_SKIP_AGENT_GEAR_UPDATE=1  跳过启动更新与版本不匹配后的自动升级
set -euo pipefail

# 当前正在运行的子进程（agent-gear 或 npm）：PID 1 收到信号时转发给它。
CHILD_PID=""
SCAN_PID=""
# 置位后主循环不再拉起 agent-gear / 执行升级。
shutting_down=0

log() { echo "[worker] $*"; }

# ---------------------------------------------------------------------------
# 启动更新：`npm install -g agent-gear`（走镜像内置的内网 npm 代理）。
# 失败**不阻断**启动：镜像内已预装可用的 agent-gear，避免代理抖动/离线时容器起不来。
# 设 ZAG_SKIP_AGENT_GEAR_UPDATE=1 可跳过（离线或排障时；亦跳过版本不匹配后的自动升级）。
# ---------------------------------------------------------------------------
update_agent_gear() {
  if [ "${ZAG_SKIP_AGENT_GEAR_UPDATE:-0}" = "1" ]; then
    log "skipping agent-gear update (ZAG_SKIP_AGENT_GEAR_UPDATE=1)"
    return 0
  fi
  log "updating agent-gear via npm (registry=$(npm config get registry 2>/dev/null || echo unknown))"
  local rc=0
  npm install -g agent-gear --no-fund --no-audit &
  CHILD_PID=$!
  wait "$CHILD_PID" || rc=$?
  CHILD_PID=""
  if [ "$rc" -eq 0 ]; then
    log "agent-gear updated: $(agent-gear --version 2>/dev/null || echo 'version unknown')"
  else
    log "WARN: agent-gear update failed; continuing with the pre-installed version ($(agent-gear --version 2>/dev/null || echo 'version unknown'))"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# stderr 流式扫描：逐行原样回写 fd 2，只在出现稳定错误码 VERSION_MISMATCH 时落一个标记文件。
# 不把完整运行日志落盘（标记文件为 0 字节），避免磁盘无界增长。
# ---------------------------------------------------------------------------
scan_stderr() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s\n' "$line" >&2
    case "$line" in
      *VERSION_MISMATCH*)
        : > "$MISMATCH_MARKER"
        log "agent-gear reported VERSION_MISMATCH"
        ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# 运行 agent-gear：stdout 直接透传到入口 stdout；stderr 经 FIFO 交给 scan_stderr 流式扫描。
# 返回 agent-gear 的退出码；$CHILD_PID 供信号转发使用。
# ---------------------------------------------------------------------------
run_agent_gear() {
  local fifo="$RUN_DIR/stderr.fifo"
  rm -f "$fifo"
  mkfifo "$fifo"
  scan_stderr < "$fifo" &
  local scan_pid=$!
  SCAN_PID=$scan_pid
  agent-gear 2> "$fifo" &
  CHILD_PID=$!
  local rc=0
  wait "$CHILD_PID" || rc=$?
  CHILD_PID=""
  wait "$scan_pid" || true
  SCAN_PID=""
  rm -f "$fifo"
  return "$rc"
}

# ---------------------------------------------------------------------------
# 版本不匹配后的一次性升级：固定包名 + 固定 registry（不读取服务端下发的任何地址）。
# 成功判据：npm 退出 0 且 `agent-gear --version` 输出非空。
# ---------------------------------------------------------------------------
maybe_upgrade_agent_gear() {
  log "upgrading agent-gear after VERSION_MISMATCH (registry=$(npm config get registry 2>/dev/null || echo unknown))"
  local rc=0
  npm install -g agent-gear --no-fund --no-audit &
  CHILD_PID=$!
  wait "$CHILD_PID" || rc=$?
  CHILD_PID=""
  if [ "$rc" -ne 0 ]; then
    log "ERROR: agent-gear upgrade failed (exit=$rc); stopping recovery loop"
    return 1
  fi
  local version
  version=$(agent-gear --version 2>/dev/null | head -n 1 || true)
  if [ -z "$version" ]; then
    log "ERROR: agent-gear --version is unavailable after upgrade; stopping recovery loop"
    return 1
  fi
  log "agent-gear upgraded: $version"
  return 0
}

# ---------------------------------------------------------------------------
# 受监督运行：
# - exit 0 / 信号退出 / 普通非零退出 → 结束，不升级不重启；
# - 非零退出 + mismatch 标记 + 未尝试升级 + 未设置跳过开关 → 升级一次后重启；
# - 第二次 mismatch / 安装失败 / skip → 非零退出（有界收敛）。
# ---------------------------------------------------------------------------
supervise_agent_gear() {
  local upgrade_attempted=0
  while true; do
    if [ "$shutting_down" -eq 1 ]; then
      return 0
    fi
    rm -f "$MISMATCH_MARKER"
    local rc=0
    if run_agent_gear; then
      rc=0
    else
      rc=$?
    fi
    if [ "$shutting_down" -eq 1 ]; then
      return 0
    fi
    if [ "$rc" -eq 0 ]; then
      log "agent-gear exited normally"
      return 0
    fi
    if [ ! -f "$MISMATCH_MARKER" ]; then
      log "agent-gear exited with code $rc (no VERSION_MISMATCH); not upgrading"
      return "$rc"
    fi
    if [ "$upgrade_attempted" -eq 1 ]; then
      log "ERROR: agent-gear still reports VERSION_MISMATCH after upgrade; exiting"
      return 1
    fi
    if [ "${ZAG_SKIP_AGENT_GEAR_UPDATE:-0}" = "1" ]; then
      log "ERROR: agent-gear VERSION_MISMATCH; auto-upgrade disabled (ZAG_SKIP_AGENT_GEAR_UPDATE=1)"
      return 1
    fi
    if ! maybe_upgrade_agent_gear; then
      return 1
    fi
    upgrade_attempted=1
  done
}

# ---------------------------------------------------------------------------
# PID 1 信号语义：置位 shutting_down，向当前子进程转发 SIGTERM（必要时 SIGINT）并等待退出。
# 销毁信号后绝不重启 agent-gear 或执行升级。
# ---------------------------------------------------------------------------
shutdown() {
  local signal="${1:-SIGTERM}"
  shutting_down=1
  log "shutdown requested ($signal), forwarding to child"
  if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill -TERM "$CHILD_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$CHILD_PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$CHILD_PID" 2>/dev/null; then
      kill -INT "$CHILD_PID" 2>/dev/null || true
    fi
    wait "$CHILD_PID" 2>/dev/null || true
  fi
  if [ -n "${SCAN_PID:-}" ] && kill -0 "$SCAN_PID" 2>/dev/null; then
    kill -TERM "$SCAN_PID" 2>/dev/null || true
    wait "$SCAN_PID" 2>/dev/null || true
  fi
  exit 0
}

main() {
  trap 'shutdown SIGTERM' SIGTERM
  trap 'shutdown SIGINT' SIGINT

  update_agent_gear

  if [ -z "${ZAG_SERVER_ENDPOINT:-}" ]; then
    log "ZAG_SERVER_ENDPOINT is not set; cannot connect to cloud-controller"
    exit 1
  fi

  RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/zag-worker.XXXXXX")
  MISMATCH_MARKER="$RUN_DIR/mismatch"

  log "connecting to cloud-controller: ${ZAG_SERVER_ENDPOINT%%\?*}"
  local rc=0
  if supervise_agent_gear; then
    rc=0
  else
    rc=$?
  fi
  exit "$rc"
}

# 仅直接执行时运行 main；便于测试/排障按需 source 单个纯函数（不改变 PID 1 行为）。
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
