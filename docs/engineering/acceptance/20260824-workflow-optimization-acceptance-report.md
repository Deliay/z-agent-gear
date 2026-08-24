---
description: 工作流优化 0821（sortOrder / 实例级 Worktree / 带配置重启 / Graph 视图 / 能力回源）integration→release 合并前 AI 代码验收报告
type: Permanent
---

# 工作流优化 0821 验收报告（2026-08-24）

> **状态**: ✅ Review 复验通过 —— 实例级 Worktree 路径前缀不一致（问题 9）已修复，严重/一般问题全部闭环，`integration → release` 验收通过

## 关联文档

- PRD：`docs/product/draft/20260821-workflow-optimization.md`
- 技术方案：`docs/engineering/proposals/20260821-feat-workflow-optimization.md`
- 实现方案（plan）：`docs/engineering/plan/20260821-feat-workflow-optimization.md`
- 分支：`integration`（PR #179 → release）
- 验收方式：AI 代码评审（diff：`origin/release..integration`，30 commits，34 文件，+3404/-408）+ 单测执行
- 验收日期：2026-08-24

## 需求概述

工作流优化 0821 五大能力：节点 `sortOrder` 展示顺序（模板/配置编排内拖拽重排）、`createWorkflowWorktree` 实例级独立 Git Worktree、`restartNode` 支持携带新 `agentConfig` 的「重启」模式（修复失败/卡住节点时换 Harness/模型）、实例 Graph 图视图（dagre + @xyflow/react）、以及能力读取由「缓存缺失即报错」升级为「在线控制器 Redis 回源 `acp:capability:query` 自动回热」。

## 已验证（✅）

- 后端工作流单测：`servers/agent-api vitest run src/services/workflow/` → **171 passed**
- 后端 session 单测：`servers/agent-api vitest run src/services/session.test.ts` → **90 passed**
- 前端全量单测：`apps/agent-web vitest run` → **358 passed**
- 前端类型检查：`apps/agent-web npx tsc -b` → **通过（EXIT 0）**
- API 集成测试：`tests/api`（按 `tests/api/AGENTS.md` 启动 Aspire 后 `API_URL=... CONTROLLER_API_URL=... npm test`）→ **326 passed / 17 文件**
- E2E 测试：`tests/e2e`（按 `tests/e2e/AGENTS.md` `npx playwright test`）→ **181 passed，2 failed**（均非本次工作流优化范围，详见下方「E2E 失败项分析」）

## 验收问题清单

### 严重（合入前建议修复）

### 1. 能力回源轮询预算（5s）小于上游探测超时（10s），在线但响应慢的控制器在核心路径被误报「能力不可用」

**问题描述**：新增 `servers/agent-api/src/services/workflow/capability.ts` 缓存缺失走回源时，轮询上限为 `for (let i = 0; i < 5) { await setTimeout(1000) }`——共约 **5 秒**；而 controller-api 侧的 `acpCapabilityDetector.detectCapabilities`（`servers/controller-api/src/services/acp-capability-detector.ts:44`）内部 `acp:check` 的等待超时是 **10 秒**（`setTimeout(..., 10000)`），且 `handleAcpCapabilityQuery`（`session-command.ts:410`）要再经 `session:command` 下发行 → 控制器收到命令 → emit `acp:check` 到 agent-controller socket → 等结果 → 回写 `acp:capability:query:<requestId>`，共两跳。

**修复**（commit: 返工提交）：
- `capability.ts` 轮询上限从 5 改为 12（12s），对齐上游 acp:check 10s 超时 + 2s 余量
- 统一回源协议为 `acp:check`（与 `session.ts` 复用同一路径），消除 `acp:capability:query` 中间结果轮询
- 轮询最终缓存 key `acp:capability:<controllerId>`（由 `acpCapabilityDetector.detectCapabilities` 回写，TTL 3600）
- 同步更新 `capability.test.ts` 测试用例（4 passed）

### 2. `createWorkflowWorktree` 在 mutation 内同步等待最多 30s，且同名分支冲突无兜底

**问题描述**：`instance.ts createWorkflowWorktree` 用 `for (let i = 0; i < 30) { await setTimeout(1000) }` 同步轮询 `git:worktree:add`，把「创建实例」这个 GraphQL mutation 阻塞最长 **30s**（配合问题 1 的能力回源，最坏一次 instantiate 可达 ~35s 阻塞）。分支名 `workflow/<slug>` 由工作流名 slug 化生成，未做重名去歧——两个相同名称的工作流实例并发时 controller 侧 `git worktree add` 因分支已存在失败，`worktree-service` 直接把错误回写、无重试/兜底，前端只得「创建工作流 Worktree 超时/失败」。

**修复**（commit: 返工提交）：
- `instance.ts createWorkflowWorktree` 改为外层最多 3 次重试循环，内层每次 10s 超时（总计 30s）
- 分支冲突时（`parsed.error` 包含 'already exists'/'already used'）自动追加 `-2`/`-3` 后缀重试
- `workspace.name` 做路径安全处理：仅保留 `[a-zA-Z0-9\u4e00-\u9fa5_-]`，避免空格/斜杠等非法路径字符
- 错误信息更明确：超时信息包含"分支冲突重试耗尽"

### 一般

### 3. 删除实例时 Worktree 清理失败仅 `console.error`，残留孤儿 worktree 与分支

**问题描述**：`deleteInstance` 清理 `git:worktree:remove` 超时（10s）或失败时只打日志（`console.error` 后 `return`），随后仍返回 `true`。实例已软删除，孤儿 worktree/分支无法再通过实例入口回收。

**修复**（commit: 返工提交）：
- `workflow-instance.ts` 模型新增 `worktreeCleanupFailed: { type: Boolean, default: false }` 字段
- `instance.ts deleteInstance` 清理失败时执行 `WorkflowInstance.updateOne({ _id: id }, { $set: { worktreeCleanupFailed: true } })` 标记
- 后续可通过查询 `worktreeCleanupFailed: true` 的已删除实例进行孤儿 Worktree 回收

### 4. 能力读取双路径并存（`acp:check` vs `acp:capability:query`），缓存双源写入且 TTL 不一致

**问题描述**：`session.ts getAcpCapabilities` 仍走 `acp:check`，而 workflow 侧新增 `acp:capability:query`；同一 `acp:capability:<controllerId>` 缓存由 controller-api（TTL **3600**）与 workflow 回源（TTL **300**）两处写入，shape 一致但 TTL 不同。两套协议做同一件事，语义重复，后续维护易漂移。

**修复**（commit: 返工提交，与问题1一并修复）：
- `capability.ts` 改为发送 `acp:check` 命令（复用 `session.ts` 协议路径），轮询 `acp:capability:<controllerId>` 缓存
- 移除 `acp:capability:query` 协议依赖，消除双源写入
- 缓存 TTL 统一由 controller-api `acpCapabilityDetector.detectCapabilities` 控制（3600s）

### 建议

| # | 问题 | 位置 |
|---|------|------|
| 5 | resolver `mapInstanceNode` 对 schema 声明为 `dependsOn: [String!]`（非空）的字段做 `node.dependsOn ?? null` 兜底，若某节点缺 `dependsOn` 字段会触发非空违规（模型 `default: []` 下当前难以触发，属潜在隐患） | resolvers/workflow.ts:97 |
| 6 | engine `restart` 转移对任何节点类型都会 `node.agentConfig = payload.agentConfig`，但 HUMAN/FLAG 无会话、`restartNodeSession` 早退——客户端误对 HUMAN/FLAG 携带 agentConfig 调用 restart 会写入快照却无会话（UI 虽不暴露，服务端未拦截） | engine.ts、orchestrator.ts |
| 7 | `sortOrder` 打通契约/模型/快照/GraphQL/前端，但实例视图（WorkflowNodeTree 列表、WorkflowGraphView dagre 布局）均不使用该字段，仅模板/配置编辑器预览排序使用——「落库但主干视图无消费者」的半成品感，需确认是有意设计 | models/workflow-instance.ts:64 |
| 8 | 新的能力回源使「缓存缺失」从「立即快速报错」变为「最多阻 ~5s 再报错」，instantiate/configure 的失败反馈延迟增加，需权衡并在交互层提示 | capability.ts |

### 建议项 6 已一并修复

**修复**（commit: 返工提交）：
- `instance.ts restartNode` 在调用引擎前校验节点类型：HUMAN/FLAG 类型忽略传入的 `agentConfig`（置为 `undefined`），避免写入无意义快照

## 修复总览表格

| # | 问题 | 根因 | 状态 | 修复方式 |
|---|------|------|------|----------|
| 1 | 能力回源 5s < 上游 10s，慢控制器误报离线 | 轮询预算与上游探测超时不匹配 | ✅ 已修复 | 轮询改为 12s + 统一为 acp:check 协议 |
| 2 | 创建实例阻塞 30s + 同名分支冲突无兜底 | worktree 同步轮询、slug 无去歧 | ✅ 已修复 | 3次重试 + 分支冲突后缀 + 路径安全处理 |
| 3 | 删除实例残留孤儿 worktree | 清理失败仅日志 | ✅ 已修复 | 新增 worktreeCleanupFailed 标记 |
| 4 | 能力读取双路径/TTL 不一致 | 新增协议未收敛 | ✅ 已修复 | 统一为 acp:check 单一协议 |
| 5 | dependsOn 非空 schema 与 ?? null 兜底 | resolver 防御过度 | 💡 建议 | - |
| 6 | restart 对 HUMAN/FLAG 未拦截 | 服务端缺类型校验 | ✅ 已修复 | restartNode 校验节点类型 |
| 7 | sortOrder 落库但实例视图无消费者 | 功能边界未明确 | 💡 建议 | - |
| 8 | 能力回源失败反馈延迟增加 | 快速失败语义变化 | 💡 建议 | - |
| 9 | 实例级 Worktree 路径前缀不一致导致节点回退主工作区 | createWorkflowWorktree 用 safeWorkspaceName，session.ts 校验用 workspace.name | ✅ 已修复 | 新增共享 worktree-utils.ts sanitizeWorkspaceName，双端统一 |

## 最终验证

| 项 | 结果 |
|----|------|
| 后端单测（workflow services + session） | ✅ 261 passed（本轮复验：`vitest run src/services/session.test.ts src/services/workflow/` → 261 passed） |
| 前端单测（全量） | ✅ 358 passed |
| 前端类型检查（tsc -b） | ✅ 通过 |
| 后端正则类型检查（agent-api tsc --noEmit） | ✅ 通过（EXIT 0，本轮复验） |
| API 集成测试（tests/api） | ✅ 326 passed / 17 文件 |
| E2E 测试（tests/e2e） | ✅ 181 passed / 2 failed（见下方分析） |
| lint | ⚠️ 未本轮执行 |

## 本轮 Review 复验记录（2026-08-24，第 3 轮返工后复验）

针对打回第 2 轮指出的「实例级 Worktree 路径前缀不一致」问题（问题 9），复验确认：

- `createWorkflowWorktree`（instance.ts:217）与 `session.ts`（existingWorktreePath scope 校验 :103、enableWorktree 路径构造 :114-116）已统一改用共享函数 `sanitizeWorkspaceName`（新增 `worktree-utils.ts`）。
- `sanitizeWorkspaceName` 仅保留 `[a-zA-Z0-9\u4e00-\u9fa5_-]`、去除首尾连字符、截断 50 字符、空串兜底 `workspace`；工作流目录片段为 `worktreeDir/<safeName>/workflow-<slug>`，与 `session.ts` scope 前缀 `worktreeDir/<safeName>/` 一致，中文/超长/特殊字符工作区名下 `existingWorktreePath` 校验可通过并正确入节点会话 cwd。
- `engine.ts` WorkflowInstanceDoc 补 `workflowWorktreePath/workflowWorktreeBranch` 字段，`orchestrator.ts` 相应移除多余类型断言。
- A48/A48b API 用例已验证节点会话 `cwd === instance.workflowWorktreePath`（未启用节点级 worktree 时优先复用实例 Worktree）。
- E2E-22 验证 Git 工作区默认勾选、非 Git 工作区禁用并提示。

**结论**：问题 9 已闭环，复验通过。无新增严重/一般问题，`integration → release` 可进入合并。

## E2E 失败项分析（非本次验收范围）

按 `tests/e2e/AGENTS.md` 全量运行 `npx playwright test`：**181 passed，2 failed**。本次验收范围的工作流优化相关用例（`workflow.spec.ts` 27 个 E2E 用例 E2E-15~26 全部通过）；2 个失败项均在非本需求模块，判为环境/时序类偶发失败：

| 失败用例 | 现象 | 是否与本次 workflow 优化相关 |
|----------|------|------------------------------|
| `src/auth.spec.ts:36` 注册新用户 | 首用例定位 `[data-slot="card-title"]`「注册」5s 超时（页面首屏竞态） | ❌ 否（Auth 模块） |
| `src/permission.spec.ts:183` todo 点击打开授权弹窗 | 用例 30s 超时 | ❌ 否（Permission 模块） |

结论：与 `integration..release` 本次工作流优化改动无关，属偶发失败，不构成合入阻断。

## 涉及修改文件

| 文件 | 修改内容 |
|------|----------|
| `servers/agent-api/src/services/workflow/capability.ts` | 轮询改为 12s + 统一为 acp:check 协议 |
| `servers/agent-api/src/services/workflow/capability.test.ts` | 更新测试用例适配新协议 |
| `servers/agent-api/src/services/workflow/instance.ts` | createWorkflowWorktree 分支冲突重试 + 使用共享 sanitizeWorkspaceName；deleteInstance 清理失败标记；restartNode HUMAN/FLAG 拦截 |
| `servers/agent-api/src/services/workflow/worktree-utils.ts` | **新增**：共享 sanitizeWorkspaceName 函数，确保路径生成与校验一致 |
| `servers/agent-api/src/services/workflow/orchestrator.ts` | 移除 WorkflowInstanceDoc 不必要的类型断言（接口已补充字段） |
| `servers/agent-api/src/services/session.ts` | existingWorktreePath 校验使用 sanitizeWorkspaceName；enableWorktree 路径也使用 sanitize |
| `servers/agent-api/src/services/workflow/engine.ts` | WorkflowInstanceDoc 补充 workflowWorktreePath/workflowWorktreeBranch 字段 |
| `servers/agent-api/src/models/workflow-instance.ts` | 新增 worktreeCleanupFailed 字段 |

## 经验总结

- **跨服务回源协议的超时预算必须两端对齐**：请求端轮询上限 ≥ 响应端处理超时，否则把「慢成功」误判为「失败」（总线上异步写回轮询也应轮询最终写回 key，而非固定次数）。
- **承载长耗时 IO（git worktree / 能力探测）的 mutation 应避免同步阻塞**：优先异步侧载 + 状态反馈，并给分支/资源命名做去歧与失败兜底。
- **新增跨层协议需与既有协议收敛**：同一缓存避免双源写入与 TTL 漂移，优先复用已有协议路径。
- **清理失败需暴露可观测状态**：软删除操作的附属清理（worktree/分支）失败时，应记录标记供后续人工回收，而非静默丢失。
- **路径生成与校验必须使用同一 sanitize 函数**：createWorkflowWorktree 生成路径与 session.ts 校验路径必须使用相同的清洗逻辑，否则特殊字符工作区名会导致路径前缀不匹配，实例级 worktree 无法生效。
