#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRYPOINT="$SCRIPT_DIR/entrypoint.sh"
ORIGINAL_PATH="$PATH"
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "ok - $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL - $*" >&2; }
assert_eq() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (expected=$1 actual=$2)"; fi; }
assert_contains() { if [ -f "$1" ] && grep -qF -- "$2" "$1"; then pass "$3"; else fail "$3 (missing '$2' in $1)"; fi; }
count_lines() { if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }

write_stubs() {
  mkdir -p "$STUB_DIR"
  printf '#!/usr/bin/env bash\necho "docker $*" >> "$STUB_DIR/docker_invocations"\nexit 0\n' > "$STUB_DIR/docker"
  printf '#!/usr/bin/env bash\necho "dockerd $*" >> "$STUB_DIR/dockerd_invocations"\nexit 0\n' > "$STUB_DIR/dockerd"
  cat > "$STUB_DIR/setpriv" <<'STUB'
#!/usr/bin/env bash
set -u
echo "$*" >> "$STUB_DIR/setpriv_args"
while [ $# -gt 0 ]; do
  case "$1" in
    --reuid=*|--regid=*|--init-groups) shift ;;
    env) shift; break ;;
    *) break ;;
  esac
done
while [ $# -gt 0 ] && [ "${1%%=*}" != "$1" ]; do
  echo "$1" >> "$STUB_DIR/setpriv_env"
  case "$1" in
    PATH=*) export PATH="$STUB_DIR:${1#PATH=}" ;;
    *) export "$1" ;;
  esac
  shift
done
exec "$@"
STUB
  cat > "$STUB_DIR/npm" <<'STUB'
#!/usr/bin/env bash
set -u
if [ "${1:-}" = "config" ]; then
  echo "https://npm.internal.fffdan.com/repository/npm-proxy/"
  exit 0
fi
date +%s%N >> "$STUB_DIR/npm_installs"
case "${STUB_NPM_MODE:-ok}" in fail) exit 1 ;; *) echo "2.10.0" > "$STUB_DIR/version" ;; esac
exit 0
STUB
  cat > "$STUB_DIR/agent-gear" <<'STUB'
#!/usr/bin/env bash
set -u
if [ "${1:-}" = "--version" ]; then cat "$STUB_DIR/version"; exit 0; fi
echo "start $(date +%s%N)" >> "$STUB_DIR/agent_starts"
n=$(wc -l < "$STUB_DIR/agent_starts" | tr -d ' ')
if [ "${STUB_RUN_FOREVER:-0}" = "1" ]; then
  trap 'echo TERM >> "$STUB_DIR/signals"; exit 0' TERM
  trap 'echo INT >> "$STUB_DIR/signals"; exit 0' INT
  echo ready > "$STUB_DIR/agent_ready"
  sleep 30 & wait $!
fi
set -- ${STUB_AGENT_EXITS:-0}
i=1
for code in "$@"; do
  if [ "$i" -eq "$n" ]; then exit "$code"; fi
  i=$((i + 1))
done
exit 0
STUB
  chmod +x "$STUB_DIR"/*
}

setup_env() {
  TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/zag-entrypoint-test.XXXXXX")
  STUB_DIR="$TEST_DIR/bin"
  RUN_TMP="$TEST_DIR/run"
  mkdir -p "$STUB_DIR" "$RUN_TMP"
  write_stubs
  echo "2.10.0" > "$STUB_DIR/version"
  export STUB_DIR TMPDIR="$RUN_TMP"
  export PATH="$STUB_DIR:$ORIGINAL_PATH"
  export ZAG_SERVER_ENDPOINT="wss://cloud.example.invalid/worker"
  export STUB_RUN_FOREVER=0
  export STUB_NPM_MODE=ok
  export STUB_AGENT_EXITS="42"
  unset ZAG_SKIP_AGENT_GEAR_UPDATE ZAG_KEEPALIVE_BACKOFF_MS STUB_RUN_FOREVER
}

teardown_env() {
  rm -rf "$TEST_DIR"
  unset STUB_DIR TMPDIR ZAG_SERVER_ENDPOINT STUB_AGENT_EXITS STUB_NPM_MODE STUB_RUN_FOREVER
  unset ZAG_SKIP_AGENT_GEAR_UPDATE ZAG_KEEPALIVE_BACKOFF_MS
  export PATH="$ORIGINAL_PATH"
}

run_entrypoint() {
  bash "$ENTRYPOINT" > "$TEST_DIR/stdout.log" 2> "$TEST_DIR/stderr.log"
  echo $?
}

echo "== bash -n =="
if bash -n "$ENTRYPOINT"; then pass "entrypoint.sh 语法检查"; else fail "entrypoint.sh 语法检查"; fi

echo "== T-EP0/0a: 不装配 docker shim、不调用 docker/dockerd =="
setup_env
rc=$(run_entrypoint)
assert_eq 0 "$rc" "T-EP0 入口正常退出"
assert_eq 0 "$(count_lines "$STUB_DIR/dockerd_invocations")" "T-EP0 入口不启动 dockerd"
assert_eq 0 "$(count_lines "$STUB_DIR/docker_invocations")" "T-EP0 入口不调用 docker"
for needle in install_docker_shim DOCKER_SHIM_PATH HARBOR_PROXY start_dockerd; do
  if grep -qF -- "$needle" "$ENTRYPOINT"; then fail "T-EP0a 仍包含 $needle"; else pass "T-EP0a 已移除 $needle"; fi
done
teardown_env

echo "== T-EP1: 非零退出 → 每轮自更新 → 重启（第二次 42 收敛） =="
setup_env
export STUB_AGENT_EXITS="1 42"
export ZAG_KEEPALIVE_BACKOFF_MS=10
rc=$(run_entrypoint)
assert_eq 0 "$rc" "T-EP1 42 后入口 0 退出"
assert_eq 2 "$(count_lines "$STUB_DIR/agent_starts")" "T-EP1 agent-gear 启动 2 次"
assert_eq 2 "$(count_lines "$STUB_DIR/npm_installs")" "T-EP1 启动自更新 1 + 每轮自更新 1"
assert_contains "$TEST_DIR/stdout.log" "self-update then restarting" "T-EP1 日志记录自更新后重启"
teardown_env

echo "== T-EP2: 自更新失败被容忍，仍保活重启 =="
setup_env
export STUB_AGENT_EXITS="1 42"
export STUB_NPM_MODE=fail
export ZAG_KEEPALIVE_BACKOFF_MS=10
rc=$(run_entrypoint)
assert_eq 0 "$rc" "T-EP2 更新失败不阻断保活"
assert_eq 2 "$(count_lines "$STUB_DIR/agent_starts")" "T-EP2 仍然重启"
assert_eq 2 "$(count_lines "$STUB_DIR/npm_installs")" "T-EP2 启动与每轮各尝试一次"
assert_contains "$TEST_DIR/stdout.log" "WARN: agent-gear update failed" "T-EP2 日志 WARN 容忍失败"
teardown_env

echo "== T-EP3: 连续崩溃持续重启直到 42 =="
setup_env
export STUB_AGENT_EXITS="1 1 42"
export ZAG_KEEPALIVE_BACKOFF_MS=10
rc=$(run_entrypoint)
assert_eq 0 "$rc" "T-EP3 收敛退出 0"
assert_eq 3 "$(count_lines "$STUB_DIR/agent_starts")" "T-EP3 启动 3 次"
assert_eq 3 "$(count_lines "$STUB_DIR/npm_installs")" "T-EP3 每轮均自更新"
teardown_env

echo "== T-EP4: skip 开关跳过全部自更新但仍重启 =="
setup_env
export STUB_AGENT_EXITS="1 42"
export ZAG_SKIP_AGENT_GEAR_UPDATE=1
export ZAG_KEEPALIVE_BACKOFF_MS=10
rc=$(run_entrypoint)
assert_eq 0 "$rc" "T-EP4 skip 后仍收敛 0"
assert_eq 0 "$(count_lines "$STUB_DIR/npm_installs")" "T-EP4 不执行任何 npm 安装"
assert_eq 2 "$(count_lines "$STUB_DIR/agent_starts")" "T-EP4 仍然重启"
assert_contains "$TEST_DIR/stdout.log" "skipping agent-gear update" "T-EP4 日志说明跳过"
teardown_env

echo "== T-EP5: 普通非零退出 → 自更新并重启 =="
setup_env
export STUB_AGENT_EXITS="7 42"
export ZAG_KEEPALIVE_BACKOFF_MS=10
rc=$(run_entrypoint)
assert_eq 0 "$rc" "T-EP5 42 后收敛 0"
assert_eq 2 "$(count_lines "$STUB_DIR/agent_starts")" "T-EP5 非零退出后重启"
assert_eq 2 "$(count_lines "$STUB_DIR/npm_installs")" "T-EP5 重启前自更新"
teardown_env

echo "== T-EP6: 正常退出 0（非 42）→ 自更新并重启 =="
setup_env
export STUB_AGENT_EXITS="0 42"
export ZAG_KEEPALIVE_BACKOFF_MS=10
rc=$(run_entrypoint)
assert_eq 0 "$rc" "T-EP6 42 后收敛 0"
assert_eq 2 "$(count_lines "$STUB_DIR/agent_starts")" "T-EP6 正常退出也重启"
assert_eq 2 "$(count_lines "$STUB_DIR/npm_installs")" "T-EP6 重启前自更新"
teardown_env

signal_case() {
  local signal="$1"
  setup_env
  export STUB_RUN_FOREVER=1
  set -m
  bash "$ENTRYPOINT" > "$TEST_DIR/stdout.log" 2> "$TEST_DIR/stderr.log" &
  local ep_pid=$!
  set +m
  local i
  for i in $(seq 1 100); do [ -f "$STUB_DIR/agent_ready" ] && break; sleep 0.05; done
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
  assert_contains "$STUB_DIR/signals" "TERM" "T-EP7($signal) setpriv 链下子进程收到信号"
  assert_eq 1 "$(count_lines "$STUB_DIR/agent_starts")" "T-EP7($signal) 销毁后不重启"
  assert_eq 1 "$(count_lines "$STUB_DIR/npm_installs")" "T-EP7($signal) 不触发每轮自更新"
  teardown_env
}
echo "== T-EP7: 信号转发 =="
signal_case TERM
signal_case INT

echo "== T-EP8: 日志有界 / 透传 =="
setup_env
export STUB_AGENT_EXITS="1 42"
export ZAG_KEEPALIVE_BACKOFF_MS=10
rc=$(run_entrypoint)
assert_eq 0 "$rc" "T-EP8 收敛退出"
assert_contains "$TEST_DIR/stdout.log" "agent-gear exited" "T-EP8 stdout 透传"
big_files=$(find "$RUN_TMP" -type f -size +1k 2>/dev/null | wc -l | tr -d ' ')
assert_eq 0 "$big_files" "T-EP8 运行目录无完整日志落盘"
log_files=$(find "$RUN_TMP" -type f -name '*.log' 2>/dev/null | wc -l | tr -d ' ')
assert_eq 0 "$log_files" "T-EP8 运行目录无 .log 文件"
teardown_env

echo "== T-EP9: 退出码 42 → 不自更新、不重启、入口 0 =="
setup_env
export STUB_AGENT_EXITS="42"
rc=$(run_entrypoint)
assert_eq 0 "$rc" "T-EP9 入口 0 退出"
assert_eq 1 "$(count_lines "$STUB_DIR/agent_starts")" "T-EP9 不重启"
assert_eq 1 "$(count_lines "$STUB_DIR/npm_installs")" "T-EP9 仅启动自更新 1 次"
assert_contains "$TEST_DIR/stdout.log" "server shutdown; stopping keepalive" "T-EP9 日志说明服务端终止"
teardown_env

echo "== T-EP10: 退避递增 + 每轮自更新 =="
setup_env
export STUB_AGENT_EXITS="1 1 1 42"
export ZAG_KEEPALIVE_BACKOFF_MS=40
rc=$(run_entrypoint)
assert_eq 0 "$rc" "T-EP10 收敛退出 0"
assert_eq 4 "$(count_lines "$STUB_DIR/agent_starts")" "T-EP10 启动 4 次"
assert_eq 4 "$(count_lines "$STUB_DIR/npm_installs")" "T-EP10 每轮自更新"
t1=$(sed -n '2p' "$STUB_DIR/agent_starts" | awk '{print $2}')
t2=$(sed -n '3p' "$STUB_DIR/agent_starts" | awk '{print $2}')
t3=$(sed -n '4p' "$STUB_DIR/agent_starts" | awk '{print $2}')
d1=$(( (t2 - t1) / 1000000 ))
d2=$(( (t3 - t2) / 1000000 ))
if [ "$d2" -gt "$d1" ]; then pass "T-EP10 退避递增（${d1}ms → ${d2}ms）"; else fail "T-EP10 退避未递增（${d1}ms → ${d2}ms）"; fi
teardown_env

echo "== T-EP11: setpriv 参数与 worker env 构造 =="
setup_env
export STUB_AGENT_EXITS="42"
rc=$(run_entrypoint)
assert_eq 0 "$rc" "T-EP11 入口正常退出"
assert_contains "$STUB_DIR/setpriv_args" "--reuid=1000 --regid=1000 --init-groups" "T-EP11 setpriv 降权参数"
assert_contains "$STUB_DIR/setpriv_env" "HOME=/home/worker" "T-EP11 HOME"
assert_contains "$STUB_DIR/setpriv_env" "USER=worker" "T-EP11 USER"
assert_contains "$STUB_DIR/setpriv_env" "NVM_DIR=/home/worker/.nvm" "T-EP11 NVM_DIR"
assert_contains "$STUB_DIR/setpriv_env" "PATH=/home/worker/.nvm/current/bin" "T-EP11 PATH 以 worker nvm 打头"
teardown_env
echo "== T-EP12: 单行 JSON 日志（T-OBS16） =="
setup_env
# 提取 log/json_escape 函数做单元级验证（source 整个 entrypoint 会执行主流程）
sed -n '/^json_escape()/p; /^log()/,/^}/p' "$ENTRYPOINT" > "$TEST_DIR/logfns.sh"
assert_json_line() {
  if printf '%s' "$1" | node -e '
let d = "";
process.stdin.on("data", (c) => (d += c)).on("end", () => {
  const o = JSON.parse(d);
  for (const k of ["level", "time", "service", "serviceVersion", "env", "hostname", "pid", "component", "msg"]) {
    if (!(k in o)) { console.error("missing field " + k); process.exit(2); }
  }
  if (Number.isNaN(Date.parse(o.time))) process.exit(3);
});' 2>/dev/null; then pass "$2"; else fail "$2"; fi
}
# a. 含引号/反斜杠/控制字符（tab/换行/NUL 邻近控制符）仍可解析
weird=$(bash -c "source '$TEST_DIR/logfns.sh'; log \"quote=\\\" backslash=\\\\ tab=$(printf '\t') nl=$(printf '\a') end\"")
assert_json_line "$weird" "T-EP12 含引号/反斜杠/控制字符仍可 JSON.parse"
case "$weird" in *'quote=\"'*) pass "T-EP12 引号已转义" ;; *) fail "T-EP12 引号未转义: $weird" ;; esac
case "$weird" in *$'\n'*) fail "T-EP12 输出含裸换行（非单行）" ;; *) pass "T-EP12 单行输出" ;; esac
# b. 字段口径：service 固定 zag-worker、serviceVersion 取 ZAG_WORKER_VERSION（缺省 unknown）
v1=$(bash -c "source '$TEST_DIR/logfns.sh'; log hello")
assert_json_line "$v1" "T-EP12 缺省形态字段齐备"
case "$v1" in *'"service":"zag-worker"'*) pass "T-EP12 service=zag-worker" ;; *) fail "T-EP12 service 口径: $v1" ;; esac
case "$v1" in *'"serviceVersion":"unknown"'*) pass "T-EP12 serviceVersion 缺省 unknown" ;; *) fail "T-EP12 serviceVersion 缺省口径: $v1" ;; esac
v2=$(bash -c "source '$TEST_DIR/logfns.sh'; ZAG_WORKER_VERSION=9.9.9; log hello")
case "$v2" in *'"serviceVersion":"9.9.9"'*) pass "T-EP12 serviceVersion 取 ZAG_WORKER_VERSION" ;; *) fail "T-EP12 serviceVersion 注入: $v2" ;; esac
# c. 整个入口的 stdout 每行均可 JSON.parse（退出码/自更新/信号语义由 T-EP0~T-EP11 保障不变）
setup_env
export STUB_AGENT_EXITS="1 42"
export ZAG_KEEPALIVE_BACKOFF_MS=10
rc=$(run_entrypoint)
assert_eq 0 "$rc" "T-EP12 入口收敛退出"
bad_line=$(node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter((l) => l.trim());
for (const line of lines) {
  try {
    const o = JSON.parse(line);
    for (const k of ["level", "time", "service", "serviceVersion", "env", "hostname", "pid", "component", "msg"]) {
      if (!(k in o)) { console.log(line); process.exit(0); }
    }
  } catch { console.log(line); process.exit(0); }
}
console.log("");' "$TEST_DIR/stdout.log")
if [ -z "$bad_line" ]; then pass "T-EP12 stdout 每行可 JSON.parse 且字段齐备"; else fail "T-EP12 非 JSON 行: $bad_line"; fi
teardown_env

echo
echo "passed=$PASS failed=$FAIL"
if [ "$FAIL" -ne 0 ]; then exit 1; fi






