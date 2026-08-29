---
description: 工作流 Worktree 节点会话启动失败修复 - 实现计划（从技术提案拆解的分阶段可执行任务与测试覆盖计划）
type: Permanent
---

# 工作流 Worktree 节点会话启动失败修复 - 实现计划

**关联 Proposal**: `proposals/20260829-fix-workflow-worktree-session-start.md`（v1.2）
**关联 PRD**: `docs/product/draft/20260829-workflow-worktree-session-start.md`（v1.2）
**feat-branch**: `prd/workflow-worktree-session-start`
**创建日期**: 2026-08-29
**计划版本**: v1.1（v1.0 基于提案 v1.0 的「服务端 `os.homedir()` 展开」方案编写，该方案因 agent-api 与 agent-controller 不同机被否决；v1.1 按提案 v1.2 全面重写——`~` 展开以控制器 register 上报的 `homeDir`/`platform` 为准，生效目录收敛为 `DEFAULT_WORKTREE_DIR` 单一定义 + `resolveEffectiveWorktreeDir`，范围由 agent-api 单方扩展为 contracts / agent-controller / controller-api / agent-api / agent-web 五方）

## 实现顺序

```
Phase 1: 契约更新（contracts/agent-controller-websocket.md register 负载）
  ├── Phase 2: agent-controller（register 上报 homeDir/platform）
  ├── Phase 3: controller-api（register 持久化 homeDir/platform）
  ├── Phase 4: agent-api（生效目录解析 + 校验归一化，核心修复）
  └── Phase 5: agent-web（设置页默认目录文案对齐）
       └── Phase 6: 服务编排 + 手工验证（Aspire）
            └── Phase 7: API 测试回归（tests/api）
                 └── Phase 8: E2E 测试回归（tests/e2e）
```

依赖说明：Phase 1 契约先行，是后续所有阶段的输入（提案 §6.2）；Phase 2-5 契约对齐后可并行开发——按 `z-coding` 的子项目并行实现模式，各委托一个 subagent，分别基于 `prd/workflow-worktree-session-start` 创建开发分支 `packages/workflow-worktree-session-start`、`servers/workflow-worktree-session-start-controller`、`servers/workflow-worktree-session-start`、`apps/workflow-worktree-session-start`，完成后各自提 PR 回 `prd/workflow-worktree-session-start` 待 review；测试阶段在全部实现合并后推进。开发模式采用 TDD（红-绿-重构）：每个 Phase 先写/补测试再实现，编码前加载 `docs/engineering/common-rules.md` 及对应端规范（`backend-rules.md` / `frontend-rules.md`）。

关键约束（提案 §1.2/§6.1，实现期不得回退）：

- agent-api 侧**禁止任何 `os.homedir()` 兜底猜测**，`~` 展开只能使用控制器上报的 `homeDir`。
- 生效目录一律经 `resolveEffectiveWorktreeDir(controller)` 取值：已配置用 `controllers.worktreeDir`，未配置回退 `DEFAULT_WORKTREE_DIR`；现存的 4 处硬编码兜底（`session.ts:101`、`session.ts:114`、`worktree.ts:103`、`instance.ts:206`）全部收敛。
- 越权路径仍被 `BAD_USER_INPUT` 拒绝，防护强度不回退；旧控制器缺 `homeDir` 且生效目录含 `~` 时抛**明确错误**（引导升级控制器或配置绝对路径），不静默放行。

---

## Phase 1: 契约更新

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/agent-controller-websocket.md` | 修改 | §2.2 `register`（Controller → Server）负载表新增两个**可选**字段：`homeDir`（控制器本机 `os.homedir()`）、`platform`（控制器本机 `os.platform()`，`linux`/`darwin`/`win32`）；注明旧版本控制器可不上报、服务端按字段缺失处理，不破坏既有握手。GraphQL 契约（`CreateSessionInput.existingWorktreePath`、错误码 `BAD_USER_INPUT`）不变 |

### 验证

- [ ] 契约与提案 §3.1 一致，评审通过后进入 Phase 2-5

---

## Phase 2: agent-controller

开发分支：`packages/workflow-worktree-session-start`（基于 `prd/workflow-worktree-session-start`）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/socketio-client.ts` | 修改 | register 负载（`socketio-client.ts:228-233`）新增 `homeDir: homedir()`、`platform: platform()`——`platform` 已从 `os` 引入（:3），补充引入 `homedir`；`RegisterPayload` 类型（:36 附近）补 `homeDir`/`platform` 两字段。控制器端 `worktree-handler.ts` 的 `expandTilde` 保持不变（提案 §6.1） |
| `packages/agent-controller/tests/socketio-client.test.ts` | 修改 | 新增用例 T-C1 |

### 测试用例

| # | 用例 | 预期 |
|---|------|------|
| T-C1 | 连接后发出的 `register` 负载 | 包含 `homeDir`（等于本机 `os.homedir()`）与 `platform`（等于本机 `os.platform()`） |

### 命令参考

```bash
cd packages/agent-controller && npm run build && npm run test
```

### 验收 checklist

- [ ] T-C1 通过，既有单测无回归
- [ ] register 负载与 Phase 1 契约字段一致

---

## Phase 3: controller-api

开发分支：`servers/workflow-worktree-session-start-controller`（基于 `prd/workflow-worktree-session-start`）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/controller-api/src/services/socketio.ts` | 修改 | `RegisterPayload`（:23）新增 `homeDir?: string`、`platform?: string`；`register` 处理器（:34-98）的 upsert（:81 附近）将两字段写入控制器文档——每次连接刷新，保证控制器换机/换系统后数据及时更新；缺字段时按缺失处理不报错 |
| `servers/controller-api/src/models/controller.ts` | 修改 | schema 新增 `homeDir: String`、`platform: String`（无需迁移，旧文档缺字段按缺失处理） |
| `servers/controller-api/src/services/socketio.test.ts` | 修改 | 新增用例 T-S1、T-S2 |

### 测试用例

| # | 用例 | 预期 |
|---|------|------|
| T-S1 | register 携带 `homeDir`/`platform` | upsert 后控制器文档含两字段；重复 register 时字段被刷新 |
| T-S2 | register 为旧负载（无两字段） | 注册正常完成不报错，文档两字段保持缺失 |

### 命令参考

```bash
cd servers/controller-api && npm run build && npm run test
```

### 验收 checklist

- [ ] T-S1、T-S2 通过，既有单测无回归
- [ ] 持久化字段与 Phase 1 契约一致

---

## Phase 4: agent-api（核心修复）

开发分支：`servers/workflow-worktree-session-start`（基于 `prd/workflow-worktree-session-start`）。

TDD 顺序：先写 `worktree-utils.test.ts`（新工具函数）与 `session.test.ts` / `worktree.test.ts` 新增用例（RED）→ 实现工具函数并接入 4 处取值点（GREEN）→ 重构清理（保持测试通过）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/services/workflow/worktree-utils.ts` | 修改 | 新增：`DEFAULT_WORKTREE_DIR = '~/.zag/worktrees'`（全平台单一定义，`~` 指控制器本机 home，与设置页展示一致）；`resolveEffectiveWorktreeDir(controller)`（已配置返回配置值，未配置/空串返回默认值）；`expandTildeWith(p, homeDir)`（用上报 homeDir 展开 `~/` 前缀，无 homeDir 或不含 `~` 原样返回）；`normalizeForCompare(p, platform)`（统一 `\`→`/`，`win32` 时转小写）；`worktreeScopePrefix(worktreeDir, workspaceName, homeDir)`（展开 + `sanitizeWorkspaceName` 清洗 + 归一化 + 末尾分隔符） |
| `servers/agent-api/src/services/workflow/worktree-utils.test.ts` | 新增 | 工具函数用例 T-U1 ~ T-U4 |
| `servers/agent-api/src/models/controller.ts` | 修改 | schema 新增 `homeDir: String`、`platform: String`（读取侧，与 controller-api 写入对齐） |
| `servers/agent-api/src/services/session.ts` | 修改 | ① 校验端（:101-108）：`scopePrefix = worktreeScopePrefix(resolveEffectiveWorktreeDir(controller), workspace.name, controller.homeDir)`，`existingWorktreePath` 经 `normalizeForCompare(..., controller.platform)` 后比较；生效目录含 `~` 且 `controller.homeDir` 缺失时抛**明确错误**（引导升级控制器或在设置页配置绝对路径），不静默放行；② 生成端（:114-118）：`worktreeDir` 取值同样改走 `resolveEffectiveWorktreeDir`；错误码 `BAD_USER_INPUT` 行为不变 |
| `servers/agent-api/src/services/session.test.ts` | 修改 | 新增用例 T-A1 ~ T-A6，保留既有越权拒绝用例 |
| `servers/agent-api/src/services/worktree.ts` | 修改 | :103-104 改走 `resolveEffectiveWorktreeDir` + `worktreeScopePrefix`（顺带修复「未展开 `~`」与「未清洗 `workspace.name`」两处口径不一致）；`deleteWorktree` 经 `list()` 复用同一口径，无需单独改动 |
| `servers/agent-api/src/services/worktree.test.ts` | 修改 | 新增口径一致性用例 T-A7 |
| `servers/agent-api/src/services/workflow/instance.ts` | 修改 | :206 的 `controller.worktreeDir \|\| '~/.zag/worktrees'` 改走 `resolveEffectiveWorktreeDir(controller)`（生成端与校验端同源，`wtPath` 拼接逻辑不变） |
| `servers/agent-api/src/services/workflow/instance.test.ts` | 修改 | 新增用例 T-A8（自定义目录下生成路径以配置值为准） |

### 测试用例

| # | 位置 | 用例 | 预期 |
|---|------|------|------|
| T-U1 | worktree-utils.test.ts | `expandTildeWith('~/x', '/home/u')` / 无 homeDir / 不含 `~` | `/home/u/x`；无 homeDir 原样返回；原样返回 |
| T-U2 | worktree-utils.test.ts | `normalizeForCompare` | `\`→`/`；`platform='win32'` 时转小写；非 win32 保持大小写 |
| T-U3 | worktree-utils.test.ts | `worktreeScopePrefix('~/.zag/worktrees', 'My WS/名', '/home/u')` | 展开 `~`、工作区名经 `sanitizeWorkspaceName` 清洗、末尾带分隔符 |
| T-U4 | worktree-utils.test.ts | `resolveEffectiveWorktreeDir` | 已配置返回配置值；未配置/空串返回 `DEFAULT_WORKTREE_DIR` |
| T-A1 | session.test.ts | 未配置 worktreeDir（生效默认 `~/.zag/worktrees`）+ `controller.homeDir` 已上报 + `existingWorktreePath` 为展开后路径 | 校验通过，会话以该路径为 cwd 创建成功（默认配置必现场景） |
| T-A2 | session.test.ts | 设置页配置了自定义目录（绝对路径 / 含 `~` 两种） | 生成与校验均以配置值为准 |
| T-A3 | session.test.ts | 展开后仍越界的路径（`<scope>/../evil`、其他工作区目录、scope 兄弟目录） | 仍抛 `BAD_USER_INPUT`，防护不回退 |
| T-A4 | session.test.ts | `homeDir` 缺失且生效目录含 `~`（旧版控制器） | 抛明确错误，文案含升级/配置绝对路径引导 |
| T-A5 | session.test.ts | `platform='win32'` 控制器（`\` 分隔符、大小写差异） | 归一化后正确判定归属 |
| T-A6 | session.test.ts | 生效目录为绝对路径（设置页目录选择器主路径） | 不依赖 `homeDir`，行为与现状一致 |
| T-A7 | worktree.test.ts | `worktreeDir` 含 `~` 且工作区名含空格/斜杠时，list/delete 归属判断 | 与 session.create 校验结论一致（同一路径同一结论） |
| T-A8 | instance.test.ts | 配置了自定义 `worktreeDir` 时创建实例级 Worktree | 下发的 `wtPath` 以配置值为准，不再命中硬编码默认值 |

### 命令参考

```bash
cd servers/agent-api && npm run build && npm run test
```

### 验收 checklist

- [ ] T-U1 ~ T-U4、T-A1 ~ T-A8 全部通过，既有单测无回归（`npm run test` 全绿）
- [ ] agent-api 代码中无 `os.homedir()` 兜底展开（grep 验证）
- [ ] 4 处硬编码 `'~/.zag/worktrees'` 兜底全部收敛至 `resolveEffectiveWorktreeDir`（grep 验证仅 `worktree-utils.ts` 单一定义）
- [ ] 越权 `existingWorktreePath` 仍被 `BAD_USER_INPUT` 拒绝
- [ ] `session.ts` 与 `worktree.ts` 归属判断共用 `worktreeScopePrefix`，口径一致

---

## Phase 5: agent-web

开发分支：`apps/workflow-worktree-session-start`（基于 `prd/workflow-worktree-session-start`）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/settings/WorkspaceSection.tsx` | 修改 | :231 默认目录展示文案 `~/.zag/worktrees（默认）` 与 `DEFAULT_WORKTREE_DIR` 语义对齐（仅文案/注释对齐，不改交互；`~` 含义为控制器本机 home） |

### 命令参考

```bash
cd apps/agent-web && npm run build && npm run lint && npm run test
```

### 验收 checklist

- [ ] 构建/lint/单测通过，设置页交互无变化
- [ ] 展示文案与实际生效默认值语义一致

---

## Phase 6: 服务编排 + 手工验证（Aspire）

按 `z-aspire-orchestrator` 编排启动全量服务：

```bash
aspire start    # agent-api + controller-api + agent-web + MongoDB + Redis
```

手工验证（对照 PRD §1.3 成功标准）：

1. 默认「Git Worktree 工作目录」（未配置，生效 `~/.zag/worktrees`）下，勾选「为工作流创建 Worktree」实例化工作流，流转到 AI 节点 → 会话正常启动，无「existingWorktreePath does not belong to this workspace」报错，工作目录为实例专属 Worktree
2. 在控制器设置中修改「Git Worktree 工作目录」为自定义目录 → 新建 Worktree、节点会话启动、Worktree 列表/删除全部以新配置为准，设置页展示与实际生效一致
3. 传入不属于该工作区的 `existingWorktreePath` → 仍被拒绝并提示
4. 旧版控制器（不上报 `homeDir`）+ 生效目录含 `~` → 给出明确的升级/配置绝对路径提示，不静默放行
5. 单独启用「初始化新 Worktree」的节点行为与现状一致；未勾选的实例与普通会话不受影响

### 验收 checklist

- [ ] 默认与自定义目录两种配置下流程均正常
- [ ] 旧控制器提示路径可感知、可操作
- [ ] 防护行为无回退

---

## Phase 7: API 测试回归（tests/api）

按 `z-test` 规范，真实 Mongo/Redis + fake controller 环境全量回归：

```bash
# 参照 tests/api 现有运行方式
```

| # | 用例 | 预期 |
|---|------|------|
| A1 | `tests/api` worktree 相关用例全量 | 全绿，无回归 |
| A2 | fake controller 的 `register` 负载补充 `homeDir`/`platform`（按真实控制器行为对齐）后，默认目录下工作流 Worktree 实例流转 AI 节点 | 会话正常启动 |
| A3 | fake controller 不上报 `homeDir` + 生效目录含 `~` | 返回明确错误提示（旧控制器边界） |

如现有 API 测试的 fake controller 未覆盖 `register` 上报字段，按 Phase 1 契约同步补齐。

### 验收 checklist

- [ ] `tests/api` 全量通过

---

## Phase 8: E2E 测试回归（tests/e2e）

```bash
# 参照 tests/e2e 现有运行方式（worktree.spec.ts 等，需在 Aspire 编排环境运行，与 API 套件串行执行）
```

### 验收 checklist

- [ ] `tests/e2e` worktree 相关用例全量通过
- [ ] 整体回归无失败

---

## 总验收 checklist（对照提案 §9 / PRD §1.3）

- [ ] 未配置「Git Worktree 工作目录」（生效默认 `~/.zag/worktrees`）时，勾选「为工作流创建 Worktree」的实例流转到 AI 节点，会话正常启动，工作目录为工作流 Worktree
- [ ] 在设置页配置自定义目录后，Worktree 的创建、会话启动校验、列表/删除归属判断全部以该配置为准
- [ ] 设置页展示的默认目录与实际生效目录始终一致（默认值单一定义）
- [ ] 控制器为 Linux / macOS / Windows 时流程均正常（单测覆盖分隔符与大小写场景）
- [ ] 越权 `existingWorktreePath` 仍被 `BAD_USER_INPUT` 拒绝
- [ ] 旧版控制器 + 生效目录含 `~` 时给出明确的升级/配置提示
- [ ] `session.ts` 与 `worktree.ts` 的归属判断口径一致（同一路径同一结论）
- [ ] 单测 / API / E2E 全绿
- [ ] `packages/`、`servers/`（×2）、`apps/` 四个开发分支 PR review 通过并合并回 `prd/workflow-worktree-session-start`
