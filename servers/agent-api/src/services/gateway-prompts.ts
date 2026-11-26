/**
 * 网关 MCP 片段注册表（单一来源，以 MCP resources 投递）。
 *
 * 平台内置 MCP 服务 `agent-gateway-tools` 通过 MCP resources 能力
 * （`resources/list` / `resources/read`）向 AI 提供「服务暴露指引」：
 * `gateway-exposure-guidance`（endpoint/basePath 使用方式、Vite/Next/Nuxt/Spring 映射、
 * 登录鉴权 / 无 WebSocket upgrade / 30s 超时 / 上限与命名规则、禁止自行拼接地址）。
 *
 * 片段正文唯一出口是 `resources/read`（URI `zag://agent-gateway-tools/prompt/<name>`）；
 * 遵守 #580 裁决——平台片段只用 resources，不恢复 prompts。
 *
 * 文本必须与实现同源，规则变更时同步修改：
 * - 代理路由与鉴权：`servers/agent-api/src/routes/gateway-proxy.ts`（Bearer/cookie、30s、404 文案）；
 * - endpoint/basePath 计算：`servers/agent-api/src/services/gateway-endpoint.ts`；
 * - 名称/上限校验：`servers/agent-api/src/services/gateway.ts`（`config.gatewayMaxPerController`）。
 *
 * 防漂移守卫见 `gateway-prompts.test.ts`（T-GP1~4）。
 */

export interface GatewayPromptResourceDefinition {
  /** 资源 URI（稳定，`zag://<server>/prompt/<name>`） */
  uri: string;
  /** 片段名（kebab-case，稳定） */
  name: string;
  /** 一句话简介（resources/list 与错误信息共用） */
  description: string;
  /** 资源 MIME 类型（片段正文为 Markdown） */
  mimeType: string;
}

/** 平台 MCP 资源 URI 前缀（与工作流管理 / 知识库服务同一形态） */
export const GATEWAY_PROMPT_RESOURCE_URI_PREFIX = 'zag://agent-gateway-tools/prompt/';

/** 服务暴露指引 */
const GATEWAY_EXPOSURE_GUIDANCE_PROMPT = `## 网关服务暴露指引

本片段说明如何把本地服务通过平台网关暴露到外网。平台 MCP 服务 \`agent-gateway-tools\` 提供三个工具：
\`gateway_list\`（列出当前会话控制器上的端点）、\`gateway_create_endpoint\`（创建端点）、
\`gateway_delete_endpoint\`（删除端点）。

### 1. 地址唯一来源：使用工具返回值

- \`gateway_create_endpoint\` / \`gateway_list\` 返回的 \`endpoint\` 是**完整外网 URL**（恒以 \`/\` 结尾），
  \`basePath\` 是它的 path 部分（形如 \`/api/gateway/{controllerId}/{name}/\`）。
- **必须使用工具返回的 endpoint / basePath**：不要自行拼接 \`localhost:{port}\`、端口或域名，
  也不要凭记忆推断地址——**禁止自行拼接任何访问地址**，外部访问地址由服务端 \`PUBLIC_BASE_URL\` 单一来源派生。
- 对外分享给用户时，分享工具返回的完整 \`endpoint\`；给服务自身配置访问前缀时，使用 \`basePath\`。

### 2. Vite（前端项目最常见的场景）

在 \`vite.config.ts\` / \`vite.config.js\` 中：

\`\`\`ts
export default defineConfig({
  // 开发与构建同效：以工具返回的 basePath 作为资源前缀（保持首尾斜杠）
  base: '/api/gateway/{controllerId}/{name}/',
  server: {
    // 平台域名需放行，否则 Vite 会拦截 Host 头
    allowedHosts: ['<平台域名>'],
    // 网关不支持 WebSocket upgrade，HMR 长连接必然失败，必须关闭
    hmr: false,
  },
});
\`\`\`

- \`base: '<basePath>'\`：静态资源与路由前缀跟随网关路径（开发与 \`vite build\` 同效）。
- \`server.hmr: false\`：网关**不支持 WebSocket upgrade**，HMR 长连接会失败；可改为轮询（\`server.watch.usePolling\`）或直接关闭 HMR。
- \`server.allowedHosts\`：放行平台域名（或按部署配置关闭 Host 校验）。
- 前端路由与静态资源一律使用**相对路径**（或以 \`basePath\` 为前缀），避免绕过网关前缀。
- 仅修改开发服务器不足以保证生产可用：构建产物同样需要以 basePath 为前缀部署/访问。

### 3. 其他框架的同义映射

| 框架 | 配置 |
| --- | --- |
| Vite | \`base\` + \`server.allowedHosts\` + \`server.hmr: false\` |
| Next.js | \`basePath\` + \`assetPrefix\` |
| Nuxt | \`app.baseURL\` |
| Spring Boot | \`server.servlet.context-path\` |

### 4. 访问前提与限制

- **需要登录访问**：网关代理要求平台登录态（Bearer token 或登录 Cookie），匿名请求返回 401；
  分享地址时说明访问者需先登录平台。
- **单请求 30 秒超时**：超时返回 502，长轮询 / 流式响应 / 长时间任务请改用轮询或异步任务模式。
- **不支持 WebSocket upgrade**：实时推送请走 SSE 之外的轮询，或由平台会话通道承载。
- **每个控制器最多 5 个端点**（以实际部署配置为准）；名称规则 \`[a-zA-Z0-9_-]{1,50}\`，控制器内唯一。
- 端点删除后立即失效（代理返回 404 \`Gateway not found or not active\`）。

### 5. 使用纪律

- **仅在用户明确要求把服务暴露到外网时**创建端点；不要为调试或一次性验证创建。
- 完成后把工具返回的 \`endpoint\` 告知用户，并说明登录与超时/HMR 限制。
- 暴露目的结束后建议删除端点（\`gateway_delete_endpoint\`），避免残留暴露面。
`;

const PROMPT_TEXTS: Record<string, string> = {
  'gateway-exposure-guidance': GATEWAY_EXPOSURE_GUIDANCE_PROMPT,
};

/** 片段注册表（声明序即 resources/list 顺序） */
export const GATEWAY_PROMPT_RESOURCES: readonly GatewayPromptResourceDefinition[] = [
  {
    uri: `${GATEWAY_PROMPT_RESOURCE_URI_PREFIX}gateway-exposure-guidance`,
    name: 'gateway-exposure-guidance',
    description:
      '服务暴露指引：以工具返回的 endpoint/basePath 配置服务（Vite base/allowedHosts/关闭 HMR），覆盖登录鉴权、30s 超时、不支持 WebSocket upgrade、上限与命名规则、禁止自行拼接地址。',
    mimeType: 'text/markdown',
  },
];

/** 可用片段名列表（声明序；错误信息复用，保证「所列即所得」） */
export function listGatewayPromptNames(): string[] {
  return GATEWAY_PROMPT_RESOURCES.map((definition) => definition.name);
}

/** 按名称取片段完整文本；未知名称返回 null */
export function getGatewayPromptText(name: string): string | null {
  if (!name) return null;
  return Object.prototype.hasOwnProperty.call(PROMPT_TEXTS, name) ? PROMPT_TEXTS[name] : null;
}

/** 按 URI 取资源定义与正文；未知 URI 返回 null（供 resources/read 转 INVALID_PARAMS） */
export function getGatewayPromptResource(
  uri: string,
): { definition: GatewayPromptResourceDefinition; text: string } | null {
  if (!uri) return null;
  const definition = GATEWAY_PROMPT_RESOURCES.find((item) => item.uri === uri);
  if (!definition) return null;
  const text = getGatewayPromptText(definition.name);
  return text ? { definition, text } : null;
}
