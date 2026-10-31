#!/usr/bin/env bash
# 默认工作容器入口：以 worker 用户保活运行 agent-gear（回连 cloud-controller）。
#
# 保活口径（docs/engineering/plan/20261025-feat-cloud-host-keepalive.md）：
# - 退出码 42（服务端终止：unregistered / 非失败类 shutdown / INVALID_TOKEN）→ 停止保活、入口 0；
# - 其余退出（0 / 1 / 信号 / 被误杀）→ 退避 1/2/5/10/30s → 自更新 → 重启；
# - PID 1 保持 root；agent-gear / npm / node 一律经 run_as_worker() 以 worker 身份执行
#   （root 环境没有 nodejs），显式构造 HOME/USER/LOGNAME/NVM_DIR/PATH；
# - stdout/stderr 实时透传；stderr 流式扫描仅记录 VERSION_MISMATCH 标记（0 字节）；
# - 作为 PID 1 向当前子进程转发 SIGTERM/SIGINT，销毁后不重启、不自更新。
#
# 连接参数：
#   ZAG_SERVER_ENDPOINT / ZAG_CONTROLLER_KEY（cloud-controller /worker）
#   ZAG_HOST_ENDPOINT / ZAG_HOST_KEY（controller-api 标准连接，仅云电脑模式）
# 可选开关：
#   ZAG_SKIP_AGENT_GEAR_UPDATE=1  跳过全部自更新（启动与每轮），但仍保活重启
#   ZAG_KEEPALIVE_BACKOFF_MS      退避整体缩放（毫秒；仅测试用）
set -euo pipefail

WORKER_UID=1000
WORKER_GID=1000
WORKER_HOME=/home/worker
WORKER_NVM_DIR="$WORKER_HOME/.nvm"
WORKER_PATH="$WORKER_NVM_DIR/current/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

CHILD_PID=""
SCAN_PID=""
shutting_down=0

# 单行 JSON 日志（契约 contracts/observability.md / 裁决 D6）：纯 printf + sed 转义，
# 不引 jq/python。字段与 pino 对齐；service 固定 zag-worker，serviceVersion 取
# ZAG_WORKER_VERSION（缺省 unknown）。控制字符直接剔除保证单行可解析。
json_escape() { printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

log() {
  local esc time
  esc=$(json_escape "$*")
  time=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{"level":"info","time":"%s","service":"zag-worker","serviceVersion":"%s","env":"%s","hostname":"%s","pid":%s,"component":"worker-entrypoint","msg":"%s"}\n' \
    "$time" "${ZAG_WORKER_VERSION:-unknown}" "${NODE_ENV:-development}" "$(hostname 2>/dev/null || echo unknown)" "$$" "$esc"
}

# 以 worker 身份执行：setpriv 降权 + 显式构造环境（root 环境无 nodejs）。
run_as_worker() {
  setpriv --reuid="$WORKER_UID" --regid="$WORKER_GID" --init-groups \
    env HOME="$WORKER_HOME" USER=worker LOGNAME=worker \
        NVM_DIR="$WORKER_NVM_DIR" PATH="$WORKER_PATH" "$@"
}

# 后台子进程专用：exec 替换当前 shell，保证 PID 1 的转发信号直达子进程本体。
run_as_worker_exec() {
  exec setpriv --reuid="$WORKER_UID" --regid="$WORKER_GID" --init-groups \
    env HOME="$WORKER_HOME" USER=worker LOGNAME=worker \
        NVM_DIR="$WORKER_NVM_DIR" PATH="$WORKER_PATH" "$@"
}

# 启动 / 每轮自更新：npm install -g agent-gear（写入 worker 的 per-user nvm 前缀）。
# 失败不阻断保活；skip 开关跳过全部自更新。
update_agent_gear() {
  if [ "${ZAG_SKIP_AGENT_GEAR_UPDATE:-0}" = "1" ]; then
    log "skipping agent-gear update (ZAG_SKIP_AGENT_GEAR_UPDATE=1)"
    return 0
  fi
  local registry
  registry=$(run_as_worker npm config get registry 2>/dev/null || echo unknown)
  log "updating agent-gear via npm (registry=$registry)"
  local rc=0
  run_as_worker_exec npm install -g agent-gear --no-fund --no-audit &
  CHILD_PID=$!
  wait "$CHILD_PID" || rc=$?
  CHILD_PID=""
  if [ "$rc" -eq 0 ]; then
    log "agent-gear updated: $(run_as_worker agent-gear --version 2>/dev/null || echo 'version unknown')"
  else
    log "WARN: agent-gear update failed; continuing with the pre-installed version ($(run_as_worker agent-gear --version 2>/dev/null || echo 'version unknown'))"
  fi
  return 0
}

# stderr 流式扫描：逐行回写 fd 2，仅 VERSION_MISMATCH 落 0 字节标记（不落盘完整日志）。
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

# 运行 agent-gear：stdout 直通；stderr 经 FIFO 扫描；返回其退出码。
run_agent_gear() {
  local fifo="$RUN_DIR/stderr.fifo"
  rm -f "$fifo"
  mkfifo "$fifo"
  scan_stderr < "$fifo" &
  local scan_pid=$!
  SCAN_PID=$scan_pid
  run_as_worker_exec agent-gear 2> "$fifo" &
  CHILD_PID=$!
  local rc=0
  wait "$CHILD_PID" || rc=$?
  CHILD_PID=""
  wait "$scan_pid" || true
  SCAN_PID=""
  rm -f "$fifo"
  return "$rc"
}

# 退避毫秒：1/2/5/10/30s 封顶；ZAG_KEEPALIVE_BACKOFF_MS 整体缩放（仅测试）。
backoff_delay_ms() {
  local attempt="$1"
  local steps=(1 2 5 10 30)
  local idx=$attempt
  [ "$idx" -ge 5 ] && idx=4
  local seconds=${steps[$idx]}
  if [ -n "${ZAG_KEEPALIVE_BACKOFF_MS:-}" ]; then
    echo $(( seconds * ZAG_KEEPALIVE_BACKOFF_MS ))
  else
    echo $(( seconds * 1000 ))
  fi
}

sleep_ms() {
  local ms="$1"
  sleep "$(printf '%d.%03d' $((ms / 1000)) $((ms % 1000)))"
}

# 保活循环：42 停止；其余退避 → 每轮自更新 → 重启；稳定运行 >=60s 重置退避。
supervise_agent_gear() {
  local attempt=0
  while true; do
    [ "$shutting_down" -eq 1 ] && return 0
    rm -f "$MISMATCH_MARKER"
    local rc=0 start_ts=$SECONDS
    run_agent_gear || rc=$?
    [ "$shutting_down" -eq 1 ] && return 0
    if [ "$rc" -eq 42 ]; then
      log "agent-gear exited (code=42): server shutdown; stopping keepalive"
      return 0
    fi
    [ $((SECONDS - start_ts)) -ge 60 ] && attempt=0
    local delay_ms delay_log
    delay_ms=$(backoff_delay_ms "$attempt")
    delay_log=$(printf '%d.%03ds' $((delay_ms / 1000)) $((delay_ms % 1000)))
    log "agent-gear exited (code=$rc); self-update then restarting in ${delay_log} (attempt #$((attempt + 1)))"
    sleep_ms "$delay_ms"
    [ "$shutting_down" -eq 1 ] && return 0
    update_agent_gear
    attempt=$((attempt + 1))
  done
}

# PID 1 信号：置位 shutting_down，转发 SIGTERM（必要时 SIGINT）并等待；绝不重启/自更新。
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

# 仅直接执行时运行 main；便于测试按需 source 单个纯函数。
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi


