import { GraphQLError } from 'graphql';
import {
  customToolService,
  type CreateCustomToolParams,
  type CustomToolHttpConfigInput,
  type CustomToolView,
  type UpdateCustomToolParams,
} from '../../services/custom-tool-service.js';
import type { Fragment } from '../../services/fragment-render.js';
import type { AuthContext } from './auth.js';

/**
 * 自定义工具 GraphQL resolvers（契约 `contracts/custom-tool.graphql`）。
 *
 * - 未认证统一 `Not authenticated`（GraphQLError 直接透传）；
 * - 业务错误经 `wrap()` **白名单逐字透传**（契约错误表），非白名单一律收敛 `internal error`；
 * - 本文件不引用任何解密入口（明文不出服务端）。
 */

/** 契约错误口径白名单（逐字透传）。 */
const CUSTOM_TOOL_PUBLIC_ERRORS = new Set([
  'custom tool not found',
  'invalid custom tool name',
  'invalid custom tool description',
  'invalid custom tool args',
  'invalid fragment template',
  'invalid http config',
  'duplicate custom tool name',
  'global workspace is read-only',
  'Not found',
  'workspace not found',
]);

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GraphQLError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (CUSTOM_TOOL_PUBLIC_ERRORS.has(message)) throw new GraphQLError(message);
    throw new GraphQLError('internal error');
  }
}

function requireUser(context: AuthContext): string {
  if (!context.currentUser) throw new GraphQLError('Not authenticated');
  return context.currentUser.id;
}

interface CustomToolArgInputArg {
  key: string;
  name: string;
  description?: string | null;
}

export interface CreateArgs {
  input: {
    name: string;
    description?: string | null;
    type: 'prompt' | 'http';
    args: CustomToolArgInputArg[];
    prompt?: Fragment[] | null;
    http?: CustomToolHttpConfigInput | null;
  };
}

export interface UpdateArgs {
  id: string;
  input: {
    name?: string | null;
    description?: string | null;
    type?: 'prompt' | 'http' | null;
    args?: CustomToolArgInputArg[] | null;
    prompt?: Fragment[] | null;
    http?: CustomToolHttpConfigInput | null;
  };
}

export const customToolResolvers = {
  Query: {
    customTools: async (
      _parent: unknown,
      _args: unknown,
      context: AuthContext,
    ): Promise<CustomToolView[]> => {
      requireUser(context);
      return wrap(() => customToolService.list());
    },
    customTool: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ): Promise<CustomToolView | null> => {
      requireUser(context);
      return wrap(() => customToolService.get(args.id));
    },
  },
  Mutation: {
    createCustomTool: async (
      _parent: unknown,
      args: CreateArgs,
      context: AuthContext,
    ): Promise<CustomToolView> => {
      const userId = requireUser(context);
      const params: CreateCustomToolParams = {
        name: args.input.name,
        description: args.input.description,
        type: args.input.type,
        args: args.input.args ?? [],
        prompt: args.input.prompt,
        http: args.input.http,
        createdBy: userId,
      };
      return wrap(() => customToolService.create(params));
    },
    updateCustomTool: async (
      _parent: unknown,
      args: UpdateArgs,
      context: AuthContext,
    ): Promise<CustomToolView> => {
      requireUser(context);
      const params: UpdateCustomToolParams = {
        name: args.input.name,
        description: args.input.description,
        type: args.input.type,
        args: args.input.args,
        prompt: args.input.prompt,
        http: args.input.http,
      };
      return wrap(() => customToolService.update(args.id, params));
    },
    deleteCustomTool: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ): Promise<boolean> => {
      requireUser(context);
      return wrap(() => customToolService.delete(args.id));
    },
  },
};
