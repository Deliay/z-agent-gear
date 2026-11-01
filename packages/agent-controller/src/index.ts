#!/usr/bin/env node
import './observability/register.js';
import { Command } from 'commander';
import { createRequire } from 'node:module';
import { hostname, platform } from 'os';
import { resolveKey, resolveEndpoint, saveKeyToConfig, saveEndpointToConfig } from './config.js';
import { connectToServer } from './socketio-client.js';
import { writePid, removePid, isRunning } from './daemon.js';
import { startMcpRegistration } from './commands/mcp-proxy.js';
import { startMcpProxy } from './commands/mcp.js';
import { registerHarnessCommands } from './commands/harness.js';
import { isCloudHostMode, startCloudHostSupervisor } from './cloud-host/supervisor.js';
import { processRegistry, isProcessAlive } from './acp/process-registry.js';
import { logger as rootLogger } from './observability/logger.js';
import { withStartupSpan } from './startup-span.js';
export {
  EXIT_SERVER_SHUTDOWN,
  isFailureShutdownReason,
  isServerTerminationReason,
  isSignalShutdownReason,
  resolveShutdownExitCode,
} from './exit-codes.js';

// 版本号唯一事实源为 package.json（`--version` 与 npm 发布版本保持一致，避免手工同步漂移）。
const { version: CLI_VERSION } = createRequire(import.meta.url)('../package.json') as {
  version: string;
};

const log = rootLogger.child({ component: 'index' });

const program = new Command();

program
  .name('agent-gear')
  .description('Agent Controller - manages connection to controller-api')
  .version(CLI_VERSION)
  .option('-k, --key <key>', 'Controller key')
  .option('-s, --server <endpoint>', 'Server endpoint URL')
  .option('-n, --name <name>', 'Controller name')
  .action(async (options) => {
    // 启动链路一个 startup span；ZAG_INIT_TRACEPARENT（云电脑 Job env）以 link 关联创建链路（T-OBS18）。
    await withStartupSpan(
      { 'agent.mode': isCloudHostMode() ? 'cloud-host' : 'local', 'agent.version': CLI_VERSION },
      async () => {
        if (isRunning()) {
          log.error('Controller is already running. Stop it first or remove the PID file.');
          process.exit(1);
        }

        // 云电脑模式（`ZAG_HOST_ENDPOINT` + `ZAG_HOST_KEY` + `ZAG_CONTROLLER_KEY` 同时存在）：
        // 双连接编排（/worker 初始化 → controller-api 标准连接），不读取/写入本地 key 配置。
        if (isCloudHostMode()) {
          writePid();
          process.on('exit', () => {
            removePid();
          });
          try {
            await startCloudHostSupervisor();
          } catch (error) {
            log.error({ err: error }, 'cloud host supervisor failed');
            removePid();
            process.exit(1);
          }
          return;
        }

        const key = resolveKey(options.key);
        if (!key) {
          log.error('No key provided. Use --key, ZAG_CONTROLLER_KEY env, or configure in ~/.zag/config.toml');
          process.exit(1);
        }

        const endpoint = resolveEndpoint(options.server);
        if (!endpoint) {
          log.error('No server endpoint provided. Use --server, ZAG_SERVER_ENDPOINT env, or configure in ~/.zag/config.toml');
          process.exit(1);
        }

        if (options.key) saveKeyToConfig(options.key);
        if (options.server) saveEndpointToConfig(options.server);

        writePid();

        const socket = connectToServer(endpoint, key, {
          serverName: options.name || hostname(),
        });

        const shutdown = async () => {
          log.info('shutting down');
          // Kill all registered ACP processes before exiting, using the same
          // TERM → short wait → KILL semantics as the acp:stop handler
          const registered = processRegistry.listEntries();
          if (registered.length > 0) {
            log.info({ count: registered.length }, 'killing registered ACP processes');
            for (const entry of registered) {
              try {
                if (platform() === 'win32') {
                  const { execFileSync } = await import('child_process');
                  execFileSync('taskkill', ['/PID', String(entry.pid), '/T', '/F'], { timeout: 5000 });
                } else {
                  process.kill(-entry.pid, 'SIGTERM');
                }
              } catch { /* process may already be dead */ }
            }
            // Give processes a moment to exit
            await new Promise((r) => setTimeout(r, 1000));
            for (const entry of registered) {
              if (platform() !== 'win32' && isProcessAlive(entry.pid)) {
                try { process.kill(-entry.pid, 'SIGKILL'); } catch { /* already dead */ }
              }
              processRegistry.deregister(entry.sessionId);
            }
          }
          socket.disconnect();
          removePid();
          process.exit(0);
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        process.on('exit', () => {
          removePid();
        });
      },
    );
  });

program
  .command('mcp-proxy')
  .description('Register a local MCP command as a proxy')
  .requiredOption('--mcp-server <endpoint>', 'Server endpoint URL')
  .requiredOption('--mcp-key <key>', 'MCP Proxy Key')
  .requiredOption('--command <command>', 'Local MCP command to proxy')
  .action(async (options) => {
    await startMcpRegistration({
      server: options.mcpServer,
      key: options.mcpKey,
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

// 云电脑 harness 初始化子命令：`agent-gear harness prepare`（init 脚本调用）。
registerHarnessCommands(program);

program.parse();
