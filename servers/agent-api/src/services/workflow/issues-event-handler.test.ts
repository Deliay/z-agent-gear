import { describe, it, expect } from 'vitest';
import { mapConfiguredNodes, resolveFirstHumanNode } from './issues-event-handler.js';

describe('resolveFirstHumanNode', () => {
  it('按拓扑序取第一个 HUMAN（跳过前置 AI）', () => {
    expect(
      resolveFirstHumanNode([
        { nodeId: 'ai', type: 'AI', dependsOn: [] },
        { nodeId: 'human', type: 'HUMAN', dependsOn: ['ai'] },
        { nodeId: 'human2', type: 'HUMAN', dependsOn: ['human'] },
      ]),
    ).toBe('human');
  });

  it('同层按 sortOrder 升序（再按快照顺序稳定）', () => {
    expect(
      resolveFirstHumanNode([
        { nodeId: 'ai', type: 'AI', dependsOn: [], sortOrder: 0 },
        { nodeId: 'human-late', type: 'HUMAN', dependsOn: [], sortOrder: 5 },
        { nodeId: 'human-early', type: 'HUMAN', dependsOn: [], sortOrder: 1 },
      ]),
    ).toBe('human-early');
  });

  it('无 HUMAN 返回 null；环状图不阻塞', () => {
    expect(resolveFirstHumanNode([{ nodeId: 'ai', type: 'AI', dependsOn: [] }])).toBeNull();
    expect(
      resolveFirstHumanNode([
        { nodeId: 'a', type: 'AI', dependsOn: ['b'] },
        { nodeId: 'b', type: 'AI', dependsOn: ['a'] },
      ]),
    ).toBeNull();
  });
});

describe('mapConfiguredNodes', () => {
  it('保留 nodeKey 依赖并补齐默认值', () => {
    const mapped = mapConfiguredNodes([
      {
        nodeKey: 'human',
        type: 'HUMAN',
        name: '确认',
        stage: '实现阶段',
        dependsOn: ['ai'],
        linkUpstreamPullRequest: true,
      },
    ]);
    expect(mapped[0]).toMatchObject({
      nodeKey: 'human',
      type: 'HUMAN',
      name: '确认',
      stage: '实现阶段',
      dependsOn: ['ai'],
      requiresWorktree: false,
      linkUpstreamPullRequest: true,
      agentConfig: null,
    });
  });
});
