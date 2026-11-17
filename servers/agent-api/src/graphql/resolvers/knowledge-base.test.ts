import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/knowledge-base-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/knowledge-base-service.js')>();
  return {
    ...actual,
    knowledgeBaseService: {
      list: vi.fn(),
      listTree: vi.fn(),
      listDocuments: vi.fn(),
      getDocument: vi.fn(),
      listEvents: vi.fn(),
      create: vi.fn(),
      rename: vi.fn(),
      updatePermission: vi.fn(),
      remove: vi.fn(),
      createDocument: vi.fn(),
      updateDocument: vi.fn(),
      deleteDocument: vi.fn(),
      upsertDocument: vi.fn(),
    },
  };
});

vi.mock('../../services/repo-knowledge-bases.js', () => ({
  repoKnowledgeBaseService: {
    listHosts: vi.fn(),
    listKnowledgeBases: vi.fn(),
    listChildren: vi.fn(),
    getDocument: vi.fn(),
  },
}));

import { knowledgeBaseService } from '../../services/knowledge-base-service.js';
import { repoKnowledgeBaseService } from '../../services/repo-knowledge-bases.js';
import { KNOWLEDGE_BASE_PUBLIC_ERRORS, knowledgeBaseResolvers } from './knowledge-base.js';
import { typeDefs } from '../schemas/index.js';
import { resolvers } from './index.js';
import type { AuthContext } from './auth.js';

const authed: AuthContext = { currentUser: { id: 'user1', tenantId: 'tenant1', name: 'U' } };
const anonymous: AuthContext = { currentUser: null };

const DOC_INPUT = { title: '标题', tags: ['a'], description: '', content: '' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Knowledge Base resolvers', () => {
  describe('认证', () => {
    it.each([
      ['knowledgeBases', () => knowledgeBaseResolvers.Query.knowledgeBases({}, {}, anonymous)],
      ['knowledgeBaseTree', () => knowledgeBaseResolvers.Query.knowledgeBaseTree({}, {}, anonymous)],
      [
        'knowledgeBaseDocuments',
        () =>
          knowledgeBaseResolvers.Query.knowledgeBaseDocuments(
            {},
            { knowledgeBaseId: 'k1' },
            anonymous,
          ),
      ],
      [
        'knowledgeBaseDocument',
        () =>
          knowledgeBaseResolvers.Query.knowledgeBaseDocument(
            {},
            { knowledgeBaseId: 'k1', path: '/a' },
            anonymous,
          ),
      ],
      [
        'knowledgeBaseEvents',
        () =>
          knowledgeBaseResolvers.Query.knowledgeBaseEvents(
            {},
            { knowledgeBaseId: 'k1' },
            anonymous,
          ),
      ],
      ['repoKnowledgeBaseHosts', () => knowledgeBaseResolvers.Query.repoKnowledgeBaseHosts({}, {}, anonymous)],
      [
        'repoKnowledgeBases',
        () =>
          knowledgeBaseResolvers.Query.repoKnowledgeBases(
            {},
            { workspaceId: 'ws-1' },
            anonymous,
          ),
      ],
      [
        'repoKnowledgeBaseDocumentChildren',
        () =>
          knowledgeBaseResolvers.Query.repoKnowledgeBaseDocumentChildren(
            {},
            { id: 'repo:ws-1:zag:a' },
            anonymous,
          ),
      ],
      [
        'repoKnowledgeBaseDocument',
        () =>
          knowledgeBaseResolvers.Query.repoKnowledgeBaseDocument(
            {},
            { id: 'repo:ws-1:zag:a', path: '/a' },
            anonymous,
          ),
      ],
      [
        'createKnowledgeBase',
        () => knowledgeBaseResolvers.Mutation.createKnowledgeBase({}, { name: 'KB' }, anonymous),
      ],
      [
        'renameKnowledgeBase',
        () =>
          knowledgeBaseResolvers.Mutation.renameKnowledgeBase(
            {},
            { id: 'k1', name: 'KB' },
            anonymous,
          ),
      ],
      [
        'updateKnowledgeBasePermission',
        () =>
          knowledgeBaseResolvers.Mutation.updateKnowledgeBasePermission(
            {},
            { id: 'k1', permissionMode: 'READ_ONLY' },
            anonymous,
          ),
      ],
      [
        'deleteKnowledgeBase',
        () => knowledgeBaseResolvers.Mutation.deleteKnowledgeBase({}, { id: 'k1' }, anonymous),
      ],
      [
        'createKnowledgeBaseDocument',
        () =>
          knowledgeBaseResolvers.Mutation.createKnowledgeBaseDocument(
            {},
            { knowledgeBaseId: 'k1', path: '/a', input: DOC_INPUT },
            anonymous,
          ),
      ],
      [
        'updateKnowledgeBaseDocument',
        () =>
          knowledgeBaseResolvers.Mutation.updateKnowledgeBaseDocument(
            {},
            { knowledgeBaseId: 'k1', path: '/a', input: DOC_INPUT },
            anonymous,
          ),
      ],
      [
        'deleteKnowledgeBaseDocument',
        () =>
          knowledgeBaseResolvers.Mutation.deleteKnowledgeBaseDocument(
            {},
            { knowledgeBaseId: 'k1', path: '/a' },
            anonymous,
          ),
      ],
    ])('%s 未认证抛 Not authenticated', async (_name, call) => {
      await expect(call()).rejects.toThrow('Not authenticated');
      expect(knowledgeBaseService.list).not.toHaveBeenCalled();
      expect(knowledgeBaseService.create).not.toHaveBeenCalled();
    });
  });

  describe('白名单透传（契约 16 条逐字）', () => {
    it('白名单集合恒为 16 条', () => {
      expect(KNOWLEDGE_BASE_PUBLIC_ERRORS.size).toBe(16);
    });

    it.each([...KNOWLEDGE_BASE_PUBLIC_ERRORS])(
      '服务层错误 %s 原样透传',
      async (message) => {
        vi.mocked(knowledgeBaseService.create).mockRejectedValue(new Error(message));
        await expect(
          knowledgeBaseResolvers.Mutation.createKnowledgeBase({}, { name: 'KB' }, authed),
        ).rejects.toThrow(message);
      },
    );

    it('非白名单错误收敛为 internal error（不泄露实现细节）', async () => {
      vi.mocked(knowledgeBaseService.create).mockRejectedValue(
        new Error('MongoServerError: duplicate key boom'),
      );
      await expect(
        knowledgeBaseResolvers.Mutation.createKnowledgeBase({}, { name: 'KB' }, authed),
      ).rejects.toThrow('internal error');
    });

    it('GraphQLError 直接透传', async () => {
      const { GraphQLError } = await import('graphql');
      vi.mocked(knowledgeBaseService.list).mockRejectedValue(new GraphQLError('Not found'));
      await expect(
        knowledgeBaseResolvers.Query.knowledgeBases({}, {}, authed),
      ).rejects.toThrow('Not found');
    });
  });

  describe('委托与路径来源', () => {
    it('Query 全入口委托 service 并透传 userId 首参', async () => {
      vi.mocked(knowledgeBaseService.list).mockResolvedValue([]);
      vi.mocked(knowledgeBaseService.listTree).mockResolvedValue([]);
      vi.mocked(knowledgeBaseService.listDocuments).mockResolvedValue([]);
      vi.mocked(knowledgeBaseService.getDocument).mockResolvedValue(null);
      vi.mocked(knowledgeBaseService.listEvents).mockResolvedValue([]);

      await knowledgeBaseResolvers.Query.knowledgeBases({}, {}, authed);
      await knowledgeBaseResolvers.Query.knowledgeBaseTree({}, {}, authed);
      await knowledgeBaseResolvers.Query.knowledgeBaseDocuments(
        {},
        { knowledgeBaseId: 'k1', prefix: '/a' },
        authed,
      );
      await knowledgeBaseResolvers.Query.knowledgeBaseDocument(
        {},
        { knowledgeBaseId: 'k1', path: '/a' },
        authed,
      );
      await knowledgeBaseResolvers.Query.knowledgeBaseEvents(
        {},
        { knowledgeBaseId: 'k1', path: '/a', limit: 5, before: '2026-01-01T00:00:00.000Z' },
        authed,
      );

      expect(knowledgeBaseService.list).toHaveBeenCalledWith('user1');
      expect(knowledgeBaseService.listTree).toHaveBeenCalledWith('user1');
      expect(knowledgeBaseService.listDocuments).toHaveBeenCalledWith('user1', 'k1', '/a');
      expect(knowledgeBaseService.getDocument).toHaveBeenCalledWith('user1', 'k1', '/a');
      expect(knowledgeBaseService.listEvents).toHaveBeenCalledWith('user1', 'k1', {
        path: '/a',
        limit: 5,
        before: '2026-01-01T00:00:00.000Z',
      });
    });

    it('createKnowledgeBaseDocument：path 入参原样委托 service（归一化由服务层负责）', async () => {
      vi.mocked(knowledgeBaseService.createDocument).mockResolvedValue({} as never);

      await knowledgeBaseResolvers.Mutation.createKnowledgeBaseDocument(
        {},
        { knowledgeBaseId: 'k1', path: '/新文档-abcd', input: DOC_INPUT },
        authed,
      );
      expect(knowledgeBaseService.createDocument).toHaveBeenLastCalledWith(
        'user1',
        'k1',
        '/新文档-abcd',
        DOC_INPUT,
      );

      await knowledgeBaseResolvers.Mutation.createKnowledgeBaseDocument(
        {},
        { knowledgeBaseId: 'k1', path: '/guides/新文档-abcd/', input: DOC_INPUT },
        authed,
      );
      expect(knowledgeBaseService.createDocument).toHaveBeenLastCalledWith(
        'user1',
        'k1',
        '/guides/新文档-abcd/',
        DOC_INPUT,
      );
    });

    it('createKnowledgeBaseDocument：服务层非法路径逐字透传', async () => {
      vi.mocked(knowledgeBaseService.createDocument).mockRejectedValue(
        new Error('invalid document path'),
      );
      await expect(
        knowledgeBaseResolvers.Mutation.createKnowledgeBaseDocument(
          {},
          { knowledgeBaseId: 'k1', path: '/a//b', input: DOC_INPUT },
          authed,
        ),
      ).rejects.toThrow('invalid document path');
    });

    it('仓库知识库四查询委托 repo 服务并归一 refresh===true', async () => {
      vi.mocked(repoKnowledgeBaseService.listHosts).mockResolvedValue([]);
      vi.mocked(repoKnowledgeBaseService.listKnowledgeBases).mockResolvedValue([]);
      vi.mocked(repoKnowledgeBaseService.listChildren).mockResolvedValue([]);
      vi.mocked(repoKnowledgeBaseService.getDocument).mockResolvedValue(null);

      await knowledgeBaseResolvers.Query.repoKnowledgeBaseHosts({}, {}, authed);
      await knowledgeBaseResolvers.Query.repoKnowledgeBases(
        {},
        { workspaceId: 'ws-1', refresh: true },
        authed,
      );
      await knowledgeBaseResolvers.Query.repoKnowledgeBases(
        {},
        { workspaceId: 'ws-1', refresh: null },
        authed,
      );
      await knowledgeBaseResolvers.Query.repoKnowledgeBaseDocumentChildren(
        {},
        { id: 'repo:ws-1:zag:a', path: '/dir' },
        authed,
      );
      await knowledgeBaseResolvers.Query.repoKnowledgeBaseDocument(
        {},
        { id: 'repo:ws-1:zag:a', path: '/dir/a' },
        authed,
      );

      expect(repoKnowledgeBaseService.listHosts).toHaveBeenCalledWith('user1');
      expect(repoKnowledgeBaseService.listKnowledgeBases).toHaveBeenNthCalledWith(
        1,
        'user1',
        'ws-1',
        true,
      );
      expect(repoKnowledgeBaseService.listKnowledgeBases).toHaveBeenNthCalledWith(
        2,
        'user1',
        'ws-1',
        false,
      );
      expect(repoKnowledgeBaseService.listChildren).toHaveBeenCalledWith(
        'user1',
        'repo:ws-1:zag:a',
        '/dir',
      );
      expect(repoKnowledgeBaseService.getDocument).toHaveBeenCalledWith(
        'user1',
        'repo:ws-1:zag:a',
        '/dir/a',
      );
    });

    it('仓库知识库扫描失败与 Workspace not found 逐字透传', async () => {
      vi.mocked(repoKnowledgeBaseService.listKnowledgeBases).mockRejectedValue(
        new Error('repo knowledge base scan failed'),
      );
      await expect(
        knowledgeBaseResolvers.Query.repoKnowledgeBases({}, { workspaceId: 'ws-1' }, authed),
      ).rejects.toThrow('repo knowledge base scan failed');

      vi.mocked(repoKnowledgeBaseService.listKnowledgeBases).mockRejectedValue(
        new Error('Workspace not found'),
      );
      await expect(
        knowledgeBaseResolvers.Query.repoKnowledgeBases({}, { workspaceId: 'ws-1' }, authed),
      ).rejects.toThrow('Workspace not found');
    });
  });

  describe('登记守卫', () => {
    it('schema 与 resolvers 双登记生效', () => {
      const merged = (typeDefs as string[]).join('\n');
      expect(merged).toContain('knowledgeBases: [KnowledgeBase!]!');
      expect(merged).toContain('createKnowledgeBaseDocument');
      expect(merged).toContain('repoKnowledgeBaseHosts');
      expect(resolvers.Query.knowledgeBases).toBeTypeOf('function');
      expect(resolvers.Query.repoKnowledgeBaseHosts).toBeTypeOf('function');
      expect(resolvers.Mutation.createKnowledgeBase).toBeTypeOf('function');
      expect(resolvers.Mutation.deleteKnowledgeBaseDocument).toBeTypeOf('function');
    });
  });
});
