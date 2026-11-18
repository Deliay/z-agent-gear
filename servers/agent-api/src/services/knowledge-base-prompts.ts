/**
 * 知识库 MCP 提示词片段注册表（单一来源）。
 *
 * 平台内置 MCP 服务 `agent-knowledge-base-tools` 通过 MCP prompts 能力
 * （`prompts/list` / `prompts/get`）向 AI 提供「仓库知识库编写指引」：
 * `repo-knowledge-base-authoring`（存储路径 / 目录结构 / knowledge-base.json / 文档组织 / front matter / 上限 / 只读语义）。
 *
 * 文本必须与实现同源，规则变更时同步修改：
 * - 扫描模块（跨包常量，不能 import）：`packages/agent-controller/src/knowledge-bases.ts`
 *   （`REPO_KNOWLEDGE_BASE_SOURCES` / `MAX_FILE_BYTES` / `MAX_ENTRIES_PER_FOLDER`）；
 * - schema 解析：`servers/agent-api/src/services/repo-knowledge-bases.ts#parseRepoKnowledgeBaseSchema`；
 * - front matter 与标题回退链：`servers/agent-api/src/services/repo-knowledge-bases.ts#parseRepoDocument`。
 *
 * 防漂移守卫见 `knowledge-base-prompts.test.ts`（T-RKB-P4）。
 */

export interface KnowledgeBasePromptDefinition {
  /** 片段名（kebab-case，稳定） */
  name: string;
  /** 一句话简介（prompts/list 与 prompts/get 的 description 共用） */
  description: string;
}

/** 仓库知识库编写指引 */
const REPO_KNOWLEDGE_BASE_AUTHORING_PROMPT = `## 仓库知识库编写指引

本片段说明如何在代码仓库中内建知识库（仓库知识库）。仓库是唯一事实源：平台只读展示，不会修改仓库文件，历史即 Git 历史。

### 1. 放置约定

- 仓库根目录下有两个约定目录：\`.zag/knowledges/\` 与 \`docs/knowledges/\`。
- 两个目录下，每个**直接子文件夹**只要包含一个 \`knowledge-base.json\` 标识文件，就是一个知识库。
- 知识库发现**不递归**：只有来源目录的直接子文件夹会被识别，深层嵌套文件夹中的 \`knowledge-base.json\` 不生效。
- 两个来源目录都支持，建议团队规范放在 \`.zag/knowledges/\`，面向开发者的文档放在 \`docs/knowledges/\`。

### 2. 目录结构示例

\`\`\`text
<仓库根>/
├── .zag/knowledges/
│   └── team-rules/
│       ├── knowledge-base.json      # 知识库标识 + 元信息
│       ├── onboarding.md
│       └── guides/
│           └── git.md
└── docs/knowledges/
    └── product-docs/
        ├── knowledge-base.json
        └── specs/
            └── overview.md
\`\`\`

### 3. knowledge-base.json

标识文件为 JSON，字段如下：

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| \`name\` | 是 | trim 后 1~64 字符 |
| \`description\` | 否 | 字符串，≤1024 字符 |

示例：

\`\`\`json
{
  "name": "团队规范",
  "description": "研发团队的编码、提交与协作规范"
}
\`\`\`

- \`name\` 缺失、为空或超过 64 字符时该知识库标记为不合法，在界面上灰显并展示原因。
- \`description\` 超过 1024 字符同样标记为不合法。
- 文件超过 1MiB 时该知识库不读取（标记 \`file too large\`）。

### 4. 文档组织

- 知识库文件夹内（含所有子目录）的 \`.md\` 文件都是该知识库的文档；扩展名按小写比较（\`.MD\` 也会被识别）。
- 文档路径 = 文件相对知识库文件夹的 POSIX 路径去掉末尾 \`.md\`，并在前面加 \`/\`。
  - \`team-rules/guides/git.md\` → 文档路径 \`/guides/git\`。
  - \`team-rules/onboarding.md\` → 文档路径 \`/onboarding\`。
- 路径大小写保留；归一后路径冲突（如 \`a.md\` 与 \`a.MD\`）会使整个知识库标记为不合法，冲突文档均不收录。
- 单个文档超过 1MiB 时该文档标记 \`file too large\`（不可打开），不影响其它文档。

### 5. Front matter（可选）

文档开头可用 \`---\` 包围 YAML 风格的极简 front matter，平台只识别以下三个键：

\`\`\`markdown
---
title: Git 提交规范
tags: [git, 规范]
description: 提交信息格式与分支约定
---

# 正文……
\`\`\`

| 键 | 规则 |
| --- | --- |
| \`title\` | trim 后 1~200 字符；用于侧边栏与预览标题 |
| \`tags\` | 最多 16 个，每个 1~32 字符；支持 \`[a, b]\` 与逗号分隔两种写法 |
| \`description\` | ≤1024 字符 |

- 只支持单行 \`key: value\`，值中不能换行；块非法时整体按「无 front matter」处理，不报错。
- 前端会把 front matter 原文渲染为键值表格（保留全部键，包括上述三键以外的自定义键），正文紧随其后。
- 标题回退链：front matter \`title\` → 正文首个一级标题（\`# \`）→ 文件名（去掉 \`.md\`）。
- 单键超限时仅忽略该键并回退默认值，不会使整个知识库不合法。

### 6. 数量与体积上限

| 限制 | 上限 |
| --- | --- |
| 单个文件（文档与 \`knowledge-base.json\` 同值） | 1MiB |
| 单个文件夹的直接子项（目录与文件合计） | 1000 个（按名称排序取前 1000，超出截断） |
| 文档数、知识库数、内容累计 | 无上限 |

超过单文件或单文件夹上限时平台会截断并标记 \`truncated\`；请拆分目录或精简文件控制在限值内。

### 7. 只读语义

- 仓库知识库**只读展示**：平台不提供编辑、删除、历史版本、权限设置入口。
- 仓库知识库**不会出现在知识库 MCP 工具中**（\`knowledge_base_list\` 等六个工具只返回平台托管知识库）。
- 不允许在平台内修改仓库知识库；更新请走仓库提交流程（修改 Markdown / \`knowledge-base.json\` 并提交到 Git）。
- 侧边栏「仓库知识库」分组默认全部折叠，点击展开才加载下一级条目；列表有约 5 分钟缓存，可用「重新检测」立即刷新。

### 8. 自检清单

1. 知识库文件夹位于 \`.zag/knowledges/\` 或 \`docs/knowledges/\` 的**直接**子目录。
2. 文件夹内存在合法的 \`knowledge-base.json\`（\`name\` 必填且 1~64 字符）。
3. 文档均为 \`.md\`，路径无冲突、单篇 ≤1MiB。
4. 需要自定义标题/标签时使用可选 front matter，且三键在限值内。
5. 修改后提交到 Git；平台侧点击「重新检测」查看最新内容。
`;

const PROMPT_TEXTS: Record<string, string> = {
  'repo-knowledge-base-authoring': REPO_KNOWLEDGE_BASE_AUTHORING_PROMPT,
};

/** 片段注册表（声明序即 prompts/list 顺序） */
export const REPO_KNOWLEDGE_BASE_PROMPT_DEFINITIONS: readonly KnowledgeBasePromptDefinition[] = [
  {
    name: 'repo-knowledge-base-authoring',
    description:
      '仓库知识库编写指引：.zag/knowledges/ 与 docs/knowledges/ 放置约定、knowledge-base.json、文档组织、front matter、上限与只读语义。',
  },
];

/** 可用片段名列表（声明序；错误信息复用，保证「所列即所得」） */
export function listKnowledgeBasePromptNames(): string[] {
  return REPO_KNOWLEDGE_BASE_PROMPT_DEFINITIONS.map((definition) => definition.name);
}

/** 按名称取片段完整文本；未知名称返回 null */
export function getKnowledgeBasePromptText(name: string): string | null {
  if (!name) return null;
  return Object.prototype.hasOwnProperty.call(PROMPT_TEXTS, name) ? PROMPT_TEXTS[name] : null;
}
