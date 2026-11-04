---
description: Github 项目设置优化实现计划：重写 GITHUB_SETUP_SCRIPT 目录已存在分支（同仓库 remote 精确匹配直接复用且零改动、空目录 rmdir 后克隆、异仓库/非空目录/同名文件统一提示「目标目录已存在其他项目」、.git 残骸保守判冲突）、T-CHG8 断言重写 + 新增 T-GHS1~14 真跑 bash 行为矩阵、契约注释增补
type: Permanent
---

# Github 项目设置优化 - 实现计划

**关联 Proposal**: `docs/engineering/proposals/20261104-fix-github-project-setup-optimization.md`（v1.0）
**关联 PRD**: `docs/product/draft/20261104-github-project-setup-optimization.md`（v1.0）
**需求总分支（feat-branch）**: `prd/github-project-setup-optimization`（需求总 PR [#438](https://github.com/Deliay/z-agent-gear/pull/438)，上游 Issue [#435](https://github.com/Deliay/z-agent-gear/issues/435)）
**实现分支**: `fix/github-project-setup-optimization-impl`（基于需求总分支）
**创建日期**: 2026-11-04
**计划版本**: v1.0

**上游评审结论（PR #438）**：Deliay 于 2026-11-04T08:53:23Z APPROVED 产品文档与技术提案，评审无正文、无 inline comment、无修改要求，按原计划推进本实现计划。

**版本说明**：

- v1.0 首版：与 PRD v1.0 / 提案 v1.0 对齐，把提案 §5.2 的 3 个实现点拆成 4 个 Phase；给出「代码探查关键事实」10 条、「上游文档 × 代码现状差异」6 条、「计划期裁决」9 条，收敛提案留白但会阻塞实现的口径（测试编号冲突、remote 精确匹配、失败文案的包装链路、`.git` 文件形态与符号链接边界）。
- 不改变 PRD 产品口径；不新增/删除契约字段（仅注释增补）；前端零改动。

## 实现顺序

```mermaid
flowchart TD
    P0["Phase 0 契约<br/>cloud-host.graphql + schema 注释"]
    P1["Phase 1 测试先行（RED）<br/>T-GHS1~14 行为矩阵 + T-CHG8 重写"]
    P2["Phase 2 脚本重写（GREEN）<br/>GITHUB_SETUP_SCRIPT"]
    P3["Phase 3 回归与收口<br/>agent-api 全量 + tests/api 回归 + 文档 + PR"]

    P0 --> P1
    P1 --> P2
    P2 --> P3
```

依赖说明：

- **P0 先行**：契约只改注释，但「同仓库复用 / 空目录清理 / 冲突提示」是脚本行为的书面依据，先落口径再写测试。
- **P1 → P2**：严格 TDD。先让 `T-CHG8`（旧断言）与新 `T-GHS1~14` 在旧脚本上失败（RED），再改脚本（GREEN）；避免先改实现导致 RED 无法定位。
- **P3 依赖 P0~P2**：脚本是容器内 runtime 脚本，API/E2E 不可见其分支，回归以单测 + 既有 API 用例为主，真机验收在验收节点执行。

开发模式采用 TDD（红-绿-重构）。编码前加载 `docs/engineering/common-rules.md`、`servers/agent-api/AGENTS.md`；本需求不触碰前端，无需加载前端规范。

### 关键约束（实现期不得回退）

- **唯一行为改动点**：`servers/agent-api/src/services/cloud-host-github-service.ts` 的 `GITHUB_SETUP_SCRIPT`。不改三步编排（workload / gitSetup / session）、不改 `runGitSetupStep`/`initializeWorkspace`/`runSessionStep`、不改工作区初始化与 CAS 回写、不改会话创建。
- **契约零字段变更**：`contracts/cloud-host.graphql` 与 `graphql/schemas/cloud-host.ts` 仅注释增补，字段/类型/可空性/默认值不动。
- **前端零改动**：冲突提示经 `operation.error` 与步骤 `detail` 原样展示；「修改前缀地址后重试」的既有路径是关闭进度框 → 重新打开「Github 项目设置」→ 修改前缀 → 重新发起（新 operation），本迭代不新增按钮。
- **复用分支零目录改动**：同仓库匹配时只 `echo` 后 exit 0，不执行 `git pull`/`fetch`/`checkout`/`reset`，不写任何文件。
- **安全优先**：仅允许 `rmdir` 移除空目录；异仓库 / 非空目录 / 同名文件 / `.git` 残骸 / `.git` 文件形态一律判冲突并非零退出，绝不删除或改动内容。
- **禁止 rebase/squash**：遵循 z-git 规范，仅允许 merge。

### 代码探查关键事实（实现时以现状为准）

- **F1**：`GITHUB_SETUP_SCRIPT`（`cloud-host-github-service.ts:40-55`）现状：remote 匹配时执行 `git -C "$TARGET" pull --ff-only`；冲突文案两条（「目标目录已存在其他 Git 仓库，请修改 clone 路径」「目标目录非空且不是 Git 仓库，请修改 clone 路径」）；目标位置是普通文件时 `-d` 不命中、直接落入 `gh repo clone` 报底层错误。
- **F2**：`T-CHG8`（`cloud-host-github-service.test.ts:390-395`）断言旧文案与 `git -C "$TARGET" pull --ff-only`；`T-CHG10b` 的注释（同文件 307 行）也提到「clone 脚本幂等（git pull --ff-only）」，需同步改写，避免文档漂移。
- **F3**：`T-CHG9`/`T-CHG10`/`T-CHG11` 已被「工作区初始化 / 重试收敛」用例占用（同文件 238/279/315 行）。提案 §5.2 拟新增的 `T-CHG9a~j` 与之冲突，必须改用新编号（见裁决 1）。
- **F4**：脚本非零退出 → `pollBatch` 抛出 `工作负载执行失败（{workloadName}，状态 {status}）：{日志末 200 字符}` → `fail()` 经 `sanitizeOperationError`（脱敏正则 + `slice(0, 512)`）落库 `operation.error` 与步骤 detail。即冲突文案不是 error 全等值，而是中段子串；断言必须用 `toContain`。
- **F5**：`GithubProjectSetupDialog` 在 `operationId` 存在时只渲染 `GithubSetupProgressDialog`；进度框仅提供「重试」（同 operation、同 `targetPath`）与「关闭」。`retry` 复用落库的 `targetPath`，因此冲突场景的重试必然复现同一失败——正确操作是关闭后重新发起（新 operation）。本迭代不改前端。
- **F6**：`createOperation` 已将输入前缀归一为 finalPath（`normalizeWorkspacePrefix` + `resolveClonePath`）并落库；脚本参数 `WORKLOAD_PARAM_TARGETPATH` 即 finalPath，无尾部斜杠，含空格时也已用双引号包裹。
- **F7**：Github Issues 联动 `services/workflow/issues-event-handler.ts:337` 复用 `cloudHostGithubService.createOperation`，自动准备链路自动获得同一幂等策略，无需改动。
- **F8**：`contracts/cloud-host.graphql:264` 与 `servers/agent-api/src/graphql/schemas/cloud-host.ts:205` 的 `setupCloudHostGithubProject` mutation 均无注释；`SetupCloudHostGithubProjectInput` 的注释已存在且双端一致。提案所说「如同位置有内联注释则同步」需按现状落地（见裁决 2）。
- **F9**：`servers/agent-api/vitest.config.ts` 的 include 为 `src/**/*.test.ts`；`.github/workflows/build-agent-api-image.yml` 在 `ubuntu-latest` 执行 `pnpm test`，bash/git 必然可用。**GitHub runner 预装 `gh`**，因此「gh 不可用」用例必须使用隔离 PATH，不能只靠删 PATH 里的 gh。
- **F10**：agent-api 现有测试无 `node:child_process` 真跑脚本的先例；`github-setup-script.behavior.test.ts` 是该形态首例，需自带临时目录、桩与超时清理。

## 上游文档 × 代码现状差异

| # | 上游表述 | 代码现状（证据） | 本计划处置 |
|---|----------|------------------|------------|
| D1 | 提案 §5.2 新增 `T-CHG9a~j` 行为矩阵 | `T-CHG9/10/11` 已被工作区初始化与重试用例占用（F3） | 新用例改用 `T-GHS1~14`；`T-CHG8` 保留编号仅重写断言（裁决 1） |
| D2 | 提案 §5.2 实现点 3：schema「如同位置有内联注释则同步」 | 两个文件的 mutation 均无注释（F8） | 契约与 schema 各增补同一段注释，保持双写一致（裁决 2） |
| D3 | 提案 §5.2：remote 匹配「沿用现状的 https/ssh 双形态子串匹配，行为不变」 | 子串匹配会把 `owner/repo-2`、`owner/repository` 误判为 `owner/repo`；旧行为下还会 pull，新行为下将**静默复用错误目录**，违反 PRD 功能点 3「目标目录是其他仓库时按冲突处理」 | 收紧为归一后精确匹配（裁决 3），并补前缀相似仓库用例 |
| D4 | 提案 §5.2：冲突文案「经 pollBatch → sanitizeOperationError → operation.error 原样展示」 | 实际被 `工作负载执行失败（…）：` 前缀包装并截断 512（F4） | 不改代码；测试/验收断言用 `toContain('目标目录已存在其他项目')` |
| D5 | PRD §3.4：进度对话框「支持修改前缀地址后重试」 | 进度框只有「重试」（同 targetPath）与「关闭」（F5） | 本迭代按提案保持前端零改动；PR 与文档说明既有路径「关闭 → 重开设置对话框 → 改前缀 → 重新发起」，列为后续可选优化 |
| D6 | 提案 §5.2：`rmdir` 失败即脚本非零退出、安全不删除 | 未覆盖 `.git` 为普通文件（linked worktree / gitfile）与符号链接指向空目录 | 补 `T-GHS13`（`.git` 文件 → exit 3）与 `T-GHS14`（符号链接 → 非零退出且链接保留），锁定安全语义（裁决 6/7） |

## 计划期裁决（提案留白 / 含混处的实现口径）

1. **测试编号**：行为矩阵统一 `T-GHS1~T-GHS14`（Github Setup Script），置于新文件 `servers/agent-api/src/services/github-setup-script.behavior.test.ts`；`T-CHG8` 保留原编号、仅重写断言（防回退字符串断言）；不再新增 `T-CHG9+`。
2. **契约注释落点**：`contracts/cloud-host.graphql` 的 `setupCloudHostGithubProject` mutation 上方增补四行口径注释；`graphql/schemas/cloud-host.ts` 同一位置写入逐字一致的注释（TS 模板字符串内避免使用反引号或按既有风格转义）。`SetupCloudHostGithubProjectInput` 既有注释不动。
3. **remote 精确匹配**：新增脚本内纯函数 `normalize_remote`：去尾部 `/` → 去 `.git` 后缀 → 再去尾部 `/` → 去 `https://`/`http://`/`ssh://`/`git://` 前缀 → 去 `user@` 前缀；归一后与 `github.com/<repo>`（https 形态）或 `github.com:<repo>`（scp 形态）**全等**才判同仓库。覆盖：`https://github.com/o/r.git`、`https://x-access-token:TOKEN@github.com/o/r.git`、`git@github.com:o/r.git`、`ssh://git@github.com/o/r`、尾部斜杠；`owner/repo-2`、`owner/repository` 不再误判。remote 读取失败（空串）归入冲突。
4. **复用分支零动作**：匹配后仅 `echo "目标目录已是 $REPO 的 Git 仓库，直接复用该目录"`，不执行任何 git 子命令；exit 0。
5. **冲突文案与退出码**：exit 2（`.git` 存在但 remote 不匹配/为空）、exit 3（非空普通目录）、exit 4（同名文件等非常规类型）统一输出 `目标目录已存在其他项目，请修改前缀地址`；`gh` 缺失保持 `gh 不可用，请先安装 Github 工作负载` + exit 1。
6. **`.git` 为文件**：`-d "$TARGET/.git"` 不命中 → 落入「目录存在且非空」分支 exit 3 判冲突，不删除（linked worktree / gitfile 形态保守处理）。
7. **空目录与符号链接**：`ls -A` 为空才 `rmdir`；`rmdir` 失败（如目标是指向空目录的符号链接）原样非零退出，不加 `|| true`、不 fallback 删除，保证「不删除任何内容」；该场景用 `T-GHS14` 锁定。
8. **行为测试工程口径**：
   - 用 `mkdtempSync(join(tmpdir(), 'zag-ghs-'))` 建临时根目录，`afterEach` 递归清理；`describe.skipIf(process.platform === 'win32')`（脚本依赖 bash/git）。
   - `gh` 桩：临时 `bin/gh`（`chmod 0o755`），内容记录 `"$*"` 到 `GH_STUB_LOG` 并按 `$4` 创建目标目录；测试断言「是否调用 clone / 参数」。
   - 运行方式：`execFileSync('/bin/bash', ['-c', GITHUB_SETUP_SCRIPT], { env, timeout: 20_000 })`；env 注入 `WORKLOAD_PARAM_TARGETPATH`、`WORKLOAD_PARAM_REPOFULLNAME`、`PATH=<桩目录>:<原 PATH>`、`GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=/bin/true`，防止 pull 回退时挂起或交互。
   - 「gh 缺失」用例使用**仅含空临时目录的 PATH**（F9），以绝对路径调用 bash，确保 `command -v gh` 失败。
   - 构造仓库：`git init -q` + `git remote add origin <url>`；需要提交时 `git -c user.name=t -c user.email=t@example.com commit --allow-empty -qm init`。
9. **基线更新清单（预期变更，非回归）**：仅 `T-CHG8` 的 4 条断言（旧文案 / `pull --ff-only` → 新文案 / `rmdir` / 不含 pull）与 `T-CHG10b` 注释；其余 agent-api 用例零改动。tests/api、tests/e2e 既有用例必须零失败。

### 新脚本全文（Phase 2 实现基准）

```bash
set -euo pipefail
TARGET="${WORKLOAD_PARAM_TARGETPATH:?missing targetPath}"
REPO="${WORKLOAD_PARAM_REPOFULLNAME:?missing repoFullName}"
command -v gh >/dev/null || { echo "gh 不可用，请先安装 Github 工作负载"; exit 1; }

normalize_remote() {
  local url="$1"
  url="${url%/}"
  url="${url%.git}"
  url="${url%/}"
  url="${url#https://}"
  url="${url#http://}"
  url="${url#ssh://}"
  url="${url#git://}"
  url="${url#*@}"
  printf '%s' "$url"
}

if [ -d "$TARGET/.git" ]; then
  ORIGIN="$(git -C "$TARGET" remote get-url origin 2>/dev/null || true)"
  REMOTE="$(normalize_remote "$ORIGIN")"
  if [ "$REMOTE" = "github.com/$REPO" ] || [ "$REMOTE" = "github.com:$REPO" ]; then
    echo "目标目录已是 $REPO 的 Git 仓库，直接复用该目录"
  else
    echo "目标目录已存在其他项目，请修改前缀地址"
    exit 2
  fi
else
  if [ -d "$TARGET" ]; then
    if [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
      echo "目标目录已存在其他项目，请修改前缀地址"
      exit 3
    fi
    rmdir "$TARGET"
  elif [ -e "$TARGET" ]; then
    echo "目标目录已存在其他项目，请修改前缀地址"
    exit 4
  fi
  gh repo clone "$REPO" "$TARGET"
fi
```

---

## Phase 0: 契约（注释增补，零字段变更）

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/cloud-host.graphql` | 修改 | `setupCloudHostGithubProject` mutation 上方增补：Git 项目设置幂等口径——目标目录已是同一仓库（remote 精确匹配）时直接复用、不拉取不改动；目标目录为空目录时自动移除后继续克隆；被其他项目占用（其他仓库 / 非空普通目录 / 同名文件）时失败并提示「目标目录已存在其他项目，请修改前缀地址」，被占用内容不被改动 |
| `servers/agent-api/src/graphql/schemas/cloud-host.ts` | 修改 | 同一 mutation 位置写入逐字一致的内联注释（按模板字符串风格转义），字段零变更 |

验收：两处注释逐字一致；`git diff` 确认无字段/类型/默认值增删改；`SetupCloudHostGithubProjectInput` 既有注释不动。

## Phase 1: 测试先行（RED）

### Step 1.1 新增脚本行为矩阵

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/services/github-setup-script.behavior.test.ts` | 新增 | 从 `./cloud-host-github-service.js` 导入 `GITHUB_SETUP_SCRIPT`（与 T-CHG8 同源，保证测的就是线上常量）；按裁决 8 搭临时目录 / gh 桩 / 隔离 PATH；覆盖下表 T-GHS1~14 |

| 用例 | 前置状态 | 预期 |
|------|---------|------|
| T-GHS1 | 目标不存在 | 调用 `gh repo clone owner/repo <target>` 一次，exit 0 |
| T-GHS2 | 同仓库 https origin（`https://github.com/owner/repo.git`） | 不调用 gh，exit 0，stdout 含「直接复用」，目录内 marker 内容不变 |
| T-GHS3 | 同仓库 ssh origin（`git@github.com:owner/repo.git`） | 同 T-GHS2 |
| T-GHS4 | 同仓库 + 本地 ahead 提交（origin 指向 github.com） | 不拉取，exit 0，HEAD sha 与提交数不变，marker 保留 |
| T-GHS5 | 同仓库带凭据 origin（`https://x-access-token:abc@github.com/owner/repo.git`） | 归一后匹配，exit 0，不调用 gh |
| T-GHS6 | 异仓库 origin（`https://github.com/owner/other.git`） | exit 2 + 冲突文案，目录内容不变，不调用 gh |
| T-GHS7 | 前缀相似仓库 origin（`https://github.com/owner/repo-2.git`） | exit 2 + 冲突文案（防子串误判，裁决 3） |
| T-GHS8 | 目标为空目录 | `rmdir` 后调用 gh clone，exit 0，目标由桩重建 |
| T-GHS9 | 目标为非空普通目录（含 marker） | exit 3 + 冲突文案，marker 内容不变 |
| T-GHS10 | 目标为同名普通文件 | exit 4 + 冲突文案，文件内容不变 |
| T-GHS11 | `.git` 存在但无 origin（`git init` 残骸） | exit 2 + 冲突文案，`.git` 仍存在 |
| T-GHS12 | `gh` 不在 PATH（隔离 PATH，F9） | exit 1 + 「gh 不可用，请先安装 Github 工作负载」 |
| T-GHS13 | `.git` 为普通文件（模拟 linked worktree gitfile） | exit 3 + 冲突文案，文件内容不变（裁决 6） |
| T-GHS14 | 目标为指向空目录的符号链接 | 非零退出（`rmdir` 失败），符号链接与指向目录均保留（裁决 7） |

### Step 1.2 重写 T-CHG8 字符串断言

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/services/cloud-host-github-service.test.ts` | 修改 | `T-CHG8` 改为：不含 `TOKEN`；含 `gh repo clone "$REPO" "$TARGET"`、`目标目录已存在其他项目`、`rmdir "$TARGET"`、`command -v gh`；**不含** `pull --ff-only`（防回退）；`T-CHG10b` 注释中的「clone 脚本幂等（git pull --ff-only）」改为「clone 脚本幂等（同仓库直接复用、空目录清理后克隆）」 |

RED 判定：`pnpm test -- cloud-host-github-service github-setup-script.behavior` 中 `T-CHG8` 与 `T-GHS2~7/9~14` 失败（旧脚本行为/旧文案），`T-GHS1/8/12` 预期已通过（旧脚本同行为）。

## Phase 2: 脚本重写（GREEN）

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/services/cloud-host-github-service.ts` | 修改 | `GITHUB_SETUP_SCRIPT` 替换为上文「新脚本全文」；保持导出常量名、`WORKLOAD_PARAM_*` 参数注入方式、`startRuntimeScript` 调用与注释结构不变；JSDoc 由「幂等 Git 设置脚本」补一句「同仓库复用零改动 / 空目录清理 / 冲突统一提示」 |

GREEN 判定：`pnpm test -- cloud-host-github-service github-setup-script.behavior` 全绿；再跑 `pnpm test`（agent-api 全量）零失败。

### 命令参考

```bash
cd servers/agent-api && pnpm build
cd servers/agent-api && pnpm test -- cloud-host-github-service github-setup-script.behavior
cd servers/agent-api && pnpm test
```

## Phase 3: 回归与收口

### Step 3.1 集成回归（tests/api）

> 脚本在云电脑容器内执行，API 层只透出 operation 状态与 error，无法直接断言脚本分支；本阶段以「契约零变更 + 既有用例零回归」为目标。先 `aspire start && aspire wait agent-api`，再按 `tests/api/AGENTS.md` 注入环境变量。

| 文件 | 操作 | 覆盖 |
|------|------|------|
| `tests/api/src/agent-api/cloud-host-workload.test.ts` | 回归（不改） | `T-CHG-API1`、`T-GH-API-P3/P4`、`T-GH-API-L1~L3` 零失败（`createOperation` 入参与校验未变） |
| `tests/api/src/agent-api/cloud-host.test.ts` | 回归（不改） | setup/retry 相关既有用例零失败 |

若环境不可达（workload 步即失败的历史情况），记录「未执行」并说明由单测 + 验收节点真机覆盖，不伪报通过。

### Step 3.2 文档收口

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/AGENTS.md` | 修改 | 「云主机工作负载与 Github 项目设置」段的编排条目补一句脚本幂等口径：目标目录已是同一仓库（remote 归一后精确匹配，含 https/ssh/凭据 URL/`.git`/尾斜杠形态）→ 直接复用零改动；空目录 `rmdir` 后克隆；异仓库 / 非空目录 / 同名文件 / `.git` 残骸统一提示「目标目录已存在其他项目，请修改前缀地址」；`.git` 为文件形态保守判冲突 |
| `docs/engineering/AGENTS.md` | 修改 | 实现计划索引登记本文件（随本 PR 提交） |

`tests/api/AGENTS.md`、`tests/e2e/AGENTS.md`、`apps/agent-web/AGENTS.md` 不改（无新增/变更用例与前端行为）。

### Step 3.3 PR 收口

1. 实现分支 `fix/github-project-setup-optimization-impl` 基于需求总分支 `prd/github-project-setup-optimization` 拉起；完成后向需求总分支发起实现 PR（需求总 PR #438 保持长开，累计方案、计划与实现）。
2. PR 描述声明：契约零字段变更（仅注释）；前端零改动；唯一行为改动是 `GITHUB_SETUP_SCRIPT`；同仓库复用不再拉取（目录零改动）、空目录自动清理、三类占用统一提示；remote 匹配由子串收紧为归一后精确匹配（附前缀相似仓库用例）；测试为 `T-CHG8` 重写 + `T-GHS1~14` 真跑 bash。
3. 通过 `agent-workflow-tools.linkPullRequest` 把实现 PR 关联到工作流对应节点。
4. 需求总 PR #438 的评审意见（含 inline comment）已在方案阶段核对：无正文、无 inline comment、无修改要求，无需回评修改项；实现 PR 的描述中注明「上游评审已通过（2026-11-04T08:53:23Z）」。

---

## 总体验收

- [ ] 契约与 schema 注释一致、零字段变更（Phase 0）
- [ ] `T-CHG8` 重写断言全绿，且脚本不含 `pull --ff-only`（防回退）
- [ ] `T-GHS1~14` 行为矩阵全绿：同仓库（https/ssh/凭据 URL）复用零改动、本地 ahead 提交保留、异仓库与前缀相似仓库判冲突、空目录清理后克隆、非空目录/同名文件/`.git` 残骸/`.git` 文件/符号链接均不删除内容
- [ ] 冲突提示在 `operation.error` 中可检索到「目标目录已存在其他项目」（允许被 `工作负载执行失败（…）：` 包装）
- [ ] agent-api 全量单测零失败（基线更新清单外无改动）
- [ ] tests/api 既有 setup/retry 用例零回归（或记录环境不可达）
- [ ] `servers/agent-api/AGENTS.md` 与 `docs/engineering/AGENTS.md` 已同步
- [ ] 实现 PR 已创建并关联到工作流节点

## 风险与回滚

| 风险 | 影响 | 缓解 |
|------|------|------|
| 同仓库复用不再拉取 | 用户期望「再次设置即更新代码」时感知为未更新 | PRD 明确「内容零改动」；用户/Agent 可自行 `git pull`；Issues 联动只需目录就绪，不依赖更新 |
| remote 匹配收紧后漏判合法形态（如企业域名、`git://`、大写主机） | 合法同仓库被判冲突，需用户改前缀或手工处理 | 覆盖 https/ssh/scp/凭据 URL/`.git`/尾斜杠矩阵（T-GHS2~5）；判冲突只提示、不删除，可安全重试；后续按实际反馈扩形态 |
| 子串匹配改为精确匹配与提案「行为不变」表述不一致 | 评审疑问 | PR 描述与计划裁决 3 说明理由：新行为下误判会静默复用错误目录，违反 PRD 功能点 3 |
| 冲突后用户点「重试」仍失败 | 体验困惑 | 文案明确「请修改前缀地址」；PR 与文档说明「关闭 → 重开设置对话框」路径；后续可选在进度框增加「修改前缀地址」入口 |
| 行为测试依赖 bash/git | 本地 Windows 开发不可跑 | `describe.skipIf(win32)`；CI 为 ubuntu-latest，必跑 |
| `rmdir` 在特殊文件系统失败 | 设置失败并暴露底层英文错误 | 罕见边界；安全优先不删除，`T-GHS14` 锁定行为；必要时用户手工清理 |
| 回滚 | — | 单文件常量回退即可（`GITHUB_SETUP_SCRIPT` 恢复旧文本），无数据/契约迁移，无前端与容器镜像变更 |
