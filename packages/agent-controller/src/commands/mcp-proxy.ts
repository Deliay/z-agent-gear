import { spawn, ChildProcess } from 'child_process';
import { io as ioClient, Socket } from 'socket.io-client';

interface McpProxyOptions {
  server: string;
  key: string;
  command: string;
}

export async function startMcpRegistration(options: McpProxyOptions): Promise<void> {
  const { server, key, command } = options;

  console.log(`Registering MCP proxy with server ${server}...`);

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
    console.error('Registration failed:', result.error);
    process.exit(1);
  }

  console.log(`Registered as proxy ${result.proxyId}, server ${result.serverId}`);

  // 2. Spawn local command
  const [cmd, ...args] = command.split(' ');
  console.log(`Starting local MCP command: ${cmd} ${args.join(' ')}`);

  const child = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  });

  child.on('error', (err) => {
    console.error('Failed to start MCP command:', err.message);
  });

  child.on('exit', (code) => {
    console.log(`MCP command exited with code ${code}`);
  });

  // 3. Establish WebSocket connection
  const socket = ioClient(`${server}/mcp-proxy`, {
    transports: ['websocket'],
    autoConnect: true,
  });

  socket.on('connect', () => {
    console.log('WebSocket connected to proxy namespace');
    socket.emit('proxy:register', { proxyId: result.proxyId, key });
  });

  socket.on('proxy:registered', (data: { proxyId: string; serverId: string }) => {
    console.log(`Registered with proxy namespace, serverId: ${data.serverId}`);
  });

  socket.on('proxy:error', (data: { code: string; message: string }) => {
    console.error(`Proxy error: ${data.code} - ${data.message}`);
  });

  // 4. Bridge requests
  socket.on('proxy:request', async (data: { requestId: string; request: any }) => {
    try {
      const response = await forwardToChild(child, data.request);
      socket.emit('proxy:response', { requestId: data.requestId, response });
    } catch (err: any) {
      socket.emit('proxy:response', {
        requestId: data.requestId,
        response: {
          jsonrpc: '2.0',
          id: data.request.id,
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
    console.log('Shutting down MCP proxy...');
    clearInterval(heartbeatInterval);
    socket.emit('proxy:unregister', { proxyId: result.proxyId });
    child.kill();
    socket.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function forwardToChild(child: ChildProcess, request: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Request timeout'));
    }, 30000);

    const onData = (data: Buffer) => {
      clearTimeout(timeout);
      child.stdout?.removeListener('data', onData);
      try {
        resolve(JSON.parse(data.toString()));
      } catch {
        reject(new Error('Invalid JSON response from MCP command'));
      }
    };

    child.stdout?.on('data', onData);
    child.stdin?.write(JSON.stringify(request) + '\n');
  });
}
