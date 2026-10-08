---
description: integration→release 集成验收报告——前端 API 自动选择与国内加速（PR #199）AI Review 轮次，记录发现的问题、根因、修复要求与验证结果
type: Permanent
---

# 前端 API 自动选择与国内加速 集成验收报告

> **状态**: 🔴 返工中 —— 第一轮 AI Review 发现 4 个问题（1 个阻塞、2 个建议、1 个可选），已修复（commit `5922eb0`）并经第二轮复核核实；但第二轮复核新发现 1 个阻塞问题（问题 5：探测失败回落时 `getApiBase()` 与 `resolveApiBase()` 返回值不一致），已再次打回返工，待修复后重新提交 Review。详见 [七、第二轮 AI Review 复核](#七第二轮-ai-review-复核2026-10-08修复后)。

## 关联文档

- 产品文档：[20260908-frontend-auto-select-server.md](../../product/draft/20260908-frontend-auto-select-server.md)（前端支持服务器自动选择 PRD v1.0）
- 技术方案：[20260908-feat-frontend-auto-select-server.md](../proposals/20260908-feat-frontend-auto-select-server.md)、[20261008-feat-domestic-api-acceleration.md](../proposals/20261008-feat-domestic-api-acceleration.md)（v1.1，含 review 修订）
- 实现计划：[20260908-feat-frontend-auto-select-server.md](../plan/20260908-feat-frontend-auto-select-server.md)、[20261008-feat-domestic-api-acceleration.md](../plan/20261008-feat-domestic-api-acceleration.md)
- 关联分支：`integration` → `release`（PR #199：<https://github.com/Deliay/z-agent-gear/pull/199>）
- 验收日期：2026-10-08
- 验收范围：`integration..release` 差异（11 个 commit、19 个文件、+1582 / -32）

## 一、需求概述

本轮集成包含两个需求：

1. **前端支持服务器自动选择**：线上构建不再硬编码单一 API 入口，启动时并发探测两个候选入口 `/health` 并选用最快者，结果会话级缓存。
2. **Web 国内加速 API 接入（Controller API 自动选择）**：探测逻辑泛化至 controller-api（`mcp-proxy.ts` 惰性解析）；修正 cn 命令模板域名（旧域名已 NXDOMAIN）；CI 移除 `VITE_API_URL` / `VITE_CONTROLLER_API_URL` 注入。

## 二、验收问题清单

### 问题 1（🔴 阻塞）本地手动开发未注入环境变量时，前端探测并直连生产 API

**问题描述**：按 `README.md:55-67`「手动启动」执行 `cd apps/agent-web && npm run dev`（仓库无 `.env.development`，不注入任何 VITE 变量）时，`resolveApiBase()` / `resolveControllerApiBase()` 会探测生产候选入口（`https://api.zag.fffdan.com`、`https://zag-agent-api.fffdan.com`、`https://ctrl.zag.fffdan.com`、`https://zag-ctrl-api.fffdan.com`，其 `/health` 公网可达且 CORS 为 `*`），探测成功后写入缓存并**直连生产环境**。变更前该路径回落 `http://localhost:4000`（`useSessionStream.ts`、`WorkspaceSection.tsx`）、`http://localhost:4001`（`mcp-proxy.ts`）或相对路径经 vite dev proxy 回本地，所有请求均留在本地。

- 复现路径：`apps/agent-web/src/lib/api-base.ts:29-64`（`envUrl` 为空即进入探测分支）+ `README.md:65-67`（文档化的手动启动路径无 env 注入）；受影响消费点 `apps/agent-web/src/hooks/useSessionStream.ts:36`、`apps/agent-web/src/components/settings/WorkspaceSection.tsx:60,177`、`apps/agent-web/src/api/mcp-proxy.ts:30,46,65`（原 localhost 回落全部移除）。
- 影响：
  1. 本地开发误读/误写**生产数据**（workspace、session、MCP proxy key 等）；
  2. 离线/内网开发完全不可用（探测失败的回落值也是生产地址）；
  3. 与 PRD §1.2 目标 2「本地开发零影响」及成功标准不符。

**根因分析**：`resolveBase` 将「未显式注入环境变量」一律当作线上场景处理，未区分 `import.meta.env.DEV`；移除旧 fallback 时未给本地开发保留 localhost 回落或 `.env.development` 默认值。Aspire 路径（`AppHost.cs:85-86` 注入 env）不受影响，问题仅出现在文档化的手动启动路径。

**修复方案**：

1. `apps/agent-web/src/lib/api-base.ts`：当 `import.meta.env.DEV` 为真且 `envUrl` 为空时跳过探测，直接回落本地地址（agent `http://localhost:4000`、controller `http://localhost:4001`，与变更前行为一致）；或为 `apps/agent-web` 增加 `.env.development` 提供默认 `VITE_API_URL` / `VITE_CONTROLLER_API_URL`。
2. 同步更新 `apps/agent-web/src/lib/api-base.test.ts`：为 no-env 场景增加 DEV 分支覆盖（T-B* / T-C* 断言调整）。
3. `README.md`「手动启动」补充说明本地默认地址行为。

**验证结果**：✅ 已修复（commit `5922eb0`）。`api-base.ts` 增加 `import.meta.env.DEV` 短路：DEV 且 `envUrl` 为空时跳过探测与 sessionStorage，直接回落本地地址（agent `http://localhost:4000`、controller `http://localhost:4001`）；`getApiBase()` 同步 DEV 回落。新增 T-B12（DEV 无 env → localhost、不探测、不写缓存）、T-B13（DEV + env → env 优先）、T-B16、T-C10 覆盖；全量 `npm test` 419/419、`npm run lint` 0 error、`npm run build` 通过。

### 问题 2（🟡 建议）探测全部失败后 fallback 被内存固化，页面生命周期内不再重试

**问题描述**：`apps/agent-web/src/lib/api-base.ts:59` catch 分支执行 `state.cached = fallback`，而入口 `api-base.ts:32` 以 `if (state.cached) return state.cached` 短路。启动瞬间一次网络抖动导致探测全部失败后，本页面后续调用直接返回 `fallback`（候选首项），即使另一候选已恢复可用也不再探测。与实现计划「全部失败/超时回落 `fallback` **且不写缓存**」的意图不完全一致（sessionStorage 未写，但内存态等效于缓存）。

**根因分析**：失败态与成功态复用同一个 `state.cached` 字段，未区分「已解析成功」与「已失败回落」。

**修复方案**：catch 分支不写 `state.cached`（保持可重探），或为失败态记录时间戳做有限次数重试；补充「失败后再次调用可重探」单测。

**验证结果**：✅ 已修复（commit `5922eb0`）。catch 分支不再写 `state.cached`，失败回落仅作用于本次返回值，内存态与持久态均不固化；新增 T-B11 / T-C11 断言「首次全失败后二次调用重新探测」（fetch 调用数 2→4，二次成功后写入 sessionStorage）。

### 问题 3（🟡 建议）bootstrap() 无异常兜底与加载反馈

**问题描述**：`apps/agent-web/src/main.tsx:9` 的 `bootstrap()` 无 `try/catch`。若 `resolveApiBase()` 抛出未捕获异常（如隐私模式/沙箱环境下 `sessionStorage` 访问抛 `SecurityError`，`api-base.ts:39` 直接调用无保护），Promise reject 无人处理，页面**白屏且无任何提示**。另外探测路径下启动期最长约 2s 无渲染内容，也没有 loading 占位。

**根因分析**：bootstrap 缺少降级路径与启动期 UI。

**修复方案**：`bootstrap()` 内 `try/catch`，异常时以 `import.meta.env.VITE_API_URL || ''` 降级渲染；可选在解析期间渲染 loading 占位。

**验证结果**：✅ 已修复（commit `5922eb0`）。`bootstrap()` 以 `try/catch` 包裹解析并以 `VITE_API_URL || ''` 降级，启动期渲染「加载中…」占位；`api-base.ts` 的 `sessionStorage` 读写以 `try/catch` 保护，T-B15 覆盖「沙箱下 `getItem`/`setItem` 抛 `SecurityError` 仍可正常探测解析」。

### 问题 4（🟢 可选）并发调用无在途去重，重复探测

**问题描述**：`resolveBase` 仅以 `state.cached` 去重。首屏 `mcp-proxy.ts` 三个函数（或未来多消费点）并发调用 `resolveControllerApiBase()` 且缓存未命中时，会各自发起一轮候选探测，产生重复请求（功能正确，仅浪费探测）。

**根因分析**：未缓存 in-flight Promise。

**修复方案**：以模块级 `pending: Promise<string> | null` 去重，`finally` 中清理。

**验证结果**：✅ 已实现（commit `5922eb0`）。模块级 `pending: Promise<string> | null` 在途去重，`finally` 清理；T-B14 / T-C12 断言并发两次 `resolve*` 仅触发一轮探测（fetch 2 次），返回同一结果。

## 三、修复总览

| # | 问题 | 根因 | 状态 | 修复 commit |
|---|------|------|------|-------------|
| 1 | 本地无 env 时探测并直连生产 API | 未区分 DEV，本地回落被移除 | ✅ 已修复（阻塞） | `5922eb0` |
| 2 | 探测失败后内存固化 fallback | 失败态复用 `state.cached` | ✅ 已修复（建议） | `5922eb0` |
| 3 | bootstrap 无异常兜底/加载态 | 缺少降级路径 | ✅ 已修复（建议） | `5922eb0` |
| 4 | 并发 resolve 重复探测 | 未去重 in-flight Promise | ✅ 已实现（可选） | `5922eb0` |
| 5 | 探测失败回落时 `getApiBase()` 与 `resolveApiBase()` 不一致，SSE/工作区请求打到静态站点来源 | 问题 2 修复后失败态不再写 `state.cached`，同步消费点失去回落值 | ❌ 待修复（阻塞，第二轮新增） | — |

## 四、本轮已核实通过项

- 实现与技术方案/实现计划一致：`resolveBase` 参数化、`Promise.any` 竞速首个 2xx 胜出、2s 超时 abort、胜出后 abort 其余探测、sessionStorage 会话级缓存、`getApiBase()` 保守回落（含 T-C9 覆盖）均为方案明确设计；本轮返工新增「DEV 回落本地、失败不固化、在途去重、bootstrap 降级」已回填方案 v1.2。
- `command-template.ts` cn 端点由 `https://ctrl.zag.cn.fffdan.com` 改为 `https://ctrl.zag.fffdan.com` 属正确修复（实现计划记录旧域名实测 NXDOMAIN），测试同步更新，仓库无旧域名残留。
- `deploy-agent-web.yml` 移除 `VITE_API_URL` / `VITE_CONTROLLER_API_URL` 与方案 v1.1 一致；`grep` 确认 `apps/agent-web/src` 仅 `api-base.ts` 直读这两个变量。
- 探测端点均有 `/health` 路由（`servers/agent-api/src/index.ts:52`、`servers/controller-api/src/index.ts:32`）。
- 文档完整：2 份技术方案、2 份实现计划、1 份 PRD，`docs/engineering/AGENTS.md` 索引同步更新；方案修订与最终实现对齐。

## 五、最终验证

| 项目 | 结果 | 说明 |
|------|------|------|
| 单元测试 | ✅ 419/419 通过（49 个文件） | 含本轮新增 9 项：DEV 回落、失败重探、并发去重、沙箱 sessionStorage 兜底；`api-base.test.ts` 共 28 项 |
| Lint | ✅ 0 error / 6 warning | 6 个 warning 均位于本次未改动文件（TodoListPanel、NewSessionDialog、HistorySessionDialog、InstantiateWorkflowDialog），为存量问题 |
| Build（tsc -b + vite build） | ✅ 通过 | chunk 体积告警为存量问题 |
| E2E | ⏳ 未执行 | 前端纯客户端变更；修复后建议随集成环境回归 |

## 六、经验总结

- 「未配置环境变量」在本地与线上含义相反：本地是常态、线上是异常。环境相关回退分支必须显式区分 `import.meta.env.DEV` / `MODE`，不能仅按「env 是否为空」推断运行环境。
- 移除旧 fallback（`http://localhost:4000` / `http://localhost:4001`）属于隐式行为变更；单测按新设计编写无法暴露该回归，评审需逐点对照变更前默认值。
- 「不写缓存」的验收断言应同时覆盖内存态与持久态，避免失败结果被模块级变量等效缓存。
- 「失败不写缓存」类修复必须同步审视全部消费点：异步 resolve 入口与同步 `getApiBase()` 入口的返回值契约需要显式保持一致，否则一个入口的修复会把故障转移到另一个入口。

## 七、第二轮 AI Review 复核（2026-10-08，修复后）

**复核对象**：修复 commit `5922eb0`、文档回填 `4ca31b6`；差异范围 `integration..release`（merge-base `6908db4`..`integration` `4ca31b6`，15 个 commit、21 个文件、+1918 / -33）。

### 7.1 上轮 4 项问题修复核验（全部属实）

| 上轮问题 | 核验结论 | 证据 |
|---|---|---|
| 问题 1（阻塞）本地无 env 直连生产 | ✅ 已修复 | `api-base.ts:64-69`：`import.meta.env.DEV` 且无显式 env 时短路回落 agent `http://localhost:4000` / controller `http://localhost:4001`，跳过线上探测与 sessionStorage；`getApiBase()`（`api-base.ts:113-118`）同步 DEV 回落；T-B12 / T-B13 / T-B16 / T-C10 覆盖 |
| 问题 2（建议）失败固化 fallback | ✅ 已修复 | `api-base.ts:88-91`：catch 分支不写 `state.cached`、不写 sessionStorage；T-B11 / T-C11 断言失败后二次调用重新探测（fetch 2→4，二次成功后才写缓存） |
| 问题 3（建议）bootstrap 无兜底/加载态 | ✅ 已修复 | `main.tsx:22-35`：`bootstrap()` try/catch 降级 `VITE_API_URL \|\| ''` + 「加载中…」启动占位；`api-base.ts:27-43` sessionStorage 读写 try/catch（沙箱/隐私模式）；T-B15 覆盖 |
| 问题 4（可选）并发重复探测 | ✅ 已实现 | `api-base.ts:74,98` 模块级 `state.pending` 在途去重 + `finally` 清理（`api-base.ts:92-95`）；T-B14 / T-C12 断言并发两次调用仅一轮探测（fetch 2 次） |

本轮独立复跑验证：`npm test` **419/419 通过**（49 个文件，`api-base.test.ts` 28 项）、`npm run lint` **0 error / 6 warning**（均为未改动文件存量 warning）、`npm run build`（tsc -b + vite build）**通过**，与上游「验证结果」一致。README「手动启动」本地地址说明、技术方案 20260908 v1.1 / 20261008 v1.2 修订、验收报告回填均已核对无误。

### 7.2 本轮新发现问题

#### 问题 5（🔴 阻塞）探测失败回落时 `getApiBase()` 与 `resolveApiBase()` 返回值不一致，SSE 与工作区请求打到静态站点来源

**问题描述**：探测全部失败时，`resolveApiBase()` 按设计回落候选首项（`api-base.ts:88-91` `return fallback`），`main.tsx:28-34` 以该值创建 Apollo client；但同一页面生命周期内，`getApiBase()`（`api-base.ts:113-118`）因问题 2 修复后 `state.cached` 不再写入、生产构建又无 `VITE_API_URL`，最终兜底返回 `''`。`''` 意味着「同源相对路径」，而生产前端部署于 GitHub Pages（`.github/workflows/deploy-agent-web.yml`，静态站点来源并非任何 API 候选来源），导致以下消费点全部 404：

- `useSessionStream.ts:36`：EventSource `''/api/session/{id}/stream` → **会话 SSE 流完全不可用**；
- `SessionView.tsx:160`：同类 SSE 建连失败；
- `WorkspaceSection.tsx:60,177`：`''/graphql` fetch 失败。

即同一页面出现两套 API base（Apollo 走候选首项、SSE/工作区走静态站点来源），呈「GraphQL 可用、会话流 404」的部分故障，比整体不可用更难排查。

**触发场景**：启动时两个候选 `/health` 在 2s 内（`api-base.ts:78` `PROBE_TIMEOUT_MS`）全部失败或超时。本需求的核心目标场景即国内慢网络，2s 竞速超时并不罕见；一旦命中，`/graphql` 仍有回落（Apollo 可用），但会话流与工作区操作直至用户刷新页面前持续不可用，且刷新前无任何提示指向根因。

**根因分析**：问题 2 的修复（失败不写 `state.cached`）破坏了「渲染前 `state.cached` 必已置值、`getApiBase()` 必与 resolve 结果一致」这一隐含不变量。`getApiBase()` 的最终兜底 `''` 是为 vite dev 代理（`vite.config.ts` `/graphql`、`/api` proxy）准备的相对路径，在生产构建中从不是合法 API base。结果是「全部失败回落 `fallback`」的契约只对异步消费点（`main.tsx` Apollo、`mcp-proxy.ts`）成立，对同步消费点（SSE、工作区 fetch）不成立——问题 4 修复中把 fallback 从「固化」改为「仅本次生效」时，未同步为同步入口保留回落值。

**修复方案**（任选其一，要求两个入口返回值在同一页面生命周期内保持一致）：

1. **推荐**：`ResolverState` 增加 `lastResolved: string | null`，成功与回落均写 `lastResolved`（回落仍不写 `state.cached`、不写 sessionStorage，保持可重探）；`getApiBase()` 改为 `state.cached ?? state.lastResolved ?? env ?? (DEV ? local : '')`。
2. 或：`getApiBase()` 生产兜底返回 `AGENT_CANDIDATES[0]` 而非 `''`，使同步消费点与 `fallback` 一致；
3. 或：bootstrap 将解析结果经 context/props 注入消费点，废弃 `getApiBase()` 对环境的猜测。

补充单测：

- 探测全部失败后 `getApiBase()` 返回 `AGENT_CANDIDATES[0]`（而非 `''`），且再次 `resolveApiBase()` 仍可重探、重探成功后更新返回值（不因回落固化，回归问题 2 语义）；
- controller 侧同样覆盖同步/异步入口一致性；
- 按新契约调整 T-C9 现有 `''` 断言。

**当前状态**：❌ 待修复（本轮打回）。

### 7.3 本轮复核结论

除问题 5 外，`integration..release` 全量差异未发现其他新问题：`mcp-proxy.ts` 惰性解析与 `mcp-proxy.test.ts`（6 项）、`command-template.ts` cn 端点修正（旧域名 NXDOMAIN）、`deploy-agent-web.yml` 移除 env 注入、文档与实现一致性均合格。**本轮结论：打回返工**——请按 7.2 修复问题 5 后重新提交 Review（预计修复面极小：`api-base.ts` + `api-base.test.ts` 即可闭环）。

## 相关文档

- [[20260824-workflow-optimization-acceptance-report.md]]
