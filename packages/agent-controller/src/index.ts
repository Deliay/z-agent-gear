#!/usr/bin/env node
import { Command } from 'commander';
import { hostname } from 'os';
import { resolveKey, resolveEndpoint, saveKeyToConfig, saveEndpointToConfig } from './config.js';
import { connectToServer } from './socketio-client.js';
import { writePid, removePid, isRunning } from './daemon.js';
import { startMcpRegistration } from './commands/mcp-proxy.js';
import { startMcpProxy } from './commands/mcp.js';

const program = new Command();

program
  .name('agent-gear')
  .description('Agent Controller - manages connection to controller-api')
  .version('1.0.0')
  .option('-k, --key <key>', 'Controller key')
  .option('-s, --server <endpoint>', 'Server endpoint URL')
  .option('-n, --name <name>', 'Controller name')
  .action(async (options) => {
    if (isRunning()) {
      console.error('Controller is already running. Stop it first or remove the PID file.');
      process.exit(1);
    }

    const key = resolveKey(options.key);
    if (!key) {
      console.error('No key provided. Use --key, ZAG_CONTROLLER_KEY env, or configure in ~/.zag/config.toml');
      process.exit(1);
    }

    const endpoint = resolveEndpoint(options.server);
    if (!endpoint) {
      console.error('No server endpoint provided. Use --server, ZAG_SERVER_ENDPOINT env, or configure in ~/.zag/config.toml');
      process.exit(1);
    }

    if (options.key) saveKeyToConfig(options.key);
    if (options.server) saveEndpointToConfig(options.server);

    writePid();

    const socket = connectToServer(endpoint, key, {
      serverName: options.name || hostname(),
    });

    const shutdown = () => {
      console.log('Shutting down...');
      socket.disconnect();
      removePid();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    process.on('exit', () => {
      removePid();
    });
  });

program
  .command('mcp-proxy')
  .description('Register a local MCP command as a proxy')
  .requiredOption('--server <endpoint>', 'Server endpoint URL')
  .requiredOption('--key <key>', 'MCP Proxy Key')
  .requiredOption('--command <command>', 'Local MCP command to proxy')
  .action(async (options) => {
    await startMcpRegistration({
      server: options.server,
      key: options.key,
      command: options.command,
    });
  });

program
  .command('mcp')
  .description('Start stdio MCP proxy (HTTP to stdio)')
  .requiredOption('--endpoint <url>', 'MCP forwarder endpoint URL')
  .requiredOption('--token <token>', 'Bearer token for authentication')
  .action(async (options) => {
    await startMcpProxy({
      endpoint: options.endpoint,
      token: options.token,
    });
  });

program.parse();
