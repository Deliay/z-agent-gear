import { GraphQLError } from 'graphql';
import { logger as rootLogger } from '../../observability/logger.js';
import { AuthProvider } from '../../models/auth-provider.js';
import { McpServer } from '../../models/mcp-server.js';
import { getRedisClient } from '../../middleware/redis.js';
import { commitSettingsService } from '../../services/commit-settings-service.js';
import { controllerKeyService } from '../../services/controller-key.js';
import { customMcpService } from '../../services/custom-mcp-service.js';
import { customToolService } from '../../services/custom-tool-service.js';
import { cloudStorageService } from '../../services/cloud-storage-service.js';
import { listExternalLogins } from '../../services/external-login.js';
import { githubService } from '../../services/github.js';
import { modelService } from '../../services/model.js';
import { providerService } from '../../services/provider.js';
import { valutService } from '../../services/valut-service.js';
import { ensureAdminToolsServer } from '../../services/workflow/admin-tools.js';
import { mapMcpServer } from './mcp-server.js';
import type { AuthContext } from './auth.js';

type Doc = Record<string, unknown>;

/** 单个分支失败降级为兜底值（设置页聚合不因某一路失败拖垮整页） */
async function degrade<T>(branch: () => Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await branch();
  } catch (err) {
    rootLogger.error({ component: 'settings', branch: label, err }, 'settingsOverview branch degraded');
    return fallback;
  }
}

/** D12：非空契约分支的兜底形态（与「查询失败/未配置」展示语义一致）。 */
const FALLBACK_COMMIT_SETTINGS = {
  committerType: 'UNSET',
  customName: null,
  customEmail: null,
  commitWithBot: false,
};
const FALLBACK_GITHUB_APP_URL = { url: '', state: '' };
const FALLBACK_STORAGE_CAPABILITIES = { enabled: false };

export const settingsResolvers = {
  Query: {
    // 薄聚合 resolver：Promise.all + per-branch degrade，14 个只读分支原样复用既有服务调用。
    settingsOverview: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      const userId = context.currentUser.id;
      const [
        commitSettings,
        providers,
        models,
        controllerKeys,
        mcpServers,
        valutEntries,
        customMcpServers,
        customTools,
        githubAccounts,
        githubAppUrl,
        myExternalLogins,
        authProviders,
        cloudStorageCapabilities,
        cloudStorages,
      ] = await Promise.all([
        degrade<Doc>(
          async () => (await commitSettingsService.getCommitSettings(userId)) as unknown as Doc,
          FALLBACK_COMMIT_SETTINGS,
          'commitSettings',
        ),
        degrade<Doc[]>(
          async () => (await providerService.findAll()) as unknown as Doc[],
          [],
          'providers',
        ),
        degrade<Doc[]>(
          async () => (await modelService.findAll()) as unknown as Doc[],
          [],
          'models',
        ),
        degrade<Doc[]>(
          async () => (await controllerKeyService.findAllByUser(userId)) as Doc[],
          [],
          'controllerKeys',
        ),
        degrade<Doc[]>(
          async () => {
            // 与 mcpServers 查询同口径：读路径确保平台工作流工具集已注册
            await ensureAdminToolsServer(userId);
            const servers = await McpServer.find({ userId }).sort({ createdAt: -1 }).lean();
            return servers.map((server) => mapMcpServer(server as never)) as unknown as Doc[];
          },
          [],
          'mcpServers',
        ),
        degrade<Doc[]>(
          async () => (await valutService.listGrouped()) as unknown as Doc[],
          [],
          'valutEntries',
        ),
        degrade<Doc[]>(
          async () => (await customMcpService.list()) as unknown as Doc[],
          [],
          'customMcpServers',
        ),
        degrade<Doc[]>(
          async () => (await customToolService.list()) as unknown as Doc[],
          [],
          'customTools',
        ),
        degrade<Doc[]>(
          async () => (await githubService.getAccounts(userId)) as unknown as Doc[],
          [],
          'githubAccounts',
        ),
        // githubAppUrl 求值即签发一次性 OAuth state（保持既有语义）；只读上下文抛错经 degrade 降级。
        // settingsOverview 不轮询：仅首次加载/显式 refetch 求值一次，不放大签发频率。
        degrade<{ url: string; state: string }>(
          async () => {
            if (context.workspaceAccess?.readOnly) {
              throw new GraphQLError('global workspace is read-only');
            }
            const { url, state } = await githubService.getAppUrl(userId);
            const redis = getRedisClient();
            await redis.set(
              `github:oauth:state:${state}`,
              JSON.stringify({
                userId,
                workspaceId: context.workspaceAccess?.id ?? null,
              }),
              'EX',
              600,
            );
            return { url, state };
          },
          FALLBACK_GITHUB_APP_URL,
          'githubAppUrl',
        ),
        degrade<Doc[]>(
          async () => (await listExternalLogins(userId)) as unknown as Doc[],
          [],
          'myExternalLogins',
        ),
        degrade<Doc[]>(
          async () => {
            const docs = (await AuthProvider.find({ enabled: true, enableFrontLogin: true })
              .sort({ createdAt: 1 })
              .lean()) as Array<{ _id: unknown; type: string; displayName: string }>;
            return docs.map((doc) => ({
              id: String(doc._id),
              type: doc.type,
              displayName: doc.type === 'github_oauth' ? 'GitHub' : doc.displayName,
            })) as unknown as Doc[];
          },
          [],
          'authProviders',
        ),
        degrade<{ enabled: boolean }>(
          async () => cloudStorageService.getCapabilities(),
          FALLBACK_STORAGE_CAPABILITIES,
          'cloudStorageCapabilities',
        ),
        degrade<Doc[]>(
          async () => (await cloudStorageService.list({ includeDestroyed: false })) as Doc[],
          [],
          'cloudStorages',
        ),
      ]);

      return {
        commitSettings,
        providers,
        models,
        controllerKeys,
        mcpServers,
        valutEntries,
        customMcpServers,
        customTools,
        githubAccounts,
        githubAppUrl,
        myExternalLogins,
        authProviders,
        cloudStorageCapabilities,
        cloudStorages,
      };
    },
  },
};
