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

const USER_ID = '507f1f77bcf86cd799439011';

/**
 * T-ISO 等价层级：19 个带 userId 的集合逐一验证
 * ① schema 同时声明 userId + tenantId；② 实际查询（countDocuments）经插件注入 tenantId=userId。
 * 这覆盖了 mock 掉 model 的 service 单测无法验证的「Mongoose 编译期注入」路径。
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

  it.each(CASES)('%s declares userId + tenantId and queries tenantId+userId', async (_name, model, collection) => {
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

  it.each(CASES)('%s injects tenantId into $or userId branches', async (_name, model) => {
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
});
