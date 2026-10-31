import { spawn, ChildProcess } from 'child_process';
import { io as ioClient, Socket } from 'socket.io-client';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';

interface McpProxyOptions {
  server: string;
  key: string;
  command: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  [key: string]: unknown;
}

const FORWARD_TIMEOUT_MS = 30_000;

// JSON-RPC notifications have no id and MUST NOT be waited on: per the MCP
// spec the server never responds to them. Waiting would stall every hop of
// the forward chain for the full timeout.
function isNotification(request: JsonRpcRequest): boolean {
  return request.id === undefined || request.id === null;
}

// Persistent line-buffered JSON-RPC dispatcher over a child process' stdio.
// Responses are matched to requests by id, so chunked responses (a single
// 'data' event is NOT guaranteed to contain exactly one complete JSON
// message) and concurrent in-flight requests are handled correctly.
export function createStdioDispatcher(child: ChildProcess, logger?: ObservationLogger) {
  const log = logger ?? rootLogger.child({ component: 'mcp-proxy' });
  let buffer = '';
  const pending = new Map<unknown, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timeout: NodeJS.Timeout; method: string }>();

  child.stdout?.on('data', (data: Buffer) => {
    buffer += data.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg: { id?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        log.error(
          { event: 'non_json_line', preview: line.slice(0, 200) },
          'ignoring non-JSON line from child',
        );
        continue;
      }
      const entry = pending.get(msg.id);
      if (!entry) {
        log.error(
          { event: 'unknown_response_id', id: typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : undefined },
          'ignoring response with unknown id',
        );
        continue;
      }
      clearTimeout(entry.timeout);
      pending.delete(msg.id);
      log.debug(
        { event: 'mcp_response', method: entry.method, id: msg.id, ...(msg.error ? { error: msg.error.message } : {}) },
        'mcp response',
      );
      entry.resolve(msg);
    }
  });

  const rejectAll = (reason: Error) => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timeout);
      entry.reject(reason);
    }
    pending.clear();
  };

  child.on('exit', (code) => {
    log.info(
      { event: 'mcp_command_exited', exitCode: code, pendingCount: pending.size },
      'MCP command exited',
    );
    rejectAll(new Error(`MCP command exited with code ${code}`));
  });

  return {
    forward(request: JsonRpcRequest): Promise<unknown> {
      const method = request.method ?? '(unknown)';
      if (isNotification(request)) {
        // Fire-and-forget: deliver the notification (e.g. notifications/initialized
        // completes the MCP handshake) but do not wait for a response.
        log.debug({ event: 'forward_notification', method }, 'forwarding notification');
        child.stdin?.write(JSON.stringify(request) + '\n');
        return Promise.resolve(null);
      }
      log.debug({ event: 'forward_request', method, id: request.id }, 'forwarding request');
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(request.id);
          reject(new Error(`Request timeout waiting for ${method}`));
        }, FORWARD_TIMEOUT_MS);
        pending.set(request.id, { resolve, reject, timeout, method });
        child.stdin?.write(JSON.stringify(request) + '\n');
      });
    },
  };
}

export async function startMcpRegistration(options: McpProxyOptions): Promise<void> {
  const { server, key, command } = options;
  const log = rootLogger.child({ component: 'mcp-proxy' });

  console.log(`Registering MCP proxy with server ${server}...`); // no-console-allow: CLI 用户可见输出（进度）

  // 1. Register with server
  const response = await fetch(`${server}/api/mcp-proxy/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key,
      hostname: process.env.HOSTNAME || 'unknown',
      command,
      serverName: command.split(' ').pop() || 'unknown',
    }),
  });

  const result = await response.json() as any;
  if (!result.success) {
    console.error('Registration failed:', result.error); // no-console-allow: CLI 用户可见输出（失败结果）
    process.exit(1);
  }

  console.log(`Registered as proxy ${result.proxyId}, server ${result.serverId}`); // no-console-allow: CLI 用户可见输出（结果：代理标识）

  // 2. Spawn local command
  const [cmd, ...args] = command.split(' ');
  console.log(`Starting local MCP command: ${cmd} ${args.join(' ')}`); // no-console-allow: CLI 用户可见输出（进度）

  const child = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  });

  child.on('error', (err) => {
    console.error('Failed to start MCP command:', err.message); // no-console-allow: CLI 用户可见输出（失败结果）
  });

  // 3. Establish WebSocket connection
  const socket = ioClient(`${server}/mcp-proxy`, {
    transports: ['websocket'],
    autoConnect: true,
  });

  socket.on('connect', () => {
    console.log('WebSocket connected to proxy namespace'); // no-console-allow: CLI 用户可见输出（进度）
    socket.emit('proxy:register', { proxyId: result.proxyId, key });
  });

  socket.on('proxy:registered', (data: { proxyId: string; serverId: string }) => {
    console.log(`Registered with proxy namespace, serverId: ${data.serverId}`); // no-console-allow: CLI 用户可见输出（结果）
  });

  socket.on('proxy:error', (data: { code: string; message: string }) => {
    log.error({ event: 'proxy_error', code: data.code, serverMessage: data.message }, 'proxy error');
  });

  // 4. Bridge requests
  const dispatcher = createStdioDispatcher(child, log);
  socket.on('proxy:request', async (data: { requestId: string; request: JsonRpcRequest }) => {
    try {
      const response = await dispatcher.forward(data.request);
      socket.emit('proxy:response', { requestId: data.requestId, response });
    } catch (err: any) {
      log.error(
        {
          event: 'forward_failed',
          method: data.request?.method,
          id: data.request?.id,
          err: { message: err?.message ?? String(err) },
        },
        'mcp forward failed',
      );
      socket.emit('proxy:response', {
        requestId: data.requestId,
        response: {
          jsonrpc: '2.0',
          id: data.request.id ?? null,
          error: { code: -32603, message: err.message },
        },
      });
    }
  });

  // 5. Heartbeat
  const heartbeatInterval = setInterval(() => {
    if (socket.connected) {
      socket.emit('proxy:heartbeat', { proxyId: result.proxyId });
    }
  }, 30000);

  // 6. Cleanup
  const shutdown = () => {
    console.log('Shutting down MCP proxy...'); // no-console-allow: CLI 用户可见输出（进度/生命周期）
    clearInterval(heartbeatInterval);
    socket.emit('proxy:unregister', { proxyId: result.proxyId });
    child.kill();
    socket.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
