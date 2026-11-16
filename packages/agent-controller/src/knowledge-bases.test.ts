import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, chmod, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  scanKnowledgeBases,
  REPO_KNOWLEDGE_BASE_SOURCES,
  MAX_KNOWLEDGE_BASES_PER_SOURCE,
  MAX_DOCUMENTS_PER_BASE,
  MAX_SCHEMA_BYTES,
  MAX_DOCUMENT_BYTES,
} from './knowledge-bases.js';

let root: string;
let zagDir: string;
let docsDir: string;

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
    expect(result.sources.map((item) => item.source)).toEqual(['zag', 'docs']);
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

  it('T-RKB-SCAN7 上限矩阵：库数/文档数/schema/单文档/单库截断', async () => {
    // 每来源 >20 库：按 localeCompare 取前 20
    for (let i = 0; i < MAX_KNOWLEDGE_BASES_PER_SOURCE + 2; i += 1) {
      await makeKb(zagDir, `kb${String(i).padStart(2, '0')}`);
    }
    const result = await scanKnowledgeBases(root);
    const zag = result.sources[0];
    expect(zag.truncated).toBe(true);
    expect(zag.knowledgeBases).toHaveLength(MAX_KNOWLEDGE_BASES_PER_SOURCE);
    expect(zag.knowledgeBases[0].folder).toBe('kb00');
    expect(zag.knowledgeBases.at(-1)?.folder).toBe('kb19');

    // schema >64KiB → 该库 error:file too large
    const bigSchemaRoot = await mkdtemp(join(tmpdir(), 'rkb-schema-'));
    const bigSchemaDir = join(bigSchemaRoot, '.zag', 'knowledges');
    const bigKb = join(bigSchemaDir, 'big');
    await mkdir(bigKb, { recursive: true });
    await writeFile(join(bigKb, 'knowledge-base.json'), 'x'.repeat(MAX_SCHEMA_BYTES + 1));
    const bigSchemaResult = await scanKnowledgeBases(bigSchemaRoot);
    expect(bigSchemaResult.sources[0].knowledgeBases[0]).toEqual({
      folder: 'big',
      error: 'file too large',
    });
    await rm(bigSchemaRoot, { recursive: true, force: true });

    // 文档数 >50 截断；单文档 >128KiB 该文档 error；单库 >1MiB 停止并 truncated
    const limitsRoot = await mkdtemp(join(tmpdir(), 'rkb-limits-'));
    const limitsDir = join(limitsRoot, '.zag', 'knowledges');
    const manyDir = join(limitsDir, 'many');
    await mkdir(manyDir, { recursive: true });
    await writeFile(join(manyDir, 'knowledge-base.json'), '{"name":"many"}');
    for (let i = 0; i < MAX_DOCUMENTS_PER_BASE + 2; i += 1) {
      await writeFile(join(manyDir, `d${String(i).padStart(2, '0')}.md`), '# x');
    }
    const bigDocDir = join(limitsDir, 'bigdoc');
    await mkdir(bigDocDir, { recursive: true });
    await writeFile(join(bigDocDir, 'knowledge-base.json'), '{"name":"bigdoc"}');
    await writeFile(join(bigDocDir, 'big.md'), 'x'.repeat(MAX_DOCUMENT_BYTES + 1));
    const limits = await scanKnowledgeBases(limitsRoot);
    const many = limits.sources[0].knowledgeBases.find((item) => item.folder === 'many');
    const bigDoc = limits.sources[0].knowledgeBases.find((item) => item.folder === 'bigdoc');
    expect(many?.truncated).toBe(true);
    expect(many?.documents).toHaveLength(MAX_DOCUMENTS_PER_BASE);
    expect(bigDoc?.documents).toEqual([{ path: 'big.md', error: 'file too large' }]);
    await rm(limitsRoot, { recursive: true, force: true });
  });

  it('T-RKB-SCAN7b 单库 >1MiB 停止读取并 truncated；单来源 >2MiB 停止', async () => {
    const kb = await makeKb(zagDir, 'huge');
    // 每篇 ~100KiB，11 篇累计 >1MiB
    const chunk = 'x'.repeat(100 * 1024);
    for (let i = 0; i < 12; i += 1) {
      await writeFile(join(kb, `part${String(i).padStart(2, '0')}.md`), chunk);
    }

    const result = await scanKnowledgeBases(root);
    const entry = result.sources[0].knowledgeBases[0];
    expect(entry.truncated).toBe(true);
    expect((entry.documents?.length ?? 0)).toBeLessThan(12);
    expect(result.sources[0].truncated).toBe(true);
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
  it('两个固定约定目录', () => {
    expect(REPO_KNOWLEDGE_BASE_SOURCES).toEqual([
      { source: 'zag', subdir: '.zag/knowledges' },
      { source: 'docs', subdir: 'docs/knowledges' },
    ]);
  });
});
