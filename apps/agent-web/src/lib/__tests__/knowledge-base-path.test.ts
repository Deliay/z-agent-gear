// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  DOC_PATH_MAX,
  breadcrumbOf,
  buildKnowledgeBaseTree,
  decodeDocumentPath,
  encodeDocumentPath,
  joinDocPath,
  knowledgeBaseDocHref,
  newDocumentName,
  normalizeDocumentPath,
} from '../knowledge-base-path';

describe('knowledge-base-path（T-KBP1~6）', () => {
  it('T-KBP1 路径归一与服务端同规则', () => {
    expect(normalizeDocumentPath('/')).toBe('/');
    expect(normalizeDocumentPath('  /a/b  ')).toBe('/a/b');
    expect(normalizeDocumentPath('/a/b/')).toBe('/a/b');
    expect(normalizeDocumentPath('/a//')).toBe('/a');
    expect(normalizeDocumentPath('/a/b///')).toBe('/a/b');
    expect(normalizeDocumentPath('/中文 文档')).toBe('/中文 文档');

    // 服务端 invalid document path 的输入矩阵（前端返回 null）
    expect(normalizeDocumentPath('a/b')).toBeNull();
    expect(normalizeDocumentPath('')).toBeNull();
    expect(normalizeDocumentPath('   ')).toBeNull();
    expect(normalizeDocumentPath('/a//b')).toBeNull();
    expect(normalizeDocumentPath('/a\u0000b')).toBeNull();
    expect(normalizeDocumentPath('/a\nb')).toBeNull();
    expect(normalizeDocumentPath(`/${'a'.repeat(129)}`)).toBeNull();
    expect(normalizeDocumentPath(`/${'a'.repeat(DOC_PATH_MAX)}`)).toBeNull();
    expect(normalizeDocumentPath('/a'.repeat(300))).toBeNull();
  });

  it('T-KBP2 joinDocPath 拼接父路径与名称', () => {
    expect(joinDocPath('/', '新文档-abcd')).toBe('/新文档-abcd');
    expect(joinDocPath('/a', 'b')).toBe('/a/b');
    expect(joinDocPath('/a/b/', '/c/')).toBe('/a/b/c');
    // 空名称保持父路径；父路径非法回退根
    expect(joinDocPath('/a', '   ')).toBe('/a');
    expect(joinDocPath('not-a-path', 'c')).toBe('/c');
  });

  it('T-KBP3 breadcrumbOf 逐段累积', () => {
    expect(breadcrumbOf('/')).toEqual([{ label: '根目录', path: '/' }]);
    expect(breadcrumbOf('/a/b/c')).toEqual([
      { label: '根目录', path: '/' },
      { label: 'a', path: '/a' },
      { label: 'b', path: '/a/b' },
      { label: 'c', path: '/a/b/c' },
    ]);
    // 归一化失败按根处理
    expect(breadcrumbOf('bad')).toEqual([{ label: '根目录', path: '/' }]);
  });

  it('T-KBP4 buildKnowledgeBaseTree 路径层级聚合与同级稳定排序', () => {
    const tree = buildKnowledgeBaseTree([
      { path: '/a/c', title: 'C' },
      { path: '/a/b', title: 'B' },
      { path: '/a', title: 'A' },
      { path: '/z', title: 'Z' },
      { path: '/z', title: '重复路径' },
    ]);

    // 根级按标题字典序；/a 同时是文档与父路径
    expect(tree.map((node) => node.path)).toEqual(['/a', '/z']);
    const a = tree.find((node) => node.path === '/a');
    expect(a?.document?.title).toBe('A');
    expect(a?.children.map((node) => node.path)).toEqual(['/a/b', '/a/c']);
    expect(a?.children[0].document?.title).toBe('B');
    expect(a?.children[0].children).toEqual([]);

    // 根文档（path=/）作为独立节点
    const withRoot = buildKnowledgeBaseTree([{ path: '/', title: '根文档' }]);
    expect(withRoot).toHaveLength(1);
    expect(withRoot[0].path).toBe('/');
    expect(withRoot[0].document?.title).toBe('根文档');

    // 非法路径被忽略
    expect(buildKnowledgeBaseTree([{ path: 'bad', title: 'X' }])).toEqual([]);
  });

  it('T-KBP5 newDocumentName 形如「新文档-XXXX」', () => {
    for (let index = 0; index < 20; index += 1) {
      expect(newDocumentName()).toMatch(/^新文档-[a-z0-9]{4}$/);
    }
  });

  it('T-KBP6 路由路径编码/解码与 href', () => {
    expect(encodeDocumentPath('/a b/中文')).toBe('/a%20b/%E4%B8%AD%E6%96%87');
    expect(decodeDocumentPath('a%20b/%E4%B8%AD%E6%96%87')).toBe('/a b/中文');
    expect(decodeDocumentPath(undefined)).toBe('/');
    expect(decodeDocumentPath('')).toBe('/');
    // 非法百分号编码容忍为原文
    expect(decodeDocumentPath('a%2/b')).toBe('/a%2/b');
    expect(encodeDocumentPath('/')).toBe('/');

    expect(knowledgeBaseDocHref('kb-1', '/a b')).toBe('/knowledge-bases/kb-1/a%20b');
    expect(knowledgeBaseDocHref('kb-1', '/a/b', true)).toBe('/knowledge-bases/kb-1/a/b?edit=1');
  });
});
