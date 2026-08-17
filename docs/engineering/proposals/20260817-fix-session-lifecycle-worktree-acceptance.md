---
description: 会话生命周期与 Worktree 管理验收问题修复方案（3 阻塞 + 7 严重 + 关联一般项）
type: Permanent
---

# 会话生命周期与 Worktree 验收问题修复 - 技术方案

**功能名称**: 会话生命周期与 Worktree 管理验收问题修复
**关联 PRD**: docs/product/draft/20260817-session-lifecycle-and-worktree-management.md
**关联验收报告**: docs/engineering/acceptance/20260817-session-lifecycle-and-worktree-acceptance-report.md
**feat-branch**: `integration`（PR #173 → release，基线提交 5404086）
**创建日期**: 2026-08-17
**作者**: ZeroAsh

## 1. 概述

### 1.1 背景

integration → release 合并前 AI 验收不通过：3 个阻塞 + 7 个严重问题，另有 17 个一般项与 15 个建议项。本方案覆盖**全部阻塞与严重问题（#1-#10）**，并顺带处理与修复面直接相邻的一般项（#11/#13/#14/#17/#19/#21/#22/#23/#25/#26/#27/#34/#35/#36/#37/#38/#39/#40/#41），建议项及独立性较强的一般项（#12/#15/#16/#18/#20/#24/#28-#33/#42）留待后续轮次。

### 1.2 目标

- 修复验收报告 #1-#10，主查询路径、reconcile 对账链路、目录删除安全模型全部闭环。
- 按 TDD：先补失败用例（红），再修实现（绿），四个子项目单测全绿。
- API/E2E 空转断言补齐真实断言，全量测试通过。

### 1.3 范围

| 子项目 | 问题 |
|--------|------|
| servers/agent-api | #1（mapSession 序列化）、#3a（deleteWorktree 路径归属校验）、#4（复用 worktree 不写 worktreeBranch）、#5（deleteWorktree success 语义）、#10（会话按 workspace 过滤）、#11（creating/connecting 也发 stop）、#13（ack 陈旧消费）、#25（BAD_USER_INPUT） |
| servers/controller-api | #2（acp:reconcile 下发 + pending 补做）、#14（once 误消费 ack）、#34（ack 超时窗口对齐）、#35（stopped 无条件 ended） |
| packages/agent-controller | #3c（fs:remove-dir 白名单）、#6（EXDEV）、#7（deregister + PID 复用探活）、#8（Windows .cmd EINVAL）、#38-#41（payload 校验/注册表清理/停机注销） |
| apps/agent-web | #21（查询失败静默吞）、#22（删除中可关闭弹框）、#23（failures 明细展示）、#26（删除后跳转首页）、#36（预选择展示路径）、#37（死参数） |
| contracts | #27（小节重号 + 黑白名单表述统一 + workspaceWorktrees 归属） |
| tests/api + tests/e2e | #9（A7/A8/A10、E2E-2/3/4/5 真实断言） |

## 2. 修复方案

### 2.1 agent-api（servers/agent-api）

**#1 worktree.ts `workspaceWorktrees` sessions 序列化**
- `services/worktree.ts:96` 不再展开 lean 文档，复用 session 服务的 `mapSession`（从 `services/session.ts` 导出或经公共映射函数调用），保证 `createdAt/updatedAt` 为 ISO String。
- 单测：worktreeService 归并路径返回的 session 字段为 String 类型。

**#3a deleteWorktree 路径归属校验**
- `deleteWorktree` 校验 `worktreePath` 必须等于 `workspace.path` 的 worktreeDir 子路径，或属于 `list()` 归集结果中的已知 worktree 路径；否则抛 `BAD_USER_INPUT`。

**#4 复用 worktree 不写 worktreeBranch**
- `services/session.ts:74-76`：传入 `existingWorktreePath` 时不写 `worktreeBranch`（该会话非 worktree 属主）；`delete()` 清理条件 `worktreePath && worktreeBranch` 自然不再命中共享 worktree。
- 单测：existingWorktreePath + worktreeBranchSuffix 组合创建后会话无 worktreeBranch，delete 不触发 git:worktree:remove。

**#5 deleteWorktree success 语义**
- fs 兜底成功时清空 `removeError`；`success = failures.length === 0 && removeError === null`。
- 单测：git remove 失败 + fs 兜底成功 → success=true 且 error=null；兜底也失败 → success=false。

**#10 workspaceWorktrees 会话过滤**
- Session 查询按 worktree 路径前缀限定本 workspace 管理范围（worktreePath 以该 workspace 归集的 worktree 路径集合过滤），并排除 `status: 'ended'`；`sessionCount` 同步修正。
- `createSession` 校验 `existingWorktreePath` 归属该 workspace（属于其 worktreeDir 之下），否则 `BAD_USER_INPUT`。

**#11 creating/connecting 也发 acp:stop**
- `delete()` 对 `creating`/`connecting` 状态会话恢复发送 `acp:stop`（走 stopSessionWithAck，容忍 controller 不在线）。

**#13 waitForStopAck 陈旧 ack**
- ack key 携带操作标识（如 stop 请求发起时生成的 nonce/ts），waitForStopAck 只消费本次请求之后的 ack；最简实现：发起前删除旧 key，ack 值带时间戳并校验不早于发起时间。

**#25 互斥参数错误码**
- `existingWorktreePath`+`enableWorktree` 互斥错误抛带 `code: 'BAD_USER_INPUT'` 的 GraphQLError。

### 2.2 controller-api（servers/controller-api）

**#2 acp:reconcile 下发**
- controller `register`/重连时：读取该 controller 活跃会话（sessions Map）+ Redis `acp:stop:pending:{controllerId}` list，emit `acp:reconcile { activeSessionIds, pendingKillSessionIds }`。
- `stopSessionWithAck` 未命中 sessions Map（controller 离线）时也写 pending list。
- 补「离线删除 → 重连 reconcile 补做」单测。

**#14 once 误消费 ack**
- `stopSessionWithAck` 监听 ack 时校验事件 payload 的 sessionId 匹配目标会话，不匹配不结算（改 `on` + 手动移除，或 once 内判断后重挂）。

**#34 ack 超时窗口对齐**
- controller-api 单次 ack 等待与 agent-api 等待窗口对齐（agent-api 10s × 重试策略与 controller-api 保持一致）；ack TTL 按提案统一为 60s。

**#35 handleControllerStopped 状态抖动**
- 收到 `acp:stopped` 时若会话正处于 stop-pending/删除流程或随后立即 resume，避免无条件置 `ended` 的抖动：仅在会话当前状态非 `idling` 目标转移时落 `ended`，resume 路径以 resume 结果为准。

### 2.3 agent-controller（packages/agent-controller）

**#3c fs:remove-dir 白名单**
- `fs-handler.ts isPathSafe` 改白名单：仅允许 controller 已注册 worktree 路径集合（ProcessRegistry/会话上下文持有的 worktreePath）及其子路径；显式拒绝 `/`、homedir、cwd、Windows 系统盘关键路径。纵深防御。

**#6 ProcessRegistry EXDEV**
- 临时文件写入 `REGISTRY_DIR`（`~/.zag`）内再 renameSync（同目录原子）；`flush()` 加 try/catch 容错。
- 补一个不 mock fs 的真实文件系统集成测试。

**#7 deregister + PID 复用**
- bridge `emitStopped` 统一出口处 deregister（注册表与 bridge 生命周期绑定）；两处 5s 后 SIGKILL 前 `kill(pid, 0)` 探活。

**#8 Windows .cmd EINVAL**
- win32 解析到 `.cmd`/`.bat` 时保留 `shell: true`（或 `cmd.exe /c` 包裹）；解析到真实 `.exe` 时无 shell 直启。修正 `tests/acp-spawner.test.ts:224-233` 预期。

**#38-#41**
- reconcile/acp:stop handler 入口校验 payload 类型（sessionIds 为 string[]），非法直接忽略并 warn。
- process-registry：移除未使用的 `unlinkSync` 导入；`isProcessAlive` EPERM 视为存活（无权信号 ≠ 死进程）。
- `index.ts` 停机路径注销注册表条目（与 acp:stop 的 TERM→KILL 语义对齐）。

### 2.4 agent-web（apps/agent-web）

- **#21** `WorktreeSidebarGroup`：`workspaceWorktrees` 查询失败时回退为平铺展示会话（release 版行为），不静默吞错。
- **#22** `DeleteWorktreeConfirmDialog`：删除进行中禁止 ESC/遮罩关闭。
- **#23** failures 明细展示：`success=false` 或 `failures.length>0` 时 toast 包含失败明细；`success=true && failures.length>0` 按部分失败提示。
- **#26** 删除成功后按提案跳转回首页（navigate('/')）。
- **#36** `NewSessionDialog` 预选择模式展示目标 worktree 路径。
- **#37** 移除未使用的 `workspaceName` prop（或实际用于弹框文案）。
- 前端组件补单测（参照项目组件测试惯例）。

### 2.5 契约（contracts/）

- `agent-session-websocket.md`：新增小节重编号（2.16-2.19 → 不与 git:status 的 2.16 冲突）；`fs:remove-dir` 节统一为**白名单**表述（与修复后实现一致）。
- `workspaceWorktrees`/`deleteWorktree` 契约从 `agent-session.graphql` 移至 `controller-workspace.graphql`（与实现归属一致）。

### 2.6 测试补齐（#9）

- **A7**：fake controller 注入部分失败（某会话 acp:stop 不 ack / remove 失败），断言 `success=false`、error 非空、失败明细含该会话。
- **A8**：真实多节点工作流实例删除，断言所有节点会话均被清理（deleteWorkflowInstance multi-node cleanup）。
- **A10**：真实 rework 流程（completeRework → 节点会话关闭重建），断言 `engine.ts:212-228` 修复行为。
- **E2E-5**：除 DB 删除外，断言 fake controller 收到 `acp:stop` 且进程句柄不存在。
- **E2E-2/3/4**：补展开后会话断言、新建会话归组流程、确认删除路径。

## 3. 测试策略

### 3.1 单元测试（vitest，各子项目）

- agent-api：worktreeService（#1/#5/#10）、sessionService（#4/#11/#13/#25）。
- controller-api：acp-session-manager（#2 reconcile 下发/pending 补做、#14、#34、#35）。
- agent-controller：fs-handler 白名单（#3c）、process-registry 真实 fs 集成（#6）、deregister/探活（#7）、spawner Windows（#8）。
- agent-web：worktree 组件（#21/#22/#23/#26/#36）。

### 3.2 API / E2E

按 z-test 流程：环境编排（aspire 或 docker-compose）→ 串行执行 tests/api 全量 → tests/e2e 全量（E2E 与 API 不并行，见 common-rules 测试陷阱）。

## 4. 验收标准

- [x] 四个子项目单测全绿（含新增用例）
- [x] API 测试全量通过（含补齐断言的 A7/A8/A10）
- [x] E2E 测试全量通过（含补齐断言的 E2E-2/3/4/5）
- [x] 阻塞 #1-#3、严重 #4-#10 逐条闭环，验收报告回填修复 commit

## 5. 最终验证结果

| 项目 | 结果 |
|------|------|
| agent-api 单测 | ✅ 543/543（commit b7de271） |
| controller-api 单测 | ✅ 392/392（commit 6e6966d） |
| agent-controller 单测 | ✅ 351/351（commit 055107a，含真实 fs 集成测试） |
| agent-web 单测 / build / lint | ✅ 358/358；vite build 通过；涉及文件 0 lint error（commit af93a52） |
| 契约修复 | ✅ 354ca11（重编号 + 白名单统一 + 归属迁移） |
| API 测试（Aspire 环境） | ✅ 308/308（commit a3a137a） |
| E2E 测试（Playwright 全套） | ✅ 177/177（commit a3a137a） |

**修复轮次新发现并修复**：WorktreeSidebarGroup 下拉菜单 `onSelect`→`onClick`（Base UI Menu.Item 无 onSelect，菜单项死按钮），由 E2E-3 真实流程暴露。

**遗留跟进**：SessionView 删除存活会话走 `deleteHistorySession` 绕过 stop-ack 生命周期——release 存量行为（非本 PR 引入），建议另立轮次；一般项 #12/#15-#20/#24、建议项 #28-#33/#42 未处理。

## 6. 相关文档

- 验收报告：[[20260817-session-lifecycle-and-worktree-acceptance-report]]
- 技术方案：[[20260817-feat-session-lifecycle-and-worktree-management]]
