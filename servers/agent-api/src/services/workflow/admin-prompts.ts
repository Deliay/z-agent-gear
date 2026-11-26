/**
 * 工作流 MCP 片段注册表（单一来源，以 MCP resources 投递）。
 *
 * 平台内置 MCP 服务 `agent-workflow-admin-tools` 通过 MCP resources 能力
 * （`resources/list` / `resources/read`）向 AI 提供两段权威说明：
 * - `workflow-schema`：工作流 Schema 说明（顶层结构 / 节点类型 / 节点字段 / 图校验规则 / AI 节点 Agent 配置）；
 * - `workflow-project-persistence`：工作流项目持久化指引（`.zag/workflow/templates/` 放置约定 / 文件格式 / 约束 / 生效方式）。
 *
 * 片段正文唯一出口是 `resources/read`（URI 形如 `zag://<server>/prompt/<name>`），不再通过 prompts 提供。
 *
 * 片段文本必须与实现同源，规则变更时同步修改：
 * - 图规则：`servers/agent-api/src/services/workflow/template.ts#validateTemplateGraph`；
 * - 项目文件解析：`servers/agent-api/src/services/workflow/repo-templates.ts#parseRepoTemplate`；
 * - 扫描上限（跨包常量，不能 import）：`packages/agent-controller/src/workflow-templates.ts`
 *   （`WORKFLOW_TEMPLATES_SUBDIR` / `WORKFLOW_TEMPLATES_MAX_FILES` / `WORKFLOW_TEMPLATES_MAX_FILE_BYTES` /
 *   `WORKFLOW_TEMPLATES_MAX_TOTAL_BYTES`）；
 * - Agent 配置校验：`servers/agent-api/src/services/workflow/configured.ts#validateAgentConfigs`。
 *
 * 防漂移守卫见 `admin-prompts.test.ts`（T-AP4 / T-AP5）。
 */

export interface AdminPromptResourceDefinition {
  /** 资源 URI（稳定，`zag://<server>/prompt/<name>`） */
  uri: string;
  /** 片段名（kebab-case，稳定） */
  name: string;
  /** 一句话简介（resources/list 与错误信息共用） */
  description: string;
  /** 资源 MIME 类型（片段正文为 Markdown） */
  mimeType: string;
}

/** 平台 MCP 资源 URI 前缀（两个平台服务的共同形态） */
export const ADMIN_PROMPT_RESOURCE_URI_PREFIX = 'zag://agent-workflow-admin-tools/prompt/';

/** 工作流 Schema 说明片段 */
const WORKFLOW_SCHEMA_PROMPT = `## 工作流 Schema 说明

本片段说明平台工作流模板（工作流 Schema）的结构与校验规则。创建工作流模板、已配置工作流或工作流实例时，请严格按本文书写节点图，违反任一规则都会被平台校验拒绝。

### 1. 顶层结构

\`\`\`jsonc
{
  "name": "必填，模板名称（非空字符串）",
  "description": "可选，模板描述",
  "nodes": [ /* 必填，至少 1 个节点 */ ]
}
\`\`\`

- \`name\`：必填，非空字符串。
- \`description\`：可选字符串。
- \`nodes\`：必填，至少 1 个节点。
- 名称长度规则：只有「已配置工作流」与「工作流实例」在配置/实例化时会把名称归一为 trim 后 1~64 字符；模板本身不做名称长度校验。

### 2. 节点类型

| 类型 | 语义 |
| --- | --- |
| \`HUMAN\` | 人类节点：唯一的入口节点类型，承载人工输入、审核与打回；可开启「联动上游 Pull Request」 |
| \`AI\` | AI 执行节点：由 Agent 会话执行，必须配置提示词（prompts）并在配置/实例化阶段补齐 Agent 配置 |
| \`FLAG\` | 旗帜节点：标记与汇合语义，不执行 AI，不允许配置提示词与产物标题 |

### 3. 节点字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| \`nodeKey\` | string | 必填；节点唯一标识，全图唯一（nodeKey 重复会被拒绝） |
| \`type\` | \`HUMAN\` \\| \`AI\` \\| \`FLAG\` | 必填；节点类型 |
| \`name\` | string | 必填；节点名称（用于展示与错误信息） |
| \`description\` | string | 可选；节点描述 |
| \`stage\` | string | 必填；节点所属阶段（用于分组展示） |
| \`dependsOn\` | string[] | 必填；上游节点 nodeKey 列表；空数组表示无上游，可作为首节点候选 |
| \`requiresWorktree\` | boolean | 必填；该节点会话是否需要 worktree 隔离 |
| \`prompts\` | string[] | 仅 AI 节点；至少 1 条去空白后非空的提示词 |
| \`artifactTitles\` | string[] | 仅 AI 节点；可选，产物标题列表 |
| \`linkUpstreamPullRequest\` | boolean | 仅 HUMAN 节点可设为 true；是否联动上游 Pull Request |
| \`sortOrder\` | number | 可选；同层展示排序（必须为有限数字） |

### 4. 图校验规则

平台按以下规则逐条校验节点图（校验失败会返回可读中文原因）：

1. \`nodes\` 至少需要 1 个节点。
2. \`nodeKey\` 全局唯一，不允许重复。
3. \`dependsOn\` 中的每个 nodeKey 必须引用图中存在的节点，不允许引用不存在的节点。
4. 节点图必须是有向无环图（DAG），不允许出现循环依赖。
5. 入度为 0 的节点（\`dependsOn\` 为空）有且仅有 1 个，即首节点唯一。
6. 首节点必须是人类节点（HUMAN）——若首节点为 AI 或 FLAG 会被拒绝。
7. AI 节点的提示词（prompts）至少需要 1 条非空内容。
8. HUMAN / FLAG 节点不允许配置提示词（prompts）与产物标题（artifactTitles）。
9. 仅人类节点可开启「联动上游 Pull Request」；AI / FLAG 节点设为 true 会被拒绝。

### 5. AI 节点的 Agent 配置（agentConfig）

模板与项目内 JSON 文件**不包含** agentConfig；Agent 配置发生在「配置工作流」/「实例化」阶段，由平台为每个 AI 节点补齐：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| \`acpServerType\` | string | 必填；ACP 服务器类型，必须在该控制器的可用能力清单内 |
| \`initNewWorktree\` | boolean | 必填；是否为该节点新建 worktree |
| \`modeId\` | string | 可选；Agent 模式 |
| \`modelId\` | string | 可选；Agent 模型 |

缺失 \`agentConfig.acpServerType\` 或 \`initNewWorktree\` 会被拒绝；\`acpServerType\` 不在控制器可用列表内同样会被拒绝。
`;

/** 工作流项目持久化指引片段 */
const WORKFLOW_PROJECT_PERSISTENCE_PROMPT = `## 工作流项目持久化指引

本片段说明如何把工作流模板随项目代码一起持久化在仓库中，以及平台检测、配置与生效的规则。

### 1. 放置约定

- 模板文件放在仓库根目录下的 \`.zag/workflow/templates/\` **直下**。
- 一个 \`.json\` 文件对应一个工作流模板，文件名即模板的仓库来源标识。
- 只扫描该目录的直下文件，**不递归**子目录。
- 符号链接按 \`stat\` 判定：只有指向常规文件的链接才会被读取。
- 文件名必须非空且以 \`.json\` 结尾，不允许包含路径分隔符（\`/\` 或反斜杠）、\`..\` 或空字符。

### 2. 文件格式

文件内容为 JSON，顶层结构与「工作流 Schema 说明」一致：

\`\`\`jsonc
{
  "name": "必填，非空字符串",
  "description": "可选字符串",
  "nodes": [ /* 非空数组，节点图规则与 workflow-schema 一致 */ ]
}
\`\`\`

- 节点图规则（nodeKey 唯一、首节点唯一且为 HUMAN、DAG 无环、AI 节点 prompts 至少 1 条、字段类型约束等）与 \`workflow-schema\` 片段完全一致。
- 项目文件**不包含** agentConfig：Agent 配置在平台侧「配置工作流」时补齐。

### 3. 文件约束

- 仅识别上述目录直下的 \`.json\` 常规文件；不递归、不写回、不执行。
- 最多扫描 20 个文件。
- 单个文件内容上限 128KiB（131072 字节）；超限文件标记 \`file too large\`，不参与解析。
- 全部文件内容累计上限 1MiB（1048576 字节）；超限后截断（\`truncated\` 为 true），超出部分的文件不生效。

### 4. 检测、配置与生效方式

- **检测时机**：文件随仓库提交后，在云电脑新增工作目录（含完成 GitHub 项目设置）时平台会自动检测并提示配置；也可在云电脑设置中随时手动检测与配置。
- **检测前置**：控制器需在线，且 agent-gear 版本 ≥2.18.0；版本低于要求时检测返回空列表（不报错）。
- **快照语义**：配置时对模板做一次快照（来源标记为仓库来源）；仓库后续修改不会影响已配置的工作流，需要重新配置才会采用新内容。
- **仅支持云电脑**：仓库模板仅能在云电脑（cloud 控制器）上检测与配置；本地控制器会返回 \`repo workflow only supports cloud host\`。
- **不合法文件处理**：逐个文件隔离校验，不合法文件会被标记 \`valid=false\` 并给出原因（JSON 语法错误 / 顶层形状错误 / 节点字段类型错误 / 图校验失败），不会静默忽略，也不会影响其它合法文件。
`;

const PROMPT_TEXTS: Record<string, string> = {
  'workflow-schema': WORKFLOW_SCHEMA_PROMPT,
  'workflow-project-persistence': WORKFLOW_PROJECT_PERSISTENCE_PROMPT,
};

/** 片段注册表（声明序即 resources/list 顺序） */
export const ADMIN_PROMPT_RESOURCES: readonly AdminPromptResourceDefinition[] = [
  {
    uri: `${ADMIN_PROMPT_RESOURCE_URI_PREFIX}workflow-schema`,
    name: 'workflow-schema',
    description: '工作流 Schema 说明：顶层结构、节点类型与字段、图校验规则、AI 节点 Agent 配置。',
    mimeType: 'text/markdown',
  },
  {
    uri: `${ADMIN_PROMPT_RESOURCE_URI_PREFIX}workflow-project-persistence`,
    name: 'workflow-project-persistence',
    description:
      '工作流项目持久化指引：.zag/workflow/templates/ 放置约定、JSON 文件格式、文件约束与检测配置生效方式。',
    mimeType: 'text/markdown',
  },
];

/** 可用片段名列表（声明序；错误信息复用，保证「所列即所得」） */
export function listAdminPromptNames(): string[] {
  return ADMIN_PROMPT_RESOURCES.map((definition) => definition.name);
}

/** 按名称取片段完整文本；未知名称返回 null */
export function getAdminPromptText(name: string): string | null {
  if (!name) return null;
  return Object.prototype.hasOwnProperty.call(PROMPT_TEXTS, name) ? PROMPT_TEXTS[name] : null;
}

/** 按 URI 取资源定义与正文；未知 URI 返回 null（供 resources/read 转 INVALID_PARAMS） */
export function getAdminPromptResource(
  uri: string,
): { definition: AdminPromptResourceDefinition; text: string } | null {
  if (!uri) return null;
  const definition = ADMIN_PROMPT_RESOURCES.find((item) => item.uri === uri);
  if (!definition) return null;
  const text = getAdminPromptText(definition.name);
  return text ? { definition, text } : null;
}
