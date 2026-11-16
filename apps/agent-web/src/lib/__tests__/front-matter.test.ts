import { describe, it, expect } from 'vitest';
import { splitFrontMatter } from '../front-matter';

describe('splitFrontMatter（T-RKB-WEB-L2）', () => {
  it('拆出全部键值对（含三键以外的键）与正文', () => {
    const content =
      '---\ntitle: Git 规范\ntags: [git, 规范]\ndescription: 说明\ncustom: 自定义\n---\n# 正文\n';
    const { frontMatter, body } = splitFrontMatter(content);

    expect(frontMatter).toEqual([
      { key: 'title', value: 'Git 规范' },
      { key: 'tags', value: '[git, 规范]' },
      { key: 'description', value: '说明' },
      { key: 'custom', value: '自定义' },
    ]);
    expect(body).toBe('# 正文\n');
  });

  it('无 front matter / 块非法 → frontMatter 为空且 body 恒等于原文', () => {
    for (const content of ['# 无块', '---\nnot a pair\n---\n# x', '---\ntitle: 未闭合\n# x']) {
      const split = splitFrontMatter(content);
      expect(split.frontMatter).toEqual([]);
      expect(split.body).toBe(content);
    }
  });

  it('仅识别前 4KiB 内闭合的 front matter', () => {
    const content = `---\n${'x'.repeat(5000)}\n---\n# 正文`;
    const split = splitFrontMatter(content);
    expect(split.frontMatter).toEqual([]);
    expect(split.body).toBe(content);
  });
});
