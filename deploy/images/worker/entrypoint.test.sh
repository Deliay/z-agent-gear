#!/usr/bin/env bash
# worker entrypoint 恢复/失败/信号测试：纯 Bash + 临时 PATH stub，不依赖 Bats、不启动真实 dockerd、
# 不访问真实 npm 网络。
#
# 覆盖（对应实现计划 T-EP0 ~ T-EP8）：
#   T-EP0 入口不装配 docker shim、不调用 docker/dockerd（docker 能力全部由「Docker」工作负载脚本提供）
#   T-EP0a 入口源码静态断言：不含 install_docker_shim / DOCKER_SHIM_PATH / HARBOR_PROXY
#   T-EP1 版本不匹配 → 一次升级 → 重启成功
#   T-EP2 升级安装失败 → 非零退出，无循环
#   T-EP3 升级后仍不匹配 → 非零退出，不再升级
#   T-EP4 ZAG_SKIP_AGENT_GEAR_UPDATE=1 → 不升级直接退出
#   T-EP5 普通非零退出 → 不升级
#   T-EP6 正常退出 → 不升级
#   T-EP7 SIGTERM / SIGINT → 转发子进程、退出 0、不重启
#   T-EP8 日志有界：运行目录不落盘完整日志，stdout/stderr 透传
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRYPOINT="$SCRIPT_DIR/entrypoint.sh"
ORIGINAL_PATH="$PATH"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "ok - $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL - $*" >&2; }

assert_eq() {
  local expected="$1" actual="$2" message="$3"
  if [ "$expected" = "$actual" ]; then
    pass "$message"
  else
    fail "$message (expected=$expected actual=$actual)"
  fi
}

assert_contains() {
  local file="$1" needle="$2" message="$3"
  if [ -f "$file" ] && grep -qF -- "$needle" "$file"; then
    pass "$message"
  else
    fail "$message (missing '$needle' in $file)"
  fi
}

count_lines() {
  local file="$1"
  if [ -f "$file" ]; then
    wc -l < "$file" | tr -d ' '
  else
    echo 0
  fi
}

write_stubs() {
  mkdir -p "$STUB_DIR"

  # docker / dockerd stub 仅用于**哨兵**：入口不再调用 docker/dockerd（能力由「Docker」工作负载脚本提供），
  # 一旦被调用即写入标记文件，T-EP0 断言标记不存在（stub 不依赖真实 dockerd / docker.sock）。
  cat > "$STUB_DIR/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_DIR/docker_invocations"
exit 0
STUB

  cat > "$STUB_DIR/dockerd" <<'STUB'
#!/usr/bin/env bash
echo "dockerd $*" >> "$STUB_DIR/dockerd_invocations"
exit 0
STUB

  cat > "$STUB_DIR/npm" <<'STUB'
#!/usr/bin/env bash
set -u
# `npm config get registry` 不计数、不改版本。
if [ "${1:-}" = "config" ]; then
  echo "https://npm.internal.fffdan.com/repository/npm-proxy/"
  exit 0
fi
echo "install" >> "$STUB_DIR/npm_installs"
if [ -f "$STUB_DIR/agent_starts" ]; then
  echo "recovery" >> "$STUB_DIR/npm_recovery_installs"
fi
case "${STUB_NPM_MODE:-ok}" in
  fail)
    exit 1
    ;;
  fail_once)
    count=$(wc -l < "$STUB_DIR/npm_installs" | tr -d ' ')
    if [ "$count" -eq 1 ]; then
      exit 1
    fi
    echo "2.2.0" > "$STUB_DIR/version"
    ;;
  noop)
    ;;
  ok)
    echo "2.2.0" > "$STUB_DIR/version"
    ;;
  *)
    exit 1
    ;;
esac
exit 0
STUB

  cat > "$STUB_DIR/agent-gear" <<'STUB'
#!/usr/bin/env bash
set -u
if [ "${1:-}" = "--version" ]; then
  cat "$STUB_DIR/version"
  exit 0
fi
echo "start" >> "$STUB_DIR/agent_starts"
case "${STUB_AGENT_MODE:-normal}" in
  mismatch)
    echo "connect failed: server error [VERSION_MISMATCH] minimum 2.2.0" >&2
    exit 1
    ;;
  by_version)
    if [ "$(cat "$STUB_DIR/version")" = "2.2.0" ]; then
      trap 'echo TERM >> "$STUB_DIR/signals"; exit 0' TERM
      trap 'echo INT >> "$STUB_DIR/signals"; exit 0' INT
      echo "agent-gear running version=2.2.0"
      exit 0
    fi
    echo "connect failed: server error [VERSION_MISMATCH] minimum 2.2.0" >&2
    exit 1
    ;;
  error)
    echo "connect failed: websocket error (connection refused)" >&2
    exit 7
    ;;
  normal)
    trap 'echo TERM >> "$STUB_DIR/signals"; exit 0' TERM
    trap 'echo INT >> "$STUB_DIR/signals"; exit 0' INT
    echo "agent-gear running version=$(cat "$STUB_DIR/version")"
    if [ "${STUB_RUN_FOREVER:-0}" = "1" ]; then
      echo ready > "$STUB_DIR/agent_ready"
      sleep 30 & wait $!
    fi
    exit 0
    ;;
  *)
    exit 3
    ;;
esac
STUB

  chmod +x "$STUB_DIR/docker" "$STUB_DIR/dockerd" "$STUB_DIR/npm" "$STUB_DIR/agent-gear"
}

setup_env() {
  local version="${1:-2.1.0}"
  TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/zag-entrypoint-test.XXXXXX")
  STUB_DIR="$TEST_DIR/bin"
  RUN_TMP="$TEST_DIR/run"
  mkdir -p "$STUB_DIR" "$RUN_TMP"
  write_stubs
  echo "$version" > "$STUB_DIR/version"

  export STUB_DIR
  export PATH="$STUB_DIR:$ORIGINAL_PATH"
  export TMPDIR="$RUN_TMP"
  export ZAG_SERVER_ENDPOINT="wss://cloud.example.invalid/worker"
  export STUB_AGENT_MODE="normal"
  export STUB_NPM_MODE="ok"
  export STUB_RUN_FOREVER=0
  unset ZAG_SKIP_AGENT_GEAR_UPDATE
  unset ZAG_DOCKER_SHIM_PATH
}

teardown_env() {
  rm -rf "$TEST_DIR"
  unset STUB_DIR TMPDIR ZAG_SERVER_ENDPOINT ZAG_DOCKER_SHIM_PATH
  unset STUB_AGENT_MODE STUB_NPM_MODE STUB_RUN_FOREVER STUB_AGENT_SLEEP
  unset ZAG_SKIP_AGENT_GEAR_UPDATE
  export PATH="$ORIGINAL_PATH"
}

run_entrypoint() {
  bash "$ENTRYPOINT" > "$TEST_DIR/stdout.log" 2> "$TEST_DIR/stderr.log"
  echo $?
}

# ---------------------------------------------------------------------------
echo "== bash -n =="
if bash -n "$ENTRYPOINT"; then
  pass "entrypoint.sh 语法检查"
else
  fail "entrypoint.sh 语法检查"
fi

# ---------------------------------------------------------------------------
echo "== T-EP0: 入口不装配 docker shim、不调用 docker/dockerd =="
setup_env 2.2.0
rc=$(run_entrypoint)
assert_eq 0 "$rc" "T-EP0 入口正常退出"
if [ -e "$TEST_DIR/docker-shim" ]; then
  fail "T-EP0 入口不应写入 docker shim ($TEST_DIR/docker-shim)"
else
  pass "T-EP0 入口未写入 docker shim"
fi
assert_eq 0 "$(count_lines "$STUB_DIR/dockerd_invocations")" "T-EP0 入口不启动 dockerd"
assert_eq 0 "$(count_lines "$STUB_DIR/docker_invocations")" "T-EP0 入口不调用 docker"
if grep -qF "start_dockerd" "$ENTRYPOINT"; then
  fail "T-EP0 entrypoint.sh 仍包含 start_dockerd"
else
  pass "T-EP0 entrypoint.sh 已移除 start_dockerd"
fi
teardown_env

# ---------------------------------------------------------------------------
echo "== T-EP0a: entrypoint.sh 不含 docker shim 残留 =="
for needle in install_docker_shim DOCKER_SHIM_PATH HARBOR_PROXY; do
  if grep -qF -- "$needle" "$ENTRYPOINT"; then
    fail "T-EP0a entrypoint.sh 仍包含 $needle"
  else
    pass "T-EP0a entrypoint.sh 已移除 $needle"
  fi
done

# ---------------------------------------------------------------------------
echo "== T-EP1: 版本不匹配 → 一次升级 → 重启成功 =="
setup_env 2.1.0
export STUB_AGENT_MODE=by_version
export STUB_NPM_MODE=fail_once
rc=$(run_entrypoint)
assert_eq 0 "$rc" "T-EP1 升级重连后正常退出"
assert_eq 2 "$(count_lines "$STUB_DIR/agent_starts")" "T-EP1 agent-gear 启动 2 次"
assert_eq 1 "$(count_lines "$STUB_DIR/npm_recovery_installs")" "T-EP1 恢复升级 1 次"
assert_eq 2 "$(count_lines "$STUB_DIR/npm_installs")" "T-EP1 启动更新失败 1 次 + 恢复升级 1 次"
assert_eq "2.2.0" "$(cat "$STUB_DIR/version")" "T-EP1 升级后版本为 2.2.0"
assert_contains "$TEST_DIR/stdout.log" "agent-gear upgraded: 2.2.0" "T-EP1 日志记录升级后版本"
teardown_env

# ---------------------------------------------------------------------------
echo "== T-EP2: 升级失败 → 非零退出 =="
setup_env 2.1.0
export STUB_AGENT_MODE=mismatch
export STUB_NPM_MODE=fail
rc=$(run_entrypoint)
if [ "$rc" -ne 0 ]; then pass "T-EP2 安装失败非零退出"; else fail "T-EP2 安装失败应非零退出 (rc=$rc)"; fi
assert_eq 1 "$(count_lines "$STUB_DIR/agent_starts")" "T-EP2 不重启 agent-gear"
assert_eq 1 "$(count_lines "$STUB_DIR/npm_recovery_installs")" "T-EP2 恢复升级仅尝试 1 次"
assert_contains "$TEST_DIR/stdout.log" "agent-gear upgrade failed" "T-EP2 日志记录失败原因"
teardown_env

# ---------------------------------------------------------------------------
echo "== T-EP3: 二次拒绝 → 不再升级 =="
setup_env 2.1.0
export STUB_AGENT_MODE=mismatch
export STUB_NPM_MODE=noop
rc=$(run_entrypoint)
if [ "$rc" -ne 0 ]; then pass "T-EP3 二次拒绝非零退出"; else fail "T-EP3 二次拒绝应非零退出 (rc=$rc)"; fi
assert_eq 2 "$(count_lines "$STUB_DIR/agent_starts")" "T-EP3 重启后再次尝试注册"
assert_eq 1 "$(count_lines "$STUB_DIR/npm_recovery_installs")" "T-EP3 不再执行第二次恢复升级"
assert_contains "$TEST_DIR/stdout.log" "still reports VERSION_MISMATCH" "T-EP3 日志说明二次不匹配"
teardown_env

# ---------------------------------------------------------------------------
echo "== T-EP4: skip 开关 → 不升级直接退出 =="
setup_env 2.1.0
export STUB_AGENT_MODE=mismatch
export ZAG_SKIP_AGENT_GEAR_UPDATE=1
rc=$(run_entrypoint)
if [ "$rc" -ne 0 ]; then pass "T-EP4 skip 后非零退出"; else fail "T-EP4 skip 后应非零退出 (rc=$rc)"; fi
assert_eq 0 "$(count_lines "$STUB_DIR/npm_installs")" "T-EP4 不执行任何 npm 安装"
assert_eq 1 "$(count_lines "$STUB_DIR/agent_starts")" "T-EP4 不重启 agent-gear"
assert_contains "$TEST_DIR/stdout.log" "auto-upgrade disabled" "T-EP4 日志说明跳过原因"
teardown_env

# ---------------------------------------------------------------------------
echo "== T-EP5: 普通非零退出 → 不升级 =="
setup_env 2.2.0
export STUB_AGENT_MODE=error
rc=$(run_entrypoint)
assert_eq 7 "$rc" "T-EP5 保持 agent-gear 退出码"
assert_eq 0 "$(count_lines "$STUB_DIR/npm_recovery_installs")" "T-EP5 不触发恢复升级"
assert_eq 1 "$(count_lines "$STUB_DIR/agent_starts")" "T-EP5 不重启 agent-gear"
assert_contains "$TEST_DIR/stdout.log" "not upgrading" "T-EP5 日志说明不升级"
teardown_env

# ---------------------------------------------------------------------------
echo "== T-EP6: 正常退出 → 不升级 =="
setup_env 2.2.0
rc=$(run_entrypoint)
assert_eq 0 "$rc" "T-EP6 正常退出码 0"
assert_eq 0 "$(count_lines "$STUB_DIR/npm_recovery_installs")" "T-EP6 不触发恢复升级"
assert_eq 1 "$(count_lines "$STUB_DIR/agent_starts")" "T-EP6 不重启 agent-gear"
teardown_env

# ---------------------------------------------------------------------------
signal_case() {
  local signal="$1"
  setup_env 2.2.0
  export STUB_RUN_FOREVER=1
  # 开启作业控制：非交互 shell 的后台作业默认忽略 SIGINT（POSIX），否则 T-EP7(INT) 测不到转发路径。
  set -m
  bash "$ENTRYPOINT" > "$TEST_DIR/stdout.log" 2> "$TEST_DIR/stderr.log" &
  local ep_pid=$!
  set +m

  local i
  for i in $(seq 1 100); do
    [ -f "$STUB_DIR/agent_ready" ] && break
    sleep 0.05
  done
  if [ ! -f "$STUB_DIR/agent_ready" ]; then
    fail "T-EP7($signal) agent-gear 未进入运行状态"
    kill -KILL "$ep_pid" 2>/dev/null || true
    wait "$ep_pid" 2>/dev/null || true
    teardown_env
    return
  fi

  kill -"$signal" "$ep_pid" 2>/dev/null || true
  local rc=0
  wait "$ep_pid" || rc=$?
  assert_eq 0 "$rc" "T-EP7($signal) 入口退出码 0"
  # 入口统一向子进程转发 SIGTERM（必要时再补 SIGINT）；父进程收到的信号类型不改变该语义。
  assert_contains "$STUB_DIR/signals" "TERM" "T-EP7($signal) 子进程收到转发信号"
  assert_eq 1 "$(count_lines "$STUB_DIR/agent_starts")" "T-EP7($signal) 销毁后不重启"
  assert_eq 0 "$(count_lines "$STUB_DIR/npm_recovery_installs")" "T-EP7($signal) 不触发升级"
  teardown_env
}

echo "== T-EP7: 信号转发 =="
signal_case TERM
signal_case INT

# ---------------------------------------------------------------------------
echo "== T-EP8: 日志有界 / 透传 =="
setup_env 2.1.0
export STUB_AGENT_MODE=by_version
export STUB_NPM_MODE=fail_once
rc=$(run_entrypoint)
assert_eq 0 "$rc" "T-EP8 恢复流程正常退出"
assert_contains "$TEST_DIR/stderr.log" "VERSION_MISMATCH" "T-EP8 stderr 实时透传"
assert_contains "$TEST_DIR/stdout.log" "agent-gear running" "T-EP8 stdout 实时透传"
big_files=$(find "$RUN_TMP" -type f -size +1k 2>/dev/null | wc -l | tr -d ' ')
assert_eq 0 "$big_files" "T-EP8 运行目录无完整日志落盘"
log_files=$(find "$RUN_TMP" -type f -name '*.log' 2>/dev/null | wc -l | tr -d ' ')
assert_eq 0 "$log_files" "T-EP8 运行目录无 .log 文件"
marker_size=$(find "$RUN_TMP" -type f -name mismatch -printf '%s' 2>/dev/null | head -n 1)
if [ -z "$marker_size" ] || [ "$marker_size" = "0" ]; then
  pass "T-EP8 mismatch 标记为 0 字节（仅标记不落盘日志）"
else
  fail "T-EP8 mismatch 标记应存在且为 0 字节 (size=$marker_size)"
fi
teardown_env

# ---------------------------------------------------------------------------
echo
echo "passed=$PASS failed=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
