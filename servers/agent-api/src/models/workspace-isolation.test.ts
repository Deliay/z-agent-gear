import { describe, it, expect } from 'vitest';
import { Session } from './session.js';
import { Controller } from './controller.js';
import { ControllerKey } from './controller-key.js';
import { CloudHost } from './cloud-host.js';
import { ConfiguredWorkflow } from './configured-workflow.js';
import { WorkflowInstance } from './workflow-instance.js';
import { WorkflowTemplate } from './workflow-template.js';
import { GitHubAccount } from './github-account.js';
import { UserCommitSetting } from './user-commit-setting.js';
import { Provider } from './provider.js';
import { Model } from './model.js';
import { WORKSPACE_ID_COLLECTIONS } from '../migrations/015-team-workspaces.js';

/**
 * T-WS 互校矩阵（对照一期 T-ISO 模式）：
 * 迁移 015 的集合清单与真实 Mongoose 模型集合名逐一相等；
 * 工作流域（workflow* + cloudhosts）使用 `resourceWorkspaceId`（F1 + 计划期裁决），
 * 其余集合使用 `workspaceId`。
 */
describe('workspace-isolation 互校（T-WS）', () => {
  const models = [
    Session,
    Controller,
    ControllerKey,
    CloudHost,
    ConfiguredWorkflow,
    WorkflowInstance,
    WorkflowTemplate,
    GitHubAccount,
    UserCommitSetting,
    Provider,
    Model,
  ];

  it('迁移清单覆盖 11 个资源集合，且集合名与模型一致', () => {
    const modelCollections = models.map((model) => model.collection.name).sort();
    const migrationCollections = WORKSPACE_ID_COLLECTIONS.map((entry) => entry.collection).sort();
    // providers/models 由复制步骤单独处理（清单中为 9 个回填集合）
    expect(migrationCollections).toEqual(
      modelCollections.filter((name) => name !== 'providers' && name !== 'models'),
    );
    expect(migrationCollections).toHaveLength(9);
  });

  it('工作流域字段名为 resourceWorkspaceId，其余为 workspaceId', () => {
    const fieldOf = new Map(WORKSPACE_ID_COLLECTIONS.map((entry) => [entry.collection, entry.field]));
    expect(fieldOf.get('cloudhosts')).toBe('resourceWorkspaceId');
    expect(fieldOf.get('configuredworkflows')).toBe('resourceWorkspaceId');
    expect(fieldOf.get('workflowinstances')).toBe('resourceWorkspaceId');
    expect(fieldOf.get('workflowtemplates')).toBe('resourceWorkspaceId');
    expect(fieldOf.get('sessions')).toBe('workspaceId');
    expect(fieldOf.get('githubaccounts')).toBe('workspaceId');
    expect(fieldOf.get('user_commit_settings')).toBe('workspaceId');
  });

  it('工作流域命名冲突零残留：workspaceId 保留项目工作区语义', () => {
    expect(WorkflowInstance.schema.path('workspaceId')?.options.ref).toBe('ControllerWorkspace');
    expect(WorkflowInstance.schema.path('resourceWorkspaceId')?.options.ref).toBe('Workspace');
    expect(CloudHost.schema.path('workspaceId')?.options.ref).toBe('ControllerWorkspace');
    expect(CloudHost.schema.path('resourceWorkspaceId')?.options.ref).toBe('Workspace');
  });

  it('三集合不挂作用域插件且具有唯一索引声明', () => {
    const indexes = (model: typeof Provider) => model.schema.indexes();
    expect(indexes(Provider as never)).toBeTruthy();
    // 迁移清单不含 tenantmembers/workspaces/workspacemembers
    const names = WORKSPACE_ID_COLLECTIONS.map((entry) => entry.collection);
    expect(names).not.toContain('tenantmembers');
    expect(names).not.toContain('workspaces');
    expect(names).not.toContain('workspacemembers');
  });
});
