/**
 * 工作流 GitHub Pull Request 联动提示词常量（文案对齐 PRD 附录 A）。
 *
 * 实现层仅补充工具名等实现细节，不改变产品语义。
 */

/** 追加提示词 key：PR 工具使用指引 */
export const GITHUB_PR_PROMPT_KEY = 'github-pr';
/** 追加提示词 key：PR 审核结论 */
export const GITHUB_PR_REVIEW_PROMPT_KEY = 'github-pr-review';
/** 系统管理键（禁止人工写入/删除） */
export const SYSTEM_PROMPT_KEYS = [GITHUB_PR_PROMPT_KEY, GITHUB_PR_REVIEW_PROMPT_KEY] as const;

export const GITHUB_PR_PROMPT = `## GitHub Pull Request 联动

本工作流已启用 Pull Request 联动（监听 Pull Request）。当你在本节点产出或定位到 GitHub Pull Request 时，请使用工作流提供的 Pull Request 关联工具（agent-workflow-tools.linkPullRequest），把本次 Pull Request 关联到当前工作流与当前节点：

1. 关联时机：创建（或确认复用）Pull Request 后立即关联；关联前先确认当前节点信息（工作流实例 ID 与节点 ID）。
2. 关联信息：调用 linkPullRequest 时只需传 pullRequestId（\`owner/repo#编号\` 或完整 Pull Request 地址）；工作流实例 ID 与节点 ID 由当前会话自动确定。
3. 关联效果：该 Pull Request 在 GitHub 上的审核结果会驱动工作流中联动的人类节点——审核通过则自动完成该人类节点，并把评审意见传递给下游；审核被拒绝则自动打回该人类节点，返工原因中附带评审意见并提醒检查 inline comment。
4. 同一节点重复关联视为更新（以最后一次为准）；若更换了新的 Pull Request，请用新的 Pull Request 重新关联。
5. 收到「Pull Request审核通过」或「Pull Request审核被拒绝」的追加提示词后：逐条落实评审意见（务必查看 pull request 的 inline comment），修改对应产物，并在 pull request 中逐条回复处理结果，便于审核人复审。
6. 只关联确实存在、且属于本次工作的 Pull Request；不要关联无关或不存在的 Pull Request。`;

const COMMENT_MAX_LENGTH = 8000;
const TRUNCATED_SUFFIX = '……（已截断）';

export interface ReviewPromptInput {
  comment?: string | null;
  prUrl?: string | null;
  reviewer?: string | null;
  submittedAt?: string | null;
}

/** 评审意见按纯文本处理：trim + 超长截断 */
export function normalizeReviewComment(comment?: string | null): string {
  const text = (comment ?? '').trim();
  if (text.length <= COMMENT_MAX_LENGTH) return text;
  return text.slice(0, COMMENT_MAX_LENGTH) + TRUNCATED_SUFFIX;
}

function normalizeReviewMeta(input: ReviewPromptInput): {
  comment: string;
  prUrl: string;
  reviewer: string;
  submittedAt: string;
} {
  return {
    comment: normalizeReviewComment(input.comment),
    prUrl: (input.prUrl ?? '').trim(),
    reviewer: (input.reviewer ?? '').trim() || '未知',
    submittedAt: (input.submittedAt ?? '').trim() || new Date().toISOString(),
  };
}

/** 审核通过：写入 github-pr-review，向下游传递 */
export function buildReviewPassedPrompt(input: ReviewPromptInput): string {
  const meta = normalizeReviewMeta(input);
  return `Pull Request审核通过
${meta.comment}
详情请查看pull request:${meta.prUrl}
审核人：${meta.reviewer}，审核时间：${meta.submittedAt}
处理要求：
1. 请通读评审意见（含 pull request 的 inline comment）并逐条落实：如评审意见包含修改要求，在本节点及后续工作中完成修改，并在 pull request 中回复处理结果。
2. 若评审意见说明无需修改，按原计划继续推进后续工作。`;
}

/** 审核被拒绝：作为 rejectNode 打回内容，驱动上游返工 */
export function buildReviewRejectedPrompt(input: ReviewPromptInput): string {
  const meta = normalizeReviewMeta(input);
  return `Pull Request审核被拒绝
${meta.comment}
详情请查看pull request:${meta.prUrl}
注意检查pr的inline comment
审核人：${meta.reviewer}，审核时间：${meta.submittedAt}
返工要求：
1. 逐条处理评审意见与 pull request 的 inline comment，修改对应产物；
2. 修改完成后更新原 pull request（追加提交）；如需改用新的 pull request，请重新关联到当前工作流与节点；
3. 在 pull request 中逐条回复处理结果，便于审核人复审。`;
}
