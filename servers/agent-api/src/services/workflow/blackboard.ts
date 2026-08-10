/**
 * 工作流黑板服务（纯函数优先，便于单测）。
 *
 * - 产物 key：`{nodeId}-{nodeName}-产物-{title}`
 * - 打回记录 key：`打回-{nodeId}-{序号}`，value 为 JSON（reason/fromNodeId/at）
 * - removeKey 将 entry 挪入 blackboardTrash（垃圾桶）
 * - blackboardUpdatedAt 记录每个 key 的最后更新时间（供 BlackboardEntry.updatedAt 使用）
 */

/** 支持黑板操作的最小实例结构（Mongoose 文档或测试 mock 均可满足） */
export interface BlackboardInstance {
  blackboard: Map<string, string>;
  blackboardTrash: Map<string, string>;
  blackboardUpdatedAt: Map<string, Date>;
  save?: () => Promise<unknown>;
}

const ARTIFACT_MARKER = '-产物';
const REJECT_KEY_PREFIX = '打回-';

/** 构造产物 key：`{nodeId}-{nodeName}-产物-{title}` */
export function artifactKey(nodeId: string, nodeName: string, title: string): string {
  return `${nodeId}-${nodeName}${ARTIFACT_MARKER}-${title}`;
}

export function getValue(instance: BlackboardInstance, key: string): string | null {
  return instance.blackboard.get(key) ?? null;
}

export async function setValue(instance: BlackboardInstance, key: string, value: string): Promise<void> {
  instance.blackboard.set(key, value);
  instance.blackboardUpdatedAt.set(key, new Date());
  await instance.save?.();
}

/** 移除 key：entry 从黑板挪入垃圾桶，并更新时间 */
export async function removeKey(instance: BlackboardInstance, key: string): Promise<void> {
  if (!instance.blackboard.has(key)) {
    throw new Error(`黑板中不存在 key「${key}」`);
  }
  const value = instance.blackboard.get(key)!;
  instance.blackboard.delete(key);
  instance.blackboardTrash.set(key, value);
  instance.blackboardUpdatedAt.set(key, new Date());
  await instance.save?.();
}

/** 当前黑板 keys（不含垃圾桶） */
export function listKeys(instance: BlackboardInstance): string[] {
  return [...instance.blackboard.keys()];
}

/** 产物 key 前缀匹配：`{nodeId}-{nodeName}-产物`，仅返回当前黑板中该节点的产物 keys */
export function getArtifactKeys(instance: BlackboardInstance, nodeId: string, nodeName: string): string[] {
  const prefix = `${nodeId}-${nodeName}${ARTIFACT_MARKER}`;
  return [...instance.blackboard.keys()].filter((key) => key.startsWith(prefix));
}

/**
 * 追加打回记录：key = `打回-{nodeId}-{序号}`（序号递增，含垃圾桶中的历史序号），
 * value 为 JSON { reason, fromNodeId, at }。
 * @returns 写入的 key
 */
export async function addRejectRecord(
  instance: BlackboardInstance,
  nodeId: string,
  reason: string,
  fromNodeId?: string | null,
): Promise<string> {
  const prefix = `${REJECT_KEY_PREFIX}${nodeId}-`;
  let maxSeq = 0;
  for (const source of [instance.blackboard, instance.blackboardTrash]) {
    for (const key of source.keys()) {
      if (!key.startsWith(prefix)) continue;
      const seq = Number(key.slice(prefix.length));
      if (Number.isInteger(seq) && seq > maxSeq) maxSeq = seq;
    }
  }
  const key = `${prefix}${maxSeq + 1}`;
  const value = JSON.stringify({
    reason,
    fromNodeId: fromNodeId ?? null,
    at: new Date().toISOString(),
  });
  instance.blackboard.set(key, value);
  instance.blackboardUpdatedAt.set(key, new Date());
  await instance.save?.();
  return key;
}
