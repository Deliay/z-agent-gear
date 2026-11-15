import { describe, it, expect } from 'vitest';
import {
  ADMIN_PROMPT_DEFINITIONS,
  listAdminPromptNames,
  getAdminPromptText,
} from './admin-prompts.js';

describe('admin-prompts 注册表', () => {
  it('T-AP1: 注册表恰 2 项且声明序稳定（workflow-schema 在前）', () => {
    expect(ADMIN_PROMPT_DEFINITIONS).toHaveLength(2);
    expect(ADMIN_PROMPT_DEFINITIONS.map((item) => item.name)).toEqual([
      'workflow-schema',
      'workflow-project-persistence',
    ]);
  });

  it('T-AP1: 每项 name 为 kebab-case 非空、description 非空', () => {
    for (const item of ADMIN_PROMPT_DEFINITIONS) {
      expect(item.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(item.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('T-AP2: listAdminPromptNames 与注册表同序一致', () => {
    expect(listAdminPromptNames()).toEqual(ADMIN_PROMPT_DEFINITIONS.map((item) => item.name));
  });

  it('T-AP3: getAdminPromptText 命中返回非空且互不相同；未知/空串返回 null', () => {
    const schema = getAdminPromptText('workflow-schema');
    const persistence = getAdminPromptText('workflow-project-persistence');
    expect(schema).toBeTruthy();
    expect(persistence).toBeTruthy();
    expect(schema).not.toBe(persistence);
    expect(getAdminPromptText('unknown')).toBeNull();
    expect(getAdminPromptText('')).toBeNull();
  });

  it('T-AP4: workflow-schema 文本与 validateTemplateGraph 口径对齐（防漂移守卫）', () => {
    const text = getAdminPromptText('workflow-schema')!;
    // 首节点唯一且为 HUMAN（template.ts#validateTemplateGraph 第 5 条）
    expect(text).toContain('首节点');
    expect(text).toContain('HUMAN');
    expect(text).toContain('人类节点');
    // AI 节点 prompts 至少 1 条非空
    expect(text).toContain('至少需要 1 条');
    // nodeKey 唯一
    expect(text).toContain('nodeKey');
    expect(text).toContain('唯一');
    // DAG 无环
    expect(text).toMatch(/循环依赖|无环/);
    // 仅 HUMAN 可联动上游 PR
    expect(text).toContain('仅人类节点');
    expect(text).toContain('联动上游 Pull Request');
    // agentConfig 必填项
    expect(text).toContain('acpServerType');
    expect(text).toContain('initNewWorktree');
    // F7/D10：模板层无名称长度归一，不得宣称「模板名称 1~64」
    expect(text).not.toMatch(/模板名称[^\n]{0,10}1~64/);
  });

  it('T-AP5: workflow-project-persistence 文本与 agent-gear 扫描约束对齐（防漂移守卫）', () => {
    const text = getAdminPromptText('workflow-project-persistence')!;
    // 常量来源：packages/agent-controller/src/workflow-templates.ts
    expect(text).toContain('.zag/workflow/templates');
    expect(text).toContain('20');
    expect(text).toContain('128KiB');
    expect(text).toContain('1MiB');
    expect(text).toContain('不递归');
    expect(text).toContain('快照');
    expect(text).toContain('2.18.0');
  });
});
