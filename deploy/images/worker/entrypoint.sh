#!/usr/bin/env bash
# 默认工作容器入口：以 worker 用户保活运行 agent-gear（回连 cloud-controller）。
#
# 保活口径（docs/engineering/plan/20261025-feat-cloud-host-keepalive.md）：
# - 退出码 42（服务端终止：unregistered / 非失败类 shutdown / INVALID_TOKEN）→ 停止保活、入口 0；
# - 其余退出（0 / 1 / 信号 / 被误杀）→ 退避 1/2/5/10/30s → 自更新 → 重启；
# - PID 1 保持 root；agent-gear / npm / node 一律经 run_as_worker() 以 worker 身份执行
#   （root 环境没有 nodejs），显式构造 HOME/USER/LOGNAME/NVM_DIR/PNPM_HOME/PATH；
# - stdout/stderr 实时透传；stderr 流式扫描仅记录 VERSION_MISMATCH 标记（0 字节）；
# - 作为 PID 1 向当前子进程转发 SIGTERM/SIGINT，销毁后不重启、不自更新。
#
# pnpm 口径（docs/engineering/plan/20261029-feat-pnpm-workload-and-harness-optional.md）：
# - 启动时 ensure_pnpm 预装固定版本 pnpm（幂等、失败仅告警不阻断保活；工作负载脚本自带
#   npm 自举回退兜底存量容器）；
# - PNPM_HOME/bin（pnpm 12 的全局 bin）与 PNPM_HOME 并入 WORKER_PATH，并写 /etc/profile.d/pnpm.sh
#   （登录 shell）与 `pnpm setup`（交互 shell ~/.bashrc）双入口；agent-gear 预装与自更新统一走
#   pnpm（`pnpm add -g`），npm 仅保留为 pnpm 自举通道（存量容器 `npm install -g pnpm@12.16.1`）。
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
# pnpm 固定版本与全局 bin 目录（决策 1/2）：与迁移 017/018 脚本内自举回退块同版本。
PNPM_VERSION="${PNPM_VERSION:-12.16.1}"
# pnpm 可执行文件（测试可指向不存在的命令，用于验证存量容器自举分支）。
PNPM_CMD="${ZAG_PNPM_CMD:-pnpm}"
PNPM_HOME="$WORKER_HOME/.local/share/pnpm"
# pnpm 12 的全局 bin 目录为 $PNPM_HOME/bin（pnpm 9 为 $PNPM_HOME，两者都保留以兼容存量）。
PNPM_BIN_DIR="$PNPM_HOME/bin"
# /etc/profile.d 写入目标（登录 shell 全局生效）；仅测试可用环境变量改写到临时目录。
PNPM_PROFILE_FILE="${ZAG_PNPM_PROFILE_FILE:-/etc/profile.d/pnpm.sh}"
# 既有顺序不变，仅在 nvm bin 之后追加 pnpm 全局 bin。
WORKER_PATH="$WORKER_NVM_DIR/current/bin:$PNPM_BIN_DIR:$PNPM_HOME:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

CHILD_PID=""
SCAN_PID=""
shutting_down=0

# 单行 JSON 日志（契约 contracts/observability.md / 裁决 D6）：纯 printf + sed 转义，
# 不引 jq/python。字段与 pino 对齐；service 固定 zag-worker，serviceVersion 取
# ZAG_WORKER_VERSION（缺省 unknown）。控制字符直接剔除保证单行可解析。
json_escape() { printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

log() {
  local esc time ver env_name host_name
  esc=$(json_escape "$*")
  # 契约 T-OBS16「每行可 JSON.parse」：字段值与 msg 一样必须过 json_escape（env/主机名含引号或
  # 反斜杠时裸插会产生非法 JSON）。pid 为数字，安全。
  ver=$(json_escape "${ZAG_WORKER_VERSION:-unknown}")
  env_name=$(json_escape "${NODE_ENV:-development}")
  host_name=$(json_escape "$(hostname 2>/dev/null || echo unknown)")
  time=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{"level":"info","time":"%s","service":"zag-worker","serviceVersion":"%s","env":"%s","hostname":"%s","pid":%s,"component":"worker-entrypoint","msg":"%s"}\n' \
    "$time" "$ver" "$env_name" "$host_name" "$$" "$esc"
}

# 以 worker 身份执行：setpriv 降权 + 显式构造环境（root 环境无 nodejs）。
run_as_worker() {
  setpriv --reuid="$WORKER_UID" --regid="$WORKER_GID" --init-groups \
    env HOME="$WORKER_HOME" USER=worker LOGNAME=worker \
        NVM_DIR="$WORKER_NVM_DIR" PNPM_HOME="$PNPM_HOME" PATH="$WORKER_PATH" "$@"
}

# 后台子进程专用：exec 替换当前 shell，保证 PID 1 的转发信号直达子进程本体。
run_as_worker_exec() {
  exec setpriv --reuid="$WORKER_UID" --regid="$WORKER_GID" --init-groups \
    env HOME="$WORKER_HOME" USER=worker LOGNAME=worker \
        NVM_DIR="$WORKER_NVM_DIR" PNPM_HOME="$PNPM_HOME" PATH="$WORKER_PATH" "$@"
}

# 重写 /etc/profile.d/pnpm.sh 的幂等标记块（登录 shell 生效）：先清旧块再追加。
# 写失败（非 root/只读文件系统）仅告警——交互/登录 shell 接线是双保险之一。
write_pnpm_profile() {
  {
    if [ -f "$PNPM_PROFILE_FILE" ]; then
      sed -i '/^# >>> pnpm >>>$/,/^# <<< pnpm <<<$/d' "$PNPM_PROFILE_FILE" 2>/dev/null || true
    fi
    printf '# >>> pnpm >>>\nexport PNPM_HOME="%s"\ncase ":$PATH:" in *":$PNPM_HOME/bin:"*) ;; *) export PATH="$PNPM_HOME/bin:$PATH" ;; esac\ncase ":$PATH:" in *":$PNPM_HOME:"*) ;; *) export PATH="$PNPM_HOME:$PATH" ;; esac\n# <<< pnpm <<<\n' \
      "$PNPM_HOME" >> "$PNPM_PROFILE_FILE"
  } 2>/dev/null || log "WARN: cannot write pnpm profile ($PNPM_PROFILE_FILE)"
}

# 预装固定版本 pnpm（幂等）：优先 `command -v pnpm` 命中即跳过；安装固定版本 pin。
# 失败仅告警不阻断（工作负载脚本内的自举回退块兜底存量容器）；不受自更新 skip 开关影响。
ensure_pnpm() {
  if run_as_worker sh -c "command -v '$PNPM_CMD' >/dev/null 2>&1"; then
    log "pnpm already installed: $(run_as_worker "$PNPM_CMD" --version 2>/dev/null || echo 'version unknown')"
  elif run_as_worker npm install -g "pnpm@${PNPM_VERSION}" --no-fund --no-audit; then
    log "pnpm installed: $(run_as_worker "$PNPM_CMD" --version 2>/dev/null || echo 'version unknown')"
  else
    log "WARN: pnpm install failed; workload scripts will fall back to npm bootstrap"
  fi
  write_pnpm_profile
  run_as_worker "$PNPM_CMD" setup >/dev/null 2>&1 || true
}

# 启动 / 每轮自更新：pnpm add -g agent-gear（写入 PNPM_HOME 全局 bin）。
# 失败不阻断保活；skip 开关跳过全部自更新。
update_agent_gear() {
  if [ "${ZAG_SKIP_AGENT_GEAR_UPDATE:-0}" = "1" ]; then
    log "skipping agent-gear update (ZAG_SKIP_AGENT_GEAR_UPDATE=1)"
    return 0
  fi
  local registry
  registry=$(run_as_worker "$PNPM_CMD" config get registry 2>/dev/null || echo unknown)
  log "updating agent-gear via pnpm (registry=$registry)"
  local rc=0
  run_as_worker_exec "$PNPM_CMD" add -g agent-gear &
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

  # 先确保 pnpm 就绪（任何工作负载脚本下发前），再进入自更新/保活链路。
  ensure_pnpm

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


