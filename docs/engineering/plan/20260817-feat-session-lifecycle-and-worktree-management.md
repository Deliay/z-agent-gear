---
description: 会话生命周期与 Worktree 管理增强 - 实现计划（从技术提案拆解的分阶段可执行任务与测试覆盖计划）
type: Permanent
---

# 会话生命周期与 Worktree 管理增强 - 实现计划

**关联 Proposal**: `proposals/20260817-feat-session-lifecycle-and-worktree-management.md`（v1.2）
**关联 PRD**: `docs/product/draft/20260817-session-lifecycle-and-worktree-management.md`
**feat-branch**: `feat/session-lifecycle-worktree`
**创建日期**: 2026-08-17

## 实现顺序

```
Phase 1: 契约更新（contracts/）
  ├── Phase 2: agent-controller（ProcessRegistry + 进程组 kill + worktree/fs 事件 + 对账）
  ├── Phase 3: controller-api（acp:stop 送达保证 + start/resume dispatcher 并发修复）
  └── Phase 4: agent-api（删除顺序修正 + WorktreeService + GraphQL + 两个 bug 修复）
       └── Phase 5: agent-web（侧边栏 Worktree 层级 + 添加/删除入口）
            └── Phase 6: API 测试（tests/api）
                 └── Phase 7: E2E 测试（tests/e2e）
```

依赖说明：Phase 1 契约先行，是后续所有阶段的输入；Phase 2/3/4 三个后端子项目契约对齐后可并行开发（各委托一个 subagent，遵循 `z-coding` 的子项目并行实现模式）；Phase 5 前端依赖 Phase 4 的 GraphQL 可运行；测试阶段在全部实现完成后推进。开发模式采用 TDD（红-绿-重构）：每个 Phase 先写/补测试再实现。

---

## Phase 1: 契约更新

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/agent-session.graphql` | 修改 | 新增 `WorkspaceWorktree` 类型、`workspaceWorktrees` 查询、`deleteWorktree` mutation（含 `DeleteWorktreeResult`/`WorktreeDeleteFailure`）；`CreateSessionInput` 增加 `existingWorktreePath`（与 `enableWorktree` 互斥） |
| `contracts/controller-workspace.graphql` | 修改 | `ControllerWorkspace` 增加 `isGitRepo: Boolean` |
| `contracts/agent-session-websocket.md` | 修改 | 新增 `git:worktree:list`、`fs:remove-dir` 事件；`git:worktree:remove` 增加 `force` 参数；`acp:stop` 增加 ack/离线补发语义 |
| `contracts/agent-controller-websocket.md` | 修改 | 新增重连对账事件 `acp:reconcile`（`activeSessionIds` + `pendingKillSessionIds`）；`acp:stopped` ack 事件 |

### 验证

- [ ] 契约与提案 §3.1/§3.2 一致，评审通过

---

## Phase 2: agent-controller

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/acp/process-registry.ts` | 新增 | `~/.zag/processes.json` 持久化注册表：register/deregister/list，tmp+rename 原子写，启动时 PID 校验（cwd + startedAt 防 PID 复用误杀） |
| `packages/agent-controller/src/acp/spawner.ts` | 修改 | POSIX `detached: true` 进程组 spawn；`stop()` 先 `kill(-pid, SIGTERM)`、5s 后 `SIGKILL`；Windows 去掉 `shell: true`，改用 `taskkill /PID /T /F`（失败降级 `process.kill`）；spawn 时注册 PID，exit 时注销 |
| `packages/agent-controller/src/acp/bridge.ts` | 修改 | `stop()` 的 `cancel()`/`closeSession()` 包 5s 超时（`Promise.race`），超时直接走 spawner.stop() |
| `packages/agent-controller/src/worktree-handler.ts` | 修改 | 新增 `list()`（`git worktree list --porcelain` 解析）；`remove` 支持 `force` 参数（`--force`，不做 commit 暂存） |
| `packages/agent-controller/src/fs-handler.ts` | 修改 | 新增 `removeDir()`：`fs.rm(path, {recursive, force})`，路径白名单校验（仅 worktreeDir 下或已注册 worktree 路径） |
| `packages/agent-controller/src/socketio-client.ts` | 修改 | `acp:stop` bridge 未命中时查注册表按 PID 强杀并回 `acp:stopped {killed}` ack；注册 `acp:reconcile`（杀 pendingKill + 收割不在 activeSessionIds 的孤儿）、`git:worktree:list`、`fs:remove-dir` 事件 |
| `packages/agent-controller/src/index.ts` | 修改 | daemon 收到 SIGINT/SIGTERM 时先遍历注册表 kill 全部进程组再退出 |
| `packages/agent-controller/src/acp/process-registry.test.ts` 等 | 新增/修改 | 注册/注销/原子写/PID 校验；spawner 进程组 kill 参数；路径白名单校验 |

### 命令参考

```bash
cd packages/agent-controller && npm run build && npm run test
```

### 验收 checklist

- [ ] 单测通过；进程组 kill 覆盖 POSIX/Windows 两条路径（Windows 分支以参数断言覆盖）
- [ ] 注册表文件损坏/不存在时降级安全，不阻塞启动

---

## Phase 3: controller-api

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/controller-api/src/services/acp-session-manager.ts` | 修改 | ① `startSession`/`resumeSession` 的 per-call `socket.once('acp:start:result')` 改为「每 socket 常驻 dispatcher + `Map<requestId, PendingRequest>` 路由」：命中才 clearTimeout+resolve，未命中仅记日志，socket 断开统一失败处理；② `stopSession` 发 `acp:stop(ackRequired)` 后等 `acp:stopped` ack（10s），超时重发一次，controller 离线时追加 `acp:stop:pending:{controllerId}`；③ 审计其它 `once` 等待点消除同类竞态 |
| `servers/controller-api/src/services/session-command.ts` | 修改 | `acp:stopped` 回传写 Redis（`acp:stop:ack:{sessionId}`）；controller 重连注册后下发 `acp:reconcile` 并补发 pending 列表 |
| `servers/controller-api/src/socketio.ts` | 修改 | socket 级 no-op handler 注释路径与 dispatcher 对齐 |
| 相关 `*.test.ts` | 新增/修改 | 同 socket 并发 N 个 startSession 按 requestId 正确路由（注入延迟与乱序结果）；socket 断连统一失败；stop ack 超时重发与离线挂起 |

### 命令参考

```bash
cd servers/controller-api && npm run build && npm run test
```

### 验收 checklist

- [ ] 并发启动单测全部通过（含乱序/延迟注入，覆盖 common-rules 指出的 fake controller 秒回掩盖竞态问题）
- [ ] `cleanupFailedSession` 在 dispatcher 未命中/超时/断连路径统一生效

---

## Phase 4: agent-api

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/models/controller-workspace.ts` | 修改 | 新增 `isGitRepo`（可选），复用 `detectGitRepo` 链路懒填充，`git:init` 后更新 |
| `servers/agent-api/src/services/session.ts` | 修改 | ① `delete()`/`close()` 顺序修正：先 `acp:stop`（等 ack 上限 10s，超时继续并挂起补发）后 worktree 清理；② `create` 支持 `existingWorktreePath`（跳过 `git:worktree:add`，与 `enableWorktree` 互斥报 `BAD_USER_INPUT`）；③ MCP endpoint 创建失败且会话显式携带 `mcpServerIds` 时 fail-fast 抛错 |
| `servers/agent-api/src/services/worktree.ts` | 新增 | `list(controllerId, workspaceId)`：`git:worktree:list` 结果 ∪ sessions 按 `worktreePath` 归组（离线降级仅 sessions）；`deleteWorktree()` 编排：逐会话终止（跳过 commit 暂存）→ `git:worktree:remove(force)` → 失败兜底 `fs:remove-dir`，逐项汇报失败 |
| `servers/agent-api/src/services/workflow/orchestrator.ts` | 修改 | `ensureWorkflowToolsServer`/`ensureAdminToolsServer` 并发 upsert 捕获 `E11000` 后重读既有文档返回 |
| `servers/agent-api/src/services/workflow/engine.ts` | 修改 | `case 'completeRework'` 末尾对齐 `complete` 收尾：先 `refreshCurrentNodeNames` + `instance.save()` 落库 DONE，再 `hooks.onNodeDone` 触发 `endNodeSession → sessionService.close` |
| `servers/agent-api/src/services/workflow/instance.ts` | 修改 | 实例删除沿用增强后的 `sessionService.delete`，清理失败项汇总汇报 |
| `servers/agent-api/src/graphql/schemas/` + `resolvers/` | 修改 | `workspaceWorktrees`/`deleteWorktree`/`isGitRepo`/`existingWorktreePath` 对齐 Phase 1 契约 |
| 相关 `*.test.ts` | 新增/修改 | worktree 归组并集与离线降级；删除顺序断言（先 stop 后 remove）；upsert E11000 重读；`completeRework` 触发 `onNodeDone` 且先于 close 落库 DONE；endpoint 失败 fail-fast |

### 命令参考

```bash
cd servers/agent-api && npm run build && npm run test
```

### 验收 checklist

- [ ] 删除顺序回归：单会话删除的 commit 暂存语义不变（先停进程后暂存）
- [ ] `completeRework` 后节点会话状态为 `ended`，无残留
- [ ] 并发首建平台 MCP server 不再抛 E11000

---

## Phase 5: agent-web

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/graphql/` | 修改 | 新增 `workspaceWorktrees` query、`deleteWorktree` mutation 文档；列表数据挂入 Sidebar 现有轮询 query |
| `apps/agent-web/src/components/WorktreeSidebarGroup.tsx` | 新增 | worktree 节点：分支名 + 展开/收起 + 「添加」菜单（新建会话/拉起工作流实例）+ 「删除」按钮；展开渲染该 worktree 关联会话 |
| `apps/agent-web/src/components/Sidebar.tsx` | 修改 | workspace 节点下挂 Worktree 层级（`isGitRepo` falsy 不渲染）；归组改为按后端 `worktreePath` 精确匹配（弃用名称反推）；非 worktree 会话保持平铺 |
| `apps/agent-web/src/components/DeleteWorktreeConfirmDialog.tsx` | 新增 | 强警示确认弹窗：文案含「彻底删除」「不可恢复」及将关闭的对话数量（`sessionCount`），确认调 `deleteWorktree`，成功后跳转首页并刷新列表 |
| `apps/agent-web/src/components/NewSessionDialog.tsx` | 修改 | 支持 `existingWorktreePath` 预选：工作目录锁定为该路径，隐藏 worktree 创建 Section |
| `apps/agent-web/src/components/__tests__/` | 新增/修改 | WorktreeSidebarGroup 渲染/展开/归组；确认弹窗文案与取消无副作用；预选目录行为 |

### 命令参考

```bash
cd apps/agent-web && npm run build && npm run lint && npm run test
```

### 验收 checklist

- [ ] Git 仓库工作区展示 worktree 分组，非 Git 不展示；空 worktree 也展示
- [ ] 删除确认弹窗取消无任何变更；确认后侧边栏刷新

---

## Phase 6: API 测试（tests/api）

| # | 接口 | 用例 | 预期 |
|---|------|------|------|
| A1 | workspaceWorktrees | Git 仓库工作区 | 返回 worktree 列表 ∪ 会话归组，空 worktree 包含在内 |
| A2 | workspaceWorktrees | controller 离线 | 降级为仅 sessions 归组，不报错 |
| A3 | createSession(existingWorktreePath) | 复用已有 worktree | 不再调用 `git:worktree:add`，cwd 指向该路径 |
| A4 | createSession | existingWorktreePath 与 enableWorktree 同传 | 返回 BAD_USER_INPUT |
| A5 | deleteSession | 删除顺序与 ack | 先 acp:stop 后 worktree 清理；ack 超时仍完成删除 |
| A6 | deleteWorktree | 正常路径 | 全部会话关闭、force remove 成功，closedSessionIds 完整 |
| A7 | deleteWorktree | 部分会话清理失败 / remove 失败 | failures 逐项汇报；remove 失败走 fs:remove-dir 兜底 |
| A8 | deleteWorkflowInstance | 多节点实例 | 全部节点会话进程清理，失败项可见且不阻塞其余节点 |
| A9 | 并发实例化 N 个工作流 | 同 controller 并发启动 | 全部节点会话建立成功、均获得 MCP 工具（fake controller 注入启动延迟） |
| A10 | 返工流程 | 打回 → completeCurrentRework | 返工完成后节点会话状态为 ended |

### 验收 checklist

- [ ] A1–A10 全部通过

---

## Phase 7: E2E 测试（tests/e2e）

| # | 场景 | 验证点 |
|---|------|--------|
| E2E-1 | 侧边栏层级展示 | Git 仓库工作区展示 worktree 分组与分支名；非 Git 工作区不展示 |
| E2E-2 | worktree 展开 | 列出全部关联对话（含工作流节点会话），点击跳转会话页 |
| E2E-3 | worktree 添加 | 新建会话落在该 worktree 分组下；拉起工作流实例出现在工作流分组 |
| E2E-4 | worktree 删除 | 确认弹窗文案含「彻底删除」「不可恢复」与对话数量；确认后会话消失、目录删除；取消无变更 |
| E2E-5 | 删除会话进程销毁 | 删除单会话/工作流实例后，测试控制器桩验证对应进程不复存在 |

### 验收 checklist

- [ ] E2E-1 ~ E2E-5 全部通过（需在 Aspire 编排环境运行，与 API 套件串行执行）

---

## 总体验收

- [ ] 所有 Phase checklist 完成
- [ ] `packages/agent-controller` / `servers/controller-api` / `servers/agent-api` / `apps/agent-web` build + lint + test 全绿
- [ ] API 测试 A1–A10、E2E 测试 E2E-1~5 通过
- [ ] 提案 §9 验收标准逐项达成（进程无残留 / 对账清理生效 / 离线补发 / 并发 MCP 正常 / 返工会话关闭）
- [ ] PRD §1.3 成功标准逐项达成
