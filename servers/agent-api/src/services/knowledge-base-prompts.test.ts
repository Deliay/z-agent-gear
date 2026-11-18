import { describe, it, expect } from 'vitest';
import {
  REPO_KNOWLEDGE_BASE_PROMPT_DEFINITIONS,
  getKnowledgeBasePromptText,
  listKnowledgeBasePromptNames,
} from './knowledge-base-prompts.js';

/**
 * 仓库知识库编写指引（prompts 单一来源）。
 * T-RKB-P1~P4：注册表形态、要点覆盖、可用片段名、与扫描器常量防漂移守卫。
 */

const PROMPT_NAME = 'repo-knowledge-base-authoring';

describe('knowledge-base prompts', () => {
  it('T-RKB-P1 片段注册表：单片段 repo-knowledge-base-authoring 且含 description', () => {
    expect(REPO_KNOWLEDGE_BASE_PROMPT_DEFINITIONS).toEqual([
      {
        name: PROMPT_NAME,
        description: expect.stringContaining('仓库知识库编写指引'),
      },
    ]);
    expect(listKnowledgeBasePromptNames()).toEqual([PROMPT_NAME]);
  });

  it('T-RKB2-P1 文本覆盖全部要点（路径/结构/schema/文档组织/front matter/上限/只读）', () => {
    const text = getKnowledgeBasePromptText(PROMPT_NAME) ?? '';
    for (const anchor of [
      '.zag/knowledges/',
      'docs/knowledges/',
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

  it('T-RKB-P3 未知/空名称返回 null（供 prompts/get 转 INVALID_PARAMS）', () => {
    expect(getKnowledgeBasePromptText('')).toBeNull();
    expect(getKnowledgeBasePromptText('unknown-prompt')).toBeNull();
  });

  it('T-RKB2-P2 防漂移守卫：两个子目录与扫描上限字面量必须与 agent-gear 扫描器一致', () => {
    // 来源：packages/agent-controller/src/knowledge-bases.ts
    const text = getKnowledgeBasePromptText(PROMPT_NAME) ?? '';
    expect(text).toContain('.zag/knowledges');
    expect(text).toContain('docs/knowledges');
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
