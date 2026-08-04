import { McpServer } from '../models/mcp-server.js';

export const name = '003-mcp-server-registry-fields';

export async function run(): Promise<void> {
  await McpServer.updateMany(
    { source: { $exists: false } },
    { $set: { source: 'proxy', enabled: true } },
  );
  console.log('[Migration 003] Backfilled source/enabled for mcpservers');
}
