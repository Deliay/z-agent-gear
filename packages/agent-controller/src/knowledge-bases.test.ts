import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, chmod, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  scanKnowledgeBases,
  REPO_KNOWLEDGE_BASE_SOURCES,
  MAX_ENTRIES_PER_FOLDER,
  MAX_FILE_BYTES,
} from './knowledge-bases.js';

let root: string;
let zagDir: string;
let docsDir: string;
let docsRoot: string;

async function makeKb(sourceDir: string, folder: string, schema = '{"name":"kb"}') {
  const dir = join(sourceDir, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'knowledge-base.json'), schema, 'utf8');
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rkb-scan-'));
  zagDir = join(root, '.zag', 'knowledges');
  docsDir = join(root, 'docs', 'knowledges');
  docsRoot = join(root, 'docs');
  await mkdir(zagDir, { recursive: true });
  await mkdir(docsDir, { recursive: true });
});

afterEach(async () => {
  for (const dir of [zagDir, docsDir]) {
    await chmod(dir, 0o755).catch(() => undefined);
  }
  await rm(root, { recursive: true, force: true });
});

describe('scanKnowledgeBases', () => {
  it('T-RKB-SCAN1 两个来源目录各识别一个知识库', async () => {
    await makeKb(zagDir, 'a', '{"name":"A"}');
    await makeKb(docsDir, 'b', '{"name":"B"}');

    const result = await scanKnowledgeBases(root);

    expect(result.success).toBe(true);
    expect(result.sources.map((item) => item.source)).toEqual(['zag', 'docs', 'docs-root']);
    expect(result.sources[0].knowledgeBases.map((item) => item.folder)).toEqual(['a']);
    expect(result.sources[1].knowledgeBases.map((item) => item.folder)).toEqual(['b']);
    expect(result.sources[0].knowledgeBases[0].schema).toBe('{"name":"A"}');
  });

  it('T-RKB-SCAN2 无 knowledge-base.json / 为目录 / 链接到目录 → 不识别', async () => {
    await mkdir(join(zagDir, 'plain'), { recursive: true });
    await writeFile(join(zagDir, 'plain', 'a.md'), '# a');
    await mkdir(join(zagDir, 'schema-dir', 'knowledge-base.json'), { recursive: true });
    await mkdir(join(zagDir, 'target-dir'), { recursive: true });
    await symlink(join(zagDir, 'target-dir'), join(zagDir, 'linked-dir'));
    // knowledge-base.json 为符号链接指向目录 → 不识别
    await mkdir(join(zagDir, 'schema-target'), { recursive: true });
    await mkdir(join(zagDir, 'schema-link'), { recursive: true });
    await symlink(join(zagDir, 'schema-target'), join(zagDir, 'schema-link', 'knowledge-base.json'));

    const result = await scanKnowledgeBases(root);

    expect(result.sources[0].knowledgeBases).toEqual([]);
  });

  it('T-RKB-SCAN3 库内递归收集 .md（含子目录、.MD 小写比较），非 .md 不收录', async () => {
    const kb = await makeKb(zagDir, 'kb');
    await mkdir(join(kb, 'a', 'b'), { recursive: true });
    await writeFile(join(kb, 'root.md'), '# root');
    await writeFile(join(kb, 'a', 'b', 'deep.MD'), '# deep');
    await writeFile(join(kb, 'a', 'note.txt'), 'nope');

    const result = await scanKnowledgeBases(root);
    const entry = result.sources[0].knowledgeBases[0];

    expect(entry.documents?.map((doc) => doc.path)).toEqual([
      'a/b/deep.MD',
      'root.md',
    ]);
    expect(entry.documents?.every((doc) => doc.content !== undefined)).toBe(true);
  });

  it('T-RKB-SCAN4 知识库发现不递归（二级子目录中的 knowledge-base.json 不识别）', async () => {
    const nested = join(zagDir, 'outer', 'inner');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'knowledge-base.json'), '{"name":"inner"}', 'utf8');

    const result = await scanKnowledgeBases(root);

    expect(result.sources[0].knowledgeBases).toEqual([]);
  });

  it('T-RKB-SCAN5 目录不存在 → 该来源空列表且 success:true', async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), 'rkb-empty-'));
    const result = await scanKnowledgeBases(emptyRoot);
    expect(result).toEqual({
      success: true,
      sources: [
        { source: 'zag', knowledgeBases: [], truncated: false },
        { source: 'docs', knowledgeBases: [], truncated: false },
        { source: 'docs-root', knowledgeBases: [], truncated: false },
      ],
      truncated: false,
    });
    await rm(emptyRoot, { recursive: true, force: true });
  });

  it('T-RKB-SCAN6 来源目录读取 EACCES → 整体 permission denied', async () => {
    await makeKb(zagDir, 'a');
    await chmod(zagDir, 0o000);
    try {
      const result = await scanKnowledgeBases(root);
      expect(result).toEqual({
        success: false,
        sources: [],
        truncated: false,
        error: 'permission denied',
      });
    } finally {
      await chmod(zagDir, 0o755);
    }
  });

  it('T-RKB-SCAN7 (deprecated) 上限矩阵已由 T-RKB2-SCAN1~5 取代', () => {
    expect(MAX_ENTRIES_PER_FOLDER).toBe(1000);
    expect(MAX_FILE_BYTES).toBe(1024 * 1024);
  });

  it('T-RKB2-SCAN1 单库 >50 篇文档且累计 >1MiB：全部加载、不截断', async () => {
    const kb = await makeKb(zagDir, 'many');
    const chunk = 'x'.repeat(20 * 1024);
    for (let i = 0; i < 60; i += 1) {
      await writeFile(join(kb, `d${String(i).padStart(2, '0')}.md`), chunk);
    }

    const result = await scanKnowledgeBases(root);
    const entry = result.sources[0].knowledgeBases[0];

    expect(entry.documents).toHaveLength(60);
    expect(entry.documents?.every((doc) => doc.content?.length === chunk.length)).toBe(true);
    expect(entry.truncated).toBe(false);
    expect(result.sources[0].truncated).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('T-RKB2-SCAN2 单文件夹 >1000 直接子项：按名称取前 1000、库级 truncated 上浮', async () => {
    const kb = await makeKb(zagDir, 'big');
    // 1000 个文件 + 1 个目录（目录名排序在最后）→ 直接子项 1001，目录层被截断
    for (let i = 0; i < MAX_ENTRIES_PER_FOLDER; i += 1) {
      await writeFile(join(kb, `a${String(i).padStart(4, '0')}.md`), '# x');
    }
    await mkdir(join(kb, 'z-extra'), { recursive: true });
    await writeFile(join(kb, 'z-extra', 'deep.md'), '# deep');

    const result = await scanKnowledgeBases(root);
    const entry = result.sources[0].knowledgeBases[0];
    expect(entry.documents).toHaveLength(MAX_ENTRIES_PER_FOLDER);
    expect(entry.documents?.some((doc) => doc.path === 'z-extra/deep.md')).toBe(false);
    expect(entry.truncated).toBe(true);
    expect(result.sources[0].truncated).toBe(true);
    expect(result.truncated).toBe(true);

    // 其余目录不受影响
    const other = await makeKb(zagDir, 'small');
    await writeFile(join(other, 'ok.md'), '# ok');
    const again = await scanKnowledgeBases(root);
    const small = again.sources[0].knowledgeBases.find((item) => item.folder === 'small');
    expect(small?.truncated).toBe(false);
    expect(small?.documents).toHaveLength(1);
  });

  it('T-RKB2-SCAN3 单文档 >1MiB：该文档 error 不读内容，其余正常且库不截断', async () => {
    const kb = await makeKb(zagDir, 'mixed');
    await writeFile(join(kb, 'big.md'), 'x'.repeat(MAX_FILE_BYTES + 1));
    await writeFile(join(kb, 'ok.md'), '# ok');

    const result = await scanKnowledgeBases(root);
    const entry = result.sources[0].knowledgeBases[0];
    const big = entry.documents?.find((doc) => doc.path === 'big.md');
    const ok = entry.documents?.find((doc) => doc.path === 'ok.md');

    expect(big).toEqual({ path: 'big.md', error: 'file too large' });
    expect(ok?.content).toBe('# ok');
    expect(entry.truncated).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('T-RKB2-SCAN4 knowledge-base.json >1MiB：整库 file too large 且不读文档', async () => {
    const kbDir = join(zagDir, 'badschema');
    await mkdir(kbDir, { recursive: true });
    await writeFile(join(kbDir, 'knowledge-base.json'), 'x'.repeat(MAX_FILE_BYTES + 1));
    await writeFile(join(kbDir, 'doc.md'), '# doc');

    const result = await scanKnowledgeBases(root);

    expect(result.sources[0].knowledgeBases[0]).toEqual({
      folder: 'badschema',
      error: 'file too large',
    });
  });

  it('T-RKB2-SCAN5 来源目录 >1000 子文件夹：前 1000 识别、仅来源级截断', async () => {
    for (let i = 0; i <= MAX_ENTRIES_PER_FOLDER; i += 1) {
      await makeKb(zagDir, `kb${String(i).padStart(4, '0')}`);
    }

    const result = await scanKnowledgeBases(root);
    const source = result.sources[0];

    expect(source.knowledgeBases).toHaveLength(MAX_ENTRIES_PER_FOLDER);
    expect(source.knowledgeBases[0].folder).toBe('kb0000');
    expect(source.knowledgeBases.at(-1)?.folder).toBe('kb0999');
    expect(source.truncated).toBe(true);
    expect(result.truncated).toBe(true);
    // 来源目录层截断不绑定到具体知识库
    expect(source.knowledgeBases.every((item) => item.truncated !== true)).toBe(true);
  });

  it('T-RKB2-SCAN5b 来源目录「目录 + 散置文件」合计 >1000：按名称合并取前 1000，窗口外文件夹不识别', async () => {
    // 999 个散置文件 + 2 个知识库文件夹（名称排序在文件之后）→ 直接子项 1001
    for (let i = 0; i < MAX_ENTRIES_PER_FOLDER - 1; i += 1) {
      await writeFile(join(zagDir, `a${String(i).padStart(4, '0')}.md`), '# note');
    }
    await makeKb(zagDir, 'z-kb-in');
    await makeKb(zagDir, 'z-kb-out');

    const result = await scanKnowledgeBases(root);
    const source = result.sources[0];

    // 窗口内仅容纳 999 个文件 + z-kb-in；z-kb-out 在窗口外不遍历、不识别
    expect(source.knowledgeBases.map((item) => item.folder)).toEqual(['z-kb-in']);
    expect(source.truncated).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('T-RKB3-SCAN1 docs 一层文件夹含 knowledge-base.json → 第三来源识别，文档路径正确', async () => {
    const kb = await makeKb(docsRoot, 'guides', '{"name":"指南"}');
    await writeFile(join(kb, 'intro.md'), '# 简介');
    await mkdir(join(kb, 'api'), { recursive: true });
    await writeFile(join(kb, 'api', 'rest.md'), '# REST');

    const result = await scanKnowledgeBases(root);
    const source = result.sources.find((item) => item.source === 'docs-root');

    expect(source?.knowledgeBases.map((item) => item.folder)).toEqual(['guides']);
    expect(source?.knowledgeBases[0].schema).toBe('{"name":"指南"}');
    expect(source?.knowledgeBases[0].documents?.map((doc) => doc.path)).toEqual([
      'api/rest.md',
      'intro.md',
    ]);
  });

  it('T-RKB3-SCAN2 三来源同名文件夹互不覆盖，来源顺序固定', async () => {
    await makeKb(zagDir, 'same', '{"name":"ZAG 库"}');
    await makeKb(docsDir, 'same', '{"name":"DOCS 库"}');
    await makeKb(docsRoot, 'same', '{"name":"DOCS_ROOT 库"}');

    const result = await scanKnowledgeBases(root);

    expect(result.sources.map((item) => item.source)).toEqual(['zag', 'docs', 'docs-root']);
    expect(result.sources.map((item) => item.knowledgeBases[0]?.schema)).toEqual([
      '{"name":"ZAG 库"}',
      '{"name":"DOCS 库"}',
      '{"name":"DOCS_ROOT 库"}',
    ]);
  });

  it('T-RKB3-SCAN3 docs/knowledges 容器本身不被识别；其子文件夹仍属 docs 来源', async () => {
    // 容器目录直接含 knowledge-base.json：docs-root 必须跳过
    await writeFile(join(docsRoot, 'knowledges', 'knowledge-base.json'), '{"name":"容器"}', 'utf8');
    await makeKb(docsDir, 'child', '{"name":"子库"}');
    await makeKb(docsRoot, 'guides', '{"name":"指南"}');

    const result = await scanKnowledgeBases(root);
    const docsSource = result.sources.find((item) => item.source === 'docs');
    const docsRootSource = result.sources.find((item) => item.source === 'docs-root');

    expect(docsSource?.knowledgeBases.map((item) => item.folder)).toEqual(['child']);
    expect(docsRootSource?.knowledgeBases.map((item) => item.folder)).toEqual(['guides']);
  });

  it('T-RKB3-SCAN4 docs 深层嵌套 knowledge-base.json 不识别（发现不递归）', async () => {
    const nested = join(docsRoot, 'outer', 'inner');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'knowledge-base.json'), '{"name":"inner"}', 'utf8');

    const result = await scanKnowledgeBases(root);
    const source = result.sources.find((item) => item.source === 'docs-root');

    expect(source?.knowledgeBases).toEqual([]);
  });

  it('T-RKB3-SCAN5 docs 目录不存在 → 第三来源空列表；子项 >1000 → 来源截断', async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), 'rkb-docs-root-empty-'));
    const empty = await scanKnowledgeBases(emptyRoot);
    expect(empty.sources.find((item) => item.source === 'docs-root')).toEqual({
      source: 'docs-root',
      knowledgeBases: [],
      truncated: false,
    });
    await rm(emptyRoot, { recursive: true, force: true });

    for (let i = 0; i <= MAX_ENTRIES_PER_FOLDER; i += 1) {
      await makeKb(docsRoot, `kb${String(i).padStart(4, '0')}`);
    }
    const result = await scanKnowledgeBases(root);
    const source = result.sources.find((item) => item.source === 'docs-root');
    expect(source?.knowledgeBases).toHaveLength(MAX_ENTRIES_PER_FOLDER);
    expect(source?.truncated).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('T-RKB3-SCAN6 docs-root 单文件上限：schema 超限整库 error、单文档超限逐条 error', async () => {
    const badSchema = join(docsRoot, 'bad-schema');
    await mkdir(badSchema, { recursive: true });
    await writeFile(join(badSchema, 'knowledge-base.json'), 'x'.repeat(MAX_FILE_BYTES + 1));
    const mixed = await makeKb(docsRoot, 'mixed', '{"name":"混合"}');
    await writeFile(join(mixed, 'big.md'), 'x'.repeat(MAX_FILE_BYTES + 1));
    await writeFile(join(mixed, 'ok.md'), '# ok');

    const result = await scanKnowledgeBases(root);
    const source = result.sources.find((item) => item.source === 'docs-root');
    const bad = source?.knowledgeBases.find((item) => item.folder === 'bad-schema');
    const entry = source?.knowledgeBases.find((item) => item.folder === 'mixed');

    expect(bad).toEqual({ folder: 'bad-schema', error: 'file too large' });
    expect(entry?.documents?.find((doc) => doc.path === 'big.md')).toEqual({
      path: 'big.md',
      error: 'file too large',
    });
    expect(entry?.documents?.find((doc) => doc.path === 'ok.md')?.content).toBe('# ok');
  });

  it('T-RKB-SCAN8 符号链接：指向常规 .md 文件读取；指向目录/悬空跳过', async () => {
    const kb = await makeKb(zagDir, 'kb');
    await writeFile(join(kb, 'real.md'), '# real');
    await symlink(join(kb, 'real.md'), join(kb, 'link.md'));
    await symlink(join(root, '..'), join(kb, 'dir.md'));
    await symlink(join(kb, 'missing.md'), join(kb, 'dangling.md'));
    const device = '/dev/null';
    if (await stat(device).then(() => true).catch(() => false)) {
      await symlink(device, join(kb, 'dev.md'));
    }

    const result = await scanKnowledgeBases(root);
    const entry = result.sources[0].knowledgeBases[0];

    expect(entry.documents?.map((doc) => doc.path)).toEqual(['link.md', 'real.md']);
    expect(entry.documents?.every((doc) => doc.content === '# real')).toBe(true);
  });
});

describe('REPO_KNOWLEDGE_BASE_SOURCES', () => {
  it('三个来源（zag / docs / docs-root，docs-root 跳过 knowledges 容器）', () => {
    expect(REPO_KNOWLEDGE_BASE_SOURCES).toEqual([
      { source: 'zag', subdir: '.zag/knowledges' },
      { source: 'docs', subdir: 'docs/knowledges' },
      { source: 'docs-root', subdir: 'docs', excludeFolders: ['knowledges'] },
    ]);
  });
});
