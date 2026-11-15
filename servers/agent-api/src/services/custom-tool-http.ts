import { Agent, fetch as undiciFetch, FormData, Headers } from 'undici';
import {
  renderFragments,
  FRAGMENT_ERRORS,
  type Fragment,
  type RenderContext,
} from './fragment-render.js';
import type { CustomToolHttpConfigView, CustomToolMcpEntry } from './custom-tool-service.js';
import { valutService } from './valut-service.js';

/**
 * 自定义工具 http 执行器（需求 #449 / 提案 §5.2 实现点 5）。
 *
 * - 渲染分工：endpoint / queries / headers / body 各自由 Fragment 格式管线渲染（只编码一次，
 *   组装层**不二次编码**）；endpoint 渲染后必须 `http(s)://` 开头；json body 渲染后必须合法 JSON。
 * - 执行：undici fetch（`dispatcher` 仅 `insecure=true` 时替换为模块级 `insecureAgent`，
 *   不污染默认 dispatcher）；30s 硬超时；响应体 ≤256KB 截断并标注。
 * - 日志红线：请求/响应正文、headers、endpoint 全串、渲染中间值**一律不入日志**；
 *   失败只抛归类文案（`request failed` / `request timeout` / `tls verification failed`）。
 * - SSRF 面与 custom-mcp-forwarder 同口径（PRD：目标不做内外网限制）。
 */

export const HTTP_TOOL_TIMEOUT_MS = 30_000;
export const HTTP_RESPONSE_MAX_BYTES = 256 * 1024;

/** 仅在本次调用使用的 insecure dispatcher（模块级单例，与进程同生灭）。 */
export const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

export class CustomToolHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomToolHttpError';
  }
}

export interface CustomToolHttpResult {
  status: number;
  contentType: string | null;
  bodyText: string;
  truncated: boolean;
}

const MANAGED_CONTENT_TYPES: Record<'text' | 'json', string> = {
  text: 'text/plain; charset=utf-8',
  json: 'application/json',
};

function isTlsError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  const message = err instanceof Error ? err.message : String(err);
  return (
    typeof code === 'string' &&
    (code.startsWith('CERT_') || code === 'ERR_TLS_CERT_ALTNAME_INVALID' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT')
  ) || /certificate|self-signed|SSL|TLS/i.test(message);
}

function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: unknown })?.name;
  return (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    /timeout|aborted/i.test(err instanceof Error ? err.message : String(err))
  );
}

/** 渲染单个 Fragment[]（注入 valut 取值 + 调用参数）。 */
function makeRenderer(context: RenderContext) {
  return (fragments: Fragment[]): Promise<string> =>
    renderFragments(fragments, context, (key, ctx) =>
      valutService.resolveManualValueByKey(key, ctx.workspaceId),
    );
}

function appendQuery(url: URL, key: string, rendered: string): void {
  // rendered 已由 Fragment 格式管线（Uri）编码，组装层不二次编码
  const pair = `${encodeURIComponent(key)}=${rendered}`;
  url.search = url.search ? `${url.search}&${pair}` : `?${pair}`;
}

export async function execute(
  tool: CustomToolMcpEntry,
  params: Record<string, string>,
  renderContext: RenderContext,
): Promise<CustomToolHttpResult> {
  const config: CustomToolHttpConfigView | null = tool.http;
  if (!config) throw new CustomToolHttpError('invalid http config');

  const context: RenderContext = { ...renderContext, params };
  const render = makeRenderer(context);

  // 1) endpoint
  const endpoint = (await render(config.endpoint)).trim();
  if (!/^https?:\/\//i.test(endpoint)) {
    throw new CustomToolHttpError('invalid endpoint');
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new CustomToolHttpError('invalid endpoint');
  }

  // 2) queries（值已按格式管线编码）
  for (const query of config.queries) {
    appendQuery(url, query.key, await render(query.value));
  }

  // 3) headers（非 ASCII 值经百分号编码：HTTP header 只接受 ByteString）
  const headers = new Headers();
  for (const header of config.headers) {
    const rendered = await render(header.value);
    const safe = /[^\t\x20-\x7e]/.test(rendered) ? encodeURIComponent(rendered) : rendered;
    headers.append(header.key, safe.replace(/[\r\n]/g, ''));
  }

  // 4) body
  const method = config.method.toUpperCase();
  type UndiciBody = NonNullable<Parameters<typeof undiciFetch>[1]>['body'];
  let body: UndiciBody | undefined;
  if (config.bodyType && !['GET', 'HEAD'].includes(method)) {
    if (config.bodyType === 'form') {
      const form = new FormData();
      for (const field of config.form ?? []) {
        form.append(field.key, await render(field.value));
      }
      body = form;
    } else {
      const rendered = await render(config.body ?? []);
      if (config.bodyType === 'json') {
        try {
          JSON.parse(rendered);
        } catch {
          throw new CustomToolHttpError('rendered body is not valid json');
        }
      }
      body = rendered;
      // 托管 content-type 优先于用户同名 header（与 custom-mcp-forwarder「托管凭据覆盖」同思路）
      headers.set('content-type', MANAGED_CONTENT_TYPES[config.bodyType]);
    }
  }

  // 5) execute
  try {
    const response = await undiciFetch(url, {
      method,
      headers,
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(HTTP_TOOL_TIMEOUT_MS),
      ...(config.insecure ? { dispatcher: insecureAgent } : {}),
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    const truncated = buffer.length > HTTP_RESPONSE_MAX_BYTES;
    const bodyText = buffer.subarray(0, HTTP_RESPONSE_MAX_BYTES).toString('utf8');
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      bodyText,
      truncated,
    };
  } catch (err) {
    if (isTimeoutError(err)) throw new CustomToolHttpError('request timeout');
    if (isTlsError(err)) throw new CustomToolHttpError('tls verification failed');
    throw new CustomToolHttpError('request failed');
  }
}

/** 供 MCP 层使用的错误文案归一（渲染错误原样白名单，其余收敛）。 */
export function toHttpToolError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('valut key not found:') || message.startsWith('missing parameter:')) {
    return message;
  }
  if (message === FRAGMENT_ERRORS.tooLarge) return message;
  if (message === 'rendered body is not valid json') return message;
  if (message === 'invalid endpoint') return message;
  if (message === 'request timeout') return message;
  if (message === 'tls verification failed') return message;
  if (message === 'request failed') return message;
  return 'request failed';
}
