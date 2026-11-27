import { describe, it, expect } from 'vitest';
import {
  REPO_KNOWLEDGE_BASE_PROMPT_RESOURCES,
  REPO_KNOWLEDGE_BASE_PROMPT_RESOURCE_URI_PREFIX,
  getKnowledgeBasePromptResource,
  getKnowledgeBasePromptText,
  listKnowledgeBasePromptNames,
} from './knowledge-base-prompts.js';

/**
 * 仓库知识库编写指引（resources 单一来源）。
 * T-RKB-P1~P4：注册表形态、要点覆盖、可用片段名、与扫描器常量防漂移守卫。
 */

const PROMPT_NAME = 'repo-knowledge-base-authoring';
const RESOURCE_URI = 'zag://agent-knowledge-base-tools/prompt/repo-knowledge-base-authoring';

describe('knowledge-base prompts', () => {
  it('T-RKB-P1 片段注册表：单片段 repo-knowledge-base-authoring 且含 uri/description/mimeType', () => {
    expect(REPO_KNOWLEDGE_BASE_PROMPT_RESOURCES).toEqual([
      {
        uri: RESOURCE_URI,
        name: PROMPT_NAME,
        description: expect.stringContaining('仓库知识库编写指引'),
        mimeType: 'text/markdown',
      },
    ]);
    expect(REPO_KNOWLEDGE_BASE_PROMPT_RESOURCE_URI_PREFIX).toBe(
      'zag://agent-knowledge-base-tools/prompt/',
    );
    expect(listKnowledgeBasePromptNames()).toEqual([PROMPT_NAME]);
  });

  it('T-RKB2-P1 文本覆盖全部要点（路径/结构/schema/文档组织/front matter/上限/只读）', () => {
    const text = getKnowledgeBasePromptText(PROMPT_NAME) ?? '';
    for (const anchor of [
      '.zag/knowledges/',
      'docs/knowledges/',
      '一层文件夹',
      'docs/guides/',
      '跳过 `docs/knowledges`',
      'knowledge-base.json',
      '直接子文件夹',
      'name',
      '1~64',
      'description',
      '1024',
      '递归',
      '路径',
      'title',
      'tags',
      'description',
      'front matter',
      '首个一级标题',
      '文件名',
      '1MiB',
      '1000',
      '无上限',
      '只读',
      '不会出现在知识库 MCP 工具中',
      '仓库提交流程',
    ]) {
      expect(text).toContain(anchor);
    }
    // 旧口径不得残留
    for (const legacy of ['20 个', '50 个', '64KiB', '128KiB', '2MiB']) {
      expect(text).not.toContain(legacy);
    }
  });

  it('T-RKB-P3 未知/空名称返回 null（供 resources/read 转 INVALID_PARAMS）', () => {
    expect(getKnowledgeBasePromptText('')).toBeNull();
    expect(getKnowledgeBasePromptText('unknown-prompt')).toBeNull();
  });

  it('T-RKB-P4 getKnowledgeBasePromptResource 按 URI 命中；未知 URI 返回 null', () => {
    const found = getKnowledgeBasePromptResource(RESOURCE_URI);
    expect(found).toBeTruthy();
    expect(found!.definition.name).toBe(PROMPT_NAME);
    expect(found!.text).toBe(getKnowledgeBasePromptText(PROMPT_NAME));
    expect(getKnowledgeBasePromptResource('zag://agent-knowledge-base-tools/prompt/nope')).toBeNull();
    expect(getKnowledgeBasePromptResource(PROMPT_NAME)).toBeNull();
  });

  it('T-RKB3-P2 防漂移守卫：三个来源（含 docs 一层文件夹与容器跳过）必须与扫描器一致', () => {
    // 来源：packages/agent-controller/src/knowledge-bases.ts（docs-root 跳过 knowledges）
    const text = getKnowledgeBasePromptText(PROMPT_NAME) ?? '';
    expect(text).toContain('.zag/knowledges');
    expect(text).toContain('docs/knowledges');
    expect(text).toContain('一层文件夹');
    expect(text).toContain('docs/guides/');
    expect(text).toContain('跳过 `docs/knowledges`');
    expect(text).toContain('1MiB');
    expect(text).toContain('1000');
    expect(text).toContain('无上限');
    // 旧上限常量已删除：守卫必须能捕获回退
    expect(text).not.toContain('20 个');
    expect(text).not.toContain('50 个');
    expect(text).not.toContain('64KiB');
    expect(text).not.toContain('128KiB');
    expect(text).not.toContain('2MiB');
  });
});
