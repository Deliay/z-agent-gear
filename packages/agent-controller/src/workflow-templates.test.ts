import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, chmod, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  scanWorkflowTemplates,
  WORKFLOW_TEMPLATES_SUBDIR,
  WORKFLOW_TEMPLATES_MAX_FILES,
  WORKFLOW_TEMPLATES_MAX_FILE_BYTES,
} from './workflow-templates.js';

let root: string;
let templatesDir: string;

async function writeTemplate(name: string, content: string) {
  await writeFile(join(templatesDir, name), content, 'utf8');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wt-scan-'));
  templatesDir = join(root, WORKFLOW_TEMPLATES_SUBDIR);
  await mkdir(templatesDir, { recursive: true });
});

afterEach(async () => {
  await chmod(templatesDir, 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe('scanWorkflowTemplates', () => {
  it('T-WT1 目录不存在 → success:true 空列表', async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), 'wt-empty-'));
    const result = await scanWorkflowTemplates(emptyRoot);
    expect(result).toEqual({ success: true, templates: [], truncated: false });
    await rm(emptyRoot, { recursive: true, force: true });
  });

  it('T-WT2 空目录 / 非 .json 文件 / 子目录中的 .json 均不返回（不递归）', async () => {
    await writeTemplate('readme.md', '# x');
    await writeTemplate('template.txt', '{}');
    await mkdir(join(templatesDir, 'nested'));
    await writeFile(join(templatesDir, 'nested', 'inner.json'), '{}');

    const result = await scanWorkflowTemplates(root);

    expect(result.success).toBe(true);
    expect(result.templates).toEqual([]);
  });

  it('T-WT3 多文件按文件名 localeCompare 排序并返回内容', async () => {
    await writeTemplate('b.json', '{"name":"b"}');
    await writeTemplate('a.json', '{"name":"a"}');
    await writeTemplate('c.json', '{"name":"c"}');

    const result = await scanWorkflowTemplates(root);

    expect(result.success).toBe(true);
    expect(result.templates.map((t) => t.fileName)).toEqual(['a.json', 'b.json', 'c.json']);
    expect(result.templates[0].content).toBe('{"name":"a"}');
  });

  it('T-WT4 单文件 >128KiB → 该文件 error:file too large，其余正常', async () => {
    await writeTemplate('big.json', 'x'.repeat(WORKFLOW_TEMPLATES_MAX_FILE_BYTES + 1));
    await writeTemplate('ok.json', '{"name":"ok"}');

    const result = await scanWorkflowTemplates(root);

    expect(result.templates).toEqual([
      { fileName: 'big.json', error: 'file too large' },
      { fileName: 'ok.json', content: '{"name":"ok"}' },
    ]);
  });

  it('T-WT5 文件数 >20 → 仅前 20 个且 truncated:true', async () => {
    for (let i = 0; i < WORKFLOW_TEMPLATES_MAX_FILES + 3; i++) {
      const name = `t${String(i).padStart(2, '0')}.json`;
      await writeTemplate(name, '{}');
    }

    const result = await scanWorkflowTemplates(root);

    expect(result.success).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.templates).toHaveLength(WORKFLOW_TEMPLATES_MAX_FILES);
    expect(result.templates[0].fileName).toBe('t00.json');
    expect(result.templates.at(-1)?.fileName).toBe('t19.json');
  });

  it('T-WT6 总量 >1MiB → 停止读取且 truncated:true', async () => {
    // 每个文件 128KiB（未超单文件上限），9 个文件累计 1.125MiB
    const chunk = 'x'.repeat(WORKFLOW_TEMPLATES_MAX_FILE_BYTES);
    for (let i = 0; i < 9; i++) {
      await writeTemplate(`f${i}.json`, chunk);
    }

    const result = await scanWorkflowTemplates(root);

    expect(result.success).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.templates.length).toBeLessThan(9);
    expect(result.templates.every((t) => t.content !== undefined)).toBe(true);
  });

  it('T-WT7 符号链接：指向常规 .json 文件读取；指向目录/设备跳过', async () => {
    await writeTemplate('real.json', '{"name":"real"}');
    await symlink(join(templatesDir, 'real.json'), join(templatesDir, 'link.json'));
    await symlink(join(root, '..'), join(templatesDir, 'dir.json'));
    const device = '/dev/null';
    const hasDevice = await stat(device).then(() => true).catch(() => false);
    if (hasDevice) {
      await symlink(device, join(templatesDir, 'dev.json'));
    }

    const result = await scanWorkflowTemplates(root);

    expect(result.success).toBe(true);
    expect(result.templates.map((t) => t.fileName)).toEqual(['link.json', 'real.json']);
    expect(result.templates.every((t) => t.content === '{"name":"real"}')).toBe(true);
  });

  it('T-WT8 目录读取 EACCES → success:false, error:permission denied', async () => {
    await chmod(templatesDir, 0o000);

    const result = await scanWorkflowTemplates(root);

    expect(result).toEqual({
      success: false,
      templates: [],
      truncated: false,
      error: 'permission denied',
    });
  });
});
