---
description: 工作流 Worktree 节点会话启动失败修复 - 实现计划（从技术提案拆解的分阶段可执行任务与测试覆盖计划）
type: Permanent
---

# 工作流 Worktree 节点会话启动失败修复 - 实现计划

**关联 Proposal**: `proposals/20260829-fix-workflow-worktree-session-start.md`（v1.0）
**关联 PRD**: `docs/product/draft/20260829-workflow-worktree-session-start.md`
**feat-branch**: `prd/workflow-worktree-session-start`
**创建日期**: 2026-08-29

## 实现顺序

```
Phase 1: 契约确认（无变更，核对后跳过）
  └── Phase 2: agent-api（共享路径工具 + session/worktree 校验归一化，TDD）
       └── Phase 3: 服务编排 + 手工验证（Aspire）
            └── Phase 4: API 测试回归（tests/api）
                 └── Phase 5: E2E 测试回归（tests/e2e）
```

依赖说明：本修复无契约变更（`CreateSessionInput.existingWorktreePath`、错误码均不变），Phase 1 仅核对确认；改动集中在 agent-api 单个子项目，按 `z-coding` 模式委托一个 subagent，基于 `prd/workflow-worktree-session-start` 创建开发分支 `servers/workflow-worktree-session-start`，完成后提 PR 回 `prd/workflow-worktree-session-start` 待 review。开发模式采用 TDD（红-绿-重构）：先补失败测试再实现，编码前加载 `docs/engineering/common-rules.md` 与 `docs/engineering/backend-rules.md`。

---

## Phase 1: 契约确认

技术提案 §3.1 明确无契约变更。核对 `contracts/` 无需修改：

- `CreateSessionInput.existingWorktreePath` 字段语义不变
- 错误码沿用 `BAD_USER_INPUT`
- `controller-workspace.graphql` 不变

### 验证

- [ ] 确认 `contracts/` 零变更，进入 Phase 2

---

## Phase 2: agent-api

开发分支：`servers/workflow-worktree-session-start`（基于 `prd/workflow-worktree-session-start`）。

TDD 顺序：先写 `worktree-utils.test.ts`（新工具函数）与 `session.test.ts` / `worktree.test.ts` 新增用例（RED）→ 实现 `expandTilde` / `worktreeScopePrefix` 并接入两处校验（GREEN）→ 重构清理（保持测试通过）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/services/workflow/worktree-utils.ts` | 修改 | 新增 `expandTilde(p)`：仅展开 `~/` 前缀为 `os.homedir()`（与 `packages/agent-controller/src/worktree-handler.ts:6-7` 语义一致），绝对路径原样返回；新增 `worktreeScopePrefix(worktreeDir, workspaceName)`：`expandTilde` → 拼接 `sanitizeWorkspaceName(workspaceName)` → `path.normalize` → 保证末尾 `path.sep` |
| `servers/agent-api/src/services/workflow/worktree-utils.test.ts` | 新增 | 工具函数用例（下表 T1-T2） |
| `servers/agent-api/src/services/session.ts` | 修改 | `session.ts:101-108`：`scopePrefix` 改用 `worktreeScopePrefix(worktreeDir, workspace.name)`；比较前对 `input.existingWorktreePath` 也做 `expandTilde` 再 `path.normalize`，两侧同口径后 `startsWith` 判断；错误信息、`BAD_USER_INPUT` 行为不变 |
| `servers/agent-api/src/services/session.test.ts` | 修改 | 新增归属校验用例（下表 T3-T5），保留既有越权拒绝用例 |
| `servers/agent-api/src/services/worktree.ts` | 修改 | `worktree.ts:104`：`scopePrefix` 改用 `worktreeScopePrefix(worktreeDir, workspace.name)`，顺带修复「未展开 `~`」与「未清洗 `workspace.name`」两处口径不一致；`deleteWorktree` 经 `list()` 复用同一口径，无需单独改动 |
| `servers/agent-api/src/services/worktree.test.ts` | 修改 | 口径一致性用例（下表 T6） |

### 测试用例

| # | 位置 | 用例 | 预期 |
|---|------|------|------|
| T1 | worktree-utils.test.ts | `expandTilde('~/x')` / 绝对路径 / 无 `~` 相对路径 | `<home>/x`；绝对路径原样返回；相对路径原样返回 |
| T2 | worktree-utils.test.ts | `worktreeScopePrefix('~/.zag/worktrees', 'My WS/名')` | 展开 `~`、工作区名经 `sanitizeWorkspaceName` 清洗、`normalize` 后末尾带分隔符 |
| T3 | session.test.ts | `worktreeDir='~/.zag/worktrees'`（mock `os.homedir`）+ `existingWorktreePath` 为展开后路径 `<home>/.zag/worktrees/<ws>/workflow-xxx` | 校验通过，会话以该路径为 cwd 创建成功（默认配置必现场景） |
| T4 | session.test.ts | 展开后仍越界的路径（`<scope>/../evil`、其他工作区目录、scope 兄弟目录） | 仍抛 `BAD_USER_INPUT`，防护不回退 |
| T5 | session.test.ts | `existingWorktreePath` 本身带 `~/` 前缀 | 与展开后形式判定结论一致 |
| T6 | worktree.test.ts | `worktreeDir` 含 `~` 且工作区名含空格/斜杠时，list/delete 归属判断 | 与 session.create 校验结论一致（同一路径同一结论） |

### 命令参考

```bash
cd servers/agent-api && npm run build && npm run test
```

### 验收 checklist

- [ ] T1-T6 全部通过，既有单测无回归（`npm run test` 全绿）
- [ ] 默认 `worktreeDir`（`~/.zag/worktrees`）下展开后的工作流 Worktree 路径通过校验
- [ ] 越权 `existingWorktreePath` 仍被 `BAD_USER_INPUT` 拒绝
- [ ] `session.ts` 与 `worktree.ts` 归属判断共用 `worktreeScopePrefix`，口径一致

---

## Phase 3: 服务编排 + 手工验证（Aspire）

按 `z-aspire-orchestrator` 编排启动全量服务：

```bash
aspire start    # agent-api + controller-api + agent-web + MongoDB + Redis
```

手工验证（对照 PRD 成功标准）：

1. 在 Git 工作区勾选「为工作流创建 Worktree」实例化工作流，流转到 AI 节点 → 会话正常启动，无「existingWorktreePath does not belong to this workspace」报错
2. 确认节点会话工作目录为该实例的工作流专属 Worktree
3. 单独启用「初始化新 Worktree」的节点行为与现状一致
4. 传入不属于该工作区的 `existingWorktreePath` → 仍被拒绝

### 验收 checklist

- [ ] 默认与自定义 `worktreeDir` 两种配置下流程均正常
- [ ] 防护行为无回退

---

## Phase 4: API 测试回归（tests/api）

按 `z-test` 规范，真实 Mongo/Redis + fake controller 环境全量回归：

```bash
# 参照 tests/api 现有运行方式
```

| # | 用例 | 预期 |
|---|------|------|
| A1 | `tests/api` worktree 相关用例全量 | 全绿，无回归 |
| A2 | 工作流 Worktree 实例流转 AI 节点（如已有覆盖） | 会话正常启动 |

如现有 API 测试未覆盖「`worktreeDir` 含 `~` + 工作流 Worktree 会话启动」场景，补充一条对应用例。

### 验收 checklist

- [ ] `tests/api` 全量通过

---

## Phase 5: E2E 测试回归（tests/e2e）

```bash
# 参照 tests/e2e 现有运行方式（worktree.spec.ts 等）
```

### 验收 checklist

- [ ] `tests/e2e` worktree 相关用例全量通过
- [ ] 整体回归无失败

---

## 总验收 checklist（对照提案 §9 / PRD §1.3）

- [ ] 默认 `worktreeDir`（`~/.zag/worktrees`）下，勾选「为工作流创建 Worktree」的实例流转到 AI 节点，会话正常启动，工作目录为工作流 Worktree
- [ ] 自定义绝对路径 `worktreeDir` 下行为不变（回归通过）
- [ ] 越权 `existingWorktreePath` 仍被 `BAD_USER_INPUT` 拒绝
- [ ] `session.ts` 与 `worktree.ts` 的归属判断口径一致（同一路径同一结论）
- [ ] 单测 / API / E2E 全绿
