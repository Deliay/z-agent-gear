/** 工作流系统提示（注入到每个 AI 节点会话提示词首位） */
export const WORKFLOW_SYSTEM_PROMPT =
  '你身处一个工作流系统，你需要合理使用工具拿到你需要的信息，然后在完成工作时也需要使用工具对当前节点进行操作。';

/** 会话兜底提示词（面向 LLM：会话结束但节点未转移时 resume 并发送） */
export const FALLBACK_PROMPT =
  '你身处一个自动化工作流系统，当前会话绑定到一个工作流节点。系统检测到会话已结束，但节点状态仍未推进。' +
  '你必须使用提供的工作流 MCP 工具对当前节点执行操作：工作已完成时调用 completeCurrentNode（产物通过黑板工具写入）；' +
  '需要上游返工时调用 rejectCurrentNode 并给出明确原因。不要只输出文本而不调用工具。';

/** 空闲停滞提醒：turn 结束（如权限审批超时）但节点未推进时使用（会话仍存活，无需 resume） */
export const IDLE_NUDGE_PROMPT =
  '你身处一个自动化工作流系统，当前会话绑定到一个工作流节点。系统检测到本轮执行已停止（可能因权限审批超时），但节点状态仍未推进。' +
  '你必须继续执行任务，并使用提供的工作流 MCP 工具对当前节点执行操作：工作已完成时调用 completeCurrentNode（产物通过黑板工具写入）；' +
  '需要上游返工时调用 rejectCurrentNode 并给出明确原因；确实无法继续时调用 failCurrentNode 说明原因。不要只输出文本而不调用工具。';

/**
 * 打回后复工（原始会话）继续提示词：上游返工完成后，在本节点原始会话中继续。
 * 明确的产物重取口径 + completeCurrentNode 唯一推进指引。
 */
export const RESUME_CONTINUE_PROMPT =
  '你打回的上游节点已完成返工，上游产物已更新并重新写入黑板。请先通过工作流工具重新获取上游产物' +
  '（getBlackboardValue / getNodeArtifactKeys），确认与最新产物一致后继续本节点工作；工作完成后调用 completeCurrentNode 推进节点。';

/**
 * 返工说明段（新会话返工路径追加在首条消息尾部）：
 * - 说明本节点处于返工状态与打回原因；
 * - 唯一推进指引是 `completeCurrentRework`（REWORK 状态下 completeCurrentNode 会被引擎拒绝）。
 */
export function buildReworkSection(reason?: string | null): string {
  return [
    '## 返工说明',
    '',
    '你的工作流节点产出被下游节点打回，当前处于返工状态。',
    `打回原因：${reason ?? '（未提供）'}`,
    '请根据打回原因修订产出，通过工作流工具重新写入产物后调用 completeCurrentRework 完成返工。',
    '若返工中发现问题根源在更上游（本节点无法独立修正），可调用 rejectCurrentNode 将本节点打回并触发上游返工。',
  ].join('\n');
}

