import { describe, it, expect } from 'vitest';
import {
  GITHUB_PR_PROMPT,
  buildReviewPassedPrompt,
  buildReviewRejectedPrompt,
  normalizeReviewComment,
} from './pr-prompts.js';

describe('pr-prompts', () => {
  it('github-pr 指引覆盖关联时机/信息/效果/处置要求', () => {
    expect(GITHUB_PR_PROMPT).toContain('## GitHub Pull Request 联动');
    expect(GITHUB_PR_PROMPT).toContain('linkPullRequest');
    expect(GITHUB_PR_PROMPT).toContain('inline comment');
    expect(GITHUB_PR_PROMPT).toContain('只关联确实存在');
  });

  it('审核通过文案与 PRD A.2 一致', () => {
    expect(
      buildReviewPassedPrompt({
        comment: '可以合并',
        prUrl: 'https://github.com/a/b/pull/1',
        reviewer: 'alice',
        submittedAt: '2026-10-23T06:00:00Z',
      }),
    ).toBe(`Pull Request审核通过
可以合并
详情请查看pull request:https://github.com/a/b/pull/1
审核人：alice，审核时间：2026-10-23T06:00:00Z
处理要求：
1. 请通读评审意见（含 pull request 的 inline comment）并逐条落实：如评审意见包含修改要求，在本节点及后续工作中完成修改，并在 pull request 中回复处理结果。
2. 若评审意见说明无需修改，按原计划继续推进后续工作。`);
  });

  it('审核被拒文案与 PRD A.3 一致', () => {
    const text = buildReviewRejectedPrompt({
      comment: '请修改',
      prUrl: 'https://github.com/a/b/pull/1',
      reviewer: 'bob',
      submittedAt: '2026-10-23T06:00:00Z',
    });
    expect(text).toContain('Pull Request审核被拒绝');
    expect(text).toContain('注意检查pr的inline comment');
    expect(text).toContain('审核人：bob');
    expect(text).toContain('返工要求：');
  });

  it('缺省审核人/时间与超长评论截断', () => {
    const text = buildReviewPassedPrompt({ comment: 'x'.repeat(9000) });
    expect(text).toContain('审核人：未知');
    expect(text).toContain('……（已截断）');
    expect(normalizeReviewComment('  hi  ')).toBe('hi');
  });
});
