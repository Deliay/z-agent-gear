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
# 主目录工具链口径：
# - 镜像**不再预装** nvm / Node.js / pnpm / agent-gear（挂载云存储会遮蔽 /home/worker），
#   全部由入口启动时以 worker 身份幂等安装：
#   ① bootstrap_home：内网 git 仓库安装 nvm → nvm 安装 Node.js → 设置 npm registry；
#   ② ensure_pnpm：用 npm 自举固定版本 pnpm；
#   ③ update_agent_gear：用 pnpm 安装 / 更新 agent-gear；
# - nvm / pnpm 的登录 shell 接线由入口幂等写入 /etc/profile.d，不依赖镜像层；
# - README/BUILD 中提到的构建期安装口径已随云存储上线废弃。
#
# 连接参数：
#   ZAG_SERVER_ENDPOINT / ZAG_CONTROLLER_KEY（cloud-controller /worker）
#   ZAG_HOST_ENDPOINT / ZAG_HOST_KEY（controller-api 标准连接，仅云电脑模式）
# 可选开关：
#   ZAG_SKIP_AGENT_GEAR_UPDATE=1  跳过全部自更新（启动与每轮），但仍保活重启
#   ZAG_KEEPALIVE_BACKOFF_MS      退避整体缩放（毫秒；仅测试用）
#   ZAG_STORAGE_HOME=1            当前容器挂载了云存储（/home/worker 为 PVC）：仅用于失败日志/回滚语义
#
# 云存储自举口径（docs/engineering/plan/20261102-feat-cloud-storage.md Phase 2 / 提案实现点 4）：
# 镜像不再预装任何主目录工具链，PVC 挂载 /home/worker 后由入口统一重建：
# - bootstrap_home 按「产物存在且可执行」幂等安装 nvm（内网 git 仓库）/ Node.js（归档恢复的完整主目录直接跳过）；
# - ensure_pnpm / update_agent_gear 补齐 pnpm / agent-gear；
# - ZAG_STORAGE_HOME=1 时任一步失败 → fail-fast（Job 失败 → 创建云电脑失败 → 存储回滚）；
# - 未设置时失败仅告警，继续保活（自举完整时为 no-op）。
# 所有安装命令均经 run_as_worker 以 worker 用户执行，确保 /home/worker 下产物属主为 worker。
set -euo pipefail

WORKER_UID=1000
WORKER_GID=1000
WORKER_HOME=/home/worker
# nvm 落点；仅测试用 ZAG_WORKER_NVM_DIR 指向临时目录（避免触碰真实 /home/worker）。
WORKER_NVM_DIR="${ZAG_WORKER_NVM_DIR:-$WORKER_HOME/.nvm}"
# nvm / Node.js 安装来源：默认值全部收敛在入口（镜像不再固化相关 ARG/ENV）；
# 均可用运行时同名环境变量覆盖。内网 git 镜像仅同步 master 分支（无 tag），故默认 ref=master。
NVM_INSTALL_URL="${NVM_INSTALL_URL:-https://git.internal.fffdan.com/nvm-sh/nvm/raw/branch/master/install.sh}"
NVM_SOURCE="${NVM_SOURCE:-https://git.internal.fffdan.com/nvm-sh/nvm.git}"
NVM_INSTALL_VERSION="${NVM_INSTALL_VERSION:-master}"
NODE_VERSION="${NODE_VERSION:-24}"
# nvm 读取的 Node.js 发行包源（内网 Nexus node-proxy），经 run_as_worker 透传给 worker 子进程。
NVM_NODEJS_ORG_MIRROR="${NVM_NODEJS_ORG_MIRROR:-https://nexus.internal.fffdan.com/repository/node-proxy}"
# npm / pnpm registry：镜像仍以 ENV 下发，这里兜底并导出给后续工作负载。
NPM_REGISTRY="${NPM_REGISTRY:-https://nexus.internal.fffdan.com/repository/npm-proxy/}"
export NPM_REGISTRY
# pnpm 固定版本与全局 bin 目录（决策 1/2）：与迁移 017/018 脚本内自举回退块同版本。
PNPM_VERSION="${PNPM_VERSION:-12.16.1}"
# pnpm 可执行文件（测试可指向不存在的命令，用于验证存量容器自举分支）。
PNPM_CMD="${ZAG_PNPM_CMD:-pnpm}"
PNPM_HOME="$WORKER_HOME/.local/share/pnpm"
# pnpm 12 的全局 bin 目录为 $PNPM_HOME/bin（pnpm 9 为 $PNPM_HOME，两者都保留以兼容存量）。
PNPM_BIN_DIR="$PNPM_HOME/bin"
# /etc/profile.d 写入目标（登录 shell 全局生效）；仅测试可用环境变量改写到临时目录。
NVM_PROFILE_FILE="${ZAG_NVM_PROFILE_FILE:-/etc/profile.d/nvm.sh}"
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
        NVM_DIR="$WORKER_NVM_DIR" NVM_SYMLINK_CURRENT=true \
        NVM_NODEJS_ORG_MIRROR="$NVM_NODEJS_ORG_MIRROR" \
        PNPM_HOME="$PNPM_HOME" PATH="$WORKER_PATH" "$@"
}

# 后台子进程专用：exec 替换当前 shell，保证 PID 1 的转发信号直达子进程本体。
run_as_worker_exec() {
  exec setpriv --reuid="$WORKER_UID" --regid="$WORKER_GID" --init-groups \
    env HOME="$WORKER_HOME" USER=worker LOGNAME=worker \
        NVM_DIR="$WORKER_NVM_DIR" NVM_SYMLINK_CURRENT=true \
        NVM_NODEJS_ORG_MIRROR="$NVM_NODEJS_ORG_MIRROR" \
        PNPM_HOME="$PNPM_HOME" PATH="$WORKER_PATH" "$@"
}

# 重写 /etc/profile.d/nvm.sh 的幂等标记块（登录 shell 生效）：先清旧块再追加。
# 写失败（非 root/只读文件系统）仅告警——登录 shell 接线不阻断保活。
write_nvm_profile() {
  {
    if [ -f "$NVM_PROFILE_FILE" ]; then
      sed -i '/^# >>> nvm >>>$/,/^# <<< nvm <<<$/d' "$NVM_PROFILE_FILE" 2>/dev/null || true
    fi
    printf '%s\n' \
      '# >>> nvm >>>' \
      'export NVM_DIR="$HOME/.nvm"' \
      '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' \
      '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"' \
      '# <<< nvm <<<' >> "$NVM_PROFILE_FILE"
  } 2>/dev/null || log "WARN: cannot write nvm profile ($NVM_PROFILE_FILE)"
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

# 自举失败处理：挂载云存储（ZAG_STORAGE_HOME=1）时 fail-fast 非零退出（不进入保活循环）；
# 未挂载时仅告警，沿用镜像既有环境继续保活（镜像内容完整时各锚点命中，不会走到这里）。
bootstrap_fail() {
  if [ "${ZAG_STORAGE_HOME:-0}" = "1" ]; then
    log "bootstrap_home failed ($1); ZAG_STORAGE_HOME=1 so exiting non-zero"
    exit 1
  fi
  log "WARN: bootstrap_home failed ($1); continuing with the image environment"
  return 0
}

# 主目录工具链自举（幂等，位于 ensure_pnpm 之前）：
# 1) nvm.sh 不存在/不可 source → 用内网安装脚本（NVM_INSTALL_URL）以自定义 git 仓库（NVM_SOURCE）重装；
# 2) current/bin/node 不可执行 → nvm install --default + nvm alias default + 重建 current 软链 + npm registry；
# 3) pnpm / agent-gear 交给既有 ensure_pnpm / update_agent_gear 幂等补齐。
# 判定只基于「产物存在且可执行」，已完成的主目录（镜像自带或归档恢复）直接跳过。
# 下载/安装输出统一转 stderr，保持入口 stdout 只有单行 JSON 日志（契约 observability）。
bootstrap_home() {
  local node_version="${NODE_VERSION:-24}"
  local nvm_install_url="${NVM_INSTALL_URL:-}"
  local nvm_source="${NVM_SOURCE:-}"
  local nvm_install_version="${NVM_INSTALL_VERSION:-master}"

  if ! run_as_worker bash -c '. "$NVM_DIR/nvm.sh" >/dev/null 2>&1'; then
    if [ -z "$nvm_install_url" ] || [ -z "$nvm_source" ]; then
      bootstrap_fail "nvm.sh is unavailable and NVM_INSTALL_URL/NVM_SOURCE is not set"
      return 0
    fi
    log "bootstrap_home: nvm not available, installing (NVM_INSTALL_URL=$nvm_install_url, NVM_SOURCE=$nvm_source, ref=$nvm_install_version)"
    # 以 worker 身份执行；METHOD=git 使用自定义 git 仓库，PROFILE=/dev/null 不写 profile
    # （登录 shell 接线由 write_nvm_profile 统一幂等写入）。卸载 NODE_VERSION 避免安装脚本
    # 顺带安装 Node.js，Node 安装由下方独立步骤显式执行。
    # curl 与安装脚本同处一条管道：set -o pipefail 保证下载失败即整条管道非零。
    if ! { curl -fsSL "$nvm_install_url" | run_as_worker env -u NODE_VERSION PROFILE=/dev/null METHOD=git \
        NVM_SOURCE="$nvm_source" NVM_INSTALL_VERSION="$nvm_install_version" bash; } 1>&2; then
      bootstrap_fail "nvm install failed (NVM_INSTALL_URL=$nvm_install_url, NVM_SOURCE=$nvm_source, ref=$nvm_install_version)"
      return 0
    fi
    if ! run_as_worker bash -c '. "$NVM_DIR/nvm.sh" >/dev/null 2>&1'; then
      bootstrap_fail "nvm.sh is still unavailable after install"
      return 0
    fi
    log "bootstrap_home: nvm installed"
  fi

  if [ ! -x "$WORKER_NVM_DIR/current/bin/node" ]; then
    log "bootstrap_home: node not available, installing Node.js $node_version"
    if ! run_as_worker env NODE_VERSION="$node_version" bash -c '
        set -eu
        . "$NVM_DIR/nvm.sh"
        nvm install --default "$NODE_VERSION"
        nvm alias default "$NODE_VERSION"
        ln -sfn "$(dirname "$(dirname "$(nvm which default)")")" "$NVM_DIR/current"
      ' 1>&2; then
      bootstrap_fail "Node.js install failed (version=$node_version)"
      return 0
    fi
    if [ -n "${NPM_REGISTRY:-}" ] && ! run_as_worker npm config set registry "$NPM_REGISTRY" 1>&2; then
      bootstrap_fail "npm registry configuration failed (NPM_REGISTRY=$NPM_REGISTRY)"
      return 0
    fi
    if [ ! -x "$WORKER_NVM_DIR/current/bin/node" ]; then
      bootstrap_fail "current/bin/node is still unavailable after install"
      return 0
    fi
    log "bootstrap_home: node installed ($("$WORKER_NVM_DIR/current/bin/node" --version 2>/dev/null || echo 'version unknown'))"
  fi
  return 0
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

  # 先写登录 shell 接线，再重建被云存储卷遮蔽的主目录工具链（幂等），随后确保 pnpm 就绪
  # （任何工作负载脚本下发前），最后进入自更新/保活链路。
  write_nvm_profile

  bootstrap_home

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


