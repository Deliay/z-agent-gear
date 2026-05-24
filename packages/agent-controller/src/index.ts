#!/usr/bin/env node
import { Command } from 'commander';
import { hostname } from 'os';
import { resolveKey, resolveEndpoint, saveKeyToConfig, saveEndpointToConfig } from './config.js';
import { connectToServer, unregister } from './socketio-client.js';
import { writePid, removePid, isRunning } from './daemon.js';

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
      unregister(socket);
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

program.parse();
