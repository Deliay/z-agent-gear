import { logger } from '../observability/logger.js';
import { CloudWorkload } from '../models/cloud-workload.js';
import {
  ASPIRE_SCRIPT_V1,
  DOCKER_SCRIPT_V1,
  DOTNET_SCRIPT,
  NODEJS_SCRIPT_V1,
} from './001-preset-workloads.js';
import { DOCKER_SCRIPT_V2 } from './002-refresh-docker-preset-script.js';
import { DOCKER_SCRIPT_V3 } from './003-docker-apt-source.js';
import { ASPIRE_SCRIPT_V2 } from './004-aspire-cli-source.js';
import {
  HARNESS_OPENCODE_INIT_SCRIPT,
  HARNESS_OPENCODE_INIT_SCRIPT_V1,
} from './006-preset-harness-opencode.js';
import { GITHUB_INIT_SCRIPT } from './007-preset-github.js';
import { HARNESS_KIMI_CODE_INIT_SCRIPT } from './009-preset-harness-kimi-code.js';
import {
  HARNESS_DEEPSEEK_INIT_SCRIPT,
  HARNESS_DEEPSEEK_INIT_SCRIPT_V1,
} from './010-preset-harness-deepseek.js';
import {
  ASPIRE_SCRIPT_V3,
  DOCKER_SCRIPT_V4,
  DOTNET_SCRIPT_V2,
  GITHUB_SCRIPT_V2,
  HARNESS_DEEPSEEK_SCRIPT_V2,
  HARNESS_KIMI_CODE_SCRIPT_V2,
  HARNESS_OPENCODE_SCRIPT_V2,
} from './012-worker-user-scripts.js';
import { HARNESS_DEEPSEEK_SCRIPT_V3 } from './013-preset-harness-deepseek-header-masq.js';
import { PLAYWRIGHT_SCRIPT_V1 } from './015-preset-playwright.js';
import { MONGODB_INIT_SCRIPT } from './016-preset-mongodb.js';
import {
  HARNESS_DEEPSEEK_SCRIPT_V4,
  HARNESS_KIMI_CODE_SCRIPT_V3,
  HARNESS_OPENCODE_SCRIPT_V3,
  PLAYWRIGHT_SCRIPT_V2,
} from './017-workload-pnpm-scripts.js';
// 018 把上述四条脚本升级到 pnpm 12（V4/V4/V5/V3）：本迁移的「最新标准版本」随之取 018 的输出，
// 保证 018 → 019 顺序执行或单独执行时都收敛到同一份最终脚本，不会把 pnpm 12 版本回退成 pnpm 9。
import {
  HARNESS_DEEPSEEK_SCRIPT_V5,
  HARNESS_KIMI_CODE_SCRIPT_V4,
  HARNESS_OPENCODE_SCRIPT_V4,
  PLAYWRIGHT_SCRIPT_V3,
} from './018-pnpm-12-upgrade.js';

const log = logger.child({ component: 'migration/019-workload-idempotent-anchors' });

/**
 * 019-workload-idempotent-anchors：全部预制工作负载脚本的「锚点判定 + 结尾硬校验 + 可重复执行」标准核查。
 *
 * 背景（提案 §实现点 5）：云存储挂载 `/home/worker` 后，恢复归档的新容器会在完整旧环境上重跑全部
 * init 脚本，脚本必须幂等。迁移按 017 形态实现：逐条按 `presetKey`（回退精确 `name`）定位，
 * 库内文本**字节等于**已知历史版本才替换为当前标准版本；管理员定制告警跳过；已删除预置项静默跳过。
 *
 * 核查结论（以当前导出常量为准）：
 * - Docker / .NET / Aspire / Github / OpenCode / Kimi Code / DeepSeek Harness / Playwright / MongoDB
 *   已满足标准（安装锚点 + 结尾硬校验 + 覆盖式/幂等写入），迁移对其历史版本做统一收敛，最新版本为空操作；
 * - Node.js 仅有「收敛式安装」而缺少开头锚点分支，故新增 `NODEJS_SCRIPT_V2`（产物可用时校验后
 *   直接 `exit 0`），旧版本按字节匹配刷新。
 * - 四条 Harness/Playwright 脚本的标准版本取 `018-pnpm-12-upgrade` 的输出（pnpm 12 引导块），
 *   因此本迁移既可在 018 之后执行（此时为 no-op），也可单独执行时直接收敛到 pnpm 12 版本。
 *
 * 迁移随启动自动执行、失败不阻断（沿用 `admin_migrations` runner 语义）。
 */
export const name = '019-workload-idempotent-anchors';

/** Node.js 版本校验块（V1 中的锚点插入位置）。 */
const NODEJS_VERSION_BLOCK = `VERSION="\${WORKLOAD_PARAM_VERSION:-22}"
if ! [[ "$VERSION" =~ ^[A-Za-z0-9._/*-]{1,32}$ ]]; then
  echo "非法的 Node.js 版本: $VERSION" >&2
  exit 2
fi
`;

/**
 * Node.js 幂等锚点：目标版本与所需包管理器已就绪 → 版本/包管理器校验后直接成功。
 * 版本别名（`lts/*`、`node` 等）不命中锚点，继续交给 `nvm install` 收敛。
 */
const NODEJS_IDEMPOTENT_ANCHOR = `
# 幂等锚点：目标 Node 版本与所需包管理器已就绪 → 校验后直接成功（不重装、不追加配置）
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  actual_version="$(node -v 2>/dev/null | sed 's/^v//')" || actual_version=""
  anchor_ok=0
  case "$VERSION" in
    *[!0-9A-Za-z.-]*|'') ;;
    *.*.*) if [ "$actual_version" = "$VERSION" ]; then anchor_ok=1; fi ;;
    *) if [ "\${actual_version%%.*}" = "$VERSION" ]; then anchor_ok=1; fi ;;
  esac
  if [ "$anchor_ok" = "1" ]; then
    package_managers_missing=0
    while IFS= read -r pm; do
      [ -z "$pm" ] && continue
      [ "$pm" = "npm" ] && continue
      command -v "$pm" >/dev/null 2>&1 || package_managers_missing=1
    done < <(node -e 'const v = JSON.parse(process.argv[1] || "[]"); for (const x of v) process.stdout.write(x + "\\n")' "\${WORKLOAD_PARAM_PACKAGE_MANAGER:-[]}")
    if [ "$package_managers_missing" = "0" ]; then
      echo "Node.js 已就绪（$VERSION），跳过安装"
      node -v
      npm -v
      npm config get registry
      exit 0
    fi
  fi
fi
`;

function withNodeAnchor(script: string): string {
  if (!script.includes(NODEJS_VERSION_BLOCK)) {
    throw new Error('018 migration: Node.js version anchor not found in preset script');
  }
  return script.replace(NODEJS_VERSION_BLOCK, `${NODEJS_VERSION_BLOCK}${NODEJS_IDEMPOTENT_ANCHOR}`);
}

/** Node.js V2：V1 基础上新增「已就绪」锚点分支，其余逐字保留。 */
export const NODEJS_SCRIPT_V2 = withNodeAnchor(NODEJS_SCRIPT_V1);

interface MutableWorkload {
  initScript?: string | null;
  markModified?: (path: string) => void;
  save: () => Promise<unknown>;
}

export interface WorkloadIdempotencyTarget {
  presetKey: string;
  name: string;
  oldScripts: string[];
  newScript: string;
}

/**
 * 全部 10 个预制工作负载的目标脚本与已知历史版本（不臆造未落库过的版本）。
 * MongoDB 自 016 起未变更，故历史链为空（库内非当前文本一律视为管理员定制）。
 */
export const WORKLOAD_IDEMPOTENCY_TARGETS: WorkloadIdempotencyTarget[] = [
  {
    presetKey: 'docker',
    name: 'Docker',
    oldScripts: [DOCKER_SCRIPT_V1, DOCKER_SCRIPT_V2, DOCKER_SCRIPT_V3],
    newScript: DOCKER_SCRIPT_V4,
  },
  {
    presetKey: 'nodejs',
    name: 'Node.js',
    oldScripts: [NODEJS_SCRIPT_V1],
    newScript: NODEJS_SCRIPT_V2,
  },
  {
    presetKey: 'dotnet',
    name: '.NET',
    oldScripts: [DOTNET_SCRIPT],
    newScript: DOTNET_SCRIPT_V2,
  },
  {
    presetKey: 'aspire',
    name: 'Aspire',
    oldScripts: [ASPIRE_SCRIPT_V1, ASPIRE_SCRIPT_V2],
    newScript: ASPIRE_SCRIPT_V3,
  },
  {
    presetKey: 'github',
    name: 'Github',
    oldScripts: [GITHUB_INIT_SCRIPT],
    newScript: GITHUB_SCRIPT_V2,
  },
  {
    presetKey: 'harness-opencode',
    name: 'OpenCode（Harness）',
    oldScripts: [
      HARNESS_OPENCODE_INIT_SCRIPT,
      HARNESS_OPENCODE_INIT_SCRIPT_V1,
      HARNESS_OPENCODE_SCRIPT_V2,
      HARNESS_OPENCODE_SCRIPT_V3,
    ],
    newScript: HARNESS_OPENCODE_SCRIPT_V4,
  },
  {
    presetKey: 'harness-kimi-code',
    name: 'Kimi Code（Harness）',
    oldScripts: [
      HARNESS_KIMI_CODE_INIT_SCRIPT,
      HARNESS_KIMI_CODE_SCRIPT_V2,
      HARNESS_KIMI_CODE_SCRIPT_V3,
    ],
    newScript: HARNESS_KIMI_CODE_SCRIPT_V4,
  },
  {
    presetKey: 'harness-deepseek-harness',
    name: 'DeepSeek Harness（Harness）',
    oldScripts: [
      HARNESS_DEEPSEEK_INIT_SCRIPT_V1,
      HARNESS_DEEPSEEK_INIT_SCRIPT,
      HARNESS_DEEPSEEK_SCRIPT_V2,
      HARNESS_DEEPSEEK_SCRIPT_V3,
      HARNESS_DEEPSEEK_SCRIPT_V4,
    ],
    newScript: HARNESS_DEEPSEEK_SCRIPT_V5,
  },
  {
    presetKey: 'playwright',
    name: 'Playwright',
    oldScripts: [PLAYWRIGHT_SCRIPT_V1, PLAYWRIGHT_SCRIPT_V2],
    newScript: PLAYWRIGHT_SCRIPT_V3,
  },
  {
    presetKey: 'mongodb',
    name: 'MongoDB',
    oldScripts: [],
    newScript: MONGODB_INIT_SCRIPT,
  },
];

async function findWorkload(presetKey: string, workloadName: string) {
  const byKey = await CloudWorkload.findOne({ presetKey });
  if (byKey) return { doc: byKey, viaName: false };
  const byName = await CloudWorkload.findOne({ name: workloadName });
  return byName ? { doc: byName, viaName: true } : null;
}

async function refresh(t: WorkloadIdempotencyTarget): Promise<void> {
  const found = await findWorkload(t.presetKey, t.name);
  // 管理员已删除的预置项不恢复（迁移只增不改/删除即尊重）
  if (!found) return;
  const doc = found.doc as unknown as MutableWorkload;
  if (found.viaName && !doc.initScript) {
    log.warn({ name: t.name }, 'workload exists without presetKey, skipping');
    return;
  }
  if (doc.initScript === t.newScript) return;
  if (!t.oldScripts.includes(doc.initScript ?? '')) {
    log.warn({ presetKey: t.presetKey }, 'script modified by admin, skipping');
    return;
  }
  doc.initScript = t.newScript;
  doc.markModified?.('initScript');
  await doc.save();
  log.info({ presetKey: t.presetKey }, 'script refreshed (idempotent anchors)');
}

export async function run(): Promise<void> {
  for (const target of WORKLOAD_IDEMPOTENCY_TARGETS) {
    await refresh(target);
  }
  log.info(
    { targets: WORKLOAD_IDEMPOTENCY_TARGETS.map((target) => target.presetKey) },
    'preset workload idempotency audit completed',
  );
}
