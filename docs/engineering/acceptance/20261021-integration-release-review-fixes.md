---
description: integration→release 集成验收首轮打回返工报告：A-1 前台 GraphQL 数据层收口后台供应商名、B-1 导入成功误报失败、B-2 取消语义回写 PRD v1.2 + C 组 15 项收口；含独立复跑 tsc/lint/单测 2087/API 443/E2E 20/20 证据
type: Permanent
---

# integration→release 集成验收返工报告（2026-10-21，第二轮提交）

> **对应首轮结论**：`docs/engineering/acceptance/20261021-integration-release-acceptance-report.md`（REJECT，3 × 🟠 + 15 × 🟡）
> **返工路线**：B-2 选择「路线 ②：PRD v1.2 如实收窄 + 测试锁定实际行为」；其余按报告建议逐项修复。
> **验证方式**：本机独立复跑（不采信自报），Aspire `--isolated` 全新栈（独立端口/全新 Mongo/Redis），避免首轮同机双栈固定端口冲突。

## 一、🟠 必须修复项

### A-1 前台 GraphQL 泄漏后台供应商名称 / providerId

**修复**：

| 位置 | 变更 |
|---|---|
| `servers/agent-api/src/graphql/resolvers/model.ts` | `Model.provider` 对 `scope==='global'` 直接返回 `null`（不查库）；`Model.providerId` 对 global 同步返回 `null` |
| `servers/agent-api/src/services/provider.ts` | `findSummaryById` 增加 global 兜底：即使未来新调用方绕过 resolver，也不会返回后台供应商摘要 |
| `servers/agent-api/src/graphql/schemas/model.ts`、`contracts/llm.graphql` | `providerId` 改为可空并注明 global 掩蔽；`provider` 注释补「global 固定返回 null」 |
| `tests/api/src/agent-api/llm.test.ts` | T-SC5 改写：global 模型断言 `provider===null && providerId===null`；同一用例自建 user 供应商，断言 user 模型仍返回自身供应商摘要（含 name，键集不含 endpoint/凭据） |
| `servers/agent-api/src/graphql/resolvers/model.test.ts`、`services/provider.test.ts` | 新增 global 返回 null / 不触发查询 / providerId 掩蔽断言 |
| `apps/agent-web/src/graphql/types.ts`、`settings/ModelSection.tsx`、`ModelItem.tsx` | `providerId` 类型改为 `string \| null`；分组仅对 user 模型使用 providerId |

**可证伪点**：修复后 `query { models { providerId provider { name } } }` 中 global 模型两项均为 `null`；若回退任一层，T-SC5 立即变红。

### B-1 导入成功后 refetch 失败被误报为「导入失败」

**修复**（`apps/admin-web/src/components/models/ImportModelsDialog.tsx`）：

1. 导入主流程与「刷新清单」副作用分离异常通道：mutation 结果先落 `result`/toast，再单独 `try/catch` refetch；refetch 失败仅 `console.warn`，不覆盖成功反馈。
2. 导入开始时捕获 `targetProviderId`；异步回包后若弹窗已关闭或已切换供应商，直接跳过 refetch（关闭场景不再用失效变量刷新）。
3. `importingRef` 防在途双击（loading 渲染前的连点只发一次请求）。

**测试**：`T-W18`（import resolve + refetch reject → 仅成功反馈、无错误 toast）；`T-W19`（导入中关闭 → 不 refetch、不误报；重开以服务端结果为准）；`T-W20`（连点只发一次）；`T-W21`（`error && data` 时导入按钮仍可用，C-2）。

### B-2 导入取消语义：回写 PRD v1.2 + 测试锁定

**路线 ②（如实收窄）**：

- PRD 升级 v1.2：功能点 1、§3.4、§3.5、§4.2 同步修订为「单次批量提交；关闭弹窗不中止服务端已开始的写入；重开以服务端结果为准（已导入项标记、勾选清零）」，删除「未开始的不执行」承诺。
- 提案/计划同步 v1.2 / v1.1，计划裁决 17 标注已回写 PRD，不再存在「单方面收窄」。
- 测试：`T-W19` 锁定「导入中关闭 → 重开勾选清零 + 已导入禁选（以服务端数据为准）」，E2E `T-E22/T-E23` 继续覆盖重开后的「已导入」标记。

## 二、🟡 C 组收口（15/15）

| # | 状态 | 修复/证据 |
|---|---|---|
| C-1 | ✅ | `ModelSection.handleDragEnd` 改用全局顺序 `modelsRef` 原位替换被拖拽组片段；`T-W23` 用交错多组数据断言 `['b','x','a','y']`（旧实现会得到 `['b','a','x','y']`） |
| C-2 | ✅ | 导入按钮禁用条件改为 `error && !data`；`T-W21` |
| C-3 | ✅ | 弹窗内 `role=status/alert` 持久展示成功/失败明细；`T-W22` 断言失败文案持续存在 |
| C-4 | ✅ | 新建自定义模型 `refetchQueries` 增加 `ADMIN_PROVIDERS`；`T-W24` |
| C-5 | ✅ | `ImportGlobalModelsMutation` 改为 `AdminProviderModelData[]`，与选择集一致 |
| C-6 | ✅ | T-MR1 台账为空时 `ctx.skip()` 并注明由迁移单测自建数据覆盖，消除空集假绿 |
| C-7 | ✅ | T-E21 删除对 4s toast 的断言，改断言持久文案「0 个模型」 |
| C-8 | ✅ | T-E23 按供应商名定位行，删除 `waitForTimeout(50)` 与 `.first()` |
| C-9 | ✅ | `settings-llm.spec.ts` 将「无删除入口」断言收敛到系统内置模型行，避免未展开用户组导致恒真 |
| C-10 | ✅ | 契约 `importGlobalModels` 注释、服务 JSDoc、PRD §3.5 均声明「仅上游连通性门禁 + 全局重名校验，不按上游清单白名单校验」 |
| C-11 | ✅ | 迁移 005 改为先按 `(modelId, batchId)` 幂等 upsert 台账、再改名；`T-MIG38` 用 `invocationCallOrder` 锁定先记账后改名 |
| C-12 | ✅ | 新增多组 fullIds、在途双击、导入后禁选、用户组删除/启停/拖拽正向能力、`groupsRef` 最新闭包（admin-web `T-W18~24`、agent-web `T-AW9/T-AW10`） |
| C-13 | ✅ | 前台空态恢复为「暂无可用模型，添加供应商后自动同步模型」 |
| C-14 | ✅ | 删除 mock-server 不可达的 Anthropic `x-api-key` 分支及死常量 |
| C-15 | ✅ | Base UI 禁用态仍以 `aria-disabled` 断言；本轮 E2E 20/20 实跑通过，与单测同口径 |

## 三、独立验证结果（本机复跑）

| 层级 | 结果 |
|---|---|
| tsc | admin-api 0 / agent-api 0 / admin-web 0 / agent-web 0 |
| eslint | admin-web 0 error / agent-web 0 error（6 条存量 warning，均在本 diff 外） |
| 单测/组件 | **2087 passed / 1 skipped**：admin-api 562、agent-api 661、cloud-controller 197、admin-web 227、agent-web 440 |
| tests/api | **443 passed / 22 skipped / 0 failed（465）**（Aspire `--isolated` 全新栈；skip 为需真实 Docker/K8s 的用例 + 空台账 T-MR1） |
| tests/e2e | **20 passed / 0 failed**（`admin-model-config.spec.ts` + `settings-llm.spec.ts`） |
| 迁移 005 | 全新栈启动执行成功；重名整理/台账路径由 T-MIG30~38 自建数据覆盖 |

### 3.1 环境说明（回应首轮经验 6）

- 本轮使用 `aspire start --isolated`：服务/Mongo/Redis/RabbitMQ 全部随机端口，避免与同机另一工作流栈的 `10001/10003/10004` 冲突。
- `tests/api` 与 `tests/e2e` 均显式注入本栈实际监听端口与 `MONGODB_URI`/`ADMIN_INITIAL_PASSWORD`，未复用固定端口默认值。
- 未手工改写共享状态；每轮验证前重建栈拿全新库。

## 四、结论

首轮 3 × 🟠 全部闭环，15 × 🟡 全部收口；T-SC5 已改为可证伪的数据层断言，B-1/B-2 有单测锁定实际行为。提交第二轮复核。
