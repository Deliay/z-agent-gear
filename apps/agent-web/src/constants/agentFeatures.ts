// FeatureId 唯一事实源：直接引用 agent-controller 的能力矩阵模块，禁止在前端手抄 20 项清单。
// 该模块为纯常量/纯函数（无 socket/fs 依赖），可安全被打包器内联。
import { FEATURE_IDS } from '../../../../packages/agent-controller/src/acp/capabilities.js';

export const AGENT_FEATURE_ORDER: readonly string[] = FEATURE_IDS;
