/**
 * Socket.IO 连接诊断日志。
 *
 * 目的：匿名连接（未 register 即断开）此前只能看到 `disconnecting undefined [id]`，
 * 无法定位来源。这里统一输出握手信息（IP / Origin / UA / query / auth 键名）与断开原因。
 *
 * 安全边界：任何可能携带凭据的字段（key/token/secret/password/authorization/cookie）
 * 只输出键名或 `***`，绝不输出原始值。
 */
const SENSITIVE_NAME_PATTERN = /token|key|secret|password|authorization|cookie/i;
const MAX_FIELD_LENGTH = 160;

interface DiagnosticHandshake {
  address?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  auth?: Record<string, unknown>;
}

interface DiagnosticSocket {
  id: string;
  nsp?: { name?: string };
  data?: Record<string, unknown>;
  handshake: DiagnosticHandshake;
}

function truncate(value: string): string {
  if (value.length <= MAX_FIELD_LENGTH) return value;
  return `${value.slice(0, MAX_FIELD_LENGTH)}…[truncated ${value.length - MAX_FIELD_LENGTH}]`;
}

function headerValue(headers: DiagnosticHandshake['headers'], name: string): string | undefined {
  const raw = headers?.[name];
  if (Array.isArray(raw)) return raw.join(', ');
  return raw;
}

export function redactLogValue(name: string, value: unknown): string {
  if (SENSITIVE_NAME_PATTERN.test(name)) return '***';
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '<unserializable>';
  }
}

function redactQuery(query: DiagnosticHandshake['query']): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(query ?? {})) {
    result[name] = truncate(redactLogValue(name, value));
  }
  return result;
}

function formatUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '<unserializable>';
  }
}

/** 一行描述“谁连上来了”，用于定位刷屏连接的来源。 */
export function describeConnection(socket: DiagnosticSocket): string {
  const handshake = socket.handshake ?? {};
  const headers = handshake.headers ?? {};
  const query = handshake.query ?? {};
  const auth = handshake.auth ?? {};

  const parts = [
    '[socket] connected',
    `id=${socket.id}`,
    `address=${handshake.address ?? '-'}`,
    `transport=${redactLogValue('transport', query.transport) || '-'}`,
    `ns=${socket.nsp?.name ?? '/'}`,
  ];

  const origin = headerValue(headers, 'origin');
  if (origin) parts.push(`origin=${truncate(origin)}`);

  const userAgent = headerValue(headers, 'user-agent');
  if (userAgent) parts.push(`ua="${truncate(userAgent)}"`);

  const forwardedFor = headerValue(headers, 'x-forwarded-for');
  if (forwardedFor) parts.push(`xff="${truncate(forwardedFor)}"`);

  parts.push(`auth=[${Object.keys(auth).join(',')}]`);
  parts.push(`query=${JSON.stringify(redactQuery(query))}`);

  return parts.join(' ');
}

/** 一行描述断开事件，匿名断开不再输出 `undefined`。 */
export function describeDisconnect(
  socket: DiagnosticSocket,
  reason: string,
  description?: unknown,
): string {
  const keyId = socket.data?.keyId;
  const parts = [
    '[socket] disconnected',
    `id=${socket.id}`,
    `address=${socket.handshake?.address ?? '-'}`,
    `ns=${socket.nsp?.name ?? '/'}`,
    `key=${keyId ? String(keyId) : '-'}`,
    `authenticated=${Boolean(keyId)}`,
    `reason=${reason}`,
  ];

  if (description !== undefined && description !== null) {
    parts.push(`desc="${truncate(formatUnknown(description))}"`);
  }

  return parts.join(' ');
}
