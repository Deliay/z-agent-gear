import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config/index.js', () => ({
  config: { frontendUrl: 'https://app.example.com' },
}));

import {
  buildIssueNodeInput,
  buildIssueTriggerComment,
  buildTriggerInstanceName,
  buildWorkflowUrl,
} from './issues-prompts.js';

describe('issues-prompts', () => {
  it('工作流地址与回评文案', () => {
    expect(buildWorkflowUrl('inst-1')).toBe('https://app.example.com/workflows/inst-1');
    expect(buildIssueTriggerComment('inst-1')).toBe(
      '工作流已经触发创建，Issue 的后续修改将不会影响工作流的执行。\n工作流地址：https://app.example.com/workflows/inst-1 ，点击查看。',
    );
  });

  it('首人类节点输入含 Issue 内容与缺省值', () => {
    expect(
      buildIssueNodeInput({
        repoFullName: 'Deliay/z-agent-gear',
        issueNumber: 42,
        issueTitle: '标题',
        issueUrl: 'https://github.com/Deliay/z-agent-gear/issues/42',
        issueAuthor: null,
        issueBody: '正文',
      }),
    ).toBe(
      [
        '来源：GitHub Issue Deliay/z-agent-gear#42',
        '标题：标题',
        '链接：https://github.com/Deliay/z-agent-gear/issues/42',
        '提交人：未知',
        '',
        '正文',
      ].join('\n'),
    );
  });

  it('实例名截断到 64 字', () => {
    const name = buildTriggerInstanceName('a/b', 1, 'x'.repeat(100));
    expect(name.length).toBe(64);
    expect(name.startsWith('a/b#1 ')).toBe(true);
  });
});
