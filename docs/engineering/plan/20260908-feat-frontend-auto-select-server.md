---
description: 前端支持服务器自动选择 - 实现计划（从技术提案拆解的分阶段可执行任务与测试覆盖计划）
type: Permanent
---

# 前端支持服务器自动选择 - 实现计划

**关联 Proposal**: `proposals/20260908-feat-frontend-auto-select-server.md`（v1.0）
**关联 PRD**: `docs/product/draft/20260908-frontend-auto-select-server.md`（v1.0）
**feat-branch**: `prd/frontend-auto-select-server`
**创建日期**: 2026-09-08
**计划版本**: v1.0

## 实现顺序

```
Phase 1: api-base.ts 统一基址解析模块（TDD 核心）
  └── Phase 2: 启动引导与消费点收敛（apollo 工厂化 + main.tsx + 3 处消费点）
       └── Phase 3: 部署配置调整（deploy-agent-web.yml）
            └── Phase 4: 构建 / lint / 单测全量回归
                 └── Phase 5: 手工验证（本地 Aspire + 线上产物）
```

依赖说明：全部改动集中在 `apps/agent-web` + 一处 CI 配置，无后端与契约变更，采用单一开发分支 `apps/frontend-auto-select-server`（基于 `prd/frontend-auto-select-server`），完成后提 PR 回 `prd/frontend-auto-select-server` 待 review。Phase 1→2 有依赖（消费点依赖解析模块的导出），Phase 3 独立但同分支提交。开发模式采用 TDD（红-绿-重构）：Phase 1 先写 `api-base.test.ts` 全部用例（RED）再实现（GREEN）；编码前加载 `docs/engineering/common-rules.md` 与 `docs/engineering/frontend-rules.md`。

关键约束（提案 §5.2/§6.1，实现期不得回退）：

- `import.meta.env.VITE_API_URL` 非空时**直接返回该值**，不发起任何探测、不读写 sessionStorage（本地开发零影响）。
- 候选列表为模块内常量 `['https://api.zag.fffdan.com', 'https://zag-agent-api.fffdan.com']`，不新增环境变量配置项。
- 竞速策略为「首个返回 2xx 的探测胜出」，单次探测超时上限 2000ms；全部失败回落候选首项且**不写缓存**。
- 不引入新 npm 依赖；`VITE_CONTROLLER_API_URL` 相关逻辑（`src/api/mcp-proxy.ts`）保持不变。

已验证的外部依赖（2026-09-08 实测）：两个候选入口 `GET /health` 均返回 200，响应头 `access-control-allow-origin: https://dev.fffdan.com` 与线上站点 origin 一致，浏览器跨域探测可成功（提案 §5.2 实现点 1 风险点排除）。注意 ACAO 为单一指定 origin 而非 `*`，若线上站点改换域名需同步后端 `CORS_ORIGIN`（`servers/agent-api/src/config/index.ts:15`）。

---

## Phase 1: api-base.ts 统一基址解析模块

开发分支：`apps/frontend-auto-select-server`（基于 `prd/frontend-auto-select-server`）。

TDD 顺序：先写 `api-base.test.ts` 全部用例（RED）→ 实现 `api-base.ts`（GREEN）→ 重构清理（保持测试通过）。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/lib/api-base.ts` | 新增 | 模块内常量：`API_CANDIDATES = ['https://api.zag.fffdan.com', 'https://zag-agent-api.fffdan.com']`、`CACHE_KEY = 'zag:api-base'`、`PROBE_TIMEOUT_MS = 2000`。导出两个函数：① `resolveApiBase(): Promise<string>`——优先级：`VITE_API_URL` 非空 → 直接返回；sessionStorage 命中 → 返回缓存；否则对每个候选并发 `fetch(`${origin}/health`, { signal })`（`AbortController` + `setTimeout` 2000ms 触发 abort），首个 `res.ok` 者胜出并写入 sessionStorage（胜出后 abort 其余在途探测），全部失败/超时回落 `API_CANDIDATES[0]` 且不写缓存；解析结果同时存入模块级变量，重复调用直接复用不重复探测。② `getApiBase(): string`——同步读取，已解析返回解析值，未解析返回 `VITE_API_URL \|\| ''` 保守值（正常运行路径下渲染发生在 `await` 之后，不会命中未完成态） |
| `apps/agent-web/src/lib/api-base.test.ts` | 新增 | 用例 T-B1 ~ T-B8；mock `globalThis.fetch`，超时用例配合 `vi.useFakeTimers()`，环境变量用 `vi.stubEnv('VITE_API_URL', ...)`，每个用例后 `vi.unstubAllEnvs()` + `sessionStorage.clear()` + 重置模块（`vi.resetModules()` + 动态 `import`）保证模块级缓存隔离 |

### 测试用例

| # | 用例 | 预期 |
|---|------|------|
| T-B1 | `VITE_API_URL` 已设置（如 `http://localhost:4000`） | 直接返回该值；`fetch` 未被调用；sessionStorage 无读写 |
| T-B2 | 无环境变量，sessionStorage 已有 `zag:api-base` | 返回缓存值；`fetch` 未被调用 |
| T-B3 | 无环境变量无缓存，两入口均 200，候选一先返回 | 选中候选一并写入 sessionStorage；候选二探测被 abort |
| T-B4 | 候选一网络错误（reject），候选二 200 | 选中候选二并写入 sessionStorage |
| T-B5 | 候选一返回 500（非 2xx），候选二 200 | 选中候选二并写入 sessionStorage |
| T-B6 | 两入口均失败 | 返回 `API_CANDIDATES[0]`；sessionStorage 无写入 |
| T-B7 | 探测挂起不返回，fake timers 推进 2000ms | 触发 abort 按失败处理；两入口均超时后回落候选首项 |
| T-B8 | 连续两次 `resolveApiBase()` | 第二次复用模块级结果，`fetch` 仅首轮调用 |

### 命令参考

```bash
cd apps/agent-web && npx vitest run src/lib/api-base.test.ts
```

### 验收 checklist

- [ ] T-B1 ~ T-B8 全部通过
- [ ] 模块无新增 npm 依赖，TypeScript strict 编译通过

---

## Phase 2: 启动引导与消费点收敛

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/lib/apollo.ts` | 修改 | 模块级 `export const client` 改为导出工厂 `createApolloClient(apiBase: string): ApolloClient`；`HttpLink` 的 `uri` 用 `${apiBase}/graphql`（`apollo.ts:25` 不再直读 `import.meta.env`）；`errorLink` / `authLink` 逻辑原样保留。全仓仅 `main.tsx` 一处 import `client`（已 grep 确认），无其他调用点受影响 |
| `apps/agent-web/src/main.tsx` | 修改 | 改为 async 引导：`const apiBase = await resolveApiBase()` → `createApolloClient(apiBase)` → `createRoot(...).render(...)`；顶层 `bootstrap()` 调用，失败不阻断渲染（`resolveApiBase` 内部已兜底，不会 reject） |
| `apps/agent-web/src/hooks/useSessionStream.ts` | 修改 | :35 `import.meta.env.VITE_API_URL \|\| 'http://localhost:4000'` → `getApiBase()` |
| `apps/agent-web/src/components/session/SessionView.tsx` | 修改 | :159 `import.meta.env.VITE_API_URL \|\| ''` → `getApiBase()` |
| `apps/agent-web/src/components/settings/WorkspaceSection.tsx` | 修改 | :59、:157 两处 `import.meta.env.VITE_API_URL \|\| 'http://localhost:4000'` → `getApiBase()` |
| 受影响既有测试（如 `components/settings/__tests__/WorkspaceSection.test.tsx`） | 修改 | 若断言依赖 `import.meta.env.VITE_API_URL` 直读，改为 `vi.mock('@/lib/api-base')` 或 `vi.stubEnv` 对齐新取值口径；仅做接口对齐，不改既有断言逻辑 |

### 行为变化说明（实现与验证时确认）

- 统一后 fallback 口径变化：原 `|| 'http://localhost:4000'` / `|| ''` 两种分散兜底取消。无 `VITE_API_URL` 且解析完成时，`getApiBase()` 返回选中/缓存/回落的候选 origin。
- 裸 `npm run dev`（不注入 `VITE_API_URL`）将走线上候选探测路径，不再命中 vite proxy 相对路径兜底——本项目统一经 Aspire 启动（`aspire/AgentGear.AppHost/AppHost.cs:84-86` 注入 `VITE_API_URL`），该路径探测被跳过，行为不变；裸 dev 属非支持路径，变化可接受。

### 命令参考

```bash
cd apps/agent-web && npm run build && npm run lint && npm run test
```

### 验收 checklist

- [ ] 构建 / lint / 单测全绿（含调整后的既有测试）
- [ ] `grep -r "import.meta.env.VITE_API_URL" apps/agent-web/src` 仅剩 `api-base.ts` 一处直读
- [ ] Apollo / SSE / fetch 三类消费点统一走解析后基址

---

## Phase 3: 部署配置调整

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `.github/workflows/deploy-agent-web.yml` | 修改 | :42 移除 `VITE_API_URL: https://zag-agent-api.fffdan.com` 注入，让线上产物进入自动选择路径；`:43 VITE_CONTROLLER_API_URL` 与 `:44 VITE_BASE_URL` 保留不变 |

### 验收 checklist

- [ ] workflow YAML 语法正确，仅移除一行 `VITE_API_URL` 注入
- [ ] 线上构建产物中 `import.meta.env.VITE_API_URL` 为空（进入探测路径）

---

## Phase 4: 构建 / lint / 单测全量回归

```bash
cd apps/agent-web && npm run build && npm run lint && npm run test
```

### 验收 checklist

- [ ] 全量单测（含新增 T-B1 ~ T-B8 与既有套件）通过
- [ ] 生产构建成功，无 TypeScript / lint 错误

---

## Phase 5: 手工验证

对照 PRD §1.3 成功标准与提案 §10：

1. **本地开发零影响**：`aspire start` 编排启动（注入 `VITE_API_URL`），DevTools Network 面板确认无任何对两个候选入口 `/health` 的探测请求，全部 API / SSE 请求发往注入地址
2. **线上自动选择**：`npm run build && npm run preview`（不注入 `VITE_API_URL`）或线上环境，DevTools 可观测到对两个候选 `/health` 的并发探测，后续 `/graphql`、`/api/session/{id}/stream` 均发往测速最快入口；刷新页面（同会话 tab 内 sessionStorage 命中）不再重复探测
3. **单入口兜底**：DevTools 阻断其中一个候选域名后刷新（新 tab），站点自动使用另一入口，登录与会话功能正常
4. **双入口不可达**：阻断两个候选域名后刷新（新 tab），约 2s 后按默认入口（候选首项）发起请求并正常报错，表现不劣于现状
5. **CI 产物**：合并后触发 `deploy-agent-web.yml`（release 分支），确认线上站点实际走自动选择

### 验收 checklist

- [ ] 上述 5 项手工验证全部通过

---

## 总验收 checklist（对照提案 §10 / PRD §1.3）

- [ ] 线上环境实际请求的入口为两个候选入口中测速最快且可用者（DevTools 可观测）
- [ ] 阻断一个入口后自动使用另一入口，站点功能正常
- [ ] 两个入口均不可达时回落默认入口，错误表现不劣于现状
- [ ] 本地 `VITE_API_URL` 指定地址时无任何探测请求，全部请求发往指定地址
- [ ] `api-base.ts` 单元测试 T-B1 ~ T-B8 全部通过，既有测试无回归
- [ ] 候选列表、超时上限、缓存 key 等取值与提案 §5.2 一致，无新增配置项
- [ ] `VITE_CONTROLLER_API_URL` 相关逻辑未受影响
- [ ] `apps/frontend-auto-select-server` 开发分支 PR review 通过并合并回 `prd/frontend-auto-select-server`
