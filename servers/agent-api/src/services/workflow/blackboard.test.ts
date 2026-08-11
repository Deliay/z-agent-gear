import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getValue,
  setValue,
  removeKey,
  listKeys,
  getArtifactKeys,
  addRejectRecord,
  type BlackboardInstance,
} from './blackboard.js';

function makeInstance(): BlackboardInstance & { save: ReturnType<typeof vi.fn> } {
  return {
    blackboard: new Map<string, string>(),
    blackboardTrash: new Map<string, string>(),
    blackboardUpdatedAt: new Map<string, Date>(),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

describe('BlackboardService', () => {
  let instance: ReturnType<typeof makeInstance>;

  beforeEach(() => {
    instance = makeInstance();
  });

  it('B1: set/get value 读写一致，并更新 updatedAt', async () => {
    await setValue(instance, 'n1-需求-产物-需求文档', '需求内容');

    expect(getValue(instance, 'n1-需求-产物-需求文档')).toBe('需求内容');
    expect(instance.blackboardUpdatedAt.get('n1-需求-产物-需求文档')).toBeInstanceOf(Date);
    expect(instance.save).toHaveBeenCalled();

    // 覆盖写：值与 updatedAt 都更新
    const firstUpdatedAt = instance.blackboardUpdatedAt.get('n1-需求-产物-需求文档')!;
    await new Promise((r) => setTimeout(r, 2));
    await setValue(instance, 'n1-需求-产物-需求文档', '需求内容v2');
    expect(getValue(instance, 'n1-需求-产物-需求文档')).toBe('需求内容v2');
    expect(instance.blackboardUpdatedAt.get('n1-需求-产物-需求文档')!.getTime()).toBeGreaterThanOrEqual(
      firstUpdatedAt.getTime(),
    );
  });

  it('B1b: 读取不存在的 key 返回 null', () => {
    expect(getValue(instance, '不存在')).toBeNull();
  });

  it('B2: remove key 后从黑板消失、出现在垃圾桶，并记录时间', async () => {
    await setValue(instance, 'n1-需求-产物-需求文档', '需求内容');

    await removeKey(instance, 'n1-需求-产物-需求文档');

    expect(getValue(instance, 'n1-需求-产物-需求文档')).toBeNull();
    expect(instance.blackboard.has('n1-需求-产物-需求文档')).toBe(false);
    expect(instance.blackboardTrash.get('n1-需求-产物-需求文档')).toBe('需求内容');
    expect(instance.blackboardUpdatedAt.get('n1-需求-产物-需求文档')).toBeInstanceOf(Date);
    expect(instance.save).toHaveBeenCalled();
  });

  it('B2b: remove 不存在的 key 拒绝', async () => {
    await expect(removeKey(instance, '不存在')).rejects.toThrow(/不存在/);
  });

  it('B3: 产物 key 前缀匹配 {nodeId}-{nodeName}-产物，仅返回该节点产物 keys', async () => {
    await setValue(instance, 'n1-技术方案-产物-方案文档', 'A');
    await setValue(instance, 'n1-技术方案-产物-评审记录', 'B');
    await setValue(instance, 'n2-代码实现-产物-代码', 'C'); // 其他节点
    await setValue(instance, 'n1-技术方案-其他', 'D'); // 同节点但非产物
    await setValue(instance, '打回-n1-1', '{}'); // 打回记录
    await removeKey(instance, 'n2-代码实现-产物-代码'); // 已入垃圾桶的不返回

    const keys = getArtifactKeys(instance, 'n1', '技术方案');
    expect(keys).toHaveLength(2);
    expect(keys).toContain('n1-技术方案-产物-方案文档');
    expect(keys).toContain('n1-技术方案-产物-评审记录');
  });

  it('B4: 打回记录 key 为 打回-{nodeId}-{序号}，序号递增，内容含 reason/来源/时间', async () => {
    const key1 = await addRejectRecord(instance, 'n2', '方案不完整', 'n3');
    const key2 = await addRejectRecord(instance, 'n2', '仍有问题', 'n3');
    const otherNodeKey = await addRejectRecord(instance, 'n9', '别的节点打回', 'n1');

    expect(key1).toBe('打回-n2-1');
    expect(key2).toBe('打回-n2-2');
    // 不同 nodeId 序号独立
    expect(otherNodeKey).toBe('打回-n9-1');

    const record = JSON.parse(getValue(instance, '打回-n2-1')!);
    expect(record.reason).toBe('方案不完整');
    expect(record.fromNodeId).toBe('n3');
    expect(new Date(record.at).getTime()).not.toBeNaN();
    expect(instance.blackboardUpdatedAt.get('打回-n2-2')).toBeInstanceOf(Date);
  });

  it('B4b: 打回记录被移除后序号继续递增（不复用垃圾桶中的序号）', async () => {
    await addRejectRecord(instance, 'n2', '第一次', 'n3');
    await removeKey(instance, '打回-n2-1');

    const key = await addRejectRecord(instance, 'n2', '第二次', 'n3');
    expect(key).toBe('打回-n2-2');
  });

  it('listKeys 返回当前黑板 keys（不含垃圾桶）', async () => {
    await setValue(instance, 'k1', 'v1');
    await setValue(instance, 'k2', 'v2');
    await removeKey(instance, 'k1');

    expect(listKeys(instance)).toEqual(['k2']);
  });
});
