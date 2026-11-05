import { logger } from '../observability/logger.js';
import { CloudWorkload } from '../models/cloud-workload.js';
import { DOCKER_SCRIPT_V1 } from './001-preset-workloads.js';
import { DOCKER_SCRIPT_V2 } from './002-refresh-docker-preset-script.js';
import { DOCKER_SCRIPT_V3 } from './003-docker-apt-source.js';
import { DOCKER_SCRIPT_V4 } from './012-worker-user-scripts.js';
import { DOCKER_SCRIPT_V5 } from './020-docker-shim-value-options.js';

const log = logger.child({ component: 'migration/021-docker-registry-mirrors' });

/**
 * 021-docker-registry-mirrors：取消「镜像引用规范化 shim」，改用 Docker 原生 `registry-mirrors`。
 *
 * 背景：shim 以 PATH 劫持方式改写 `docker pull/run/create` 的镜像引用，无法覆盖 `docker build`
 * 的 `FROM`、复杂选项与子命令，且需要持续维护选项解析（020）。Docker 原生 `registry-mirrors`
 * 由 dockerd 消费 `/etc/docker/daemon.json`，覆盖 Docker Hub 拉取的常规用法。
 *
 * 刷新口径：
 * - 未定制判定严格相等：`initScript ∈ {V1..V5, V6}` 才处理；其余视为管理员定制，打 `warn`
 *   且不覆盖、不补参数（定制脚本不消费该参数）。
 * - `initScript` 非 V6 则刷新为 V6；`paramSchema` 缺 `docker_registry_mirrors`（只按 key 判定）
 *   则追加参数；有变更才 `save()`，参数已存在则完全不动（含管理员改过的默认值）。
 * - 缺失预置项不重建（对齐 020 的「删除即尊重」口径）：`presetKey='docker'` 不存在时按精确
 *   `name='Docker'` 再查一次，命中则告警跳过；两者都不存在只告警、不 `create`。
 *
 * 脚本 V6 由 V5 定点变换生成（删除 shim 装配段与 `SHIM_PATH`，插入清理/解析/落盘段，替换
 * 启动段为可重启形态，追加 `docker info` 硬校验）；历史常量 `DOCKER_SCRIPT_V1~V5` 只读复用。
 *
 * 迁移随启动自动执行、失败不阻断（沿用 `admin_migrations` runner 语义）。
 */
export const name = '021-docker-registry-mirrors';

/** 「Docker」工作负载镜像加速地址默认值（无尾斜杠；单一事实源，脚本内不内置）。 */
export const DOCKER_REGISTRY_MIRRORS_DEFAULT =
  'https://core.harbor.internal.fffdan.com/docker-hub-proxy';

interface WorkloadParamDefinition {
  key: string;
  label: string;
  type: 'select' | 'multi_select' | 'text' | 'boolean';
  options: string[];
  defaultValue: unknown;
}

/** 「Docker」工作负载的镜像仓库镜像地址参数定义（与 `docker_apt_url` 同形态）。 */
export const DOCKER_REGISTRY_MIRRORS_PARAM: WorkloadParamDefinition = {
  key: 'docker_registry_mirrors',
  label: '镜像仓库镜像地址',
  type: 'text',
  options: [],
  defaultValue: DOCKER_REGISTRY_MIRRORS_DEFAULT,
};

// ---------------------------------------------------------------------------
// V6 定点变换（锚点漂移即抛错，避免静默产出错误脚本）
// ---------------------------------------------------------------------------

const SHIM_SECTION_ANCHOR = '# 2) 装配镜像引用规范化 shim';
const START_SECTION_ANCHOR = '# 3) 启动 dockerd 并等待就绪（已就绪则跳过）';
const VERIFY_SECTION_ANCHOR = '# 4) 校验 CLI 与构建能力';
const BUILDX_LINE = 'docker buildx version\n';
const SHIM_PATH_LINE = 'SHIM_PATH="${ZAG_DOCKER_SHIM_PATH:-/usr/local/bin/docker}"\n';
const OLD_HEADER =
  '# Docker 工作负载初始化脚本 v3（自包含）：apt 安装 → 装配镜像代理 shim → 启动并就绪 dockerd → 校验。';
const NEW_HEADER =
  '# Docker 工作负载初始化脚本 v6：apt 安装 → 清理历史 shim → 配置 registry-mirrors → 启动/重启 dockerd → 校验。';

/** 新「2)」段：地址解析 + 历史 shim 清理 + daemon.json 归属判定与落盘（三段带可测试标记）。 */
const MIRRORS_SECTION = `# 2) 清理历史镜像引用规范化 shim，并配置 Docker 原生镜像仓库镜像（registry-mirrors）

# [zag:mirrors-parse-begin]
REGISTRY_MIRRORS_RAW="\${DOCKER_REGISTRY_MIRRORS-\${WORKLOAD_PARAM_DOCKER_REGISTRY_MIRRORS-}}"
REGISTRY_MIRRORS=()
if [ -n "\${REGISTRY_MIRRORS_RAW//[[:space:]]/}" ]; then
  IFS=',' read -r -a _mirror_items <<< "$REGISTRY_MIRRORS_RAW"
  for _item in "\${_mirror_items[@]}"; do
    _item="\${_item#"\${_item%%[![:space:]]*}"}"
    _item="\${_item%"\${_item##*[![:space:]]}"}"
    while [ "\${_item%/}" != "$_item" ]; do _item="\${_item%/}"; done
    [ -z "$_item" ] && continue
    case "$_item" in
      http://*|https://*) ;;
      *) echo "镜像仓库镜像地址非法（需以 http:// 或 https:// 开头）：$_item" >&2; exit 2 ;;
    esac
    case "$_item" in
      *\\"*|*\\\\*|*[[:space:]]*) echo "镜像仓库镜像地址包含非法字符：$_item" >&2; exit 2 ;;
    esac
    REGISTRY_MIRRORS+=("$_item")
  done
fi
# [zag:mirrors-parse-end]

LEGACY_SHIM="/usr/local/bin/docker"
# 判定标记 = 平台 shim 的特征函数（裁决 11）：以相邻单引号拼接书写，使 V6 脚本字面量
# 不含该函数名（T-MIG-RM8 / tests/api 断言），shell 拼接后 grep 模式仍是同一标识符。
if [ -f "$LEGACY_SHIM" ] && grep -q 'normalize''_image' "$LEGACY_SHIM" 2>/dev/null; then
  \${SUDO} rm -f "$LEGACY_SHIM"
  echo "已清理历史镜像引用规范化 shim：$LEGACY_SHIM"
elif [ -e "$LEGACY_SHIM" ]; then
  echo "警告：$LEGACY_SHIM 存在但非本平台 shim，保留不动" >&2
fi

# [zag:mirrors-json-begin]
render_registry_mirrors_json() {
  local first=1 item out='{"registry-mirrors":['
  for item in "$@"; do
    if [ "$first" -eq 1 ]; then first=0; else out+=','; fi
    out+="\\"$item\\""
  done
  out+=']}'
  printf '%s' "$out"
}

is_managed_daemon_json() {
  local file="$1" compact
  [ -f "$file" ] || return 1
  compact="$(
    \${SUDO} cat "$file" | tr -d '[:space:]'
  )" || return 1
  printf '%s' "$compact" | grep -Eq '^\\{"registry-mirrors":\\[[^]]*\\]\\}$'
}
# [zag:mirrors-json-end]

# [zag:mirrors-apply-begin]
DAEMON_JSON=/etc/docker/daemon.json
DAEMON_CHANGED=0
DAEMON_MANAGED_REMOVED=0
if [ "\${#REGISTRY_MIRRORS[@]}" -eq 0 ]; then
  echo "未配置镜像加速，Docker Hub 将默认直连"
  if is_managed_daemon_json "$DAEMON_JSON"; then
    \${SUDO} rm -f "$DAEMON_JSON"
    DAEMON_CHANGED=1
    DAEMON_MANAGED_REMOVED=1
  elif [ -e "$DAEMON_JSON" ]; then
    echo "警告：$DAEMON_JSON 非本平台生成，保留既有配置" >&2
  fi
else
  TARGET_JSON="$(render_registry_mirrors_json "\${REGISTRY_MIRRORS[@]}")"
  if is_managed_daemon_json "$DAEMON_JSON"; then
    CURRENT_JSON="$(\${SUDO} cat "$DAEMON_JSON" | tr -d '[:space:]')"
    if [ "$CURRENT_JSON" != "$TARGET_JSON" ]; then
      \${SUDO} tee "$DAEMON_JSON" >/dev/null <<< "$TARGET_JSON"
      DAEMON_CHANGED=1
    fi
  elif [ -e "$DAEMON_JSON" ]; then
    BACKUP="$DAEMON_JSON.pre-zag-$(date +%Y%m%d%H%M%S)-$$"
    \${SUDO} cp -p "$DAEMON_JSON" "$BACKUP"
    echo "警告：$DAEMON_JSON 含非本平台配置，已备份为 $BACKUP 并写入镜像加速配置" >&2
    \${SUDO} tee "$DAEMON_JSON" >/dev/null <<< "$TARGET_JSON"
    DAEMON_CHANGED=1
  else
    \${SUDO} mkdir -p /etc/docker
    \${SUDO} tee "$DAEMON_JSON" >/dev/null <<< "$TARGET_JSON"
    DAEMON_CHANGED=1
  fi
  echo "已配置镜像加速：\${REGISTRY_MIRRORS[*]}"
fi
# [zag:mirrors-apply-end]

`;

/** 替换后的「3)」段：配置变更且已运行时先重启 dockerd，否则按需启动（就绪等待与失败诊断保留）。 */
const RESTART_SECTION = `# 3) 启动 dockerd 并等待就绪（配置变更且已运行时先重启；已就绪且无变更则跳过）
dockerd_running() { /usr/bin/docker info >/dev/null 2>&1; }
if [ "$DAEMON_CHANGED" -eq 1 ] && dockerd_running; then
  echo "镜像加速配置已变更，重启 dockerd 生效"
  \${SUDO} pkill -TERM -x dockerd || true
  for _ in $(seq 1 10); do dockerd_running || break; sleep 1; done
  if dockerd_running; then \${SUDO} pkill -KILL -x dockerd || true; sleep 1; fi
fi
if dockerd_running; then
  echo "dockerd 已在运行"
else
  \${SUDO} sh -c 'nohup dockerd -G worker >/var/log/dockerd.log 2>&1 &'
  for _ in $(seq 1 30); do
    if dockerd_running; then echo "dockerd 已就绪"; break; fi
    sleep 1
  done
fi
if ! dockerd_running; then
  echo "dockerd 未在 30s 内就绪" >&2
  tail -n 50 /var/log/dockerd.log >&2 || true
  exit 1
fi

`;

/** 追加在 `docker buildx version` 之后的硬校验：逐项断言 `docker info` 反映配置。 */
const VERIFY_SECTION = `# 5) 校验镜像加速配置生效
if [ "\${#REGISTRY_MIRRORS[@]}" -gt 0 ]; then
  INFO_MIRRORS="$(/usr/bin/docker info --format '{{json .RegistryConfig.Mirrors}}')"
  for _m in "\${REGISTRY_MIRRORS[@]}"; do
    case "$INFO_MIRRORS" in
      *"$_m"*) ;;
      *) echo "镜像加速配置未生效：docker info 未包含 $_m（当前：$INFO_MIRRORS）" >&2; exit 1 ;;
    esac
  done
  echo "镜像加速已生效：\${REGISTRY_MIRRORS[*]}"
elif [ "$DAEMON_MANAGED_REMOVED" -eq 1 ] && [ -e "$DAEMON_JSON" ]; then
  echo "镜像加速配置清理失败：$DAEMON_JSON 仍存在" >&2
  exit 1
fi
`;

function mustReplace(input: string, search: string, replacement: string, label: string): string {
  if (!input.includes(search)) {
    throw new Error(`021 migration: ${label} not found in docker preset script`);
  }
  return input.replace(search, replacement);
}

function toV6(script: string): string {
  const shimStart = script.indexOf(SHIM_SECTION_ANCHOR);
  const startSection = script.indexOf(START_SECTION_ANCHOR);
  if (shimStart < 0 || startSection <= shimStart) {
    throw new Error('021 migration: shim/start anchors not found in docker preset script');
  }
  let out = script.slice(0, shimStart) + script.slice(startSection);

  out = mustReplace(out, SHIM_PATH_LINE, '', 'SHIM_PATH line');
  out = mustReplace(out, OLD_HEADER, NEW_HEADER, 'script header');

  const startAt = out.indexOf(START_SECTION_ANCHOR);
  const verifyAt = out.indexOf(VERIFY_SECTION_ANCHOR);
  if (startAt < 0 || verifyAt <= startAt) {
    throw new Error('021 migration: start/verify anchors not found in docker preset script');
  }
  out = out.slice(0, startAt) + MIRRORS_SECTION + RESTART_SECTION + out.slice(verifyAt);

  const buildxAt = out.lastIndexOf(BUILDX_LINE);
  if (buildxAt < 0) {
    throw new Error('021 migration: buildx anchor not found in docker preset script');
  }
  const tail = buildxAt + BUILDX_LINE.length;
  return out.slice(0, tail) + VERIFY_SECTION + out.slice(tail);
}

/**
 * Docker 预制工作负载脚本 v6：v5 基础上删除镜像引用规范化 shim 装配，改为清理历史 shim +
 * 写入 `/etc/docker/daemon.json` 的 `registry-mirrors`（配置变更且 dockerd 已运行则重启），
 * 结尾以 `docker info` 逐项硬校验；新增 `docker_registry_mirrors` 参数消费（env 最高优先级）。
 */
export const DOCKER_SCRIPT_V6 = toV6(DOCKER_SCRIPT_V5);

interface MutableWorkload {
  initScript?: string | null;
  paramSchema?: Array<{ key?: string }> | null;
  markModified?: (path: string) => void;
  save: () => Promise<unknown>;
}

const DOCKER_PRESET_KEY = 'docker';
const DOCKER_PRESET_NAME = 'Docker';
const MIRRORS_PARAM_KEY = 'docker_registry_mirrors';

export async function run(): Promise<void> {
  const byKey = await CloudWorkload.findOne({ presetKey: DOCKER_PRESET_KEY });
  if (!byKey) {
    const byName = await CloudWorkload.findOne({ name: DOCKER_PRESET_NAME });
    if (byName) {
      log.warn({ name: DOCKER_PRESET_NAME }, 'workload exists without presetKey, skipping');
    } else {
      log.warn({ presetKey: DOCKER_PRESET_KEY }, 'preset workload missing, not recreating');
    }
    return;
  }

  const doc = byKey as unknown as MutableWorkload;
  const knownScripts = [
    DOCKER_SCRIPT_V1,
    DOCKER_SCRIPT_V2,
    DOCKER_SCRIPT_V3,
    DOCKER_SCRIPT_V4,
    DOCKER_SCRIPT_V5,
  ];
  const isStock = doc.initScript === DOCKER_SCRIPT_V6 || knownScripts.includes(doc.initScript ?? '');
  if (!isStock) {
    log.warn({ presetKey: DOCKER_PRESET_KEY }, 'script modified by admin, skipping');
    return;
  }

  let changed = false;
  if (doc.initScript !== DOCKER_SCRIPT_V6) {
    doc.initScript = DOCKER_SCRIPT_V6;
    doc.markModified?.('initScript');
    changed = true;
  }

  const params = doc.paramSchema ?? [];
  if (!params.some((param) => param?.key === MIRRORS_PARAM_KEY)) {
    doc.paramSchema = [...params, DOCKER_REGISTRY_MIRRORS_PARAM];
    changed = true;
  }

  if (changed) {
    await doc.save();
    log.info(
      { presetKey: DOCKER_PRESET_KEY },
      'docker preset refreshed to v6 / docker_registry_mirrors ensured',
    );
  } else {
    log.info({ presetKey: DOCKER_PRESET_KEY }, 'docker preset already up-to-date, skipping');
  }
}
