---
description: 云容器 Commit「Co-Author」设置未生效（提交作者仍为 bot、无 Co-authored-by trailer）调查报告：bot 身份解析失败导致身份下发 unset，Agent 回退写入仓库本地 bot 身份后永久覆盖全局托管身份
type: Permanent
---

# Commit 设置「Co-Author」未生效 调查报告

> **状态**: 🔴 根因已定位（双根因：服务端身份下发 `unset` + 容器侧仓库本地身份覆盖全局托管身份）；修复方案待评审；报告与最小复现已提交 `bugfix/gitcommit-coauthor-not-effective` 分支。

## 1. 问题概述

用户在设置页将 **Commit 提交人模式** 设为「Co-Author」、提交人选择 GitHub 帐号 **Deliay**，预期提交为：

- `author` = 人类（Deliay）
- commit message 携带 `Co-authored-by: z-agent-bot[bot] <...>`

实际（示例 PR <https://github.com/Deliay/z-agent-gear/pull/337>）：

- 全部 commit 的 `author` 仍为 `z-agent-bot[bot] <301571485+z-agent-bot[bot]@users.noreply.github.com>`；
- 全部 commit **没有** `Co-authored-by` trailer；
- 设置页保存成功并提示「对云容器环境生效，已运行的云电脑稍后自动更新」，但重启云电脑、等待多个同步周期后仍然无效。

本报告结论：**不是单一 UI/保存问题，而是「服务端身份下发被降级为 unset」与「容器内仓库本地 bot 身份覆盖全局托管身份」两个缺陷叠加**。后者会让问题在服务端修复后仍然持续存在（已污染的仓库不会自愈）。

## 2. 环境与版本

| 项 | 值 |
|---|---|
| 云容器 | `ZAG_HOST_NAME=开发环境`，`HOME=/home/worker`，运行用户 `worker(1000)` |
| 云主机 | `ZAG_CONTROLLER_ID=6ae225ace809eeef9f38d705`，`ZAG_USER_ID=6a1289ba95916b3624807678` |
| agent-gear | **2.11.0**（含 Commit 身份托管模块；npm 发布时间 2026-10-27T11:01Z） |
| Harness | `ZAG_HARNESS_TYPES=kimi_code,opencode` |
| 代码基线 | `main` = `34745215`（PR #333 合并）；`origin/release` = `d1168aad` |
| 相关实现提交 | `aa2fa49e feat(commit-settings): 云容器 Commit 提交人设置`（2026-10-27T06:33+08:00） |
| 多租户基线 | `3aa74370 Merge pull request #330 from Deliay/feat/multi-tenant-phase1`（2026-10-28T04:49Z） |
| 示例 PR | `Deliay/z-agent-gear#337`（20 个 commit，全部 bot 作者，全部无 trailer） |
| 取证时间 | 2026-10-28 18:50Z ~ 19:12Z |

> 关键时序：Commit 设置功能（10-27）早于多租户一期（10-28）合入；多租户的 `applyTenantScope` 会在 `userId` 查询上追加 `tenantId` 条件，见 §4.5。

## 3. 复现步骤与结果

### 3.1 现场探针（云容器内，只读）

```bash
curl -s -X POST "$ZAG_AGENT_API_ENDPOINT/internal/cloud-hosts/$ZAG_CONTROLLER_ID/commit-identity" \
  -H "Authorization: Bearer $ZAG_HOST_KEY"
```

实际输出（重复 3 次，HTTP 200，稳定复现）：

```json
{"mode":"unset"}
```

```bash
ls -la /home/worker/.zag/commit-identity.gitconfig /home/worker/.zag/git-hooks
git config --global --get-all include.path
git config --global --get core.hooksPath
```

实际输出：

```text
ls: cannot access '/home/worker/.zag/commit-identity.gitconfig': No such file or directory
ls: cannot access '/home/worker/.zag/git-hooks': No such file or directory
（include.path / core.hooksPath 均为空）
```

说明：服务端明确返回「未设置」，容器也从未写过任何托管文件，`co_author` 链路（gitconfig + `prepare-commit-msg` hook）**完全未生效**。

### 3.2 仓库本地身份（当前现场）

```bash
git config --show-origin --get-all user.name
git config --show-origin --get-all user.email
```

```text
file:/home/worker/workspace/Deliay/z-agent-gear/.git/config	z-agent-bot[bot]
file:/home/worker/workspace/Deliay/z-agent-gear/.git/config	301571485+z-agent-bot[bot]@users.noreply.github.com
```

> 所有 linked worktree 共用同一份 `.git/config`（`git -C <worktree> config --show-origin` 均指向该文件），因此影响整个仓库的全部工作流会话。

### 3.3 服务端 bot 身份解析失败的证据

agent-api 的 bot 身份缓存键位于 Redis（`github:app-bot-identity`，成功 TTL 24h、失败 sentinel 60s）：

```text
GET github:app-bot-identity  =>  "__fail__"
TTL github:app-bot-identity  =>  60（每次失效后重新拉取仍失败，重新写入 sentinel）
```

时间行为（sentinel 过期后重新触发真实请求）：

| 调用 | 耗时 | 返回 |
|---|---|---|
| sentinel 命中（连续 3 次） | ~0.07s | `{"mode":"unset"}` |
| sentinel 过期后 1 次 | **1.77s** | `{"mode":"unset"}`，随后 sentinel 重新写入 |

结论：`resolveCommitIdentity` **已经走到 co_author（或 agent_only）分支并调用 `resolveAppBotIdentity()`**，是 bot 身份拉取失败后按设计降级为 `unset`（见 `servers/agent-api/src/services/commit-settings-service.ts` L188-198、L204-213）。

补充：容器网络访问 GitHub 用户接口正常（`GET https://api.github.com/users/z-agent-bot%5Bbot%5D` → 200，1.19s），排除整体出网不可达；失败点收窄到 `GET /app`（App JWT）或经 `githubApiBaseUrl` 的 `GET /users/{slug}[bot]`。具体错误正文只出现在 agent-api 日志（`[GitHub] app bot identity unavailable: ...`），本容器无权读取，列入 §8 待确认。

### 3.4 示例 PR #337 的提交身份

```bash
gh pr view 337 --repo Deliay/z-agent-gear --json commits \
  --jq '.commits[] | [.oid[0:8], .authors[0].login, (.messageBody | test("Co-authored-by")), .messageHeadline] | @tsv'
```

20/20 commit 均为 `z-agent-bot[bot]`，`Co-authored-by` 均为 `false`（抽样）：

```text
d8724de8	z-agent-bot[bot]	false	docs(prd): 重构对话渲染产品文档与技术提案（参考 zed ACP 渲染）
4420ccf3	z-agent-bot[bot]	false	feat(agent-web): 重构对话渲染（工具调用合并/Markdown/Mermaid/...
bd151c5d	z-agent-bot[bot]	false	Merge pull request #336 from Deliay/feat/conversation-rendering-impl
```

### 3.5 Agent 回退写入 bot 身份的现场证据

opencode 运行日志（`/home/worker/.local/share/opencode/log/opencode.log`）：

- L1306：18:35:47 的 `git commit` 失败输出：
  ```text
  fatal: unable to auto-detect email address (got 'worker@zag-worker-r6kjbn-rr4k4.(none)')
  ```
- L1311：18:36:02，Agent 在同一条命令里**先写仓库本地身份、再提交**：
  ```bash
  git config user.name 'z-agent-bot[bot]' && \
  git config user.email '301571485+z-agent-bot[bot]@users.noreply.github.com' && \
  git commit -m "..."
  ```

对应的会话记录（`~/.local/share/opencode/opencode.db`，session `ses_e7c3ae466ffetrjz1AO742Sf9R`）显示 Agent 的决策过程：

> `git log -1` 看到历史作者是 bot → 设本地 `user.name/email` 为 bot → 提交成功。

这就是 `.git/config` 中 bot 身份的来源，也是「即使后续服务端下发 Co-Author，作者仍是 bot」的直接原因。

### 3.6 最小复现（确定性，100% 稳定）

脚本：`docs/engineering/acceptance/repro/20261028-gitcommit-coauthor-not-effective.repro.sh`

```bash
bash docs/engineering/acceptance/repro/20261028-gitcommit-coauthor-not-effective.repro.sh
```

实际输出（节选）：

```text
### 场景 A：仓库本地写入了 bot 身份（当前线上现场）
file:.git/config	z-agent-bot[bot]
author: z-agent-bot[bot] <301571485+z-agent-bot[bot]@users.noreply.github.com>
body: Co-authored-by: z-agent-bot[bot] <301571485+z-agent-bot[bot]@users.noreply.github.com>

### 场景 B：移除仓库本地身份后（期望的 Co-Author 结果）
file:.../.zag/commit-identity.gitconfig	Deliay
author: Deliay <12345+Deliay@users.noreply.github.com>
body: Co-authored-by: z-agent-bot[bot] <301571485+z-agent-bot[bot]@users.noreply.github.com>
```

- 场景 A：托管全局身份为 Deliay，但本地 bot 身份覆盖 → 作者 bot，trailer 也是 bot（GitHub 上看起来「只有机器人」）。
- 场景 B：移除本地身份后，托管全局身份 + hook 完全符合 Co-Author 预期。
- 复现稳定性：连续多次执行结果一致；不依赖网络或数据库。

## 4. 根因分析（含证据）

### 4.1 调用链

```mermaid
flowchart TD
    A[设置页保存 CO_AUTHOR + Deliay] --> B[(user_commit_settings)]
    C[agent-gear CommitIdentityManager 启动/每 50min] -->|POST /internal/cloud-hosts/:id/commit-identity| D[agent-api resolveCommitIdentity]
    D --> E{mode=co_author}
    E --> F[resolveCommitter: githubaccounts]
    F --> G[resolveAppBotIdentity: GET /app -> GET /users/slug[bot]]
    G -->|失败| H[降级 mode=unset]
    H --> I[容器 remove 托管配置 / 不写任何身份]
    I --> J[git commit: 无全局身份]
    J -->|fatal: unable to auto-detect email address| K[Agent 自行 git config user.name/email = bot]
    K --> L[仓库本地 bot 身份永久覆盖后续全局托管身份]
    L --> M[commit author=bot，无 trailer]
```

### 4.2 直接根因 A：服务端 bot 身份解析失败，`co_author` 整体降级为 `unset`

- 证据：§3.1 端点稳定返回 `{"mode":"unset"}`；§3.3 Redis fail sentinel 与 1.77s 的真实上游请求耗时。
- 代码：`commit-settings-service.ts` L188-198（`co_author` 必须拿到 bot，否则 `{mode:'unset'}`）；L204-213（bot 失败仅 `console.warn` 后返回 null）；`github.ts` L520-555（失败写 60s sentinel）、L557-589（`GET /app` → `GET /users/{slug}[bot]`）。
- 影响：容器端 `CommitIdentityManager` 收到 `unset` 后调用 `remove()`（`commit-identity-manager.ts` L220-227），不会写 `~/.zag/commit-identity.gitconfig`，也不会安装 hook。
- 尚未定位：`GET /app` 失败的 HTTP 状态/原因。安装 token（`ghs_`）能正常签发，说明 App JWT 本身可用，怀疑 `githubApiBaseUrl`/代理对 `/app`、`/users` 的放行差异或 App 配置差异，需 agent-api 日志确认（§8）。

### 4.3 直接根因 B：Agent 回退写入仓库本地 bot 身份，覆盖全局托管身份

- 证据：§3.5 的 18:35:47 失败输出 + 18:36:02 的 `git config user.name/email` 命令；§3.2 当前 `.git/config`；§3.6 场景 A/B 对照。
- 机制：Git 配置优先级为 **仓库本地（`.git/config`） > worktree > 全局（含 `include.path`） > 系统**。`CommitIdentity.apply()` 只写全局 `include.path`（`commit-identity.ts` L143-165），无法覆盖本地 `[user]`。
- 为什么 hook 不能补救：`prepare-commit-msg` 只能追加 `Co-authored-by`，不能改 `author`；author 与 co-author 同为 bot 时，PR 界面仍显示「只有机器人」。
- 持久性：本地配置在所有 worktree 间共享，后续任何会话/任何模式都继续以 bot 提交；**服务端修复后也不会自愈**，必须清理本地配置或改为强制覆盖。

### 4.4 次因 C：生效链路缺少「立即生效」与可观测性

- 同步周期固定 50 分钟（`commit-identity-manager.ts` L5、L266-275），设置保存后没有主动下发/推送；用户看到「稍后自动更新」但实际最长等待 50 分钟，且会话内既有进程不会重载身份。
- `resolveCommitIdentity` 把所有失败都折叠为 `unset`（L158-201），不向调用方/日志返回原因码（host 未找到 / 设置缺失 / 提交人非法 / bot 失败），导致现场只能靠 Redis/DB 反推。
- 容器端 `commit-identity-manager` 在 `unset` 时静默 `remove()`，没有「当前未生效原因」的状态回传。

### 4.5 关联风险：多租户 `tenantId` 条件（待确认，不作为本次已证根因）

Commit 设置功能早于多租户一期合入。`applyTenantScope` 会在 `{userId}` 查询上追加 `tenantId=userId`（`tenant-scope.ts` L84-89、L96-120），而 `user_commit_settings` 由 `findOneAndUpdate(...{upsert:true})` 写入。理论上 upsert 会从过滤器继承 `tenantId`，且迁移 013 已回填该集合；但若部署环境中迁移 013 未执行/写入发生在插件上线前的窗口，历史行可能缺少 `tenantId`，导致读取不到设置。**本次现场已能走到 bot 解析分支（§3.3），说明当前设置行已被读到**，故该风险降级为「防御性检查项」，但修复时仍应加一条真实 Mongoose 回归用例。

## 5. 影响范围

| 维度 | 影响 |
|---|---|
| 提交人模式 | `co_author` 完全不生效（服务端 unset）；`human_only` 同理被降级为 unset；`agent_only` 在 bot 解析失败时也会 unset，但本地 bot 身份恰好「看起来正常」 |
| 仓库/会话 | 所有共享该 `.git/config` 的 worktree 与会话（本机 6 个 worktree 均命中）；新建 worktree 继续继承 |
| 自愈性 | **不会自愈**。即使服务端恢复 co_author，本地 bot 身份仍优先生效 |
| 历史数据 | PR #337 等已产生的 commit 无法回溯修正（禁止重写历史）；只能在后续 commit 生效 |
| 其他入口 | 本地（非云容器）控制器不走该链路，不受影响；云容器的 `agent_only` 语义未被破坏，但 `human_only`/`co_author` 失效 |
| 数据修复 | 需要清理受影响仓库的本地 `user.name`/`user.email`（或由修复方案接管）；属一次性运维动作 |
| 安全/凭据 | 本次调查未读取/记录任何 token；探针均为只读（端点查询、Redis GET、git config 读取） |

## 6. 修复方案与风险

> 本节为建议，不在本调查节点实施。修复需同时解决 A（服务端）与 B（容器侧），否则只修一侧仍无效。

### 6.1 P0 服务端：恢复 bot 身份解析，并改进降级语义

1. 定位并修复 `GET /app` 失败（日志中的 `app bot identity unavailable: ...`）：核对 `GITHUB_APP_ID`、`GITHUB_APP_PRIVATE_KEY`、`GITHUB_API_BASE_URL`；为该请求补充状态码/URL 级告警（不含 JWT）。
2. **降级策略调整**：`co_author` 在 bot 解析失败时，不应整体 `unset`；建议降级为 `human_only`（人类作者生效，仅缺 trailer）并记录 `bot_unavailable` 原因码。这样至少满足「人类为主体」的核心诉求。
3. 为 `resolveCommitIdentity` 增加原因码（`host_not_found` / `settings_missing` / `mode_unset` / `committer_invalid` / `bot_unavailable`），仅写日志/内部指标，不改变对容器的 `{mode:'unset'}` 契约。
4. 设置保存后主动触发目标云主机 `refreshNow()`（Socket.IO/内部端点），或把周期缩短为分钟级；至少让「已运行云电脑稍后自动更新」有明确时限。

### 6.2 P0 容器侧：让托管身份真正拥有最高优先级

候选方案（建议 A + C 组合）：

- **方案 A（推荐）**：`CommitIdentity.apply()` 除全局 `include.path` 外，对已登记的 workspace/worktree 写入 **仓库本地** `user.name/email`（并备份原值，`remove()` 时精确还原）。这样天然覆盖历史遗留的 bot 本地身份，且「未设置 = 零残留」仍可满足。
- **方案 B**：在启动 harness 会话时注入 `GIT_AUTHOR_NAME/EMAIL`、`GIT_COMMITTER_NAME/EMAIL` 环境变量（Git 环境变量优先级最高）。缺点：只对新会话生效，且需要重启会话；对环境变量泄漏面更大。
- **方案 C（治理）**：禁止 Agent 自行写入仓库本地身份（更新 z-git/系统提示词与 harness 约束）；提交失败时让 Agent 报错/等待平台身份，而不是「看历史作者是谁就照抄」。
- **方案 D（兜底）**：应用身份时检测并清理「与之冲突的、且值等于平台 bot 的」本地 `user.*`（备份后清理），避免误删用户自定义身份。

### 6.3 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 误改用户仓库配置 | 方案 A/D 会写/删本地 `user.*` | 仅处理已登记 workspace；精确匹配托管值才清理；备份原值并在 remove 时还原 |
| 历史作者归属变化 | 修复后新 commit 作者变为人类 | 属预期；不重写历史，PR 中说明生效边界 |
| 多 harness/多会话 | 运行中的 opencode/Kimi 进程不会重载配置 | 依赖 git 每次 commit 读取配置（生效）；环境变量方案需重启会话 |
| bot 解析持续失败 | 降级 human_only 后仍无 trailer | 增加告警与原因码；bot 恢复后下一周期自动补 trailer |
| 多租户 `tenantId` 漂移 | 历史设置行可能读不到 | 修复时补真实 Mongoose upsert/读取回归用例，并核对迁移 013 执行记录 |

## 7. 回归测试计划

| 层级 | 用例 | 断言 |
|---|---|---|
| 单测（agent-controller） | `T-CI6`：仓库本地存在 bot `user.*` 时 apply(`co_author`) 后提交 | `author` = 人类；trailer = bot；连续两次 apply 幂等 |
| 单测（agent-controller） | `T-CI7`：remove 后本地 `user.*` 精确还原 | 原值逐字恢复，用户其他配置零触碰；worktree 场景同样生效 |
| 单测（agent-controller） | `T-CIM9`：服务端返回 `unset` 时不覆盖/不删除用户本地身份 | 现状保留，不产生半配置 |
| 单测（agent-api） | bot 解析失败时 `co_author` 的降级策略 | 返回 `human_only`（或约定的兜底）+ 原因码日志 |
| API（tests/api） | 保存 `CO_AUTHOR` → 查询回读 → `POST commit-identity` | 返回 `co_author` + 人类/bot 字段；bot 失败场景按兜底断言 |
| E2E（tests/e2e） | 设置页保存 Co-Author + 真实容器执行一次提交 | GitHub commit `author.login=Deliay`，message 含 `Co-authored-by: z-agent-bot[bot]` |
| 真实验收 | 旧容器（已污染本地身份）不清理直接升级 | 修复后首个 commit 即人类作者（验证方案 A/C 的覆盖能力） |

**修复前最小验证命令**：

```bash
bash docs/engineering/acceptance/repro/20261028-gitcommit-coauthor-not-effective.repro.sh
# 期望修复后：场景 A 的 author 也必须是 Deliay（不再是 bot）
```

## 8. 待确认问题

1. **`GET /app` 的具体失败原因**：需要 agent-api 日志中 `[GitHub] app bot identity unavailable: <reason>` 一行，或确认 `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_API_BASE_URL` 的部署值（无需提供私钥内容，只需确认是否存在、base URL 是否指向代理）。容器侧访问 `https://api.github.com/users/z-agent-bot%5Bbot%5D` 正常（200），故不是整体出网问题。
2. **设置保存时间与容器启动时间的先后**：容器 16:42Z 启动，本次取证 19:09Z；若设置是近期保存，需确认期间是否有一次 50 分钟同步窗口。此项只影响「延迟」判定，不影响 A/B 两个根因。
3. **DB 中当前 `user_commit_settings` 行**（只读核对）：`userId=6a1289ba95916b3624807678` 的 `committerMode` 是 `co_author` 还是 `agent_only`、`committerType=github_account` 是否指向 Deliay、`tenantId` 是否等于 `userId`。现场已能触发 bot 解析，说明行存在且可读，但仍建议核对字段。
4. **数据修复授权**：是否允许修复版本对已存在仓库执行「备份并清理本地 bot `user.*`」，以及清理范围（仅本平台 workspace，还是用户手工 clone 的目录也处理）。
5. **降级语义取舍**：bot 解析失败时 `co_author` 降级为 `human_only` 是否可接受（推荐），还是必须保持 `unset` 以保证 trailer 完整性。
6. **生效时限**：设置保存后是否接受最长 50 分钟延迟；若不接受，是否引入「保存即推送刷新」的通道。

## 9. 附录：取证命令与边界

```bash
# 1) 服务端下发
curl -s -X POST "$ZAG_AGENT_API_ENDPOINT/internal/cloud-hosts/$ZAG_CONTROLLER_ID/commit-identity" \
  -H "Authorization: Bearer $ZAG_HOST_KEY"

# 2) 托管文件 / 全局配置
ls -la /home/worker/.zag/commit-identity.gitconfig /home/worker/.zag/git-hooks
git config --global --get-all include.path
git config --global --get core.hooksPath

# 3) 仓库本地身份
git config --show-origin --get-all user.name
git config --show-origin --get-all user.email

# 4) PR 提交身份
gh pr view 337 --repo Deliay/z-agent-gear --json commits \
  --jq '.commits[] | [.oid[0:8], .authors[0].login, (.messageBody | test("Co-authored-by"))] | @tsv'

# 5) 最小复现
bash docs/engineering/acceptance/repro/20261028-gitcommit-coauthor-not-effective.repro.sh

# 6) bot 身份缓存（只读；需 Redis 网络可达）
#    GET github:app-bot-identity -> __fail__，TTL 60
```

边界说明：

- 本次只做只读取证，未修改 `main`、未修改任何运行中容器的 git 配置、未调用任何写接口。
- 未读取或记录任何 token / 私钥；PR #337 的提交历史不重写。
- 最小复现使用临时 `HOME` 与临时仓库，不触碰 `/home/worker/.gitconfig` 或业务仓库。
