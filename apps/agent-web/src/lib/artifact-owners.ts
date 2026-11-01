import type { BlackboardEntryData, WorkflowNodeData } from '@/graphql/workflow'

/**
 * 黑板产物 key 约定（对齐 agent-api blackboard.ts artifactKey）：
 * `{nodeId}-{nodeName}-产物-{title}`。
 * 列表视图与图表视图的产物归属必须同源，避免两处口径漂移。
 */
export const ARTIFACT_KEY_MARKER = '-产物-'

type ArtifactOwnerNode = Pick<WorkflowNodeData, 'id' | 'name'>

export function artifactPrefix(node: ArtifactOwnerNode): string {
  return `${node.id}-${node.name}${ARTIFACT_KEY_MARKER}`
}

/** 命中该条目归属的节点；无法解析时返回 null（调用方回退实例级展示） */
export function findArtifactOwner<T extends ArtifactOwnerNode>(
  nodes: T[],
  key: string,
): T | null {
  return nodes.find((node) => key.startsWith(artifactPrefix(node))) ?? null
}

/** 从黑板聚合某节点产物（与后端 getArtifactKeys 前缀匹配同构） */
export function artifactsOf(
  node: ArtifactOwnerNode,
  blackboard: BlackboardEntryData[],
): { title: string; value: string }[] {
  const prefix = artifactPrefix(node)
  return blackboard
    .filter((entry) => entry.key.startsWith(prefix))
    .map((entry) => ({ title: entry.key.slice(prefix.length), value: entry.value }))
}

/** 从产物 key 截取标题（无前缀时回退原 key） */
export function artifactTitle(node: ArtifactOwnerNode, key: string): string {
  const prefix = artifactPrefix(node)
  return key.startsWith(prefix) ? key.slice(prefix.length) || key : key
}
