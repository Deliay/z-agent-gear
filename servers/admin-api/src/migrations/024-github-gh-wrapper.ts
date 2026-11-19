import { logger } from '../observability/logger.js';
import { CloudWorkload } from '../models/cloud-workload.js';
import { GITHUB_INIT_SCRIPT } from './007-preset-github.js';
import { GITHUB_SCRIPT_V2 } from './012-worker-user-scripts.js';

const log = logger.child({ component: 'migration/024-github-gh-wrapper' });

/**
 * 024-github-gh-wrapper：Github 预制工作负载脚本 V3 —— 安装 `/usr/local/bin/gh` wrapper。
 *
 * 口径（实现计划 `docs/engineering/plan/20261118-feat-github-project-token.md` Phase 2）：
 * - wrapper 在每次 `gh` 调用前按当前目录的 git origin 通过 `agent-gear github-token` 申请
 *   项目级 GITHUB_TOKEN，拿到后以 env 注入执行原生 gh；
 * - 任何 token 获取失败都只打印一行 stderr，并继续执行原生 gh（退出码为 gh 自身语义）；
 * - 安装脚本可对「镜像预装 gh / 无 wrapper 的旧容器 / 已是 V3 的容器」重复执行，
 *   最终收敛到同一份 wrapper（marker + 结尾硬校验）；管理员的定制脚本不被覆盖；
 * - 安装期一律 `ZAG_GH_WRAPPER_SKIP_TOKEN=1` 直通原生 gh，不触发项目识别/网络。
 */
export const name = '024-github-gh-wrapper';

/** wrapper 版本 marker（必须位于 `/usr/local/bin/gh` 第 2 行）。 */
export const GH_WRAPPER_MARKER = '# zag-gh-wrapper:v1';

/**
 * `/usr/local/bin/gh` wrapper 内容（逐字写入容器）。
 *
 * 解析顺序（D2）：`$ZAG_AGENT_GEAR_BIN` → `command -v agent-gear` → 固定候选绝对路径；
 * 全部不可用时按降级路径执行原生 gh（stderr 一行）。token 只经 env 注入单次 gh 子进程。
 */
export const GH_WRAPPER_SCRIPT = `#!/usr/bin/env bash
${GH_WRAPPER_MARKER}
set -u
REAL_GH="\${ZAG_GH_REAL:-/usr/bin/gh}"
[ -x "$REAL_GH" ] || REAL_GH=/usr/local/bin/gh.zag-real
[ -x "$REAL_GH" ] || { echo "gh-wrapper: 未找到原生 gh（$REAL_GH）" >&2; exit 127; }
if [ -n "\${ZAG_GH_WRAPPER_SKIP_TOKEN:-}" ]; then exec "$REAL_GH" "$@"; fi

AGENT_GEAR="\${ZAG_AGENT_GEAR_BIN:-}"
if [ -z "$AGENT_GEAR" ]; then
  AGENT_GEAR="$(command -v agent-gear 2>/dev/null || true)"
fi
if [ -z "$AGENT_GEAR" ]; then
  for candidate in /home/worker/.local/share/pnpm/agent-gear \\
                   /home/worker/.local/share/pnpm/bin/agent-gear \\
                   /usr/local/bin/agent-gear; do
    if [ -x "$candidate" ]; then AGENT_GEAR="$candidate"; break; fi
  done
fi

TOKEN=''
RC=0
if [ -n "$AGENT_GEAR" ]; then
  OUT="$("$AGENT_GEAR" github-token </dev/null 2>/dev/null)" || RC=$?
else
  RC=127
fi
if [ "$RC" -eq 0 ]; then
  case "$OUT" in
    *$'\\n'*|*' '*|*$'\\t'*) : ;;
    ?*) [ "\${#OUT}" -le 4096 ] && TOKEN="$OUT" ;;
  esac
elif [ "$RC" -ne 3 ]; then
  echo "gh-wrapper: 无法获取项目级 GITHUB_TOKEN，按原样执行 gh（agent-gear exit $RC）" >&2
fi

if [ -n "$TOKEN" ]; then export GITHUB_TOKEN="$TOKEN"; fi
exec "$REAL_GH" "$@"
`;

/**
 * Github 工作负载 V3 初始化脚本（自包含 `${SUDO}` 正典形态，不复用 012 私有 helper）。
 *
 * 幂等顺序即契约：锚点早退（真实 gh + 最新 wrapper）→ 确保真实 gh → 让位/覆盖 wrapper →
 * 结尾硬校验（PATH 命中 wrapper + SKIP 旁路可用）。
 */
export const GITHUB_INIT_SCRIPT_V3 = `#!/usr/bin/env bash
set -euo pipefail

SUDO=sudo; command -v sudo >/dev/null || SUDO=
REAL_GH=/usr/bin/gh
WRAP_PATH=/usr/local/bin/gh
WRAP_MARKER='${GH_WRAPPER_MARKER}'

# 0) 幂等锚点：真实 gh 可用 且 wrapper 已是最新 → SKIP 硬校验后成功
if [ -x "$REAL_GH" ] && head -n 2 "$WRAP_PATH" 2>/dev/null | grep -qF "$WRAP_MARKER"; then
  ZAG_GH_WRAPPER_SKIP_TOKEN=1 "$WRAP_PATH" --version >/dev/null
  exit 0
fi

# 1) 确保真实 gh（镜像已预装；缺失走内网 apt 代理）
if [ ! -x "$REAL_GH" ]; then
  \${SUDO} install -m 0755 -d /etc/apt/keyrings
  \${SUDO} curl -fsSL https://nexus.internal.fffdan.com/repository/github-cli-apt-proxy/githubcli-archive-keyring.gpg \\
    -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  \${SUDO} chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  printf '%s\\n' 'deb [signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://nexus.internal.fffdan.com/repository/github-cli-apt-proxy/ stable main' \\
    | \${SUDO} tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  \${SUDO} apt-get update
  \${SUDO} apt-get install -y gh
fi

# 2) 旧容器无 wrapper / 版本过旧 → 无条件覆盖；非本 wrapper 的现存文件让位
if [ -e "$WRAP_PATH" ] && ! head -n 2 "$WRAP_PATH" 2>/dev/null | grep -qF "$WRAP_MARKER"; then
  \${SUDO} mv "$WRAP_PATH" "$WRAP_PATH.zag-real"
fi
\${SUDO} tee "$WRAP_PATH" >/dev/null <<'WRAP'
${GH_WRAPPER_SCRIPT}WRAP
\${SUDO} chmod 0755 "$WRAP_PATH"

# 3) 硬校验：PATH 解析到 wrapper，且经 SKIP 旁路可用
command -v gh | grep -qxF "$WRAP_PATH"
ZAG_GH_WRAPPER_SKIP_TOKEN=1 gh --version >/dev/null
`;

interface MutableWorkload {
  initScript?: string | null;
  markModified?: (path: string) => void;
  save: () => Promise<unknown>;
}

/** 已知历史版本链：只有字节等于其中之一才视为「未定制」并刷新。 */
export const GITHUB_OLD_SCRIPTS = [GITHUB_INIT_SCRIPT, GITHUB_SCRIPT_V2];

async function findWorkload(): Promise<MutableWorkload | null> {
  const byKey = await CloudWorkload.findOne({ presetKey: 'github' });
  if (byKey) return byKey as unknown as MutableWorkload;
  const byName = await CloudWorkload.findOne({ name: 'Github' });
  return (byName as unknown as MutableWorkload) ?? null;
}

export async function run(): Promise<void> {
  const workload = await findWorkload();
  if (!workload) {
    log.info({ event: 'preset_missing' }, 'Github 预制工作负载不存在，跳过');
    return;
  }
  if (workload.initScript === GITHUB_INIT_SCRIPT_V3) {
    log.info({ event: 'already_current' }, 'Github 工作负载脚本已是最新');
    return;
  }
  if (!GITHUB_OLD_SCRIPTS.includes(workload.initScript ?? '')) {
    log.warn({ event: 'script_customized' }, 'Github 工作负载脚本已被管理员定制，跳过');
    return;
  }
  workload.initScript = GITHUB_INIT_SCRIPT_V3;
  workload.markModified?.('initScript');
  await workload.save();
  log.info({ event: 'script_refreshed' }, 'Github 工作负载脚本已升级到 V3（gh wrapper）');
}
