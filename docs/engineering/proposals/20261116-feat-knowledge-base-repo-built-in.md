---
description: 仓库内建知识库技术提案：知识库支持在代码仓库中内建——agent-gear 新增 `knowledge-bases:scan` 白名单扫描事件直读工作区 `.zag/knowledges/` 与 `docs/knowledges/`（子文件夹含 knowledge-base.json 即知识库、库内 Markdown 为文档），controller-api 白名单中继写 Redis 结果键，agent-api 按云电脑懒加载扫描结果并解析校验（schema + front matter + 路径归一），GraphQL 四个只读查询（候选云电脑骨架 / 单云电脑知识库列表 / 逐级子条目 / 单文档）透出；agent-web 侧边栏「仓库知识库」分组默认全部折叠、点击展开才加载下一级，文档 front matter 渲染为键值表格；知识库 MCP 新增「仓库知识库编写指引」prompts 能力；仓库知识库不落 MongoDB、不进知识库工具、无任何写入口
type: Permanent
---

# 仓库内建知识库 - 技术提案

**功能名称**: 仓库内建知识库（知识库支持在代码仓库中内建）
**关联 PRD**: `docs/product/draft/20261116-knowledge-base-repo-built-in.md`
**技术提案版本**: v1.1
**创建日期**: 2026-11-16
**作者**: z-agent-bot
**feat-branch**: `feat/knowledge-base-repo-built-in`

> v1.1 修订（评审返工，PR #546 inline comments）：
> 1. 前端树改为折叠懒加载——GraphQL 由「聚合全量树」改为四级只读查询（候选云电脑骨架 → 单云电脑知识库列表 → 逐级子条目 → 单文档），前端全部层级默认折叠、点击展开才收集下一级可用条目；
> 2. 文档 content 返回含 front matter 的原文全文，前端预览将 front matter 渲染为键值表格；
> 3. 知识库 MCP（`agent-knowledge-base-tools`）新增 MCP prompts 能力，提供「仓库知识库编写指引」提示词（存储路径 / `knowledge-base.json` / front matter / 只读语义）。

## 1. 概述

### 1.1 背景

知识库（需求 #495，提案 `docs/engineering/proposals/20261115-feat-knowledge-base.md`）以三集合事件溯源落地工作区级 wiki，平台 MCP `agent-knowledge-base-tools` 向会话注入六个工具。工作流模板项目持久化（需求 #469，提案 `docs/engineering/proposals/20261107-feat-workflow-template-project-persistence.md`）建立了「仓库为唯一事实源、平台直读不持久化」的先例：agent-gear 2.18.0 提供 `workflow-templates:scan` 白名单扫描事件，controller-api 白名单中继并写 Redis 结果键，agent-api 轮询消费并逐文件解析校验。工作流 MCP 提示词片段（需求 #523，`admin-prompts.ts`）建立了平台 MCP 以 MCP prompts 能力提供权威指引的先例。

需求 #545 要求知识库也支持从代码仓库中读取：仓库 `.zag/knowledges/` 与 `docs/knowledges/` 两个目录下，每个含 `knowledge-base.json` 的子文件夹即一个知识库（文件为 schema），库内 Markdown 文件为文档。仓库知识库**在知识库 MCP 中不显示、只在前端中显示、不允许修改**。

### 1.2 目标

- 复用「扫描事件 → 中继 → Redis 结果键 → 轮询消费」链路，agent-gear 新增 `knowledge-bases:scan` 事件扫描两个约定目录（含文档内容，白名单限界）。
- agent-api 提供**懒加载**只读查询：候选云电脑骨架（纯 DB 读、不触发扫描）→ 单云电脑知识库列表（首次展开触发扫描）→ 知识库内逐级子条目 → 单文档内容；扫描结果 Redis 短缓存（5 分钟），支持「重新检测」。
- agent-web 侧边栏「知识库」分区追加「仓库知识库」分组：**全部层级默认折叠，点击展开才收集下一级可用条目**；文档预览将文首 front matter **渲染为键值表格**。
- 知识库 MCP 新增 **prompts 能力**，提供「仓库知识库编写指引」提示词（存储路径 / 目录结构 / `knowledge-base.json` / 文档组织 / front matter / 只读语义）。
- 仓库知识库**不落 MongoDB、不进知识库工具、无任何 mutation**。

### 1.3 范围

**本期范围**：

- agent-gear：`knowledge-bases` 扫描模块与 `knowledge-bases:scan` / `knowledge-bases:scan:result` 事件注册。
- controller-api：`session:command` 白名单新增 `knowledge-bases:scan` 中继与结果回写。
- agent-api：`repo-knowledge-bases` 服务（懒加载分层查询 / 缓存 / 解析校验）、GraphQL 四个只读查询、`agent-knowledge-base-tools` prompts 能力（`knowledge-base-prompts.ts` 单一来源）。
- agent-web：侧边栏「仓库知识库」分组（折叠懒加载）、front matter 表格渲染、只读预览接线、「重新检测」。
- 契约：`contracts/knowledge-base.graphql` 扩展、`contracts/agent-session-websocket.md` 新增两个事件小节、`contracts/mcp-server.graphql` platform 注释增补（对齐 #523 先例）。

**非目标**：

- 本地控制器（非云电脑）工作目录、云电脑上默认工作区以外的工作目录（与 #469 同口径，后续迭代扩展）。
- 仓库知识库的编辑、删除、历史版本、权限设置（历史即 Git 历史）。
- 知识库**工具**暴露仓库知识库（AI 可直接读会话工作目录中的仓库文件）。
- 仓库知识库的实时同步与推送（仅短缓存 + 手动重新检测）。

## 2. 技术架构

### 2.1 系统架构图

```mermaid
flowchart LR
    subgraph FE[agent-web]
        SB[侧边栏知识库分区<br/>仓库知识库分组<br/>默认折叠·逐级懒加载]
        PV[只读预览页<br/>front matter 渲染为表格]
    end

    subgraph API[agent-api]
        GQL[GraphQL 只读查询<br/>hosts → bases → children → document]
        SVC[repo-knowledge-bases 服务<br/>分层加载 / 缓存 / 解析校验]
        KBTOOLS[agent-knowledge-base-tools<br/>+ prompts 能力]
    end

    subgraph CTRL[controller-api]
        RELAY[knowledge-bases-service<br/>白名单中继]
    end

    subgraph GEAR[agent-gear（云电脑）]
        SCAN[knowledge-bases 扫描模块<br/>直读两个约定目录]
    end

    SB --> PV --> GQL --> SVC
    SVC -->|cache miss: publish session:command| RELAY
    RELAY -->|socket.emit| SCAN
    SCAN -->|scan:result| RELAY
    RELAY -->|Redis EX 60| SVC
    SVC -->|工作区级缓存 Redis 5min| SVC
    KBTOOLS -. prompts/list · prompts/get .-> KBTOOLS
```

### 2.2 技术栈

- agent-gear：Node.js 24 + TypeScript（strict、ESM）、`node:fs/promises`（与 `workflow-templates.ts` 同型直读）。
- controller-api：Socket.IO 中继 + ioredis（结果键 EX 60，与 `workflow-templates-service` 同型）。
- agent-api：Express v5 + GraphQL-Yoga + Mongoose + ioredis（轮询消费与工作区级缓存）。
- agent-web：React 19 + Apollo Client + 既有 `MarkdownContent` 渲染管线（front matter 表格为仓库知识库预览专用组件，不侵入会话渲染）。

### 2.3 模块划分

| 模块 | 位置 | 职责 |
|------|------|------|
| 扫描模块 | `packages/agent-controller/src/knowledge-bases.ts` | 直读 `<workspacePath>/.zag/knowledges/` 与 `<workspacePath>/docs/knowledges/`：发现知识库文件夹（含 `knowledge-base.json`）、收集库内 `.md` 文件（递归）并读取内容，白名单限界与错误归一 |
| 事件注册 | `packages/agent-controller/src/socketio-client.ts` | 注册 `knowledge-bases:scan` → 回 `knowledge-bases:scan:result`（日志不含文件内容） |
| 中继服务 | `servers/controller-api/src/services/knowledge-bases-service.ts` | `session:command` 白名单分发 → `socket.emit`；`socketio.ts` 监听 `knowledge-bases:scan:result` 写 Redis（EX 60） |
| 分层服务 | `servers/agent-api/src/services/repo-knowledge-bases.ts` | 候选云电脑骨架（纯 DB）/ 单工作区知识库列表（缓存优先、miss 扫描）/ 逐级子条目（缓存派生）/ 单文档读取（缓存派生）；解析校验（schema / front matter / 路径归一）为纯函数层 |
| GraphQL | `servers/agent-api/src/graphql/{schemas,resolvers}/knowledge-base.ts` | `repoKnowledgeBaseHosts` / `repoKnowledgeBases(workspaceId, refresh)` / `repoKnowledgeBaseDocumentChildren(id, path)` / `repoKnowledgeBaseDocument(id, path)` 四个只读查询（双写登记 `schemas/index.ts` / `resolvers/index.ts`） |
| 知识库 MCP | `servers/agent-api/src/services/knowledge-base-tools.ts` + `knowledge-base-prompts.ts` | `initialize` 追加 `capabilities.prompts`；`prompts/list` / `prompts/get` 提供「仓库知识库编写指引」（文本单一来源 + 防漂移守卫）；六工具零改动 |
| 前端 | `apps/agent-web/src/components/knowledge-base/`、`lib/repo-knowledge-base.ts`、`lib/front-matter.ts` | 侧边栏「仓库知识库」分组（默认折叠、逐级懒加载、重新检测）、front matter 表格渲染、只读预览接线 |

## 3. API 设计

### 3.1 API 契约

**（a）`contracts/agent-session-websocket.md` 新增两节（顺延 §3.29/§3.30）**：`knowledge-bases:scan`（Server → Controller）与 `knowledge-bases:scan:result`（Controller → Server）。

请求 payload 与 `workflow-templates:scan` 同形（`{requestId, path}`），语义差异：扫描 `<path>/.zag/knowledges/` 与 `<path>/docs/knowledges/` 两个固定子目录。结果 payload：

```json
{
  "requestId": "string",
  "success": true,
  "sources": [
    {
      "source": "zag",
      "knowledgeBases": [
        {
          "folder": "team-rules",
          "schema": "{ \"name\": \"团队规范\" }",
          "documents": [
            { "path": "guides/git.md", "content": "---\ntitle: Git 规范\n---\n# ..." }
          ],
          "truncated": false
        },
        { "folder": "broken", "error": "file too large" }
      ],
      "truncated": false
    },
    { "source": "docs", "knowledgeBases": [], "truncated": false }
  ],
  "truncated": false
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `sources[].source` | `'zag' \| 'docs'` | 来源目录标识（`.zag/knowledges/` ↔ `zag`，`docs/knowledges/` ↔ `docs`） |
| `sources[].knowledgeBases[].folder` | `string` | 知识库文件夹名（直接子目录，不含嵌套发现） |
| `sources[].knowledgeBases[].schema` | `string?` | `knowledge-base.json` 原文（≤64 KiB；超限该库 `error:'file too large'`） |
| `sources[].knowledgeBases[].documents[]` | `{path, content?}` | 库内 `.md` 文件（递归）；`path` 为库内相对 POSIX 路径；读取失败该文档附 `error` |
| `error` | `string?` | 白名单：`file too large` / `not found` / `permission denied`（与 §3.27 同表） |
| `truncated` | `boolean` | 各级数量/体积上限截断标记 |

约束（与 §3.27 同族，防漂移守卫）：

- 仅直读两个约定子目录；知识库发现**不递归**（仅直接子文件夹）；库内文档**递归**收集 `.md` 常规文件（符号链接按 `stat` 判定为常规文件才读取）。
- 目录不存在视为空（`success:true`、对应 source 空列表）；读取权限失败 `success:false, error:'permission denied'`。
- 上限：每来源目录 ≤20 个知识库（文件夹名 `localeCompare` 排序取前 20）；每库 ≤50 个文档；`knowledge-base.json` ≤64 KiB；单文档 ≤128 KiB；单库内容累计 ≤1 MiB；单来源累计 ≤2 MiB；超限按级 `truncated:true` 或条目级 `error:'file too large'`。
- 事件**不**使用 `fs:browse`/`fs:read-file` 会话路径白名单（检测可发生在会话启动前），路径由服务端按已登记工作区下发；仅读不写、不执行。

**（b）`contracts/knowledge-base.graphql` 扩展（只读，无 mutation；懒加载四级查询）**：

```graphql
enum RepoKnowledgeBaseSource {
  ZAG    # .zag/knowledges/
  DOCS   # docs/knowledges/
}

# 候选云电脑骨架（纯 DB 读，不触发仓库扫描）
type RepoKnowledgeBaseHost {
  cloudHostId: ID!
  cloudHostName: String!
  workspaceId: ID!
  # 工作组件版本是否支持扫描（false 时前端展示升级提示，不发起加载）
  scanSupported: Boolean!
}

type RepoKnowledgeBase {
  id: ID!                    # repo:<workspaceId>:<source>:<encodeURIComponent(folder)>
  name: String!              # schema.name（不合法时为空串，看 valid/errors）
  description: String!
  source: RepoKnowledgeBaseSource!
  folder: String!
  workspaceId: ID!
  cloudHostId: ID!
  cloudHostName: String!
  valid: Boolean!
  errors: [String!]!
  documentCount: Int!        # 合法库的文档总数（不合法库为 0）
  truncated: Boolean!        # 该库是否因上限截断
}

enum RepoKnowledgeBaseNodeKind {
  FOLDER
  DOCUMENT
}

# 知识库内某一目录的直接子条目（懒加载逐级展开）
type RepoKnowledgeBaseNode {
  kind: RepoKnowledgeBaseNodeKind!
  name: String!              # 文件夹=目录段名；文档=展示标题
  path: String!              # 归一路径（/ 开头；文档用于打开预览）
}

type RepoKnowledgeBaseDocument {
  path: String!
  title: String!
  # 原文全文（**含文首 front matter 块，不剥离**）；前端将其渲染为键值表格
  content: String!
}

extend type Query {
  # 候选云电脑骨架：当前用户可见、RUNNING 且已有默认工作区的云电脑（纯 DB 读，不触发扫描）
  repoKnowledgeBaseHosts: [RepoKnowledgeBaseHost!]!
  # 某云电脑默认工作区的仓库知识库列表；首次展开触发扫描；refresh=true 重新检测
  repoKnowledgeBases(workspaceId: ID!, refresh: Boolean): [RepoKnowledgeBase!]!
  # 某知识库内某目录的直接子条目（path 缺省 = 根层级）
  repoKnowledgeBaseDocumentChildren(id: ID!, path: String): [RepoKnowledgeBaseNode!]!
  # 单文档完整内容（含 front matter 原文）；不可达/不存在统一 null（不泄露存在性）
  repoKnowledgeBaseDocument(id: ID!, path: String!): RepoKnowledgeBaseDocument
}
```

错误口径：复用既有 `Not authenticated`；单工作区扫描失败（离线/超时/版本不支持/中继异常）在该工作区级收敛——`repoKnowledgeBases` 抛白名单 `repo knowledge base scan failed`（前端对应节点展示失败与重试），`repoKnowledgeBaseDocumentChildren` / `repoKnowledgeBaseDocument` 统一返回 `[]` / `null`（不泄露存在性）；`workspaceId` 不可见/非默认工作区/非云电脑 → `Workspace not found`。契约注释同步声明「仓库知识库不进知识库 MCP 工具、只读、不落库」。

**（c）知识库 MCP prompts 能力（`agent-knowledge-base-tools`）**：

- `initialize` 返回 `capabilities: { tools: {}, prompts: {} }`（protocolVersion/serverInfo 不变，对齐 #523 `admin-tools.ts` 先例）。
- `prompts/list` 返回单个 prompt：`name: 'repo-knowledge-base-authoring'`（仓库知识库编写指引），无 cursor 分页。
- `prompts/get { name }` 返回 `{ description, messages: [{ role: 'user', content: { type: 'text', text } }] }`；未知名称/缺参 → 协议级 `INVALID_PARAMS`，message 附可用片段名。
- 指引文本覆盖（与扫描器常量同源，防漂移守卫）：存储路径（`.zag/knowledges/` 与 `docs/knowledges/`）、目录结构（子文件夹 + `knowledge-base.json` 标识）、`knowledge-base.json` schema（name 必填 1..64 / description 可选 ≤1024 + 完整示例）、文档组织（库内递归 `.md`、路径推导规则与示例）、front matter（`title`/`tags`/`description` 三键 + 完整示例 + 标题回退链）、数量与体积上限、只读语义（平台只读展示、不进知识库工具、不允许平台内修改、更新走仓库提交流程）。
- **工具面零改动**：六个知识库工具清单与行为不变，仓库知识库仍不出现在任何工具结果中（D3）。

### 3.2 内部接口

```ts
// packages/agent-controller/src/knowledge-bases.ts
export const REPO_KNOWLEDGE_BASE_SOURCES = [
  { source: 'zag', subdir: '.zag/knowledges' },
  { source: 'docs', subdir: 'docs/knowledges' },
] as const;
export async function scanKnowledgeBases(workspacePath: string): Promise<KnowledgeBaseScanResult>;

// servers/agent-api/src/services/repo-knowledge-bases.ts
export const REPO_KNOWLEDGE_BASE_MIN_AGENT_GEAR_VERSION = '2.19.0';
export function isRepoKnowledgeBaseScanSupported(version: unknown): boolean;   // compareVersions 同型
export function parseRepoKnowledgeBaseSchema(raw: string): ParsedRepoKbSchema; // 纯函数
export function parseRepoDocument(rawPath: string, content: string): ParsedRepoDocument; // 纯函数（front matter + 路径归一）
export function buildKnowledgeBaseChildren(docs: ParsedRepoDocument[], prefix: string): RepoKnowledgeBaseNode[]; // 纯函数（逐级派生）
class RepoKnowledgeBaseService {
  listHosts(userId: string): Promise<RepoKnowledgeBaseHost[]>;                                    // 纯 DB，不触发扫描
  listKnowledgeBases(userId: string, workspaceId: string, refresh?: boolean): Promise<RepoKnowledgeBase[]>; // 缓存优先，miss 扫描
  listChildren(userId: string, id: string, path?: string): Promise<RepoKnowledgeBaseNode[]>;      // 缓存派生
  getDocument(userId: string, id: string, path: string): Promise<RepoKnowledgeBaseDocument | null>;
}
export const repoKnowledgeBaseService: RepoKnowledgeBaseService;
```

`knowledge-base.json` schema（用户面契约）：

```json
{
  "name": "团队规范",                // 必填：trim 后 1..64
  "description": "……"               // 可选：≤1024
}
```

文档 front matter（可选，文件头 `---` 包围块，仅识别 `title` / `tags` / `description` 三键）：

```markdown
---
title: Git 提交规范
tags: [git, 规范]
description: 提交信息格式与分支约定
---

# 正文……
```

- front matter 解析为**极简手工解析器**（不引入 YAML 依赖）：仅当文件以 `---\n` 开头且在前 4 KiB 内存在闭合 `\n---` 时解析；每行 `key: value`；`tags` 支持 `[a, b]` 与逗号分隔两形态；值不含换行。块非法按「无 front matter」处理，不报错。
- 服务端仅取三键做元信息（title 用于树与标题）；**正文不剥离 front matter**——`RepoKnowledgeBaseDocument.content` 返回原文全文，文首 front matter 块由前端渲染为键值表格（见 §5.2 实现点 7）。
- 标题回退链：front matter `title` → 正文首个一级标题（`# `）→ 文件名（去 `.md`）。
- 字段限值与平台知识库同口径：title 1..200 / tags ≤16×1..32 去重 / description ≤1024；超限按非法收敛（front matter 该键忽略，回退默认），不使整个库非法。
- 文档路径归一：`/` + 库内相对 POSIX 路径去掉末尾 `.md`（大小写保留），随后复用平台 `normalizeDocumentPath` 校验（段非空、无控制字符、段 ≤128、全长 ≤512）；归一后冲突（如 `a.md` 与 `a.MD`、`a/b.md` 与 `a//b.md`）→ 该库标记不合法（`文档路径冲突：<path>`），冲突文档均不收录。
- 逐级子条目派生：`buildKnowledgeBaseChildren(docs, prefix)` 由全量文档路径在内存中聚合——直接子目录归并为 `FOLDER`（名=目录段），直接文档为 `DOCUMENT`（名=展示标题）；排序：文件夹在前、同组按名 `localeCompare`。

## 4. 数据模型

### 4.1 数据库设计

**零 MongoDB 变更**：仓库知识库不落库（D2），无新集合、无迁移、无索引。仓库为唯一事实源。

### 4.2 缓存设计

| 键 | 写方 | TTL | 内容 |
|----|------|-----|------|
| `knowledge-bases:scan:{requestId}` | controller-api 中继 | 60s | 单次扫描原始结果（与 `workflow-templates:scan` 同型，读后即删） |
| `repo-knowledge-bases:ws:{workspaceId}` | agent-api 分层服务 | 300s | 该工作区解析后的知识库全集（含文档内容，≤2 MiB/来源上限天然限界） |

- 候选云电脑骨架为纯 DB 读，**无缓存、无扫描**；首次展开某云电脑（`repoKnowledgeBases`）才读/写该工作区缓存。
- `refresh=true` 时删除缓存键后重扫；子条目与文档查询读同一缓存，缓存缺失时触发一次重扫（等价于一次列表加载）。
- 单文档内容不单独建缓存键（扫描结果天然含内容，D9）。

## 5. 技术实现方案

### 5.1 核心流程

```mermaid
sequenceDiagram
    participant W as agent-web
    participant A as agent-api
    participant R as Redis
    participant C as controller-api
    participant G as agent-gear

    W->>A: repoKnowledgeBaseHosts（侧边栏初始，纯 DB 读）
    A-->>W: 候选云电脑骨架（不触发任何扫描）
    W->>A: repoKnowledgeBases(workspaceId)（用户展开某云电脑）
    A->>R: GET repo-knowledge-bases:ws:{workspaceId}
    alt 缓存未命中或 refresh
        A->>R: publish session:command {type:'knowledge-bases:scan', requestId, controllerId, path}
        R-->>C: 白名单分发 → socket.emit
        C->>G: knowledge-bases:scan {requestId, path}
        G-->>C: knowledge-bases:scan:result
        C->>R: SET knowledge-bases:scan:{requestId} EX 60
        A->>R: 轮询 500ms × 30（读后即删）
        A->>A: 解析校验（schema / front matter / 路径归一）
        A->>R: SET repo-knowledge-bases:ws:{workspaceId} EX 300
    end
    A-->>W: 该云电脑知识库列表（含不合法灰显）
    W->>A: repoKnowledgeBaseDocumentChildren(id, path)（展开知识库/目录）
    A->>R: 读工作区缓存（缺失触发一次重扫）
    A-->>W: 下一级条目（FOLDER 在前）
    W->>A: repoKnowledgeBaseDocument(id, path)（点击文档）
    A->>R: 读工作区缓存
    A-->>W: 原文全文（含 front matter）→ 前端渲染表格 + 正文
```

### 5.2 关键实现点

1. **agent-gear 扫描模块（`packages/agent-controller/src/knowledge-bases.ts`）**：与 `workflow-templates.ts` 同型直读。两个固定子目录逐一扫描：`readdir({withFileTypes:true})` 发现直接子文件夹（符号链接按 `stat` 判定为目录才进入）；子文件夹内存在常规文件 `knowledge-base.json` 才识别为知识库；递归收集 `.md`（小写比较）常规文件，读取内容并累计体积。白名单错误归一 `file too large` / `not found` / `permission denied`；目录 ENOENT/ENOTDIR → 空。事件注册于 `socketio-client.ts`（日志 `knowledge_bases_scan` 仅含 `requestId/path`，不记录内容）。包版本升 2.19.0，agent-api 版本门禁 `isRepoKnowledgeBaseScanSupported` 同口径。
2. **controller-api 中继（`knowledge-bases-service.ts` + `session-command.ts` 白名单 + `socketio.ts` 监听）**：逐字镜像 `workflow-templates-service` 形态——`requestId && controllerId && path` 齐备才分发；结果键 `knowledge-bases:scan:{requestId}`（EX 60）；`sources` 非数组按 `{success:false}` 兜底落键。
3. **agent-api 分层服务（`services/repo-knowledge-bases.ts`）**：
   - **候选骨架（`listHosts`）**：`CloudHost.find({...actorFilter(userId), status:'RUNNING', workspaceId:{$ne:null}, deletedAt:null})` → 关联 `ControllerWorkspace`（取 `_id`）与 `Controller`（读 `status/version`）；输出 `scanSupported = Controller.status==='online' && isRepoKnowledgeBaseScanSupported(version)`。**纯 DB 读，不触发任何继电器扫描**（D7）。
   - **单工作区列表（`listKnowledgeBases`）**：归属校验（`controllerWorkspaceService.findById` + 该工作区必须是某 RUNNING 云电脑的默认工作区，否则 `Workspace not found`）→ 缓存命中直接返回；miss/`refresh` 走扫描（publish + 500ms×30 轮询，与 `repo-templates.ts` 同参数）→ 解析 → 写缓存。扫描失败抛 `repo knowledge base scan failed`（前端节点级重试）。
   - **逐级子条目（`listChildren`）**：解码 id → 归属校验 → 读缓存（miss 重扫）→ `buildKnowledgeBaseChildren` 派生直接子条目；非法 id/不可达 → `[]`。
   - **单文档（`getDocument`）**：同口径校验 → 缓存定位文档 → 返回 `{path, title, content:原文全文}`；任何一步不命中返回 `null`。
   - 解析为**纯函数层**（`parseRepoKnowledgeBaseSchema` / `parseRepoDocument` / `buildKnowledgeBaseChildren`），逐库隔离：schema 非法 → 该库 `valid:false, errors:[...]`，不参与文档解析；合法库归一全部文档路径并检冲突。
   - 视图装配：id 编码 `repo:<workspaceId>:<source>:<encodeURIComponent(folder)>`；`documentCount` 取合法文档数。
4. **GraphQL**：`schemas/knowledge-base.ts` 追加类型与四个查询（手写 schema 与契约**双写**），`resolvers/knowledge-base.ts` 追加 resolver 并**登记 `resolvers/index.ts`**（漏登记运行时无效，既有陷阱）。resolver 薄封装：认证 → 委托 service → 错误白名单收敛（`Not authenticated` / `Workspace not found` / `repo knowledge base scan failed` 逐字透传，其余收敛 `internal error`）。
5. **知识库 MCP：工具零改动 + prompts 能力（D3/D14）**：
   - 六工具全部经 `knowledgeBaseService`（MongoDB 唯一读写口）执行；仓库知识库不进入该路径，天然不出现在 `knowledge_base_list` 等任何工具结果中；按名称调用解析范围为可见集（MongoDB），仓库库名解析为 0 命中 → 既有「未找到」isError 口径。
   - `knowledge-base-tools.ts` 的 `initialize` 追加 `capabilities.prompts`；`prompts/list` 返回 `REPO_KNOWLEDGE_BASE_AUTHORING_PROMPT` 声明；`prompts/get` 返回文本；未知名称 → `INVALID_PARAMS` 附可用片段名（对齐 #523 `admin-tools.ts` 形态）。
   - 指引文本单一来源为新模块 `services/knowledge-base-prompts.ts`（Markdown 常量，不落库、不可在线编辑）；内容与扫描器常量（两个子目录、20/50、64KiB/128KiB/1MiB/2MiB 上限、front matter 三键与回退链）**同源对齐**，新增防漂移守卫测试（对齐 `admin-prompts.test.ts` 的 T-AP4/T-AP5 先例）。
6. **agent-web（折叠懒加载）**：
   - `lib/repo-knowledge-base.ts`：id 编解码（`repo:` 前缀判定）、`isRepoKnowledgeBaseId`。
   - `RepoKnowledgeBaseSection`（挂在平台树之后）：数据源 `GET_REPO_KNOWLEDGE_BASE_HOSTS`（`cache-and-network`，纯 DB 骨架）；**全部层级默认折叠、展开才发下一级查询**——展开云电脑 → `GET_REPO_KNOWLEDGE_BASES(workspaceId)`（`scanSupported=false` 时展示「升级后可加载」、不发查询）；展开知识库/目录 → `GET_REPO_KNOWLEDGE_BASE_CHILDREN(id, path)`；各节点独立 `loading`/失败重试态（失败不扩散）；云电脑级「重新检测」（`refetch` 携带 `refresh:true` 并失效该云电脑下已展开的子条目缓存）。条目无「+」/齿轮；`scanSupported=true` 但列表为空展示空态。
   - `KnowledgeBasePage`：`kbId` 命中 `repo:` 前缀时走 repo 分支——标题/面包屑来自已加载节点（直达链接经 `GET_REPO_KNOWLEDGE_BASE_DOCUMENT` 回源），正文经同一查询；只读渲染（隐藏编辑/删除/历史按钮；`?edit=1` 忽略）；不可达展示明确提示且不泄露内容。路由不变（`/knowledge-bases/:kbId/*`）。
   - 不合法库条目：列表内灰显并展示 `errors[0]`（与 `RepoWorkflowSection` 同形态）。
7. **front matter 表格渲染（D13）**：新增 `lib/front-matter.ts` 纯函数 `splitFrontMatter(content)`——与服务端同口径的极简规则（`---\n` 开头、前 4 KiB 内闭合 `\n---`、逐行 `key: value`）拆分出 front matter 键值对与正文；`components/knowledge-base/RepoKnowledgeBaseContent.tsx` 将 front matter 渲染为键值表格（**按原文全部键值逐行展示**，含三键以外的键），正文复用既有 `MarkdownContent`。**不改动会话 Markdown 管线**（会话消息零回归）；平台托管知识库文档正文不含 front matter 语义，不接入该组件。

## 6. 技术决策

### 6.1 决策列表

| # | 决策 | 理由 |
|---|------|------|
| D1 | 本期仅扫描 RUNNING 云电脑的**默认工作区**（GitHub 项目 clone 目录） | 「代码仓库」的平台语义即云电脑 Git 项目；与 #469 云电脑限定同口径；扫描面有界（每用户云电脑数有限） |
| D2 | 仓库知识库**不落 MongoDB**，仅 Redis 短缓存 | 仓库为唯一事实源（#469 先例）；避免双事实源脱节 |
| D3 | 知识库**工具**零改动（MongoDB 唯一读写口天然排除） | 需求明确「MCP 中不显示」；AI 可直接读会话工作目录仓库文件，无中间层 |
| D4 | GraphQL **只读**（四个查询，无 mutation） | 「不允许修改」；无写入口即无越权写仓库路径 |
| D5 | 两个来源目录 `.zag/knowledges/` 与 `docs/knowledges/`，`source` 枚举区分 | 需求指定；`.zag` 对齐工作流模板 `.zag/workflow/templates/` 约定（已核实模板实际路径） |
| D6 | 文档元信息取自可选 front matter，回退「首个一级标题 → 文件名」 | 编写体验贴近 Markdown 惯例；`knowledge-base.json` 保持最小 schema（name/description） |
| D7 | **折叠懒加载四级查询**：骨架（纯 DB）→ 单云电脑列表（触发扫描）→ 逐级子条目 → 单文档 | 评审裁决：侧边栏初始加载不得触发仓库扫描；点击展开才收集下一级可用条目；扫描面与流量随用户意图逐级发生 |
| D8 | id 编码 `repo:<workspaceId>:<source>:<encodeURIComponent(folder)>` | 复用既有 `/knowledge-bases/:kbId/*` 路由；与 Mongo ObjectId 天然区分；可解码定位工作区做归属校验 |
| D9 | 扫描结果含文档内容（≤128 KiB/篇限界），子条目与文档查询读缓存而非二次继电器 | 一次扫描服务列表/子条目/正文三类查询；限界天然封顶缓存体积 |
| D10 | agent-gear 版本门禁 `>=2.19.0`，旧组件 `scanSupported=false` 展示升级提示且不发起加载 | 与 `workflow-templates:scan` 2.18.0 门禁同口径，优雅降级且用户可知 |
| D11 | front matter 手工极简解析，不引入 YAML 依赖 | 三键单行即够；避免为新场景新增依赖面 |
| D12 | 文档路径冲突整库标记不合法 | 大小写/形态冲突在 Linux 容器可读但跨平台不可移植，显式报错优于静默二选一 |
| D13 | **content 返回含 front matter 的原文全文，前端渲染为键值表格** | 评审裁决：front matter 是文档内容的一部分，应以表格呈现；表格组件为仓库知识库预览专用，会话渲染零回归 |
| D14 | **知识库 MCP 新增 prompts 能力承载「仓库知识库编写指引」，文本单一来源 + 防漂移守卫** | 评审裁决：让 AI 能按平台规范编写仓库知识库；复用 #523 prompts 先例；工具面零改动（D3 不破） |

### 6.2 依赖与约束

- 依赖 `workflow-templates:scan` 链路全部先例（契约 §3.27/§3.28、`repo-templates.ts`、`workflow-templates-service.ts`）；扫描/中继/轮询参数与其对齐（500ms × 30、EX 60）。
- 依赖知识库（#495）的前端渲染管线与路由（`KnowledgeBaseSection` / `KnowledgeBasePage` / `MarkdownContent`）。
- 依赖工作流 MCP 提示词片段（#523）的 prompts 能力形态与防漂移守卫先例（`admin-prompts.ts` / `admin-prompts.test.ts`）。
- 依赖云电脑默认工作区口径（`CloudHost.workspaceId`，#304 二期）。
- 受继电器链路约束：云电脑离线/版本不足时不发起加载（骨架含 `scanSupported` 降级语义已确认可接受）。
- 单实例部署前提沿用（轮询消费 Redis 结果键，与既有链路一致）。

## 7. 项目结构

**新增**：

- `packages/agent-controller/src/knowledge-bases.ts`（扫描模块）
- `packages/agent-controller/src/knowledge-bases.test.ts`
- `servers/controller-api/src/services/knowledge-bases-service.ts`（+ `.test.ts`）
- `servers/agent-api/src/services/repo-knowledge-bases.ts`（+ `.test.ts`）
- `servers/agent-api/src/services/knowledge-base-prompts.ts`（+ 防漂移守卫测试）
- `apps/agent-web/src/lib/repo-knowledge-base.ts`（+ 测试）、`apps/agent-web/src/lib/front-matter.ts`（+ 测试）
- `apps/agent-web/src/components/knowledge-base/RepoKnowledgeBaseSection.tsx`（+ 测试）
- `apps/agent-web/src/components/knowledge-base/RepoKnowledgeBaseContent.tsx`（+ 测试）

**修改**：

- `packages/agent-controller/src/socketio-client.ts`（事件注册）、`package.json`（2.19.0）
- `servers/controller-api/src/services/{session-command.ts,socketio.ts}`（白名单 + 监听）
- `servers/agent-api/src/services/knowledge-base-tools.ts`（`initialize` 追加 `capabilities.prompts`、`prompts/list`、`prompts/get`）
- `servers/agent-api/src/graphql/{schemas,resolvers}/knowledge-base.ts`、`{schemas,resolvers}/index.ts`
- `apps/agent-web/src/components/knowledge-base/{KnowledgeBaseSection.tsx,KnowledgeBasePreview.tsx}`、`pages/KnowledgeBasePage.tsx`、`graphql/knowledge-base.ts`
- `contracts/{knowledge-base.graphql, agent-session-websocket.md, mcp-server.graphql}`
- 各 AGENTS.md 口径同步（agent-controller / controller-api / agent-api / agent-web）

**测试**：`tests/api/src/agent-api/repo-knowledge-base.test.ts`、`tests/e2e/src/repo-knowledge-base.spec.ts`

## 8. 测试策略

- **agent-gear 单测（T-RKB-SCAN）**：两目录发现、`knowledge-base.json` 标识判定、递归收集 `.md`、符号链接判定、各级上限与截断、ENOENT/ENOTDIR 空、EACCES → `permission denied`、单文档超限 → `file too large`。
- **controller-api 单测（T-RKB-RELAY）**：白名单三要素齐备才分发、离线仅记 error、结果落键 EX 60、`sources` 非数组兜底。
- **agent-api 单测（T-RKB）**：schema 解析矩阵（缺 name/超长/非法 JSON）、front matter 三键与回退链、路径归一与冲突整库非法、`buildKnowledgeBaseChildren` 逐级派生与排序、`listHosts` 纯 DB 不触发扫描、版本门禁 → `scanSupported=false`、缓存命中/refresh 绕过、文档查询归属校验与 null 收敛、扫描失败文案白名单；契约/schema 双写守卫与 resolver 登记守卫。
- **知识库 MCP prompts（T-RKB-P）**：`initialize` 声明 prompts、`prompts/list` 单片段、`prompts/get` 全要点覆盖（路径/结构/schema/文档组织/front matter/上限/只读语义）、未知名称 INVALID_PARAMS、文本与扫描器常量防漂移守卫；六工具零回归。
- **API 测试（tests/api，T-RKB-API）**：fake controller 全链路——骨架查询不触发扫描、展开列表触发一次扫描并写缓存、子条目/文档读缓存、不可达 null、扫描失败文案、MCP 工具列表不含仓库库。
- **前端组件（T-RKB-WEB）**：默认全部折叠、展开才发下一级查询（初始零扫描断言）、失败节点重试、front matter 表格（含三键以外的键、无 front matter 不渲染表格）、只读预览隐藏写入口、`?edit=1` 忽略、不合法库灰显。
- **E2E（E2E-RKB）**：放置知识库 → 分组列出云电脑 → 逐级展开可见 → 预览 front matter 表格 → 更新后重新检测生效 → 平台知识库零回归。

## 9. 验收标准

- [ ] PRD 功能点 1~5 全部验收项通过（放置规范识别、折叠懒加载分组、front matter 表格只读预览、MCP 工具不显示、MCP 编写指引提示词）。
- [ ] 平台托管知识库的功能（列表/树/预览/编辑/历史/设置/MCP 工具）零回归。
- [ ] 契约 `knowledge-base.graphql` 与手写 schema 一致；`agent-session-websocket.md` 新事件与实现一致；prompts 文本与扫描器常量同源。
- [ ] 单测 / API / E2E 全绿；各包 AGENTS.md 口径同步。

## 10. 相关文档

- PRD：`docs/product/draft/20261116-knowledge-base-repo-built-in.md`
- 知识库提案：`docs/engineering/proposals/20261115-feat-knowledge-base.md`
- 工作流模板项目持久化提案：`docs/engineering/proposals/20261107-feat-workflow-template-project-persistence.md`
- 工作流 MCP 提示词片段提案：`docs/engineering/proposals/20261115-feat-workflow-mcp-prompt-snippets.md`
- 契约：`contracts/knowledge-base.graphql`、`contracts/agent-session-websocket.md`、`contracts/mcp-server.graphql`
- 需求来源：GitHub Issue [Deliay/z-agent-gear#545](https://github.com/Deliay/z-agent-gear/issues/545)
