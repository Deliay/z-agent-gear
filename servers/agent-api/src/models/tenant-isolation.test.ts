import { describe, it, expect, vi, afterEach } from 'vitest';
import { Session } from './session.js';
import { Controller } from './controller.js';
import { ControllerKey } from './controller-key.js';
import { ControllerWorkspace } from './controller-workspace.js';
import { Gateway } from './gateway.js';
import { McpServer } from './mcp-server.js';
import { McpSessionEndpoint } from './mcp-session-endpoint.js';
import { CloudHost } from './cloud-host.js';
import { CloudHostGithubBinding } from './cloud-host-github-binding.js';
import { CloudHostIssuesLinkage } from './cloud-host-issues-linkage.js';
import { CloudHostSetupOperation } from './cloud-host-setup-operation.js';
import { ConfiguredWorkflow } from './configured-workflow.js';
import { WorkflowInstance } from './workflow-instance.js';
import { WorkflowPrHandler } from './workflow-pr-handler.js';
import { WorkflowTemplate } from './workflow-template.js';
import { IssueWorkflowTrigger } from './issue-workflow-trigger.js';
import { TodoItem } from './todo-item.js';
import { UserCommitSetting } from './user-commit-setting.js';
import { GitHubAccount } from './github-account.js';
import { TENANT_ID_COLLECTIONS } from '../migrations/013-tenant-id-backfill.js';

const USER_ID = '507f1f77bcf86cd799439011';

/**
 * T-ISO 等价层级：19 个带 userId 的集合逐一验证
 * ① schema 同时声明 userId + tenantId；② 实际查询（countDocuments）经插件注入 tenantId=userId。
 * 这覆盖了 mock 掉 model 的 service 单测无法验证的「Mongoose 编译期注入」路径。
 *
 * **例外（成员级集合）**：`user_commit_settings` 的键是全局成员标识 `userId`、`tenantId` 仅留档，
 * 不挂作用域插件（ALS 注入会让「同一成员在不同工作区」读写互相不可见，见模型注释与
 * `commit-settings-service.real.test.ts`）；仅在 schema 维度参与本矩阵。
 */
const CASES = [
  ['Session', Session, 'sessions'],
  ['Controller', Controller, 'controllers'],
  ['ControllerKey', ControllerKey, 'controllerkeys'],
  ['ControllerWorkspace', ControllerWorkspace, 'controllerworkspaces'],
  ['Gateway', Gateway, 'gateways'],
  ['McpServer', McpServer, 'mcpservers'],
  ['McpSessionEndpoint', McpSessionEndpoint, 'mcpsessionendpoints'],
  ['CloudHost', CloudHost, 'cloudhosts'],
  ['CloudHostGithubBinding', CloudHostGithubBinding, 'cloud_host_github_bindings'],
  ['CloudHostIssuesLinkage', CloudHostIssuesLinkage, 'cloud_host_issues_linkages'],
  ['CloudHostSetupOperation', CloudHostSetupOperation, 'cloud_host_setup_operations'],
  ['ConfiguredWorkflow', ConfiguredWorkflow, 'configuredworkflows'],
  ['WorkflowInstance', WorkflowInstance, 'workflowinstances'],
  ['WorkflowPrHandler', WorkflowPrHandler, 'workflowprhandlers'],
  ['WorkflowTemplate', WorkflowTemplate, 'workflowtemplates'],
  ['IssueWorkflowTrigger', IssueWorkflowTrigger, 'issue_workflow_triggers'],
  ['TodoItem', TodoItem, 'todoitems'],
  ['UserCommitSetting', UserCommitSetting, 'user_commit_settings'],
  ['GitHubAccount', GitHubAccount, 'githubaccounts'],
] as const;

const TENANT_SCOPED_CASES = CASES.filter(([, model]) => model.modelName !== 'UserCommitSetting');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('19 collections tenantId isolation (T-ISO)', () => {
  it('has exactly the 19 planned collections', () => {
    expect(CASES).toHaveLength(19);
    expect(CASES.map(([, , collection]) => collection)).toEqual([
      'sessions',
      'controllers',
      'controllerkeys',
      'controllerworkspaces',
      'gateways',
      'mcpservers',
      'mcpsessionendpoints',
      'cloudhosts',
      'cloud_host_github_bindings',
      'cloud_host_issues_linkages',
      'cloud_host_setup_operations',
      'configuredworkflows',
      'workflowinstances',
      'workflowprhandlers',
      'workflowtemplates',
      'issue_workflow_triggers',
      'todoitems',
      'user_commit_settings',
      'githubaccounts',
    ]);
  });

  it('TENANT_ID_COLLECTIONS 的集合名与 19 个模型 model.collection.name 逐一相等', () => {
    const actualByModel = new Map(CASES.map(([, model]) => [model.modelName, model.collection.name]));
    expect(TENANT_ID_COLLECTIONS).toHaveLength(19);
    for (const target of TENANT_ID_COLLECTIONS) {
      expect(actualByModel.get(target.model)).toBe(target.collection);
    }
    // 反向覆盖：19 个模型逐一被常量覆盖，且无重复 model / 无遗漏
    const constantModels = TENANT_ID_COLLECTIONS.map((target) => target.model);
    expect(new Set(constantModels).size).toBe(19);
    expect(new Set(constantModels)).toEqual(new Set(CASES.map(([, model]) => model.modelName)));
  });

  it.each(TENANT_SCOPED_CASES)('%s declares userId + tenantId and queries tenantId+userId', async (_name, model, collection) => {
    expect(model.collection.name).toBe(collection);
    expect(model.schema.path('userId')).toBeTruthy();
    expect(model.schema.path('tenantId')).toBeTruthy();

    const spy = vi
      .spyOn(model.collection, 'countDocuments')
      .mockResolvedValue(0 as never);

    const queryable = model as unknown as {
      countDocuments: (filter: Record<string, unknown>) => Promise<number>;
    };
    await queryable.countDocuments({ userId: USER_ID });

    expect(spy).toHaveBeenCalledTimes(1);
    const filter = spy.mock.calls[0][0] as Record<string, unknown>;
    expect(String(filter.userId)).toBe(USER_ID);
    expect(String(filter.tenantId)).toBe(USER_ID);
  });

  it.each(TENANT_SCOPED_CASES)('%s injects tenantId into $or userId branches', async (_name, model) => {
    const spy = vi
      .spyOn(model.collection, 'countDocuments')
      .mockResolvedValue(0 as never);

    const queryable = model as unknown as {
      countDocuments: (filter: Record<string, unknown>) => Promise<number>;
    };
    await queryable.countDocuments({ $or: [{ userId: USER_ID }, { isBuiltin: true }] });

    const filter = spy.mock.calls[0][0] as { $or: Array<Record<string, unknown>> };
    expect(String(filter.$or[0].userId)).toBe(USER_ID);
    expect(String(filter.$or[0].tenantId)).toBe(USER_ID);
    expect(filter.$or[1]).toEqual({ isBuiltin: true });
  });

  it('T-ISO 豁免：user_commit_settings 为成员级集合，查询不注入 tenantId（tenantId 仅留档）', async () => {
    expect(UserCommitSetting.schema.path('userId')).toBeTruthy();
    expect(UserCommitSetting.schema.path('tenantId')).toBeTruthy();

    const spy = vi
      .spyOn(UserCommitSetting.collection, 'countDocuments')
      .mockResolvedValue(0 as never);
    await UserCommitSetting.countDocuments({ userId: USER_ID });

    const filter = spy.mock.calls[0][0] as Record<string, unknown>;
    // 不注入 tenantId：任何工作区上下文（含无上下文）都能命中同一成员行
    expect(filter).toEqual({ userId: USER_ID });
  });
});
