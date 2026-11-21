---
description: 仓库知识库搜索路径扩展实现计划：agent-gear 2.23.0 新增第三来源 docs-root（docs 一层文件夹、跳过 knowledges 容器）+ 契约 §3.29/§3.30 与 GraphQL 枚举 DOCS_ROOT + agent-api 来源映射/声明序/指引防漂移 + agent-web 来源标识；含 F1~F9 代码事实、D1~D6 裁决、T-RKB3-SCAN/SVC/GQL/WEB/API/E2E 测试矩阵与回归清单
type: Permanent
---

# 仓库知识库搜索路径扩展（docs 一层文件夹） - 实现计划

**功能名称**: 仓库知识库搜索路径扩展（docs 一层文件夹）
**关联提案**: [[../proposals/20261121-feat-knowledge-base-docs-root.md]]
**关联 PRD**: [[../../product/draft/20261121-knowledge-base-docs-root.md]]
**计划版本**: v1.0
**创建日期**: 2026-11-21
**feat-branch**: `feat/docs-root-knowledge-base`

## 1. 目标与范围

### 1.1 目标

在既有仓库知识库链路上增加第三来源 `docs-root`：仓库 `docs/` 的一层文件夹（跳过 `knowledges`）含 `knowledge-base.json` 即一个知识库。既有两个来源（`zag` / `docs`）行为逐字不变。

### 1.2 不在范围

- 更深层级递归发现；
- `docs/knowledges` 容器目录识别；
- 上限口径调整；
- MongoDB / 迁移 / 索引；
- 知识库 MCP 六工具；
- 版本门禁提升。

## 2. 代码事实核对（F）

| 编号 | 事实 | 位置 |
|---|---|---|
| F1 | `REPO_KNOWLEDGE_BASE_SOURCES` 为二元组 `zag`/`docs`，`scanKnowledgeBases` 逐项调用 `scanSource` 后直接 push，顺序即来源顺序 | `packages/agent-controller/src/knowledge-bases.ts:17-20,256-272` |
| F2 | `scanSource` 读取来源目录直接子项、按名称排序取前 1000、筛目录（含目录符号链接）后逐库调用 `scanKnowledgeBase`，未识别库（无 schema/error）跳过 | 同上 `:194-247` |
| F3 | `KnowledgeBaseSourceResult.source` 类型派生自来源表元素 | 同上 `:22,48-52` |
| F4 | controller-api `KnowledgeBasesService.handleScanResult` 只校验 `sources` 为数组，其余原样写 Redis EX 60 | `servers/controller-api/src/services/knowledge-bases-service.ts:43-56` |
| F5 | agent-api `SOURCE_BY_RAW` / `RAW_BY_SOURCE` / `SOURCE_ORDER` 为来源单一映射，`buildCache` 按 `SOURCE_ORDER` 取 `bySource` 后输出；缺失来源自然为空 | `servers/agent-api/src/services/repo-knowledge-bases.ts:169-178,666-698` |
| F6 | id 编解码只校验 `SOURCE_BY_RAW` 命中，新增映射即自动支持 | 同上 `:204-232` |
| F7 | GraphQL 手写 schema 与契约双写；`RepoKnowledgeBaseSource` 枚举目前两值 | `servers/agent-api/src/graphql/schemas/knowledge-base.ts:81`、`contracts/knowledge-base.graphql` |
| F8 | 编写指引文本与扫描器常量同源，防漂移守卫以字面量断言来源目录与上限 | `servers/agent-api/src/services/knowledge-base-prompts.ts`、`knowledge-base-prompts.test.ts` T-RKB2-P2 |
| F9 | 前端 `SOURCE_BY_RAW` / `sourceLabel` / 徽标三分支依赖来源枚举 | `apps/agent-web/src/lib/repo-knowledge-base.ts`、`RepoKnowledgeBaseSection.tsx:165,204-207` |

## 3. 实现步骤

### Phase 0：契约与领域模型

1. `contracts/agent-session-websocket.md`
   - §3.29 请求语义补充第三来源；约束补充 `docs/` 一层文件夹与跳过 `knowledges`；来源数不再固定「两个」。
   - §3.30 示例增加 `docs-root`；字段表 `source` 联合类型与 `folder` 说明扩展。
2. `contracts/knowledge-base.graphql`
   - 注释「仓库内建知识库」补充第三来源；
   - `RepoKnowledgeBaseSource` 增加 `DOCS_ROOT` 与逐值注释。
3. 领域模型：B0 `00-上下文概览.md` 发现规则、`01-聚合与实体.md` 来源枚举（已在提案阶段同步，本阶段复核）。

### Phase 1：agent-gear 扫描器

1. 来源表元素增加可选 `excludeFolders`：

```ts
export const REPO_KNOWLEDGE_BASE_SOURCES = [
  { source: 'zag', subdir: '.zag/knowledges' },
  { source: 'docs', subdir: 'docs/knowledges' },
  { source: 'docs-root', subdir: 'docs', excludeFolders: ['knowledges'] },
] as const;
```

2. `RepoKnowledgeBaseSource` 自动包含 `'docs-root'`。
3. `scanSource` 在目录收集阶段过滤 `excludeFolders`（精确名称匹配，区分大小写；`knowledges` 以仓库约定为准）。
4. `scanKnowledgeBases` 无需改循环逻辑（自动扫描三项）。
5. 版本 `2.22.0 → 2.23.0`；`socketio-client.ts` 顶部版本注释补充。
6. `AGENTS.md` 的扫描说明补充第三来源。

### Phase 2：agent-api

1. 类型与映射：

```ts
export type RepoKnowledgeBaseSource = 'ZAG' | 'DOCS' | 'DOCS_ROOT';
const SOURCE_BY_RAW = { zag: 'ZAG', docs: 'DOCS', 'docs-root': 'DOCS_ROOT' };
const RAW_BY_SOURCE = { ZAG: 'zag', DOCS: 'docs', DOCS_ROOT: 'docs-root' };
const SOURCE_ORDER = ['ZAG', 'DOCS', 'DOCS_ROOT'];
```

2. `buildCache` 无需改结构（按 `SOURCE_ORDER`、缺省空）。
3. GraphQL 手写 schema 增加 `DOCS_ROOT`。
4. 编写指引：
   - §1 放置约定：新增 `docs/` 一层文件夹，跳过 `docs/knowledges`，发现不递归；
   - §2 目录结构示例新增 `docs/guides/`；
   - §6 上限不变；
   - §8 自检清单新增第三条来源；
   - description 同步。
5. 模块注释更新（不再写「两个约定目录」）。
6. `AGENTS.md` 仓库知识库段落同步来源说明。

### Phase 3：agent-web

1. `RepoKnowledgeBaseSource` 增加 `'DOCS_ROOT'`；`SOURCE_BY_RAW['docs-root']`。
2. `sourceLabel('DOCS_ROOT')` = `docs`（一层文件夹）。
3. 徽标：`DOCS_ROOT` 显示 `docs/`；既有 `ZAG`=`zag`、`DOCS`=`docs` 不变。
4. GraphQL 查询类型 `RepoKnowledgeBaseSourceData` 增加 `'DOCS_ROOT'`。
5. `AGENTS.md` 如有来源说明则同步。

### Phase 4：测试

| 编号 | 层 | 断言 |
|---|---|---|
| T-RKB3-SCAN1 | agent-gear 单测 | `docs/guides/knowledge-base.json` + 文档 → 第三来源 1 库，`folder='guides'`、文档路径正确 |
| T-RKB3-SCAN2 | 同上 | 三来源同时存在 → `sources.map(source)===['zag','docs','docs-root']`，同名文件夹独立 |
| T-RKB3-SCAN3 | 同上 | `docs/knowledges/knowledge-base.json` 直接存在 → 第三来源不识别；其子文件夹仍属 `docs` |
| T-RKB3-SCAN4 | 同上 | `docs/a/b/knowledge-base.json` → 第三来源空（不递归） |
| T-RKB3-SCAN5 | 同上 | `docs/` 不存在 → 第三来源空列表、`success:true`；`docs/` 直接子项 >1000 → 来源截断 |
| T-RKB3-SCAN6 | 同上 | `docs/<库>/knowledge-base.json` >1MiB → 该库 `error:'file too large'`；单文档超限不影响其他文档 |
| T-RKB3-SVC1 | agent-api 单测 | `buildCache` 输出顺序 zag→docs→docs-root；缺 `docs-root` 来源零报错 |
| T-RKB3-SVC2 | 同上 | id 编解码支持 `repo:<ws>:docs-root:<folder>`；未知来源仍 null |
| T-RKB3-P1 | 同上 | 指引包含 `docs/<文件夹>`、`docs-root`、跳过 `knowledges` 锚点；旧锚点不残留 |
| T-RKB3-GQL1 | agent-api schema 测试 | 契约与手写 schema 的 `RepoKnowledgeBaseSource` 均含 `DOCS_ROOT` |
| T-RKB3-WEB1 | agent-web lib | 解码 `repo:ws:docs-root:x` → `{source:'DOCS_ROOT'}`；`sourceLabel('DOCS_ROOT')` |
| T-RKB3-WEB2 | agent-web 组件 | 三来源徽标 `zag` / `docs` / `docs/` |
| T-RKB3-API1 | tests/api | fixture 增加 `docs-root` → GraphQL 返回 `source: DOCS_ROOT` 并可 children/document |
| T-RKB3-API2 | tests/api | 仅两来源 fixture（旧组件）→ 零报错、`DOCS_ROOT` 不出现 |
| T-RKB3-E2E1 | tests/e2e | 三来源知识库同时展示，第三来源可展开并打开文档 |

## 4. 计划期裁决（D）

| 编号 | 裁决 | 原因 |
|---|---|---|
| D1 | 新增 `docs-root` 原始来源段与 `DOCS_ROOT` 枚举值 | 避免 `DOCS` 内同名文件夹 ID 冲突；既有 ID、缓存键、展示零回归 |
| D2 | 跳过 `docs/knowledges` 容器（精确名称） | 该目录是既有来源容器，识别会与 `DOCS` 语义重叠 |
| D3 | 不提升 `REPO_KNOWLEDGE_BASE_MIN_AGENT_GEAR_VERSION` | 旧组件缺第三来源仍可完整使用两个来源；提升会误伤存量云电脑 |
| D4 | 复用 `scanSource` + `excludeFolders` | 上限、符号链接、错误归一、截断语义同构，避免第二套实现 |
| D5 | 前端徽标 `docs/`，`sourceLabel` 为 `docs`（一层文件夹） | 与既有 `docs`（`docs/knowledges`）可区分且不破坏既有文本 |
| D6 | 来源声明序 `ZAG → DOCS → DOCS_ROOT` | 新来源追加在末尾，既有列表顺序零变化 |

## 5. 回归清单

- [ ] `.zag/knowledges` 与 `docs/knowledges` 的扫描、上限、截断、错误文案逐字不变。
- [ ] 旧 agent-gear（两项 sources）接入新 agent-api：GraphQL 返回两个来源，无 `DOCS_ROOT` 条目、无错误。
- [ ] `repo:` id 编解码对旧两来源逐字不变；缓存键与 TTL 不变。
- [ ] 知识库 MCP 六工具与 prompts 注册表形态不变（仅指引文本更新）。
- [ ] 前端旧两来源徽标文本不变（`zag` / `docs`）。
- [ ] `status` / 错误白名单 / `documentCount` / `truncated` 语义不变。
- [ ] 无 MongoDB 变更、无迁移。

## 6. 验收

- [ ] 契约评审通过
- [ ] 领域模型同步
- [ ] 单测全绿
- [ ] API 测试通过（需 `MONGODB_URI`）
- [ ] E2E 测试通过（需 Aspire 全量）
