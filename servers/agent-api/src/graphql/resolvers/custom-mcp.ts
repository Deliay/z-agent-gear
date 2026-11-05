import { GraphQLError } from 'graphql';
import {
  customMcpService,
  type CreateCustomMcpServerParams,
  type CustomMcpAuthInputValue,
  type CustomMcpHeader,
  type CustomMcpServerView,
  type UpdateCustomMcpServerParams,
} from '../../services/custom-mcp-service.js';
import type { AuthContext } from './auth.js';

/**
 * 自定义 MCP GraphQL resolvers（契约 `contracts/custom-mcp.graphql`）。
 *
 * - 未认证统一 `Not authenticated`（GraphQLError 直接透传）；
 * - 业务错误经 `wrap()` **白名单逐字透传**（契约错误表），非白名单一律收敛
 *   `internal error`——不泄露驱动/实现细节，也不让任何 token 明文进入错误信息；
 * - 本文件不引用解密入口（明文不出服务端；单测扫描本文件断言）；
 * - `bearerEntryManaged` 由服务层按条目 namespace 派生（无需类型级 resolver）。
 */

/** 契约错误口径白名单（逐字透传）。 */
const CUSTOM_MCP_PUBLIC_ERRORS = new Set([
  'custom mcp server not found',
  'invalid mcp name',
  'invalid mcp endpoint',
  'invalid custom headers',
  'bearer token is required',
  'bearer entry must be manual namespace',
  'bearer entry not editable in place',
  'global workspace is read-only',
  'Not found',
]);

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GraphQLError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (CUSTOM_MCP_PUBLIC_ERRORS.has(message)) throw new GraphQLError(message);
    throw new GraphQLError('internal error');
  }
}

function requireUser(context: AuthContext): string {
  if (!context.currentUser) throw new GraphQLError('Not authenticated');
  return context.currentUser.id;
}

export interface CreateArgs {
  input: {
    name: string;
    description?: string | null;
    endpoint: string;
    auth: CustomMcpAuthInputValue;
    customHeaders?: CustomMcpHeader[] | null;
  };
}

export interface UpdateArgs {
  id: string;
  input: {
    name?: string | null;
    description?: string | null;
    endpoint?: string | null;
    auth?: CustomMcpAuthInputValue | null;
    customHeaders?: CustomMcpHeader[] | null;
  };
}

export const customMcpResolvers = {
  Query: {
    customMcpServers: async (
      _parent: unknown,
      _args: unknown,
      context: AuthContext,
    ): Promise<CustomMcpServerView[]> => {
      requireUser(context);
      return wrap(() => customMcpService.list());
    },
    customMcpServer: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ): Promise<CustomMcpServerView | null> => {
      requireUser(context);
      return wrap(() => customMcpService.get(args.id));
    },
  },
  Mutation: {
    createCustomMcpServer: async (
      _parent: unknown,
      args: CreateArgs,
      context: AuthContext,
    ): Promise<CustomMcpServerView> => {
      const userId = requireUser(context);
      const params: CreateCustomMcpServerParams = {
        name: args.input.name,
        description: args.input.description,
        endpoint: args.input.endpoint,
        auth: args.input.auth,
        customHeaders: args.input.customHeaders,
        createdBy: userId,
      };
      return wrap(() => customMcpService.create(params));
    },
    updateCustomMcpServer: async (
      _parent: unknown,
      args: UpdateArgs,
      context: AuthContext,
    ): Promise<CustomMcpServerView> => {
      requireUser(context);
      const params: UpdateCustomMcpServerParams = {
        name: args.input.name,
        description: args.input.description,
        endpoint: args.input.endpoint,
        auth: args.input.auth,
        customHeaders: args.input.customHeaders,
      };
      return wrap(() => customMcpService.update(args.id, params));
    },
    deleteCustomMcpServer: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ): Promise<boolean> => {
      requireUser(context);
      return wrap(() => customMcpService.delete(args.id));
    },
  },
};
