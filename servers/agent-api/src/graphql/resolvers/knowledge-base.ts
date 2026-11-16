import { GraphQLError } from 'graphql';
import {
  knowledgeBaseService,
  type KnowledgeBaseDocumentInput,
  type KnowledgeBaseDocumentMetaView,
  type KnowledgeBaseDocumentView,
  type KnowledgeBaseEventView,
  type KnowledgeBaseTreeItemView,
  type KnowledgeBaseView,
} from '../../services/knowledge-base-service.js';
import type { KnowledgeBasePermissionMode } from '../../models/knowledge-base.js';
import type { AuthContext } from './auth.js';

/**
 * 知识库 GraphQL resolvers（契约 `contracts/knowledge-base.graphql`）。
 *
 * - 未认证统一 `Not authenticated`（GraphQLError 直接透传）；
 * - 业务错误经 `wrap()` **白名单逐字透传**（契约 14 条错误表），非白名单一律收敛
 *   `internal error`——不泄露驱动/实现细节；
 * - 权限/可见性判定全部委托 `knowledge-base-service`（唯一判定源），resolver 不做第二套矩阵。
 */

/** 契约错误口径白名单（逐字透传，共 14 条）。 */
export const KNOWLEDGE_BASE_PUBLIC_ERRORS = new Set([
  'Not authenticated',
  'workspace not found',
  'knowledge base not found',
  'knowledge base name already exists',
  'invalid knowledge base name',
  'not a tenant admin',
  'knowledge base permission denied',
  'knowledge base document not found',
  'knowledge base document already exists',
  'invalid document path',
  'invalid document title',
  'invalid document tags',
  'invalid document description',
  'invalid document content',
]);

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GraphQLError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (KNOWLEDGE_BASE_PUBLIC_ERRORS.has(message)) throw new GraphQLError(message);
    throw new GraphQLError('internal error');
  }
}

function requireUser(context: AuthContext): string {
  if (!context.currentUser) throw new GraphQLError('Not authenticated');
  return context.currentUser.id;
}

export interface DocumentInputArgs {
  input: KnowledgeBaseDocumentInput;
}

export const knowledgeBaseResolvers = {
  Query: {
    knowledgeBases: async (
      _parent: unknown,
      _args: unknown,
      context: AuthContext,
    ): Promise<KnowledgeBaseView[]> => {
      const userId = requireUser(context);
      return wrap(() => knowledgeBaseService.list(userId));
    },
    knowledgeBaseTree: async (
      _parent: unknown,
      _args: unknown,
      context: AuthContext,
    ): Promise<KnowledgeBaseTreeItemView[]> => {
      const userId = requireUser(context);
      return wrap(() => knowledgeBaseService.listTree(userId));
    },
    knowledgeBaseDocuments: async (
      _parent: unknown,
      args: { knowledgeBaseId: string; prefix?: string | null },
      context: AuthContext,
    ): Promise<KnowledgeBaseDocumentMetaView[]> => {
      const userId = requireUser(context);
      return wrap(() =>
        knowledgeBaseService.listDocuments(userId, args.knowledgeBaseId, args.prefix ?? undefined),
      );
    },
    knowledgeBaseDocument: async (
      _parent: unknown,
      args: { knowledgeBaseId: string; path: string },
      context: AuthContext,
    ): Promise<KnowledgeBaseDocumentView | null> => {
      const userId = requireUser(context);
      return wrap(() => knowledgeBaseService.getDocument(userId, args.knowledgeBaseId, args.path));
    },
    knowledgeBaseEvents: async (
      _parent: unknown,
      args: {
        knowledgeBaseId: string;
        path?: string | null;
        limit?: number | null;
        before?: string | null;
      },
      context: AuthContext,
    ): Promise<KnowledgeBaseEventView[]> => {
      const userId = requireUser(context);
      return wrap(() =>
        knowledgeBaseService.listEvents(userId, args.knowledgeBaseId, {
          path: args.path ?? undefined,
          limit: args.limit ?? undefined,
          before: args.before ?? undefined,
        }),
      );
    },
  },
  Mutation: {
    createKnowledgeBase: async (
      _parent: unknown,
      args: { name: string },
      context: AuthContext,
    ): Promise<KnowledgeBaseView> => {
      const userId = requireUser(context);
      return wrap(() => knowledgeBaseService.create(userId, args.name));
    },
    renameKnowledgeBase: async (
      _parent: unknown,
      args: { id: string; name: string },
      context: AuthContext,
    ): Promise<KnowledgeBaseView> => {
      const userId = requireUser(context);
      return wrap(() => knowledgeBaseService.rename(userId, args.id, args.name));
    },
    updateKnowledgeBasePermission: async (
      _parent: unknown,
      args: { id: string; permissionMode: KnowledgeBasePermissionMode },
      context: AuthContext,
    ): Promise<KnowledgeBaseView> => {
      const userId = requireUser(context);
      return wrap(() =>
        knowledgeBaseService.updatePermission(userId, args.id, args.permissionMode),
      );
    },
    deleteKnowledgeBase: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ): Promise<boolean> => {
      const userId = requireUser(context);
      return wrap(() => knowledgeBaseService.remove(userId, args.id));
    },
    createKnowledgeBaseDocument: async (
      _parent: unknown,
      args: { knowledgeBaseId: string; path: string; input: KnowledgeBaseDocumentInput },
      context: AuthContext,
    ): Promise<KnowledgeBaseDocumentView> => {
      const userId = requireUser(context);
      return wrap(() =>
        knowledgeBaseService.createDocument(userId, args.knowledgeBaseId, args.path, args.input),
      );
    },
    updateKnowledgeBaseDocument: async (
      _parent: unknown,
      args: { knowledgeBaseId: string; path: string; input: KnowledgeBaseDocumentInput },
      context: AuthContext,
    ): Promise<KnowledgeBaseDocumentView> => {
      const userId = requireUser(context);
      return wrap(() =>
        knowledgeBaseService.updateDocument(
          userId,
          args.knowledgeBaseId,
          args.path,
          args.input,
        ),
      );
    },
    deleteKnowledgeBaseDocument: async (
      _parent: unknown,
      args: { knowledgeBaseId: string; path: string },
      context: AuthContext,
    ): Promise<boolean> => {
      const userId = requireUser(context);
      return wrap(() =>
        knowledgeBaseService.deleteDocument(userId, args.knowledgeBaseId, args.path),
      );
    },
  },
};
