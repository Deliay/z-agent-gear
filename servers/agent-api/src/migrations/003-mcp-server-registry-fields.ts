import { logger } from '../observability/logger.js';
import { McpServer } from '../models/mcp-server.js';

const log = logger.child({ component: 'migration/003-mcp-server-registry-fields' });

export const name = '003-mcp-server-registry-fields';

export async function run(): Promise<void> {
  await McpServer.updateMany(
    { source: { $exists: false } },
    { $set: { source: 'proxy', enabled: true } },
  );
  log.info('backfilled source/enabled for mcpservers');
}
