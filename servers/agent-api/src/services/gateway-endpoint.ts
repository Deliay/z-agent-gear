/**
 * 网关 endpoint / basePath 唯一计算口径（需求 #565 / 提案 §3.2）。
 *
 * - `endpoint` 为完整外网 URL：`{PUBLIC_BASE_URL}/api/gateway/{controllerId}/{name}/`；
 * - `basePath` 为其 path 部分（恒以 `/` 开头与结尾）；
 * - `PUBLIC_BASE_URL` 去尾斜杠归一，`controllerId` / `name` 按路径段编码；
 * - 纯函数、零 IO；**禁止在其它位置二次拼接**（GraphQL `Gateway.endpoint`、
 *   前端展示与平台 MCP `agent-gateway-tools` 返回值同源）。
 *
 * 与代理路由 `router.all('/gateway/:controllerId/:name/{*path}')`（挂载于 `/api`）逐字对齐。
 */

/** `PUBLIC_BASE_URL` 归一：去掉末尾所有斜杠（配置层已归一，此处防御式再归一）。 */
export function normalizeGatewayBaseUrl(publicBaseUrl: string): string {
  return String(publicBaseUrl ?? '').replace(/\/+$/, '');
}

/** 外网访问基础路径：`/api/gateway/{controllerId}/{name}/`（恒以 `/` 开头与结尾）。 */
export function buildGatewayBasePath(controllerId: string, name: string): string {
  return `/api/gateway/${encodeURIComponent(controllerId)}/${encodeURIComponent(name)}/`;
}

/** 完整外网访问地址：`{publicBaseUrl}/api/gateway/{controllerId}/{name}/`。 */
export function buildGatewayEndpoint(
  publicBaseUrl: string,
  controllerId: string,
  name: string,
): string {
  return `${normalizeGatewayBaseUrl(publicBaseUrl)}${buildGatewayBasePath(controllerId, name)}`;
}
