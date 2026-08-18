---
description: 会话生命周期与 Worktree 管理增强 integration→release 合并前 AI 代码验收报告
type: Permanent
---

# 会话生命周期与 Worktree 管理验收报告（2026-08-17）

> **状态**: 🔧 第五轮修复完成 —— 人工复验发现的「删除存活会话 ACP 进程泄漏」「删除 Worktree 误删根工作区」「admin-tools 不默认启用」「resume 路径 mode/model 时序」均已修复并验证通过（单测/API/E2E 全绿），待复验合入 release

## 关联文档

- PRD：[[20260817-session-lifecycle-and-worktree-management]]（docs/product/draft/20260817-session-lifecycle-and-worktree-management.md）
- 技术方案：[[20260817-feat-session-lifecycle-and-worktree-management]]（docs/engineering/proposals/20260817-feat-session-lifecycle-and-worktree-management.md）
- 实现计划：docs/engineering/plan/20260817-feat-session-lifecycle-and-worktree-management.md
- 分支：`integration`（PR #173 → release，基线提交 5404086）
- 验收方式：AI 代码评审（diff：`origin/release..origin/integration`，24 commits，48 文件，+3468/-365，分 5 组并行评审并抽查复核）+ 全量单测执行
- 验收日期：2026-08-17

## 需求概述

会话生命周期与 Worktree 管理增强：会话删除前等待 `acp:stop` ack 再清理 worktree；controller 断线重连后通过 `acp:reconcile` 对账清理孤儿进程（ProcessRegistry 进程注册表 + 进程组 kill）；Worktree 归组展示/新建会话预选择/删除确认（`workspaceWorktrees`/`deleteWorktree`）；`existingWorktreePath` 复用已有 worktree；controller-api dispatcher 并发会话改造；`fs:remove-dir` 目录删除兜底；`completeRework` 后节点会话关闭修复。

## 验收问题清单

### 阻塞（合入前必须修复）

### 1. `workspaceWorktrees` 的 `sessions` 字段返回原始 lean 文档，GraphQL 序列化必然报错

**问题描述**：`servers/agent-api/src/services/worktree.ts:96` 直接 `{ ...session, id }` 展开 Mongoose lean 文档，未走 `mapSession`。schema 中 `WorkspaceWorktree.sessions: [Session!]!`（`graphql/schemas/controller-workspace.ts:31`）且 `Session.createdAt/updatedAt: String!`（`graphql/schemas/session.ts:114-115`），而原始文档中这两个字段是 `Date` 对象——graphql-js 的 `GraphQLString.serialize` 对对象类型抛 `String cannot represent value`，在非空字段上错误冒泡导致整个查询失败。全库无 Session 字段级 resolver 兜底。

**触发场景**：任一 worktree 下有关联会话时调用 `workspaceWorktrees` 查询 → 必现报错。前端侧边栏 worktree 分组（本特性主路径）在真实有会话的场景下整体不可用；API 测试 A1-A10 用 fake controller 走 DB 归并路径也未覆盖到该序列化问题。

**修复方向**：`worktree.ts:96` 复用 session 服务的 `mapSession`（导出或通过公共方法调用），与 `session.ts` 的映射保持一致。

### 2. `acp:reconcile` 服务端从未下发，离线补做/重连对账是断头路

**问题描述**：`servers/` 全目录 grep `reconcile` 零匹配——controller-api 从不 emit `acp:reconcile`。`stopSessionWithAck` 超时后把 sessionId 写入 `acp:stop:pending:{controllerId}`（`acp-session-manager.ts:882-883`），但无任何消费者；且 controller 离线时 `stopSessionWithAck` 在 sessions Map 未命中直接 return（`:820-823`），连 pending 都不写。agent-controller 客户端的 reconcile handler（`packages/agent-controller/src/socketio-client.ts:879-905`）成为死代码。

**触发场景**：controller 离线期间用户删除会话 → agent-api 等 10s ack 超时仅 warn（`session.ts:342-344`）→ 删库 → ACP 进程永久残留，无任何补做机制。直接违反 PRD §1.3「控制器重启、断线重连后不存在归属已删除会话的孤儿进程」与 PRD 功能点 1「离线删除恢复在线后补做清理」；契约 `contracts/agent-controller-websocket.md:182-200` 与提案 §5.1 流程二均要求该机制。

**修复方向**：controller register/重连时读取活跃会话列表 + `acp:stop:pending` list，emit `acp:reconcile {activeSessionIds, pendingKillSessionIds}`；`stopSessionWithAck` 未命中 Map 时也写 pending；补「离线删除→重连补做」测试。

### 3. `fs:remove-dir` 链路可删除任意目录：agent-api 不校验路径归属，controller 仅 7 条系统目录黑名单

**问题描述**：三层失守——(a) agent-api `deleteWorktree` 的 `worktreePath` 来自 GraphQL 入参，只校验 workspace 归属（`worktree.ts:124-128`），从不校验该路径确属此 workspace 的 worktree；(b) controller-api 原样转发（`session-command.ts:113-114`）；(c) controller 端 `isPathSafe`（`packages/agent-controller/src/fs-handler.ts:8-13`）只黑名单 `/etc /usr /bin /sbin /var /proc /sys`，注释明确「we do NOT block the user home directory」，`/`、家目录、`~/Documents` 全部通过，随后 `rmSync recursive+force`。而提案（`proposals/20260817-...md:170,355,365`）与计划（Phase 2）承诺的是**白名单**（仅限 worktreeDir 之下或已注册 worktree 路径），契约 `agent-session-websocket.md:1096` 说黑名单含用户主目录、`:1107` 又说「校验路径白名单」——契约自相矛盾且均与实现不符。PRD §4.2「目录删除仅限本系统管理的目录，不得越界」不成立。

**触发场景**：已认证用户（或前端 bug）调 `deleteWorktree` 传 `worktreePath: "/home/<user>/Documents"` → git remove 失败 → fs 兜底递归删除该目录。

**修复方向**：agent-api 侧强制 `worktreePath` 为 `workspace.path`/worktreeDir 管理范围内的已知路径（复用 `list()` 归集结果校验）；controller 端按契约实现白名单或至少阻断 `/`、homedir、cwd 及 Windows 关键路径，做到纵深防御；契约文本二选一统一。

### 严重

### 4. `existingWorktreePath` + `worktreeBranchSuffix` 组合会在删会话时误删共享 worktree

**问题描述**：复用已有 worktree 的会话并未创建该 worktree，但只要客户端同时传了 `worktreeBranchSuffix`，`worktreeBranch` 就被写入（`session.ts:74-76`）；`delete()` 的清理条件 `worktreePath && worktreeBranch`（`session.ts:349`）命中后，对该共享目录执行 `git:commit`（自动提交他人改动）+ `git:worktree:remove`——即使还有其他会话正在使用该 worktree。

**修复方向**：复用路径时不写 `worktreeBranch`（或增加 `worktreeOwned` 标记，仅自有 worktree 才清理）。

### 5. `deleteWorktree` 结果语义自相矛盾，目录删除失败被静默为成功

**问题描述**：`worktree.ts:173,200-210`——(a) `git:worktree:remove` 失败写入 `removeError` 后，`fs:remove-dir` 兜底成功时未清除，目录已删却返回 `error` 非空；(b) `success: failures.length === 0` 完全不看 `removeError`——目录没删掉（controller 离线、兜底也失败）仍返回 `success: true`。前端 `DeleteWorktreeConfirmDialog.tsx:49-51` 在 `success=true` 时直接 toast「Worktree 已删除」。违反 PRD 功能点 5「删除过程中任一环节失败时向用户展示错误」。

**修复方向**：fs 兜底成功时清空 `removeError`；`success` 应为 `failures.length === 0 && removeError === null`；补该组合场景测试（A6/A7 均未覆盖）。

### 6. ProcessRegistry 落盘用 `tmpdir()` + `renameSync`，跨文件系统必抛 EXDEV 并可 crash controller

**问题描述**：`packages/agent-controller/src/acp/process-registry.ts:60-62` 把临时文件写到 `os.tmpdir()`（Linux 常为 tmpfs）再 `renameSync` 到 `~/.zag/processes.json`（home 文件系统），POSIX rename 不支持跨设备，直接抛 `EXDEV`；`flush()` 无容错。最危险路径：`socketio-client.ts:328-333` 的 `setInterval` 轮询回调里 `registerPid()` → 未捕获异常 crash 整个 controller 进程。

**修复方向**：临时文件写到 `REGISTRY_DIR` 内（同目录 rename 才原子且不跨设备）；`flush()` 加 try/catch；补不 mock fs 的真实文件系统集成测试（现有 `process-registry.test.ts` 全 mock，覆盖不到）。

### 7. 正常 stop 路径不注销 ProcessRegistry，死 PID 积累 + PID 复用误杀窗口

**问题描述**：`deregister` 只在 init 失败/兜底/reconcile 三处调用，`acp:stop` 主路径（bridge 命中，`socketio-client.ts:612-648`）从不注销——每个正常结束的会话都在 `~/.zag/processes.json` 留下死 PID 条目。下次 reconcile 把这些条目当孤儿 `process.kill(-pid, 'SIGTERM')`，若 PID 已被系统复用为进程组组长则误杀无关进程组。叠加问题：两处兜底 kill 的 5s 后 SIGKILL（`socketio-client.ts:633-635,894-896`）无存活检查，同样存在 PID 复用误杀。

**修复方向**：bridge `emitStopped` 统一出口处 deregister（注册表与 bridge 生命周期绑定）；SIGKILL 前先 `kill(pid, 0)` 探活。

### 8. Windows 下 `.cmd` 代理无法启动：去掉 `shell: true` 但仍解析到 `.cmd`

**问题描述**：`packages/agent-controller/src/acp/spawner.ts:39-41` win32 直接 spawn 无 shell，但 `resolveWindowsCommand`（`:113-125`）仍可能返回 `copilot.cmd`。自 Node 18.20.2/20.12.2（CVE-2024-27980）起，spawn `.cmd` 不带 `shell: true` 直接抛 `EINVAL`——Windows 上 npm 全局安装的 ACP agent 全部起不来。`tests/acp-spawner.test.ts:224-233` 还断言固化了这一错误行为。（Node 官方文档化行为，未在 Windows 实跑验证。）

**修复方向**：Windows 下优先解析真实 `.exe` 入口，或对 `.cmd` 保留 `shell: true`/`cmd.exe /c` 包裹；修正测试预期。

### 9. 新增测试普遍存在「标题承诺 ≠ 断言内容」空转

**问题描述**（均见 `tests/api/src/agent-api/worktree.test.ts`、`tests/e2e/src/worktree.spec.ts`，对照计划 Phase 6 承诺）：
- **A7**（:297-320）声称「部分失败汇报 + fs 兜底」，fake controller 全部回 success，断言仅 `typeof success === 'boolean'`——任何响应都通过；
- **A8**（:322-339）标题「deleteWorkflowInstance multi-node cleanup」，实际只创建/删除一个普通会话，PRD 功能点 2 零覆盖；
- **A10**（:372-393）标题「rework flow」，实际只是 create+close，`engine.ts:212-228` 的 `completeRework` 修复无回归保护；
- **E2E-5**（:185-202）只断言 DB 记录删除，未断言 fake controller 收到 `acp:stop`（计划承诺「验证进程不复存在」）；
- E2E-2/3/4 各只完成计划承诺的一半（无展开后会话断言、未走新建会话归组流程、未走确认删除路径）。

**修复方向**：按计划逐条补齐真实断言（失败注入、事件到达记录、顺序时间戳）。

### 10. `workspaceWorktrees` 会话归组未按 workspace 过滤，前端分组错挂 + 新建会话归属混乱

**问题描述**：`worktree.ts:75-79` 查询条件仅 `controllerId + userId + worktreePath≠null`（Session 模型无 workspaceId 字段），同一 controller 下其他 workspace 的 worktree 会话混入本 workspace 列表；且未排除 `status: 'ended'` 会话，`sessionCount` 虚高。前端在错挂的 worktree 上点「新建会话」会把本 workspace 的 workspaceId 与对方 workspace 的 `existingWorktreePath` 一起提交（`WorktreeSidebarGroup.tsx:179-187`），后端不校验 `existingWorktreePath` 归属，造出归属混乱的会话。

**修复方向**：按 worktree 路径前缀/workspace 关联过滤会话；至少排除 `ended` 状态；createSession 校验 `existingWorktreePath` 归属该 workspace。

### 一般

| # | 问题 | 位置 |
|---|------|------|
| 11 | `delete()` 对 `creating`/`connecting` 状态会话不再发 `acp:stop`（release 版无条件发送），controller 稍后拉起 ACP 成孤儿 | session.ts:333-346 |
| 12 | `deleteWorktree` 逐会话走完整清理链（各最多 30s 轮询），N 会话最坏 N×100s+；无 controller 在线检查；某会话清理失败时 DB 残留指向已删目录的会话 | worktree.ts:143-150 |
| 13 | `waitForStopAck` 可能消费陈旧 ack（user_close 触发的 `acp:stopped` 也写同 key，30s 窗口内 resume→delete 误命中，进程未停即开始 git 清理） | session.ts:434-445 |
| 14 | `stopSessionWithAck` 用 `once` 监听 ack，被同 socket 其他 session 的 `acp:stopped` 消耗 → 误走 20s 超时 | acp-session-manager.ts:853 |
| 15 | start/resume 超时与断连路径双重状态发布（`removed`→`ended` 矛盾事件）；`cleanupFailedSession` 为浮动 promise | acp-session-manager.ts:805-810,780-786,153-158 |
| 16 | start/resume 显式失败分支不清理 `pendingInputs`，下一轮 start 注册成功时旧消息补发给新 harness | acp-session-manager.ts:153-158,494-498 |
| 17 | resume 超时错误码回归：`RESUME_TIMEOUT` → `ACP resume timeout`，前端错误码文案映射失效 | acp-session-manager.ts:452,496 |
| 18 | 30s 超时后 controller 仍成功拉起进程时产生永久孤儿（late result 仅记日志，叠加问题 2 永不收割） | acp-session-manager.ts:805-811,761-763 |
| 19 | worktree-handler 沿用 shell 字符串插值（`git -C "${path}" ...`），存在命令注入面，应改 `execFile` 数组参数 | worktree-handler.ts:80,66,107,134 |
| 20 | ackRequired 时服务端收到两个 `acp:stopped` 事件（bridge 自动 emit + handler ack），契约只描述单次语义 | bridge.ts:798-803, socketio-client.ts:641-647 |
| 21 | 前端 `workspaceWorktrees` 查询失败被静默吞掉 `return null`，git workspace 下 worktree 会话整体从侧边栏消失（release 版为平铺展示，属回归） | WorktreeSidebarGroup.tsx:45-50,73-75 |
| 22 | 删除确认对话框删除进行中可被 ESC/遮罩关闭 → 可对同一 worktree 并发发起两次删除 | DeleteWorktreeConfirmDialog.tsx:64 |
| 23 | `failures` 明细不展示：`success=false, error=null` 时只 toast 通用失败；`success=true` 但有 failures 时直接 toast 成功 | DeleteWorktreeConfirmDialog.tsx:49-55 |
| 24 | 每个展开的 git workspace 各挂 15s 轮询，后端 resolver 最长阻塞 30s，请求堆积 | WorktreeSidebarGroup.tsx:45-48, worktree.ts:58-71 |
| 25 | 互斥错误（existingWorktreePath+enableWorktree）抛普通 Error，GraphQL 返回 `INTERNAL_SERVER_ERROR` 而非计划承诺的 `BAD_USER_INPUT` | session.ts:61-63, resolvers/session.ts:97-103 |
| 26 | 删除 Worktree 成功后未按提案/计划要求跳转回首页，用户停留在失效路由 | DeleteWorktreeConfirmDialog.tsx:44-55 |
| 27 | 契约文档内部不一致：`agent-session-websocket.md` 新增小节 2.16-2.19 与原有 `git:status` 的 2.16 重号；`fs:remove-dir` 节白名单/黑名单表述自相矛盾；`workspaceWorktrees`/`deleteWorktree` 写在 `agent-session.graphql` 但实现在 controller-workspace，归属错位 | contracts/ |

### 建议

| # | 问题 | 位置 |
|---|------|------|
| 28 | `detectGitRepo` 缓存命中分支不持久化 `isGitRepo`（只有实时探测分支写库） | controller-workspace.ts:110-112 |
| 29 | agent-api `worktreeService` 零单测覆盖（merge 归组、fallback、success 语义均无），问题 1/5 若有测试大概率提前暴露 | servers/agent-api |
| 30 | controller-api 测试缺口：无同 socket 并发 start 回归测试（正是 dispatcher 要修的竞态）、无 stop ack 超时→pending 路径测试、3 个用例烧真实 30s 定时器致套件 91s | acp-session-manager.test.ts |
| 31 | agent-controller 安全关键代码零测试：`isPathSafe`/`removeDir` 无用例（现有 fs-handler.test.ts 的 mock 甚至没有 rmSync）；reconcile/acp:stop 兜底无测试 | packages/agent-controller |
| 32 | 前端新增 worktree 组件（198 行 WorktreeSidebarGroup + DeleteWorktreeConfirmDialog）零单测，违背项目组件测试惯例 | apps/agent-web/src/components/worktree/ |
| 33 | 测试覆盖缺口：越权负向零覆盖、`deleteWorktree` 离线行为未测（mutation 挂起约 60s 无文档约定）、A9 未兑现 MCP 工具断言、A5 无顺序断言 | tests/api |
| 34 | 两侧 ack 超时窗口不对齐：controller-api 10s×2 次（~20s）vs agent-api 只等 10s；ack TTL 30s 与提案的 60s 不一致 | acp-session-manager.ts:9-10, session.ts:11,436 |
| 35 | `handleControllerStopped` 无条件置 ended，stop 后立即 resume 出现 `ended`→`idling` 状态抖动 | acp-session-manager.ts:395-399 |
| 36 | 预选择模式下 NewSessionDialog 不展示目标 worktree 路径，用户无法确认会话创建位置 | NewSessionDialog.tsx:241-243 |
| 37 | `DeleteWorktreeConfirmDialog` 的 `workspaceName` prop 传入但从未使用（死参数） | DeleteWorktreeConfirmDialog.tsx:24 |
| 38 | reconcile/acp:stop 等 payload 无类型校验，服务端 payload 漂移会 unhandled rejection | socketio-client.ts:879-883 |
| 39 | `process-registry.ts`：`unlinkSync` 导入未使用；`isProcessAlive` 对其他用户进程 EPERM 误判死进程 | process-registry.ts:1,35-42 |
| 40 | `worktree-handler.ts` `list()` porcelain 解析：无空格行产生截断 key；C-quoting 路径带引号返回 | worktree-handler.ts:85-90 |
| 41 | `index.ts` 停机仅 SIGTERM 等 1s 无升级、不注销注册表（与 acp:stop 的 TERM→5s→KILL 语义不一致） | index.ts:47-69 |
| 42 | PRD 仍滞留 `docs/product/draft/`，特性进 release 前应按 z-product 流程推进 | docs/product/draft/ |

## 验证结果

| 项目 | 结果 |
|------|------|
| agent-api 单测 | ✅ vitest 528/528（37 文件） |
| controller-api 单测 | ✅ vitest 378/378（36 文件；3 个用例烧真实 30s 定时器，套件 91s） |
| agent-controller 单测 | ✅ vitest 304/304（25 文件） |
| agent-web 单测 | ✅ vitest 346/346（40 文件） |
| agent-web lint | ⚠️ 3 errors / 5 warnings，均在 `WorkflowNodeTree.tsx` 等**不在本 PR diff 内**的文件，为存量问题，非本分支引入 |
| API 测试（tests/api） | ⚠️ 未执行（需 MongoDB/Redis 环境）；静态评审确认 helper 签名与实现一致可跑通，但 A7/A8/A10 断言空转（问题 9） |
| E2E 测试（tests/e2e） | ⚠️ 未执行；静态评审确认选择器与实现匹配，但 E2E-2/3/4/5 断言不完整（问题 9） |

## 修复记录（2026-08-17 第一轮修复）

修复方案：[[20260817-fix-session-lifecycle-worktree-acceptance]]（docs/engineering/proposals/20260817-fix-session-lifecycle-worktree-acceptance.md）

### 修复总览

| # | 问题 | 根因 | 状态 | 修复 commit |
|---|------|------|------|------------|
| 1 | workspaceWorktrees sessions 返回 lean 文档序列化必炸 | 绕过 mapSession 直出 Date 对象 | ✅ 已修复（复用 mapSession + 单测） | b7de271 |
| 2 | acp:reconcile 服务端从未下发 | register 路径无对账逻辑；离线 stop 不写 pending | ✅ 已修复（register 下发 reconcile + 离线写 pending + 补做测试） | 6e6966d |
| 3 | fs:remove-dir 可删任意目录 | 三层均黑名单且不含家目录 | ✅ 已修复（agent-api 归属校验 b7de271 + controller 白名单 055107a + 契约统一 354ca11） | b7de271 / 055107a / 354ca11 |
| 4 | existingWorktreePath+suffix 误删共享 worktree | 复用路径也写 worktreeBranch，清理条件命中 | ✅ 已修复（复用路径不写 worktreeBranch） | b7de271 |
| 5 | deleteWorktree 目录删除失败被静默为成功 | success 不看 removeError；fs 兜底成功不清错误 | ✅ 已修复（success=failures 空 && removeError 空） | b7de271 |
| 6 | ProcessRegistry 跨文件系统 EXDEV 可 crash controller | tmpdir()+renameSync 跨设备；flush 无容错 | ✅ 已修复（同目录临时文件 + try/catch + 真实 fs 集成测试） | 055107a |
| 7 | 正常 stop 不注销注册表，PID 复用误杀窗口 | deregister 未挂主路径；SIGKILL 无探活 | ✅ 已修复（bridge stopped 统一出口 deregister + kill(pid,0) 探活） | 055107a |
| 8 | Windows spawn .cmd 无 shell 必 EINVAL | resolveWindowsCommand 仍返回 .cmd | ✅ 已修复（.cmd/.bat 保留 shell，.exe 直启；修正固化测试） | 055107a |
| 9 | 新增测试断言空转 | 标题承诺≠断言内容 | ✅ 已修复（A7/A8/A10、E2E-2/3/4/5 补真实断言） | a3a137a |
| 10 | workspaceWorktrees 未按 workspace 过滤 | 查询条件缺 workspace 维度、未排除 ended | ✅ 已修复（路径集合过滤 + 排除 ended + create 归属校验） | b7de271 |
| 11 | creating/connecting 不发 acp:stop | needsStop 状态列表收窄过度 | ✅ 已修复 | b7de271 |
| 13 | waitForStopAck 消费陈旧 ack | 同 key 无操作标识 | ✅ 已修复（stop 前清陈旧 ack key） | b7de271 |
| 14 | once 监听被同 socket 其他 ack 消耗 | once 无 sessionId 守卫 | ✅ 已修复（on + sessionId 校验 + 手动移除） | 6e6966d |
| 21 | 查询失败静默吞，worktree 会话消失 | return null 无回退 | ✅ 已修复（回退平铺展示） | af93a52 |
| 22 | 删除中可 ESC/遮罩关闭弹框 | onOpenChange 无守卫 | ✅ 已修复 | af93a52 |
| 23 | failures 明细不展示 | toast 只看 success/error | ✅ 已修复 | af93a52 |
| 25 | 互斥错误返回 INTERNAL_SERVER_ERROR | 普通 Error 未带 code | ✅ 已修复（BAD_USER_INPUT + resolver 透传） | b7de271 |
| 26 | 删除成功未跳转首页 | 无路由处理 | ✅ 已修复（被删 worktree 的会话页跳回首页） | af93a52 |
| 27 | 契约小节重号/黑白名单矛盾/归属错位 | 文档维护缺失 | ✅ 已修复 | 354ca11 |
| 34 | ack 超时窗口不对齐、TTL 30s≠提案 60s | 双侧常量漂移 | ✅ 已修复（5s×2≈10s 对齐 agent-api，TTL 60s） | 6e6966d |
| 35 | handleControllerStopped 无条件 ended 抖动 | 无状态守卫 | ✅ 已修复（connecting 中不落 ended） | 6e6966d |
| 36 | 预选择模式不展示目标 worktree 路径 | UI 缺失 | ✅ 已修复 | af93a52 |
| 37 | workspaceName 死参数 | 传入未使用 | ✅ 已修复（用于弹框文案） | af93a52 |
| 38 | reconcile/acp:stop payload 无类型校验 | 入口无守卫 | ✅ 已修复 | 055107a |
| 39 | unlinkSync 未使用导入；EPERM 误判死进程 | 实现疏漏 | ✅ 已修复 | 055107a |
| 41 | 停机不注销注册表、无 TERM→KILL 升级 | 与 acp:stop 语义不一致 | ✅ 已修复 | 055107a |

### 修复轮次新发现问题（已修复）

- **WorktreeSidebarGroup 下拉菜单死按钮**：`DropdownMenuItem` 误用 `onSelect`（Base UI `Menu.Item` 仅支持 `onClick`），「新建会话」「实例化工作流」永不开火——E2E-3 补齐真实流程后暴露，已修复（af93a52）。

### 跟进项（本轮未处理）

- ~~**SessionView 删除存活会话可能绕过 stop-ack 生命周期**（`SessionView.tsx:287` 仅凭 `externalSessionId` 非空走 `deleteHistorySession`）~~ → **已在第二轮修复闭环**，见下方「修复记录（2026-08-18 第二轮）」。
- 一般项 #12/#15/#16/#17/#18/#19/#20/#24 与建议项 #28-#33/#42 未在本轮范围，按方案 §1.3 留待后续。

## 修复记录（2026-08-18 第二轮：删除存活会话 ACP 进程泄漏）

人工复验发现：**新建会话后直接点击「删除」，ACP 进程被保留；点击「关闭」则进程正常结束**。

修复方案：[[20260818-fix-delete-session-acp-process-leak]]（docs/engineering/proposals/20260818-fix-delete-session-acp-process-leak.md）

### 根因

| # | 根因 | 位置 |
|---|------|------|
| R1 | 前端对任何初始化成功的会话（有 `externalSessionId`）走 `deleteHistorySession`，该 mutation 只删库 + 同步 agent 历史，从不发送 `acp:stop` → 存活 ACP 进程泄漏；「关闭」走 `closeSession` 正常停进程 | `SessionView.tsx:287`、`session-import.ts:87` |
| R2 | creating/connecting 窗口内删除时，controller-api `stopSessionWithAck` 因 sessions 映射未写入（要等 `acp:start:result` 成功）误入「离线 pending」分支，pending 仅在重连时消费，在线永不补做 → 进程泄漏 | `acp-session-manager.ts:826`、`session-command.ts`（Redis 订阅回调 async 不串行） |

### 修复内容

| 文件 | 修改 |
|------|------|
| `servers/agent-api/src/services/session-import.ts` | `deleteHistorySession` 对非 ended 会话先委托 `sessionService.delete()`（acp:stop + 等 ack + worktree 清理 + MCP 撤销 + 删库），再做 agent 历史同步；running 拒绝守卫不变 |
| `servers/controller-api/src/services/acp-session-manager.ts` | 新增 `startingSessions` 在途跟踪（start/resume 登记，finally 结算）；`stopSessionWithAck` 未命中映射时先等在途 start/resume 结算再重查，命中走正常 stop |
| `servers/controller-api/src/services/session-command.ts` | 同一 sessionId 的 `acp:start`/`acp:resume`/`acp:stop` 按到达顺序串行处理（per-session promise 链），消除 stop 先于 start 进入 manager 的残留窗口 |
| `apps/agent-web` | 不改（deleteHistorySession 语义修正后现有路由即正确） |

### 新增/更新测试

- `session-import.test.ts`：connecting/idling 会话委托 `sessionService.delete`（不再直接 deleteOne）；idling 会话删除仍同步 agent 历史。
- `acp-session-manager.test.ts`：start 在途时收到 stop → 等待 start 结算后正常下发 `acp:stop(ackRequired)`，不写 pending。
- `session-command.test.ts`：同会话 acp:start 未结算时 acp:stop 不提前调用 stopSession，start 结算后按序执行。
- API 测试：两个 deleteHistorySession 用例补「先收 acp:stop 再收 acp:delete-history-session」断言；close→resume 类用例的 fake controller 补 acp:stop ack（串行化后未 ack 的 stop 会阻塞后续 resume，真实 controller 总会 ack）。

### 验证结果（第二轮）

| 项目 | 结果 |
|------|------|
| agent-api 单测 | ✅ 543/543（38 文件；session-import 新增/更新 2 用例） |
| controller-api 单测 | ✅ 396/396（36 文件；新增 start 在途 stop、生命周期串行化 2 用例） |
| agent-controller 单测 | ✅ 351/351（27 文件，无改动回归） |
| agent-web 单测 | ✅ 358/358（43 文件，无改动回归） |
| 各子项目 build | ✅ tsc strict / vite 全部通过 |
| API 测试（tests/api，Aspire 真实 Mongo/Redis） | ✅ 308/308（含 deleteHistorySession 先 stop 后同步的新断言） |
| E2E 测试（tests/e2e，Playwright 全套） | ✅ 177/177 |

## 修复记录（2026-08-18 第三轮：删除 Worktree 误删根工作区）

人工复验发现：**删除 worktree 时把根工作区（仓库本体）也删除了，本地 .git 丢失**——严重数据丢失。

修复方案：[[20260818-fix-worktree-delete-root-workspace]]（docs/engineering/proposals/20260818-fix-worktree-delete-root-workspace.md）

### 根因（三层失守）

1. `git worktree list --porcelain` 首条即主工作区（仓库根），`worktreeService.list()` 未过滤 → 根目录作为可删 worktree 展示且通过 `deleteWorktree` 的 list 校验（`worktree.ts`）。
2. `git worktree remove --force <根>` 被 git 拒绝（main working tree）→ 进入 `fs:remove-dir` 兜底。
3. controller 端 `acp:start`/`acp:resume` 无条件 `fsHandler.registerAllowedPath(data.cwd)`，普通会话 cwd 即仓库根 → 根目录早在 `fs:remove-dir` 白名单内 → `rmSync(根, recursive)` 执行。

### 修复内容

| 文件 | 修改 |
|------|------|
| `servers/agent-api/src/services/worktree.ts` | ① `list()` 过滤主工作区（归一化比较 `wt.path === workspace.path`）；② `deleteWorktree` 显式拒绝根路径（`BAD_USER_INPUT`），先于 list 校验，不发出任何删除命令 |
| `packages/agent-controller/src/fs-handler.ts` | ③ `removeDir` 拒绝删除「`.git` 为目录」的路径（主工作区特征；linked worktree 的 `.git` 是普通文件不受影响）——与路径无关的最后一道防线 |

### 新增测试

- agent-api `worktree.test.ts`：list 过滤主工作区；deleteWorktree 根路径拒绝（无 git/fs 命令发出）。
- agent-controller `tests/fs-handler.test.ts`（新建，真实 fs）：`.git` 目录路径拒绝且目录完整；`.git` 文件路径（linked worktree）正常删除；未注册路径拒绝。

### 验证结果（第三轮）

| 项目 | 结果 |
|------|------|
| agent-api 单测 | ✅ 545/545（38 文件，+2） |
| agent-controller 单测 | ✅ 354/354（28 文件，+3 真实 fs 用例） |
| controller-api / agent-web 单测 | ✅ 396/396、358/358（本轮无改动，沿第二轮结果） |
| 各子项目 build | ✅ tsc strict 通过 |
| API 测试（tests/api） | ✅ 308/308 |
| E2E 测试（tests/e2e） | ✅ 177/177（`session-message.spec.ts` tool_call 高亮用例首跑失败、单文件重跑 6/6 通过，确认为与本次改动无关的动画时序抖动） |

## 修复记录（2026-08-18 第四轮：agent-workflow-admin-tools 默认启用）

人工复验发现：**`agent-workflow-admin-tools` 似乎不会默认启用**。

修复方案：[[20260818-fix-admin-tools-default-available]]（docs/engineering/proposals/20260818-fix-admin-tools-default-available.md）

### 根因

平台服务文档按 `{userId, name}` 隔离，由 `ensureAdminToolsServer(userId)` 幂等 upsert（`admin-tools.ts:461`），但该函数**只在 orchestrator 拉起 AI 节点会话时惰性调用**（`orchestrator.ts:84`）；二期提案承诺的「随系统启动幂等 upsert」从未实现。从未跑过工作流的用户，MCP Registry 与新建会话对话框的 MCP 选择器里根本不存在该服务——PRD 功能点 4「工作流管理工具集作为独立 scope 注册，可装配到普通会话」不成立。

### 修复内容

| 文件 | 修改 |
|------|------|
| `servers/agent-api/src/graphql/resolvers/mcp-server.ts` | `Query.mcpServers` 查询前 `await ensureAdminToolsServer(userId)`（读路径幂等注册，覆盖存量与未来用户；启动时 upsert 无法覆盖未来注册用户，注册时 upsert 无法覆盖存量用户） |

前端无需改动（`McpRegistrySection` 已有「平台内置」badge；`NewSessionDialog` 按 `enabled` 过滤后自然出现该选项）。`agent-workflow-tools` 维持节点作用域设计不变。

### 新增/更新测试（状态语义演进回填断言）

- agent-api `resolvers/mcp-server.test.ts`：mcpServers 查询调用 `ensureAdminToolsServer(userId)`；未认证不调用。
- API `mcp-server.test.ts`：原「authenticated 返回空列表」回填为「默认包含平台内置 agent-workflow-admin-tools（enabled/source/transport=platform）」。
- E2E `settings-mcp-proxy.spec.ts`：原「MCP Servers 空状态」回填为「新用户默认展示 agent-workflow-admin-tools（平台内置）」；key 列表 active 断言限定行内（新默认条目也带 active badge，原全局选择器 strict 冲突）。

### 验证结果（第四轮）

| 项目 | 结果 |
|------|------|
| agent-api 单测 | ✅ 546/546（38 文件，+1） |
| 其余子项目单测/build | ✅ 本轮无改动，沿第三轮结果；agent-api tsc strict 通过 |
| API 测试（tests/api） | ✅ 308/308 |
| E2E 测试（tests/e2e） | ✅ 177/177（三轮全套各 1 个不同用例单次失败——session-message 高亮、mcp-session 注册、permission 审批——单文件重跑均全绿，确认为全量负载下的时序抖动，与本改动无关） |

## 修复记录（2026-08-18 第五轮：节点 resume 路径 mode/model 时序）

人工复验质疑：**轮到新节点时 setModel/setMode 指令可能没发过去就开始执行 prompt，时序是否受控**。

修复方案：[[20260818-fix-resume-mode-model-sequencing]]（docs/engineering/proposals/20260818-fix-resume-mode-model-sequencing.md）

### 根因

- **create 路径时序本就受控**：modeId/modelId 随 `acp:start` 带内下发，bridge 在 `acp:initialized` 之前应用，prompt 在 `acp:start:result` 成功后才从 pendingInputs 补发。
- **resume 路径（reworkNodeSession / handleSessionEnded 兜底）时序不受控**，全链路四段缺失：① `sessionService.resume` 的 acp:resume 发布不带 modeId/modelId；② orchestrator 补救用的 `applyAgentConfig`→`setMode/setModel` 有 `status !== 'idling'` 守卫，resume 发起时状态为 ended/connecting → **静默丢弃、从未生效**；③ controller-api resumeSession 的 socket payload 不含 mode/model；④ controller 端 acp:resume handler 不传 initialModeId/initialModelId 且 `bridge.resume()` 不调用 `applyInitialModeModel()`。

### 修复内容

| 文件 | 修改 |
|------|------|
| `servers/agent-api/src/services/session.ts` | `resume()` 支持可选 `initial: { modeId, modelId }`，随 acp:resume 带内发布 |
| `servers/agent-api/src/services/workflow/orchestrator.ts` | reworkNodeSession / handleSessionEnded 以节点配置调 resume；删除恒为 no-op 的 `applyAgentConfig` 死调用（start/rework 两处） |
| `servers/controller-api/src/services/acp-session-manager.ts` | `resumeSession` 支持 initial 参数，modeId/modelId 写入 acp:resume payload |
| `servers/controller-api/src/services/session-command.ts` | `handleAcpResume` 透传 modeId/modelId |
| `packages/agent-controller/src/socketio-client.ts` | `AcpResumePayload` 增加 modeId/modelId；acp:resume handler 传 initialModeId/initialModelId |
| `packages/agent-controller/src/acp/bridge.ts` | `resume()` 两个分支（resumeSession 成功 / newSession fallback）在 emit `acp:initialized` 前 `applyInitialModeModel()` |
| `contracts/agent-session-websocket.md` | §2.11 acp:resume payload 增加 modeId/modelId 可选字段 + 客户端行为第 6 步（result 前应用初始 mode/model） |

### 新增/更新测试

- agent-api `session.test.ts`：resume 传 initial → acp:resume 含 modeId/modelId；不传 → 不含。
- agent-api `orchestrator.test.ts`：rework 以节点配置调 resume（不再调 setMode/setModel）；兜底 resume 第三参断言。
- controller-api `acp-session-manager.test.ts`：acp:resume payload 含 modeId/modelId；`session-command.test.ts`：acp:resume 命令透传（manager mock 补 resumeSession）。
- agent-controller `bridge.test.ts`：resume 两个分支均在 acp:initialized 前应用初始 mode/model（调用顺序断言）。

### 验证结果（第五轮）

| 项目 | 结果 |
|------|------|
| 四子项目单测 | ✅ agent-api 548/548、controller-api 400/400、agent-controller 358/358、agent-web 358/358（无改动） |
| 各子项目 build | ✅ tsc strict 全部通过 |
| API 测试（tests/api） | ✅ 308/308 |
| E2E 测试（tests/e2e） | ✅ 177/177（本轮全套 2 个用例单次失败——permission 弹窗、github binding toast——单跑 16/16 全绿，同为与改动无关的时序抖动） |

### 最终验证（修复后）

| 项目 | 结果 |
|------|------|
| agent-api 单测 | ✅ 543/543（38 文件，基线 528 + 新增 15） |
| controller-api 单测 | ✅ 392/392（36 文件） |
| agent-controller 单测 | ✅ 351/351（27 文件，基线 304 + 新增 47，含真实 fs 集成测试） |
| agent-web 单测 | ✅ 358/358（43 文件，基线 346 + 新增 12） |
| agent-web lint | ✅ 本分支涉及文件 0 error（存量 3 errors 在 WorkflowNodeTree.tsx 等非 diff 文件，未新增） |
| 各子项目 build | ✅ tsc strict / vite 全部通过 |
| API 测试（tests/api，Aspire 环境真实 Mongo/Redis） | ✅ 308/308（含补齐断言的 A7/A8/A10） |
| E2E 测试（tests/e2e，Playwright 全套） | ✅ 177/177（含补齐断言的 E2E-2/3/4/5，E2E-3 随 onSelect→onClick 修复转绿） |

## 结论

**验收不通过。** 3 个阻塞问题（主查询路径序列化必炸、reconcile 对账断头路、任意目录删除）与 7 个严重问题（共享 worktree 误删、删除结果语义错误、注册表 EXDEV、PID 误杀窗口、Windows 启动失败、测试空转、跨 workspace 数据错挂）必须在合入 release 前修复；一般与建议项可随修复轮次一并处理。修复后需补跑 API/E2E 全套（含补齐的真实断言）方可验收通过。

> **2026-08-17 更新**：第一轮修复已完成，全部阻塞/严重问题闭环，单测/API/E2E 全绿，详见上方「修复记录」。

## 经验总结

- **「文档承诺的安全模型」必须与实现逐字核对**：本特性 PRD/提案/计划/契约四处都写了路径白名单，实现却是黑名单且不含家目录——四处文档互相印证也无法替代对实现的核查；契约内部自相矛盾（同节既说黑名单又说白名单）是强信号。
- **链路类机制要验证「另一端真的存在」**：stop-ack/pending-list/reconcile 三段设计中，客户端 handler、Redis 写入都就位，唯独服务端下发缺失——单个环节各自测试通过，整条链路却是断头路。链路验收必须做端到端走查（grep 事件名双侧出现）。
- **GraphQL 嵌套对象复用必须走统一 mapper**：lean 文档直出绕过了 Date→String 序列化，单测（mock 层）与 API 测试（fake controller 路径）恰好都绕过了该路径——嵌套字段的序列化问题只有真实 resolver 集成测试能暴露。
- **测试标题即承诺**：A7/A8/A10、E2E-2/5 的标题与计划承诺一致、断言却恒通过——评审测试时应对照计划逐条核对断言内容，「测试存在且通过」不等于「行为被验证」。
- **落盘原子写的临时文件必须与目标同目录**：`tmpdir()` + `renameSync` 跨文件系统必崩，且全 mock 的单测永远发现不了——文件系统语义相关的代码需要至少一个不 mock 的集成测试。
