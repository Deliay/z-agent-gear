---
description: integration→release 集成验收报告——前端 API 自动选择与国内加速（PR #199）AI Review 轮次，记录发现的问题、根因、修复要求与验证结果
type: Permanent
---

# 前端 API 自动选择与国内加速 集成验收报告

> **状态**: 🔴 返工中 —— AI Review 轮次共发现 4 个问题（1 个阻塞、2 个建议、1 个可选），整体未通过，已打回返工；修复 commit 待回填。

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

**验证结果**：⏳ 待返工修复后验证。要求：单测覆盖「DEV + 无 env → localhost、不发起探测」，且全量 `npm test`（当前 410 项）/ `npm run lint` / `npm run build` 通过。

### 问题 2（🟡 建议）探测全部失败后 fallback 被内存固化，页面生命周期内不再重试

**问题描述**：`apps/agent-web/src/lib/api-base.ts:59` catch 分支执行 `state.cached = fallback`，而入口 `api-base.ts:32` 以 `if (state.cached) return state.cached` 短路。启动瞬间一次网络抖动导致探测全部失败后，本页面后续调用直接返回 `fallback`（候选首项），即使另一候选已恢复可用也不再探测。与实现计划「全部失败/超时回落 `fallback` **且不写缓存**」的意图不完全一致（sessionStorage 未写，但内存态等效于缓存）。

**根因分析**：失败态与成功态复用同一个 `state.cached` 字段，未区分「已解析成功」与「已失败回落」。

**修复方案**：catch 分支不写 `state.cached`（保持可重探），或为失败态记录时间戳做有限次数重试；补充「失败后再次调用可重探」单测。

**验证结果**：⏳ 待返工修复后验证。

### 问题 3（🟡 建议）bootstrap() 无异常兜底与加载反馈

**问题描述**：`apps/agent-web/src/main.tsx:9` 的 `bootstrap()` 无 `try/catch`。若 `resolveApiBase()` 抛出未捕获异常（如隐私模式/沙箱环境下 `sessionStorage` 访问抛 `SecurityError`，`api-base.ts:39` 直接调用无保护），Promise reject 无人处理，页面**白屏且无任何提示**。另外探测路径下启动期最长约 2s 无渲染内容，也没有 loading 占位。

**根因分析**：bootstrap 缺少降级路径与启动期 UI。

**修复方案**：`bootstrap()` 内 `try/catch`，异常时以 `import.meta.env.VITE_API_URL || ''` 降级渲染；可选在解析期间渲染 loading 占位。

**验证结果**：⏳ 待返工修复后验证。

### 问题 4（🟢 可选）并发调用无在途去重，重复探测

**问题描述**：`resolveBase` 仅以 `state.cached` 去重。首屏 `mcp-proxy.ts` 三个函数（或未来多消费点）并发调用 `resolveControllerApiBase()` 且缓存未命中时，会各自发起一轮候选探测，产生重复请求（功能正确，仅浪费探测）。

**根因分析**：未缓存 in-flight Promise。

**修复方案**：以模块级 `pending: Promise<string> | null` 去重，`finally` 中清理。

**验证结果**：⏳ 可选优化，不阻塞本轮返工。

## 三、修复总览

| # | 问题 | 根因 | 状态 | 修复 commit |
|---|------|------|------|-------------|
| 1 | 本地无 env 时探测并直连生产 API | 未区分 DEV，本地回落被移除 | 🔴 待修复（阻塞） | 待回填 |
| 2 | 探测失败后内存固化 fallback | 失败态复用 `state.cached` | 🟡 待修复（建议） | 待回填 |
| 3 | bootstrap 无异常兜底/加载态 | 缺少降级路径 | 🟡 待修复（建议） | 待回填 |
| 4 | 并发 resolve 重复探测 | 未去重 in-flight Promise | 🟢 可选 | 待回填 |

## 四、本轮已核实通过项

- 实现与技术方案/实现计划一致：`resolveBase` 参数化、`Promise.any` 竞速首个 2xx 胜出、2s 超时 abort、胜出后 abort 其余探测、sessionStorage 会话级缓存、失败不写 sessionStorage、`getApiBase()` 保守回落（含 T-C9 覆盖）均为方案明确设计。
- `command-template.ts` cn 端点由 `https://ctrl.zag.cn.fffdan.com` 改为 `https://ctrl.zag.fffdan.com` 属正确修复（实现计划记录旧域名实测 NXDOMAIN），测试同步更新，仓库无旧域名残留。
- `deploy-agent-web.yml` 移除 `VITE_API_URL` / `VITE_CONTROLLER_API_URL` 与方案 v1.1 一致；`grep` 确认 `apps/agent-web/src` 仅 `api-base.ts` 直读这两个变量。
- 探测端点均有 `/health` 路由（`servers/agent-api/src/index.ts:52`、`servers/controller-api/src/index.ts:32`）。
- 文档完整：2 份技术方案、2 份实现计划、1 份 PRD，`docs/engineering/AGENTS.md` 索引同步更新；方案 v1.1 修订与最终实现对齐。

## 五、最终验证

| 项目 | 结果 | 说明 |
|------|------|------|
| 单元测试 | ✅ 410/410 通过（49 个文件） | 含新增 `api-base.test.ts` 19 项、`mcp-proxy.test.ts` 6 项 |
| Lint | ✅ 0 error / 6 warning | 6 个 warning 均位于本次未改动文件（TodoListPanel、NewSessionDialog、HistorySessionDialog、InstantiateWorkflowDialog），为存量问题 |
| Build（tsc -b + vite build） | ✅ 通过 | chunk 体积告警为存量问题 |
| E2E | ⏳ 未执行 | 本轮为 `integration..release` 代码评审；前端纯客户端变更，E2E 建议在问题 1 修复后随集成环境回归 |

## 六、经验总结

- 「未配置环境变量」在本地与线上含义相反：本地是常态、线上是异常。环境相关回退分支必须显式区分 `import.meta.env.DEV` / `MODE`，不能仅按「env 是否为空」推断运行环境。
- 移除旧 fallback（`http://localhost:4000` / `http://localhost:4001`）属于隐式行为变更；单测按新设计编写无法暴露该回归，评审需逐点对照变更前默认值。
- 「不写缓存」的验收断言应同时覆盖内存态与持久态，避免失败结果被模块级变量等效缓存。

## 相关文档

- [[20260824-workflow-optimization-acceptance-report.md]]
