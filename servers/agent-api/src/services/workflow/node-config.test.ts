import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../models/configured-workflow.js', () => ({
  ConfiguredWorkflow: {
    findById: vi.fn(),
  },
}));

import { ConfiguredWorkflow } from '../../models/configured-workflow.js';
import {
  DEFAULT_REWORK_SESSION_BEHAVIOR,
  DEFAULT_RESUME_SESSION_BEHAVIOR,
  loadNodeConfig,
  normalizeNodeSessionBehavior,
} from './node-config.js';
import type { WorkflowInstanceDoc, WorkflowNodeDoc } from './engine.js';

function leanQuery(result: unknown) {
  return { lean: vi.fn().mockResolvedValue(result) } as never;
}

function oid(id: string) {
  return { toString: () => id } as import('mongoose').Types.ObjectId;
}

function makeInstance(configuredWorkflowId = 'cfg-1'): WorkflowInstanceDoc {
  return {
    _id: oid('inst-1'),
    configuredWorkflowId: oid(configuredWorkflowId),
    nodes: [],
  } as unknown as WorkflowInstanceDoc;
}

function makeNode(overrides: Record<string, unknown> = {}): WorkflowNodeDoc {
  return {
    nodeId: 'n1',
    nodeKey: 'design',
    type: 'AI',
    name: '技术方案',
    stage: '设计',
    status: 'RUNNING',
    dependsOn: [],
    reworkCount: 0,
    ...overrides,
  } as unknown as WorkflowNodeDoc;
}

describe('normalizeNodeSessionBehavior', () => {
  it('T-NSB1: AI 节点全缺省 → ORIGINAL_SESSION / false / NEW_SESSION / false', () => {
    expect(normalizeNodeSessionBehavior({ type: 'AI' })).toEqual({
      reworkSessionBehavior: DEFAULT_REWORK_SESSION_BEHAVIOR,
      reworkCompactOriginalContext: false,
      resumeSessionBehavior: DEFAULT_RESUME_SESSION_BEHAVIOR,
      resumeCompactOriginalContext: false,
    });
    expect(DEFAULT_REWORK_SESSION_BEHAVIOR).toBe('ORIGINAL_SESSION');
    expect(DEFAULT_RESUME_SESSION_BEHAVIOR).toBe('NEW_SESSION');
  });

  it('T-NSB1b: AI 节点显式值原样保留', () => {
    expect(
      normalizeNodeSessionBehavior({
        type: 'AI',
        reworkSessionBehavior: 'NEW_SESSION',
        reworkCompactOriginalContext: false,
        resumeSessionBehavior: 'ORIGINAL_SESSION',
        resumeCompactOriginalContext: true,
      }),
    ).toEqual({
      reworkSessionBehavior: 'NEW_SESSION',
      reworkCompactOriginalContext: false,
      resumeSessionBehavior: 'ORIGINAL_SESSION',
      resumeCompactOriginalContext: true,
    });
  });

  it('T-NSB2: 新会话时 compact 强制归一 false；原始会话保留 true', () => {
    const newSession = normalizeNodeSessionBehavior({
      type: 'AI',
      reworkSessionBehavior: 'NEW_SESSION',
      reworkCompactOriginalContext: true,
      resumeSessionBehavior: 'NEW_SESSION',
      resumeCompactOriginalContext: true,
    });
    expect(newSession.reworkCompactOriginalContext).toBe(false);
    expect(newSession.resumeCompactOriginalContext).toBe(false);

    const original = normalizeNodeSessionBehavior({
      type: 'AI',
      reworkSessionBehavior: 'ORIGINAL_SESSION',
      reworkCompactOriginalContext: true,
      resumeSessionBehavior: 'ORIGINAL_SESSION',
      resumeCompactOriginalContext: true,
    });
    expect(original.reworkCompactOriginalContext).toBe(true);
    expect(original.resumeCompactOriginalContext).toBe(true);
  });

  it('T-NSB3: HUMAN/FLAG 四字段恒 null（无论输入）', () => {
    for (const type of ['HUMAN', 'FLAG']) {
      expect(
        normalizeNodeSessionBehavior({
          type,
          reworkSessionBehavior: 'NEW_SESSION',
          reworkCompactOriginalContext: true,
          resumeSessionBehavior: 'ORIGINAL_SESSION',
          resumeCompactOriginalContext: true,
        }),
      ).toEqual({
        reworkSessionBehavior: null,
        reworkCompactOriginalContext: null,
        resumeSessionBehavior: null,
        resumeCompactOriginalContext: null,
      });
    }
  });
});

describe('loadNodeConfig 会话行为归一', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-NSB4: 快照缺失字段按默认值归一', async () => {
    const node = makeNode({ prompts: ['实现'], requiresWorktree: false, agentConfig: null });
    const config = await loadNodeConfig(makeInstance(), node);
    expect(config.reworkSessionBehavior).toBe('ORIGINAL_SESSION');
    expect(config.reworkCompactOriginalContext).toBe(false);
    expect(config.resumeSessionBehavior).toBe('NEW_SESSION');
    expect(config.resumeCompactOriginalContext).toBe(false);
  });

  it('T-NSB4b: 快照显式值透传（新会话时 compact 强制 false）', async () => {
    const node = makeNode({
      prompts: ['实现'],
      requiresWorktree: false,
      agentConfig: null,
      reworkSessionBehavior: 'NEW_SESSION',
      reworkCompactOriginalContext: true,
      resumeSessionBehavior: 'ORIGINAL_SESSION',
      resumeCompactOriginalContext: true,
    });
    const config = await loadNodeConfig(makeInstance(), node);
    expect(config.reworkSessionBehavior).toBe('NEW_SESSION');
    expect(config.reworkCompactOriginalContext).toBe(false);
    expect(config.resumeSessionBehavior).toBe('ORIGINAL_SESSION');
    expect(config.resumeCompactOriginalContext).toBe(true);
  });

  it('T-NSB4c: 快照整体缺失时回查 configured 同口径归一', async () => {
    vi.mocked(ConfiguredWorkflow.findById).mockReturnValue(
      leanQuery({
        _id: 'cfg-1',
        nodes: [
          {
            nodeKey: 'design',
            type: 'AI',
            name: '技术方案',
            stage: '设计',
            dependsOn: [],
            requiresWorktree: false,
            agentConfig: null,
            reworkSessionBehavior: 'NEW_SESSION',
            reworkCompactOriginalContext: false,
            resumeSessionBehavior: 'ORIGINAL_SESSION',
            resumeCompactOriginalContext: true,
          },
        ],
      }),
    );
    const node = makeNode({ type: 'AI' });
    const config = await loadNodeConfig(makeInstance(), node);
    expect(config.reworkSessionBehavior).toBe('NEW_SESSION');
    expect(config.reworkCompactOriginalContext).toBe(false);
    expect(config.resumeSessionBehavior).toBe('ORIGINAL_SESSION');
    expect(config.resumeCompactOriginalContext).toBe(true);
  });

  it('T-NSB4d: 回查路径 HUMAN 节点四字段恒 null', async () => {
    vi.mocked(ConfiguredWorkflow.findById).mockReturnValue(
      leanQuery({
        _id: 'cfg-1',
        nodes: [
          {
            nodeKey: 'requirement',
            type: 'HUMAN',
            name: '需求',
            stage: '需求',
            dependsOn: [],
            requiresWorktree: false,
            agentConfig: null,
            reworkSessionBehavior: 'ORIGINAL_SESSION',
            reworkCompactOriginalContext: true,
            resumeSessionBehavior: 'ORIGINAL_SESSION',
            resumeCompactOriginalContext: true,
          },
        ],
      }),
    );
    const node = makeNode({ nodeKey: 'requirement', type: 'HUMAN' });
    const config = await loadNodeConfig(makeInstance(), node);
    expect(config.reworkSessionBehavior).toBeNull();
    expect(config.reworkCompactOriginalContext).toBeNull();
    expect(config.resumeSessionBehavior).toBeNull();
    expect(config.resumeCompactOriginalContext).toBeNull();
  });
});
