---
description: Web 国内加速 API 接入（Controller API 自动选择）- 实现计划，从技术提案拆解的分阶段可执行任务与测试覆盖计划
type: Permanent
---

# Web 国内加速 API 接入（Controller API 自动选择） - 实现计划

**关联 Proposal**: `proposals/20261008-feat-domestic-api-acceleration.md`（v1.1）
**关联 PRD**: 无（工程优化需求）
**feat-branch**: `feat/domestic-api-acceleration`
**开发分支**: `impl/domestic-api-acceleration`（基于 `feat/domestic-api-acceleration`）
**创建日期**: 2026-10-08
**计划版本**: v1.1

## 版本变更

- **v1.1（2026-10-08）**：按 review 意见调整——`VITE_CONTROLLER_API_URL` 确认为「本地 Aspire 注入本地地址」用途，CI 注入移除；controller 解析由「启动期并行阻塞」改为「首次使用惰性解析」（`mcp-proxy.ts` 内 `await`），`main.tsx` 不再改动。同步补充 CI 移除的影响评估（见 Phase 4）。

## 实现顺序

```
Phase 1: api-base.ts 泛化为多服务解析器（TDD 核心）
  └── Phase 2: 消费点接入（mcp-proxy.ts 首次调用 await 解析）
       └── Phase 3: 命令模板国内地址修正
            └── Phase 4: 部署配置调整（deploy-agent-web.yml）
                 └── Phase 5: 构建 / lint / 单测全量回归
                      └── Phase 6: 手工验证（本地 Aspire + 线上产物）
```

依赖说明：全部改动集中在 `apps/agent-web` + 一处 CI 配置，无后端与契约变更，采用单一开发分支 `impl/domestic-api-acceleration`（基于 `feat/domestic-api-acceleration`），完成后提 PR 回 `feat/domestic-api-acceleration` 待 review。Phase 1→2 有依赖（消费点依赖解析模块导出），Phase 3 独立但同分支提交。开发模式采用 TDD（红-绿-重构）：Phase 1 先写 `api-base.test.ts` 增量用例（RED）再实现（GREEN）；编码前加载 `docs/engineering/common-rules.md` 与 `docs/engineering/frontend-rules.md`。

关键约束（提案 §5.2/§6.1，实现期不得回退）：

- 泛化后 **agent-api 行为保持不变**：`VITE_API_URL` 非空直接返回且不探测；候选仍为 `['https://api.zag.fffdan.com', 'https://zag-agent-api.fffdan.com']`；缓存 key 仍为 `zag:api-base`；`getApiBase()` 未解析回落 `VITE_API_URL || ''`。
- controller 候选常量固定为 `['https://ctrl.zag.fffdan.com', 'https://zag-ctrl-api.fffdan.com']`，缓存 key `zag:controller-api-base`，不新增环境变量配置项。
- controller 解析为**惰性**：`main.tsx` 不改动，`mcp-proxy.ts` 三个函数首次调用时 `await resolveControllerApiBase()`；不导出同步 `getControllerApiBase()`。
- 竞速策略统一为「首个返回 2xx 的探测胜出」，单次探测超时上限 2000ms；全部失败回落候选首项且**不写 sessionStorage**。
- 不引入新 npm 依赖；不改后端、不改 contracts。
- 命令模板保持 global/cn 静态选项；仅将 cn 域名由 `https://ctrl.zag.cn.fffdan.com` 改为 `https://ctrl.zag.fffdan.com`。

已验证的外部依赖（2026-10-08 实测）：`ctrl.zag.fffdan.com`、`zag-ctrl-api.fffdan.com` 的 `GET /health` 均返回 200 且 `access-control-allow-origin: *`，浏览器跨域探测可成功（提案 §1.2.2）；`ctrl.zag.cn.fffdan.com` 为 NXDOMAIN，确认需替换。

---

## Phase 1: api-base.ts 泛化为多服务解析器

开发分支：`impl/domestic-api-acceleration`（基于 `feat/domestic-api-acceleration`）。

TDD 顺序：先写 `api-base.test.ts` 增量用例（RED）→ 重构实现 `api-base.ts`（GREEN）→ 保持存量 T-B* 全绿。

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/lib/api-base.ts` | 修改 | 抽出参数化 `resolveBase`：入参 `{ candidates, envUrl, cacheKey, fallback, state }`，`state = { cached: string \| null }` 由各封装持有以实现独立缓存。优先级：`envUrl` 非空 → 直接返回且不探测；`sessionStorage.getItem(cacheKey)` 命中 → 返回缓存；否则对每个候选并发 `fetch(`${origin}/health`, { signal })`（`AbortController` + `setTimeout` 2000ms 触发 abort），首个 `res.ok` 者胜出、abort 其余、写 sessionStorage；全部失败/超时回落 `fallback` 且不写缓存。导出三个函数：`resolveApiBase` / `getApiBase`（agent，候选 `['https://api.zag.fffdan.com','https://zag-agent-api.fffdan.com']`，key `zag:api-base`，未解析回落 `VITE_API_URL \|\| ''`，行为与现状一致）、`resolveControllerApiBase`（controller，候选 `['https://ctrl.zag.fffdan.com','https://zag-ctrl-api.fffdan.com']`，key `zag:controller-api-base`，回落候选首项，幂等） |
| `apps/agent-web/src/lib/api-base.test.ts` | 修改 | 追加 controller 与独立性用例 T-C1 ~ T-C7；沿用现有 mock 方式（`vi.stubGlobal('fetch')`、`vi.useFakeTimers()`、`import.meta.env` 注入、`vi.resetModules()` + 动态 import 重置模块缓存） |

### 测试用例（增量）

| # | 用例 | 预期 |
|---|------|------|
| T-C1 | 设置 `VITE_CONTROLLER_API_URL`（如 `http://localhost:4001`） | `resolveControllerApiBase()` 直接返回该值；`fetch` 未被调用；sessionStorage 无读写 |
| T-C2 | 无 env，sessionStorage 已有 `zag:controller-api-base` | 返回缓存值；`fetch` 未被调用 |
| T-C3 | 无 env 无缓存，`ctrl.zag` 先于 `zag-ctrl-api` 返回 200 | 选中 `ctrl.zag.fffdan.com` 并写入 sessionStorage |
| T-C4 | 无 env，`ctrl.zag` 返回 500，`zag-ctrl-api` 200 | 选中 `zag-ctrl-api.fffdan.com` 并写入 sessionStorage |
| T-C5 | 无 env，两入口均失败 | 返回候选首项 `ctrl.zag.fffdan.com`；sessionStorage 无写入 |
| T-C6 | 无 env，两入口均挂起，fake timers 推进 2000ms | abort 后回落候选首项；sessionStorage 无写入 |
| T-C7 | 同时调用 `resolveApiBase()` 与 `resolveControllerApiBase()`，两者最快入口不同 | 各自返回自己的最快入口；两缓存 key 各自独立 |
| T-C8 | 连续两次 `resolveControllerApiBase()` | 第二次复用模块级结果，`fetch` 仅首轮调用 |

### 命令参考

```bash
cd apps/agent-web && npx vitest run src/lib/api-base.test.ts
```

### 验收 checklist

- [ ] 存量 T-B1 ~ T-B10 全部通过（agent 行为无回归）
- [ ] 增量 T-C1 ~ T-C8 全部通过
- [ ] 两组解析器缓存互不影响；TypeScript strict 编译通过

---

## Phase 2: 消费点接入（controller 惰性解析）

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/api/mcp-proxy.ts` | 修改 | 删除模块级 `const CONTROLLER_API_URL = ...`；新增 `import { resolveControllerApiBase } from '../lib/api-base'`；`fetchMcpProxyKeys` / `createMcpProxyKey` / `revokeMcpProxyKey` 三个函数内部先 `const base = await resolveControllerApiBase()`，再以 `${base}/api/mcp-proxy-keys...` 发起请求；headers / method / body 与现状保持一致 |
| `apps/agent-web/src/api/__tests__/mcp-proxy.test.ts` | 新增 | `vi.mock('@/lib/api-base')` 固定 `resolveControllerApiBase()` 返回值，mock `fetch`，断言三个函数请求 URL 前缀为解析后的基址、`x-user-id` header 与 method / body 与现状一致；并覆盖「解析返回不同基址时请求随之改变」 |
| `apps/agent-web/src/main.tsx` | **不改动** | 首屏仍只 `await resolveApiBase()` 解析 agent-api，不为 controller 增加阻塞 |

### 行为变化说明（实现与验证时确认）

- `mcp-proxy.ts` 由「模块加载期读取常量」改为「首次调用 `await` 解析」，探测只在首次使用 MCP 代理功能时发生，且模块级缓存 + sessionStorage 保证只探测一次。
- 生产构建移除 `VITE_CONTROLLER_API_URL` 后无任何「未解析 fallback 命中 localhost」的窗口（消费点自身 await）。

### 命令参考

```bash
cd apps/agent-web && npm run build && npm run lint && npm run test
```

### 验收 checklist

- [ ] 构建 / lint / 单测全绿（含新增 mcp-proxy 测试）
- [ ] `grep -rn "VITE_CONTROLLER_API_URL" apps/agent-web/src` 仅剩 `api-base.ts` 一处直读
- [ ] 三个 mcp-proxy 函数请求基址均来自 `resolveControllerApiBase()`
- [ ] `main.tsx` 无改动

---

## Phase 3: 命令模板国内地址修正

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/lib/command-template.ts` | 修改 | `ENDPOINTS.cn` 由 `https://ctrl.zag.cn.fffdan.com` 改为 `https://ctrl.zag.fffdan.com`；`global` 不变 |
| `apps/agent-web/src/lib/command-template.test.ts` | 修改 | npm / pnpm / bun / pm2 四组 cn 用例断言中的域名同步替换 |
| `apps/agent-web/src/components/common/__tests__/CommandTemplate.test.tsx` | 修改 | cn 端点断言同步替换（实现期发现的存量断言） |

### 命令参考

```bash
cd apps/agent-web && npx vitest run src/lib/command-template.test.ts
```

### 验收 checklist

- [ ] 全部命令模板用例通过
- [ ] 生成的 cn 启动命令与服务端点均为 `https://ctrl.zag.fffdan.com`

---

## Phase 4: 部署配置调整

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `.github/workflows/deploy-agent-web.yml` | 修改 | :42 移除 `VITE_CONTROLLER_API_URL: https://zag-ctrl-api.fffdan.com` 注入，让线上产物进入 controller 自动选择路径；保留 `VITE_BASE_URL` |

### `VITE_CONTROLLER_API_URL` 影响评估（提案 §5.2 实现点 4）

该变量设计本意是「本地开发由 Aspire 注入本地 controller 地址」（`AppHost.cs:85`）。解析器「env 优先」，CI 中把它当生产固定地址注入会**直接短路自动选速**，必须移除。全仓读取方核查：

| 读取方 | 类型 | 移除 CI 注入后 |
|--------|------|---------------|
| `aspire/AgentGear.AppHost/AppHost.cs:85` | 本地开发注入 | 保留，本地行为不变 |
| `.github/workflows/deploy-agent-web.yml:42` | 线上固定注入 | 移除（本次目标） |
| `apps/agent-web/src/api/mcp-proxy.ts:1` | 唯一前端消费点 | 改为 `await resolveControllerApiBase()` |
| `vite.config.ts` | — | 未使用该变量，无影响 |
| 后端 / `agent-controller` CLI | — | 使用 `ZAG_SERVER_ENDPOINT`，与该 Vite 变量无关 |

### 验收 checklist

- [ ] workflow YAML 语法正确，仅移除一行 `VITE_CONTROLLER_API_URL` 注入
- [ ] 线上构建产物中 `import.meta.env.VITE_CONTROLLER_API_URL` 为空（进入探测路径）
- [ ] `AppHost.cs` 的本地注入未改动

---

## Phase 5: 构建 / lint / 单测全量回归

```bash
cd apps/agent-web && npm run build && npm run lint && npm run test
```

### 验收 checklist

- [ ] 全量单测（含新增 T-C*、mcp-proxy、既有套件）通过
- [ ] 生产构建成功，无 TypeScript / lint 错误

---

## Phase 6: 手工验证

对照提案 §10：

1. **本地开发零影响**：`aspire start` 编排启动（注入 `VITE_API_URL` 与 `VITE_CONTROLLER_API_URL`），DevTools Network 面板确认无任何对四个候选入口 `/health` 的探测请求，API / SSE / controller 请求均发往注入地址
2. **线上自动选择（controller）**：`npm run build && npm run preview`（不注入两个 `VITE_*_API_URL`）或线上环境，进入设置页触发 MCP 代理键加载，DevTools 可观测到对 controller 两个候选各一次 `/health` 并发探测，随后 `/api/mcp-proxy-keys` 发往选中的最快入口；刷新页面（同会话 tab 内）不再重复探测；首屏加载阶段无 controller 探测
3. **单入口兜底**：DevTools 阻断其中一个 controller 候选域名后刷新（新 tab），MCP 代理键管理自动使用另一入口，功能正常
4. **双入口不可达**：阻断 controller 两个候选域名后刷新（新 tab），约 2s 后按候选首项发起请求并正常报错，表现不劣于现状
5. **命令模板**：设置页生成 MCP 代理键，选「国内」时命令中的 `--server` 为 `https://ctrl.zag.fffdan.com`，`curl <该地址>/health` 返回 200
6. **CI 产物**：合并后触发 `deploy-agent-web.yml`（release 分支），确认线上站点实际走自动选择

### 验收 checklist

- [ ] 上述 6 项手工验证全部通过

---

## 总验收 checklist（对照提案 §10）

- [ ] agent-api 既有自动选择行为无回归（T-B* 全绿）
- [ ] controller-api 首次使用 MCP 代理功能时对两个候选测速并选用最快可用者（DevTools 可观测），且不阻塞首屏
- [ ] 阻断一个 controller 入口后自动使用另一入口，MCP 代理键管理功能正常
- [ ] 两个 controller 入口均不可达时回落国内加速入口，错误表现不劣于现状
- [ ] 本地两个 `VITE_*_API_URL` 指定地址时无任何探测请求，请求均发往指定地址
- [ ] `api-base.ts` 单元测试 T-B* + T-C* 全部通过，既有测试无回归
- [ ] 命令模板「国内」生成的启动命令指向可用的 `https://ctrl.zag.fffdan.com`
- [ ] 候选列表、超时上限、缓存 key 等取值与提案 §5.2 一致，无新增配置项
- [ ] `impl/domestic-api-acceleration` 开发分支 PR review 通过并合并回 `feat/domestic-api-acceleration`
