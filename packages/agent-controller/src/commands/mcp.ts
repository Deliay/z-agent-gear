import * as readline from 'readline';

interface McpProxyOptions {
  endpoint: string;
  token: string;
}

export async function startMcpProxy(options: McpProxyOptions): Promise<void> {
  const { endpoint, token } = options;

  console.log(`Starting MCP proxy for endpoint: ${endpoint}`);

  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    try {
      const request = JSON.parse(line);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(request),
      });
      const result = await response.json();
      process.stdout.write(JSON.stringify(result) + '\n');
    } catch (err: any) {
      const error = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: err.message },
      };
      process.stdout.write(JSON.stringify(error) + '\n');
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });
}
