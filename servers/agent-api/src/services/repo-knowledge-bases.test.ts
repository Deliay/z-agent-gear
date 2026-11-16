import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../models/cloud-host.js', () => ({
  CloudHost: {
    find: vi.fn(),
    findOne: vi.fn(),
  },
}));

vi.mock('../models/controller.js', () => ({
  Controller: {
    find: vi.fn(),
    findOne: vi.fn(),
  },
}));

vi.mock('./controller-workspace.js', () => ({
  controllerWorkspaceService: {
    findById: vi.fn(),
  },
}));

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('../middleware/publish.js', () => ({
  publish: vi.fn(),
}));

import {
  buildKnowledgeBaseChildren,
  decodeRepoKnowledgeBaseId,
  encodeRepoKnowledgeBaseId,
  isRepoKnowledgeBaseScanSupported,
  parseRepoDocument,
  parseRepoKnowledgeBaseSchema,
  repoKnowledgeBaseService,
  splitRepoFrontMatter,
  REPO_KB_CACHE_TTL_SECONDS,
} from './repo-knowledge-bases.js';
import { CloudHost } from '../models/cloud-host.js';
import { Controller } from '../models/controller.js';
import { controllerWorkspaceService } from './controller-workspace.js';
import { getRedisClient } from '../middleware/redis.js';
import { publish } from '../middleware/publish.js';

function lean(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value) } as never;
}

const WORKSPACE = {
  id: 'ws-1',
  controllerId: 'ctrl-1',
  path: '/home/worker/workspace/project',
  name: 'project',
};
const HOST = { _id: 'host-1', name: '云电脑一', workspaceId: 'ws-1', controllerId: 'ctrl-1' };

const SCAN_RESULT = {
  success: true,
  sources: [
    {
      source: 'zag',
      knowledgeBases: [
        {
          folder: 'a-base',
          schema: '{"name":"甲库","description":"甲描述"}',
          documents: [
            { path: 'root.md', content: '---\ntitle: 根文档\ntags: [git, 规范]\n---\n# 正文' },
            { path: 'dir/deep.md', content: '# 深层标题' },
          ],
          truncated: false,
        },
        { folder: 'b-bad', schema: '{bad json', documents: [] },
      ],
      truncated: false,
    },
    {
      source: 'docs',
      knowledgeBases: [
        {
          folder: 'c-docs',
          schema: '{"name":"丙库"}',
          documents: [{ path: 'x.md', content: '# X' }],
        },
      ],
      truncated: false,
    },
  ],
  truncated: false,
};

describe('isRepoKnowledgeBaseScanSupported', () => {
  it('版本门禁 2.19.0', () => {
    expect(isRepoKnowledgeBaseScanSupported('2.19.0')).toBe(true);
    expect(isRepoKnowledgeBaseScanSupported('2.20.1')).toBe(true);
    expect(isRepoKnowledgeBaseScanSupported('2.18.0')).toBe(false);
    expect(isRepoKnowledgeBaseScanSupported('bad')).toBe(false);
    expect(isRepoKnowledgeBaseScanSupported(undefined)).toBe(false);
  });
});

describe('parseRepoKnowledgeBaseSchema（T-RKB-SVC1）', () => {
  it('合法 schema → name/description 落出', () => {
    expect(parseRepoKnowledgeBaseSchema('{"name":" 团队规范 ","description":"说明"}')).toEqual({
      name: '团队规范',
      description: '说明',
      errors: [],
    });
  });

  it('非法 JSON / 非对象 → knowledge-base.json 不是合法的 JSON 文件', () => {
    expect(parseRepoKnowledgeBaseSchema('{bad').errors).toEqual([
      'knowledge-base.json 不是合法的 JSON 文件',
    ]);
    expect(parseRepoKnowledgeBaseSchema('[]').errors).toEqual([
      'knowledge-base.json 不是合法的 JSON 文件',
    ]);
  });

  it('name 缺失/空/65 字符 → 名称不合法', () => {
    for (const raw of ['{}', '{"name":"   "}', JSON.stringify({ name: 'x'.repeat(65) })]) {
      expect(parseRepoKnowledgeBaseSchema(raw).errors).toEqual([
        '知识库名称不合法（name 必填，trim 后 1~64 字符）',
      ]);
    }
  });

  it('description 1025 → 描述不合法', () => {
    const raw = JSON.stringify({ name: 'ok', description: 'x'.repeat(1025) });
    expect(parseRepoKnowledgeBaseSchema(raw).errors).toEqual([
      '知识库描述不合法（description 可选，≤1024 字符）',
    ]);
  });
});

describe('splitRepoFrontMatter / parseRepoDocument（T-RKB-SVC2/3）', () => {
  it('front matter 三键解析（数组与逗号 tags、键值 trim）', () => {
    const content =
      '---\ntitle:  Git 提交规范 \ntags: [git, 规范]\ndescription:  提交信息格式 \n---\n# 正文';
    const doc = parseRepoDocument('guides/git.md', content);

    expect(doc.title).toBe('Git 提交规范');
    expect(doc.tags).toEqual(['git', '规范']);
    expect(doc.description).toBe('提交信息格式');
    expect(doc.path).toBe('/guides/git');
    // content 为原文全文（含 front matter）
    expect(doc.content).toBe(content);
  });

  it('tags 逗号形态；块非法按无 front matter；超限键忽略回退', () => {
    const comma = parseRepoDocument('a.md', '---\ntags: git, 规范\n---\n# T');
    expect(comma.tags).toEqual(['git', '规范']);

    const invalid = parseRepoDocument('a.md', '---\nnot a pair\n---\n# T');
    expect(invalid.title).toBe('T');
    expect(invalid.tags).toEqual([]);

    const oversized = parseRepoDocument(
      'a.md',
      `---\ntitle: ${'x'.repeat(201)}\ntags: [${Array.from({ length: 17 }, (_, i) => `t${i}`).join(', ')}]\ndescription: ${'d'.repeat(1025)}\n---\n# fallback`,
    );
    expect(oversized.title).toBe('fallback');
    expect(oversized.tags).toEqual([]);
    expect(oversized.description).toBe('');
  });

  it('标题回退链：fm.title → 首个一级标题 → 文件名', () => {
    expect(parseRepoDocument('a.md', '---\ntitle: FM\n---\n# H').title).toBe('FM');
    expect(parseRepoDocument('a.md', '前言\n# H1\n## H2').title).toBe('H1');
    expect(parseRepoDocument('foo/bar.MD', '无标题').title).toBe('bar');
  });

  it('仅识别前 4KiB 内闭合的 front matter；闭合行必须独立（S3）', () => {
    const tooLate = `---\n${'x'.repeat(5000)}\n---\n# H`;
    const split = splitRepoFrontMatter(tooLate);
    expect(split.present).toBe(false);
    expect(split.body).toBe(tooLate);

    for (const content of ['---\ntitle: X\n----\n# H', '---\ntitle: X\n---x\n# H']) {
      const invalid = splitRepoFrontMatter(content);
      expect(invalid.present).toBe(false);
      expect(invalid.body).toBe(content);
    }
  });
});

describe('buildKnowledgeBaseChildren（T-RKB-SVC5）', () => {
  const docs = [
    { path: '/a', title: 'A' },
    { path: '/dir/b', title: 'B' },
    { path: '/dir/deep/c', title: 'C' },
    { path: '/z', title: 'Z' },
  ];

  it('根层级：直接子目录 FOLDER + 直接文档 DOCUMENT，文件夹在前', () => {
    expect(buildKnowledgeBaseChildren(docs, '/')).toEqual([
      { kind: 'FOLDER', name: 'dir', path: '/dir' },
      { kind: 'DOCUMENT', name: 'A', path: '/a' },
      { kind: 'DOCUMENT', name: 'Z', path: '/z' },
    ]);
  });

  it('嵌套文档不越级；逐级 prefix 正确', () => {
    expect(buildKnowledgeBaseChildren(docs, '/dir')).toEqual([
      { kind: 'FOLDER', name: 'deep', path: '/dir/deep' },
      { kind: 'DOCUMENT', name: 'B', path: '/dir/b' },
    ]);
    expect(buildKnowledgeBaseChildren(docs, '/dir/deep')).toEqual([
      { kind: 'DOCUMENT', name: 'C', path: '/dir/deep/c' },
    ]);
  });
});

describe('id 编解码（T-RKB-SVC6）', () => {
  it('三段齐备 + folder encodeURIComponent 往返', () => {
    const id = encodeRepoKnowledgeBaseId('ws-1', 'ZAG', '团队 规范/核心');
    expect(id).toBe('repo:ws-1:zag:%E5%9B%A2%E9%98%9F%20%E8%A7%84%E8%8C%83%2F%E6%A0%B8%E5%BF%83');
    expect(decodeRepoKnowledgeBaseId(id)).toEqual({
      workspaceId: 'ws-1',
      source: 'ZAG',
      folder: '团队 规范/核心',
    });
  });

  it('非法 id 返回 null', () => {
    expect(decodeRepoKnowledgeBaseId('repo:ws-1')).toBeNull();
    expect(decodeRepoKnowledgeBaseId('repo:ws-1:other:a')).toBeNull();
    expect(decodeRepoKnowledgeBaseId('repo:ws-1:docs:')).toBeNull();
    expect(decodeRepoKnowledgeBaseId('abc')).toBeNull();
  });
});

describe('repoKnowledgeBaseService', () => {
  let redis: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void,
    ) => {
      callback();
      return 0 as never;
    }) as never);

    redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
    };
    vi.mocked(getRedisClient).mockReturnValue(redis as never);
    vi.mocked(controllerWorkspaceService.findById).mockResolvedValue(WORKSPACE as never);
    vi.mocked(CloudHost.findOne).mockReturnValue(lean(HOST));
    vi.mocked(CloudHost.find).mockReturnValue(lean([HOST]));
    vi.mocked(Controller.findOne).mockReturnValue(
      lean({ status: 'online', version: '2.19.0' }),
    );
    vi.mocked(Controller.find).mockReturnValue(
      lean([{ _id: 'ctrl-1', status: 'online', version: '2.19.0' }]),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T-RKB-SVC7 listHosts 纯 DB 骨架：scanSupported 版本门禁 + 排序 + 零 publish', async () => {
    vi.mocked(CloudHost.find).mockReturnValue(
      lean([
        { _id: 'h2', name: 'B 主机', workspaceId: 'ws-2', controllerId: 'ctrl-2' },
        { _id: 'h1', name: 'A 主机', workspaceId: 'ws-1', controllerId: 'ctrl-1' },
      ]),
    );
    vi.mocked(Controller.find).mockReturnValue(
      lean([
        { _id: 'ctrl-1', status: 'online', version: '2.19.0' },
        { _id: 'ctrl-2', status: 'offline', version: '2.19.0' },
      ]),
    );

    const hosts = await repoKnowledgeBaseService.listHosts('user-1');

    expect(hosts).toEqual([
      { cloudHostId: 'h1', cloudHostName: 'A 主机', workspaceId: 'ws-1', scanSupported: true },
      { cloudHostId: 'h2', cloudHostName: 'B 主机', workspaceId: 'ws-2', scanSupported: false },
    ]);
    expect(publish).not.toHaveBeenCalled();
    expect(CloudHost.find).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'RUNNING', workspaceId: { $ne: null }, deletedAt: null }),
    );
  });

  it('T-RKB-SVC8 归属链：工作区不可见 / 非 RUNNING 云电脑默认工作区 → Workspace not found', async () => {
    vi.mocked(controllerWorkspaceService.findById).mockResolvedValueOnce(null);
    await expect(repoKnowledgeBaseService.listKnowledgeBases('u', 'ws-x')).rejects.toThrow(
      'Workspace not found',
    );

    vi.mocked(CloudHost.findOne).mockReturnValueOnce(lean(null));
    await expect(repoKnowledgeBaseService.listKnowledgeBases('u', 'ws-1')).rejects.toThrow(
      'Workspace not found',
    );
  });

  it('T-RKB-SVC9/11 首次扫描：一次 publish、缓存 EX 300、来源顺序与不合法库扁平化', async () => {
    redis.get.mockImplementation(async (key: string) =>
      key.startsWith('knowledge-bases:scan:') ? JSON.stringify(SCAN_RESULT) : null,
    );

    const list = await repoKnowledgeBaseService.listKnowledgeBases('u', 'ws-1');

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      'session:command',
      expect.objectContaining({
        type: 'knowledge-bases:scan',
        controllerId: 'ctrl-1',
        path: WORKSPACE.path,
      }),
    );
    expect(redis.set).toHaveBeenCalledWith(
      'repo-knowledge-bases:ws:ws-1',
      expect.any(String),
      'EX',
      REPO_KB_CACHE_TTL_SECONDS,
    );
    expect(list.map((item) => [item.source, item.folder, item.valid])).toEqual([
      ['ZAG', 'a-base', true],
      ['ZAG', 'b-bad', false],
      ['DOCS', 'c-docs', true],
    ]);
    expect(list[0]).toMatchObject({ name: '甲库', description: '甲描述', documentCount: 2 });
    expect(list[1]).toMatchObject({ name: '', documentCount: 0 });
    expect(list[1].errors[0]).toBe('knowledge-base.json 不是合法的 JSON 文件');
  });

  it('T-RKB-SVC9b 缓存命中直接返回（零 publish）；refresh=true 先 DEL 再重扫', async () => {
    redis.get.mockImplementation(async (key: string) =>
      key.startsWith('knowledge-bases:scan:') ? JSON.stringify(SCAN_RESULT) : null,
    );
    await repoKnowledgeBaseService.listKnowledgeBases('u', 'ws-1');
    const cachedPayload = redis.set.mock.calls[0][1] as string;

    redis.get.mockResolvedValue(cachedPayload);
    const cachedList = await repoKnowledgeBaseService.listKnowledgeBases('u', 'ws-1');
    expect(cachedList).toHaveLength(3);
    expect(publish).toHaveBeenCalledTimes(1);

    redis.get.mockImplementation(async (key: string) =>
      key.startsWith('knowledge-bases:scan:') ? JSON.stringify(SCAN_RESULT) : cachedPayload,
    );
    await repoKnowledgeBaseService.listKnowledgeBases('u', 'ws-1', true);
    expect(redis.del).toHaveBeenCalledWith('repo-knowledge-bases:ws:ws-1');
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('T-RKB-SVC9c 并发首次展开 single-flight：同一工作区只触发一次扫描（S4）', async () => {
    redis.get.mockImplementation(async (key: string) =>
      key.startsWith('knowledge-bases:scan:') ? JSON.stringify(SCAN_RESULT) : null,
    );

    const [a, b] = await Promise.all([
      repoKnowledgeBaseService.listKnowledgeBases('u', 'ws-1'),
      repoKnowledgeBaseService.listKnowledgeBases('u', 'ws-1'),
    ]);

    expect(a).toEqual(b);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('T-RKB-SVC10 扫描失败矩阵统一 repo knowledge base scan failed', async () => {
    vi.mocked(Controller.findOne).mockReturnValueOnce(lean({ status: 'offline', version: '2.19.0' }));
    await expect(repoKnowledgeBaseService.listKnowledgeBases('u', 'ws-1')).rejects.toThrow(
      'repo knowledge base scan failed',
    );

    vi.mocked(Controller.findOne).mockReturnValueOnce(lean({ status: 'online', version: '2.18.0' }));
    await expect(repoKnowledgeBaseService.listKnowledgeBases('u', 'ws-1')).rejects.toThrow(
      'repo knowledge base scan failed',
    );

    redis.get.mockResolvedValueOnce(JSON.stringify({ success: false, sources: [] }));
    await expect(repoKnowledgeBaseService.listKnowledgeBases('u', 'ws-1')).rejects.toThrow(
      'repo knowledge base scan failed',
    );

    redis.get.mockResolvedValueOnce('{bad');
    await expect(repoKnowledgeBaseService.listKnowledgeBases('u', 'ws-1')).rejects.toThrow(
      'repo knowledge base scan failed',
    );

    // 轮询超时：始终无结果
    redis.get.mockResolvedValue(null);
    await expect(repoKnowledgeBaseService.listKnowledgeBases('u', 'ws-1')).rejects.toThrow(
      'repo knowledge base scan failed',
    );
  });

  it('T-RKB-SVC4 路径归一与冲突：整库不合法、冲突文档不收录', async () => {
    redis.get.mockImplementation(async (key: string) =>
      key.startsWith('knowledge-bases:scan:')
        ? JSON.stringify({
            success: true,
            sources: [
              {
                source: 'zag',
                knowledgeBases: [
                  {
                    folder: 'conflict',
                    schema: '{"name":"冲突库"}',
                    documents: [
                      { path: 'a.md', content: '# A' },
                      { path: 'a.MD', content: '# A2' },
                    ],
                  },
                  {
                    folder: 'illegal',
                    schema: '{"name":"非法路径"}',
                    documents: [{ path: `${'a'.repeat(129)}.md`, content: '# E' }],
                  },
                ],
                truncated: false,
              },
            ],
            truncated: false,
          })
        : null,
    );

    const list = await repoKnowledgeBaseService.listKnowledgeBases('u', 'ws-1');
    const conflict = list.find((item) => item.folder === 'conflict');
    const illegal = list.find((item) => item.folder === 'illegal');

    expect(conflict?.valid).toBe(false);
    expect(conflict?.errors).toContain('文档路径冲突：/a');
    expect(conflict?.documentCount).toBe(0);
    expect(illegal?.valid).toBe(false);
    expect(illegal?.errors.some((error) => error.startsWith('文档路径不合法：'))).toBe(true);
  });

  it('T-RKB-SVC4b 文档级错误仅剔除该文档（B1）；不合法库 children/document 收敛 []/null（R1）', async () => {
    redis.get.mockImplementation(async (key: string) =>
      key.startsWith('knowledge-bases:scan:')
        ? JSON.stringify({
            success: true,
            sources: [
              {
                source: 'zag',
                knowledgeBases: [
                  {
                    folder: 'with-big-doc',
                    schema: '{"name":"含超限文档"}',
                    documents: [
                      { path: 'ok.md', content: '# OK' },
                      { path: 'big.md', error: 'file too large' },
                    ],
                  },
                  {
                    folder: 'conflict',
                    schema: '{"name":"冲突库"}',
                    documents: [
                      { path: 'a.md', content: '# A' },
                      { path: 'a.MD', content: '# A2' },
                    ],
                  },
                ],
                truncated: false,
              },
            ],
            truncated: false,
          })
        : null,
    );

    const list = await repoKnowledgeBaseService.listKnowledgeBases('u', 'ws-1');
    const good = list.find((item) => item.folder === 'with-big-doc');
    const bad = list.find((item) => item.folder === 'conflict');

    expect(good?.valid).toBe(true);
    expect(good?.errors).toEqual([]);
    expect(good?.documentCount).toBe(1);

    expect(await repoKnowledgeBaseService.listChildren('u', good!.id)).toEqual([
      { kind: 'DOCUMENT', name: 'OK', path: '/ok' },
    ]);
    expect(await repoKnowledgeBaseService.getDocument('u', good!.id, '/big')).toBeNull();

    expect(bad?.valid).toBe(false);
    expect(await repoKnowledgeBaseService.listChildren('u', bad!.id)).toEqual([]);
    expect(await repoKnowledgeBaseService.getDocument('u', bad!.id, '/a')).toBeNull();
  });

  it('T-RKB-SVC12/13 children/getDocument 逐级派生；不可达收敛 []/null', async () => {
    redis.get.mockImplementation(async (key: string) =>
      key.startsWith('knowledge-bases:scan:') ? JSON.stringify(SCAN_RESULT) : null,
    );
    const list = await repoKnowledgeBaseService.listKnowledgeBases('u', 'ws-1');
    const kbId = list[0].id;

    const root = await repoKnowledgeBaseService.listChildren('u', kbId);
    expect(root).toEqual([
      { kind: 'FOLDER', name: 'dir', path: '/dir' },
      { kind: 'DOCUMENT', name: '根文档', path: '/root' },
    ]);

    const doc = await repoKnowledgeBaseService.getDocument('u', kbId, '/root');
    expect(doc?.title).toBe('根文档');
    expect(doc?.content).toContain('---\ntitle: 根文档');

    expect(await repoKnowledgeBaseService.listChildren('u', 'repo:ws-1:zag:missing')).toEqual([]);
    expect(await repoKnowledgeBaseService.getDocument('u', 'bad-id', '/root')).toBeNull();

    vi.mocked(CloudHost.findOne).mockReturnValue(lean(null));
    expect(await repoKnowledgeBaseService.listChildren('u', kbId)).toEqual([]);
    expect(await repoKnowledgeBaseService.getDocument('u', kbId, '/root')).toBeNull();
  });

  it('T-RKB-SVC12b children 缓存 miss 触发一次重扫', async () => {
    redis.get.mockImplementation(async (key: string) =>
      key.startsWith('knowledge-bases:scan:') ? JSON.stringify(SCAN_RESULT) : null,
    );
    const list = await repoKnowledgeBaseService.listKnowledgeBases('u', 'ws-1');
    const kbId = list[0].id;
    redis.del.mockClear();
    redis.get.mockImplementation(async (key: string) =>
      key.startsWith('knowledge-bases:scan:') ? JSON.stringify(SCAN_RESULT) : null,
    );

    await repoKnowledgeBaseService.listChildren('u', kbId, '/dir');
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
