import { WorkflowTemplate } from '../../models/workflow-template.js';
import { logger as rootLogger } from '../../observability/logger.js';
import { validateTemplateGraph, type WorkflowTemplateNodeInput } from './template.js';

export const BUILTIN_TEMPLATE_NAME = '开发工作流';

const STAGE_PLAN = '方案阶段';
const STAGE_IMPL = '实现阶段';

/**
 * 内置默认「开发工作流」模板节点（PRD §3.4，10 节点）。
 * 首元素系统提示由提示词组装时注入，存储不含；HUMAN/FLAG 节点不允许 prompts/artifactTitles。
 */
export const BUILTIN_TEMPLATE_NODES: WorkflowTemplateNodeInput[] = [
  {
    nodeKey: 'requirement',
    type: 'HUMAN',
    name: '产品需求',
    description: '输入初版产品需求（文本），作为整个工作流的起点',
    stage: STAGE_PLAN,
    dependsOn: [],
    requiresWorktree: false,
  },
  {
    nodeKey: 'product-design',
    type: 'AI',
    name: '产出产品需求技术方案',
    description: '根据初版需求产出产品文档与技术提案，并创建需求总分支与需求总 PR',
    stage: STAGE_PLAN,
    prompts: [
      '阅读上游产物中的初版产品需求（使用 getParentNodeIds 与 getNodeArtifactKeys / getBlackboardValue 获取），参照项目中所有 AGENTS.md（没有则参考 docs 目录约定）撰写产品文档与技术提案，内容需完整、可评审。',
      '切出需求总分支并提交产品文档与技术提案；如 gh 命令可用且存在该仓库，则创建一个需求总 PR。',
      '使用工作流工具将产物写入黑板：「产品需求和技术方案」（分支及两个文件路径及简介）、「需求总分支」（分支名）、「需求总PR」（PR 地址，未创建则说明原因）；产物 title 必须与上述完全一致，然后调用 completeCurrentNode 完成本节点。',
    ],
    artifactTitles: ['产品需求和技术方案', '需求总分支', '需求总PR'],
    dependsOn: ['requirement'],
    requiresWorktree: true,
  },
  {
    nodeKey: 'review-design',
    type: 'HUMAN',
    name: '审核产品文档与技术方案',
    description: '人工审核产品文档与技术提案；打回时需填写打回理由',
    stage: STAGE_PLAN,
    dependsOn: ['product-design'],
    requiresWorktree: false,
  },
  {
    nodeKey: 'impl-plan',
    type: 'AI',
    name: '产出实现方案',
    description: '基于产品文档与技术提案产出实现 plan，提交到需求总分支',
    stage: STAGE_PLAN,
    prompts: [
      '阅读上游产物（产品需求和技术方案、需求总分支等），参照项目中所有 AGENTS.md 产出实现方案（实现 plan），切到需求总分支提交实现计划文档。',
      '若你发现上游的产品需求或技术方案存在问题，不要勉强规划：调用 rejectCurrentNode 打回并填写明确原因（可用 targetNodeId 指定问题所在的直接上游节点）。',
      '使用工作流工具将产物「实现方案」（路径及简介）写入黑板，然后调用 completeCurrentNode 完成本节点。',
    ],
    artifactTitles: ['实现方案'],
    dependsOn: ['review-design'],
    requiresWorktree: true,
  },
  {
    nodeKey: 'review-impl-plan',
    type: 'HUMAN',
    name: '审核实现文档',
    description: '人工审核实现方案；打回时需填写打回理由',
    stage: STAGE_PLAN,
    dependsOn: ['impl-plan'],
    requiresWorktree: false,
  },
  {
    nodeKey: 'code-impl',
    type: 'AI',
    name: '代码实现',
    description: '按实现方案完成代码开发并创建实现 PR（目标分支为需求总分支）',
    stage: STAGE_IMPL,
    prompts: [
      '基于上游产物中的需求总分支切出新的实现分支，严格按照实现方案 / 技术提案 / 产品文档进行开发，遵循项目中所有 AGENTS.md 的约定。',
      '完成开发并自测通过后提交代码；如 gh 命令可用且存在该仓库，则创建目标分支为需求总分支的 PR。',
      '使用工作流工具将产物「实现分支」（分支名）、「实现PR」（PR 地址，未创建则说明原因）写入黑板，然后调用 completeCurrentNode 完成本节点。',
    ],
    artifactTitles: ['实现分支', '实现PR'],
    dependsOn: ['review-impl-plan'],
    requiresWorktree: true,
  },
  {
    nodeKey: 'ai-review',
    type: 'AI',
    name: 'AI审核代码',
    description: '审核代码实现，发现问题即打回并填写 review 意见',
    stage: STAGE_IMPL,
    prompts: [
      '审核上游的代码实现：根据上游产物检出实现分支，阅读全部变更，结合产品文档、技术提案与实现方案验证正确性、完整性与代码质量。',
      '发现任何问题时调用 rejectCurrentNode 打回并填写明确的 review 意见；若本节点被下游打回，先消化打回内容，问题源自上游时继续向上打回（用 targetNodeId 指定直接上游节点）。',
      '审核通过后调用 completeCurrentNode 完成本节点（可将审核结论作为产物写入黑板）。',
    ],
    dependsOn: ['code-impl'],
    requiresWorktree: true,
  },
  {
    nodeKey: 'human-review',
    type: 'HUMAN',
    name: '人类审核代码与验收',
    description: '人工审核代码并验收；打回时需填写打回理由',
    stage: STAGE_IMPL,
    dependsOn: ['ai-review'],
    requiresWorktree: false,
  },
  {
    nodeKey: 'merge',
    type: 'AI',
    name: '代码合并',
    description: '合并实现 PR 与需求总 PR',
    stage: STAGE_IMPL,
    prompts: [
      '根据上游产物合并实现 PR（目标分支为需求总分支），随后合并需求总 PR。',
      '合并冲突时先尝试自行解决；无法解决时调用 rejectCurrentNode 打回并说明原因。',
      '合并完成后调用 completeCurrentNode 完成本节点（可将合并结果作为产物写入黑板）。',
    ],
    dependsOn: ['human-review'],
    requiresWorktree: true,
  },
  {
    nodeKey: 'done',
    type: 'FLAG',
    name: '完成开发',
    description: '开发流程终结点',
    stage: STAGE_IMPL,
    dependsOn: ['merge'],
    requiresWorktree: false,
  },
];

/** 启动时幂等 upsert 内置模板：已存在则跳过（version 不重复自增） */
export async function seedBuiltinWorkflowTemplate(): Promise<void> {
  const existing = await WorkflowTemplate.findOne({ isBuiltin: true, name: BUILTIN_TEMPLATE_NAME }).lean();
  if (existing) return;
  // 种子数据自身必须通过图校验（防止模板定义腐化）
  validateTemplateGraph(BUILTIN_TEMPLATE_NODES);
  await WorkflowTemplate.create({
    userId: null,
    name: BUILTIN_TEMPLATE_NAME,
    description: '平台内置默认开发工作流：产品需求 → 方案 → 审核 → 实现 → 审核验收 → 合并 → 完成',
    version: 1,
    isBuiltin: true,
    nodes: BUILTIN_TEMPLATE_NODES,
  });
  rootLogger.info(
    { component: 'workflow-seed', template: BUILTIN_TEMPLATE_NAME },
    'builtin workflow template created',
  );
}
