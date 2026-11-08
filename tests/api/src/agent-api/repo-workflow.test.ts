import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import { createFrontUser } from '../support/front-users.js';

/**
 * 工作流模板项目持久化 —— API 用例 T-REPO-API1 ~ T-REPO-API7。
 *
 * 前置：`aspire start`（agent-api + controller-api 就绪）+ `INTERNAL_API_TOKEN`；
 * T-REPO-API4/5b/7 直连 Mongo 预置控制器的 cloud 类型与云电脑行（缺 `MONGODB_URI` 时跳过）。
 */
const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const MONGODB_URI = process.env.MONGODB_URI ?? '';
const HAS_MONGO = Boolean(MONGODB_URI);

const redis = new Redis(REDIS_URL, { enableOfflineQueue: false, retryStrategy: () => null });

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(AGENT_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
}

async function gql(query: string, variables: Record<string, unknown> | undefined, token: string) {
  const res = await gqlRequest(query, variables, token);
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  if (!MONGODB_URI) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(MONGODB_URI);
  return mongoose.connection.db ?? null;
}

const CREATE_KEY = `
  mutation CreateControllerKey($input: CreateKeyInput!) {
    createControllerKey(input: $input) { key { id name } rawKey }
  }
`;

const CREATE_WORKSPACE = `
  mutation CreateWorkspace($input: CreateWorkspaceInput!) {
    createWorkspace(input: $input) { id controllerId path }
  }
`;

const REFRESH_ACP_CAPABILITIES = `
  mutation RefreshAcpCapabilities($controllerId: ID!) {
    refreshAcpCapabilities(controllerId: $controllerId) { type available version checkedAt }
  }
`;

const REPO_WORKFLOW_TEMPLATES = `
  query RepoWorkflowTemplates($workspaceId: ID!) {
    repoWorkflowTemplates(workspaceId: $workspaceId) {
      fileName
      name
      description
      nodeCount
      valid
      errors
      nodes { nodeKey type name stage prompts artifactTitles dependsOn requiresWorktree linkUpstreamPullRequest sortOrder }
    }
  }
`;

const CONFIGURE_REPO_WORKFLOW = `
  mutation ConfigureRepoWorkflow($input: ConfigureRepoWorkflowInput!) {
    configureRepoWorkflow(input: $input) {
      id
      name
      controllerId
      sourceKind
      sourceRepoPath
      sourceWorkspaceId
      nodes { nodeKey type name agentConfig { acpServerType } }
    }
  }
`;

const CONFIGURED_WORKFLOWS = `
  query ConfiguredWorkflows($controllerId: ID) {
    configuredWorkflows(controllerId: $controllerId) { id name sourceKind sourceRepoPath }
  }
`;

const CREATE_WORKFLOW_TEMPLATE = `
  mutation CreateWorkflowTemplate($input: WorkflowTemplateInput!) {
    createWorkflowTemplate(input: $input) { id name version }
  }
`;

const CONFIGURE_WORKFLOW = `
  mutation ConfigureWorkflow($templateId: ID!, $input: ConfigureWorkflowInput!) {
    configureWorkflow(templateId: $templateId, input: $input) {
      id name sourceKind sourceRepoPath
    }
  }
`;

const DELETE_CLOUD_HOST = `
  mutation DeleteCloudHost($id: ID!) { deleteCloudHost(id: $id) }
`;

const VALID_TEMPLATE = {
  name: '项目开发流程',
  description: '仓库内开发流程',
  nodes: [
    {
      nodeKey: 'requirement',
      type: 'HUMAN',
      name: '产品需求',
      stage: '需求',
      dependsOn: [],
      requiresWorktree: false,
    },
    {
      nodeKey: 'design',
      type: 'AI',
      name: '技术方案',
      stage: '设计',
      prompts: ['产出技术方案'],
      artifactTitles: ['技术方案文档'],
      dependsOn: ['requirement'],
      requiresWorktree: true,
    },
  ],
};

function simpleTemplateInput(name: string) {
  return {
    name,
    description: 'API 测试用简单两节点工作流',
    nodes: [
      { nodeKey: 'input', type: 'HUMAN', name: '需求输入', stage: '阶段一', dependsOn: [], requiresWorktree: false },
      {
        nodeKey: 'exec',
        type: 'AI',
        name: 'AI执行',
        stage: '阶段一',
        prompts: ['阅读上游产物并完成执行'],
        artifactTitles: ['执行结果'],
        dependsOn: ['input'],
        requiresWorktree: false,
      },
    ],
  };
}

function configuredNodesFromTemplate() {
  return [
    {
      nodeKey: 'requirement',
      type: 'HUMAN',
      name: '产品需求',
      stage: '需求',
      dependsOn: [],
      requiresWorktree: false,
    },
    {
      nodeKey: 'design',
      type: 'AI',
      name: '技术方案',
      stage: '设计',
      prompts: ['产出技术方案'],
      artifactTitles: ['技术方案文档'],
      dependsOn: ['requirement'],
      requiresWorktree: true,
      agentConfig: { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: false },
    },
  ];
}

function createClient(): ClientSocket {
  return SocketIOClient(CONTROLLER_API_URL, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
}

function waitForEvent<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

interface FakeController {
  client: ClientSocket;
  controllerId: string;
  scans: Array<{ requestId: string; path: string }>;
}

/** 注册 fake controller：应答 acp:check / workflow-templates:scan（fixture 与 agent-gear 真实回包同形态） */
async function registerFakeController(
  token: string,
  tag: string,
  version = '2.18.0',
): Promise<FakeController> {
  const body = await gql(CREATE_KEY, { input: { name: `repo-wf-${tag}-${Date.now()}`, type: 'local' } }, token);
  const rawKey = body.createControllerKey.rawKey as string;

  const client = createClient();
  const scans: Array<{ requestId: string; path: string }> = [];

  client.on('acp:check', (data: { requestId: string }) => {
    client.emit('acp:check:result', {
      requestId: data.requestId,
      servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
    });
  });
  client.on('workflow-templates:scan', (data: { requestId: string; path: string }) => {
    scans.push(data);
    client.emit('workflow-templates:scan:result', {
      requestId: data.requestId,
      success: true,
      templates: [
        { fileName: 'dev.json', content: JSON.stringify(VALID_TEMPLATE) },
        { fileName: 'broken.json', content: '{ not json' },
        {
          fileName: 'wrong-shape.json',
          content: JSON.stringify({ name: '缺 nodes', nodes: [] }),
        },
      ],
      truncated: false,
    });
  });
  const heartbeat = setInterval(() => {
    if (client.connected) client.emit('heartbeat');
  }, 30_000);
  client.on('disconnect', () => clearInterval(heartbeat));

  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', {
    key: rawKey,
    hostname: `repo-wf-${tag}-host`,
    version,
    homeDir: '/home/fake',
    platform: 'linux',
  });
  const regData = await registered;
  return { client, controllerId: regData.controllerId, scans };
}

async function createWorkspace(token: string, controllerId: string): Promise<string> {
  const path = `/tmp/repo-wf-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const body = await gql(CREATE_WORKSPACE, { input: { controllerId, path } }, token);
  return body.createWorkspace.id as string;
}

async function refreshCapabilities(token: string, controllerId: string): Promise<string[]> {
  const body = await gql(REFRESH_ACP_CAPABILITIES, { controllerId }, token);
  return (body.refreshAcpCapabilities as { type: string; available: boolean }[])
    .filter((item) => item.available)
    .map((item) => item.type);
}

describe('工作流模板项目持久化 API', () => {
  let token = '';
  let fake: FakeController;
  let workspaceId = '';

  beforeAll(async () => {
    token = (await createFrontUser()).token;
    fake = await registerFakeController(token, 'main');
    workspaceId = await createWorkspace(token, fake.controllerId);
    await refreshCapabilities(token, fake.controllerId);
  }, 30_000);

  afterAll(() => {
    fake?.client.disconnect();
    redis.disconnect();
  });

  it('T-REPO-API1 未认证：查询/变更均 Not authenticated', async () => {
    const query = await gqlRequest(REPO_WORKFLOW_TEMPLATES, { workspaceId: 'ws-1' });
    expect((await query.json()).errors[0].message).toBe('Not authenticated');

    const mutation = await gqlRequest(CONFIGURE_REPO_WORKFLOW, {
      input: { workspaceId: 'ws-1', fileName: 'dev.json', name: 'x', nodes: [] },
    });
    expect((await mutation.json()).errors[0].message).toBe('Not authenticated');
  });

  it('T-REPO-API2 形状：合法/不合法/逐文件隔离；工作区不可见 Workspace not found', async () => {
    const data = await gql(REPO_WORKFLOW_TEMPLATES, { workspaceId }, token);
    const templates = data.repoWorkflowTemplates as Array<Record<string, unknown>>;

    expect(templates.map((item) => item.fileName)).toEqual(['broken.json', 'dev.json', 'wrong-shape.json']);
    expect(templates[0]).toMatchObject({ valid: false, errors: ['不是合法的 JSON 文件'], nodes: [] });
    expect(templates[1]).toMatchObject({
      valid: true,
      name: '项目开发流程',
      nodeCount: 2,
      errors: [],
    });
    expect((templates[1].nodes as unknown[]).length).toBe(2);
    expect(templates[2].valid).toBe(false);
    expect((templates[2].errors as string[])[0]).toContain('nodes');

    const other = await createFrontUser();
    const res = await gqlRequest(REPO_WORKFLOW_TEMPLATES, { workspaceId }, other.token);
    expect((await res.json()).errors[0].message).toBe('Workspace not found');
  });

  it('T-REPO-API3 控制器版本 2.17.0 → []（降级不抛错）', async () => {
    const old = await registerFakeController(token, 'old', '2.17.0');
    const oldWorkspace = await createWorkspace(token, old.controllerId);
    try {
      const data = await gql(REPO_WORKFLOW_TEMPLATES, { workspaceId: oldWorkspace }, token);
      expect(data.repoWorkflowTemplates).toEqual([]);
      expect(old.scans).toHaveLength(0);
    } finally {
      old.client.disconnect();
    }
  });

  it('T-REPO-API5a 非 cloud 控制器 → repo workflow only supports cloud host', async () => {
    const res = await gqlRequest(
      CONFIGURE_REPO_WORKFLOW,
      { input: { workspaceId, fileName: 'dev.json', name: '项目流', nodes: configuredNodesFromTemplate() } },
      token,
    );
    expect((await res.json()).errors[0].message).toBe('repo workflow only supports cloud host');
  });

  it('T-REPO-API6 存量行为：configureWorkflow 落库 sourceKind 归一为 PLATFORM', async () => {
    const name = `repo-wf-platform-${Date.now()}`;
    const tpl = await gql(CREATE_WORKFLOW_TEMPLATE, { input: simpleTemplateInput(name) }, token);
    const configured = await gql(
      CONFIGURE_WORKFLOW,
      {
        templateId: tpl.createWorkflowTemplate.id,
        input: { name, controllerId: fake.controllerId, nodes: configuredNodesFromTemplate() },
      },
      token,
    );
    expect(configured.configureWorkflow).toMatchObject({
      name,
      sourceKind: 'PLATFORM',
      sourceRepoPath: null,
    });
  });

  describe.skipIf(!HAS_MONGO)('需要 MONGODB_URI 的分支', () => {
    let db: mongoose.mongo.Db;
    let cloudHostId: mongoose.Types.ObjectId;

    beforeAll(async () => {
      db = (await mongoDb())!;
      await db.collection('controllers').updateOne(
        { _id: new mongoose.Types.ObjectId(fake.controllerId) },
        { $set: { type: 'cloud' } },
      );
    });

    it('T-REPO-API4 configureRepoWorkflow 成功并出现在已配置列表', async () => {
      const data = await gql(
        CONFIGURE_REPO_WORKFLOW,
        {
          input: {
            workspaceId,
            fileName: 'dev.json',
            name: '项目流',
            nodes: configuredNodesFromTemplate(),
          },
        },
        token,
      );
      const configured = data.configureRepoWorkflow as Record<string, unknown>;
      expect(configured).toMatchObject({
        name: '项目流',
        controllerId: fake.controllerId,
        sourceKind: 'REPO',
        sourceRepoPath: '.zag/workflow/templates/dev.json',
        sourceWorkspaceId: workspaceId,
      });

      const list = await gql(CONFIGURED_WORKFLOWS, { controllerId: fake.controllerId }, token);
      expect(
        (list.configuredWorkflows as Array<Record<string, unknown>>).some(
          (item) => item.id === configured.id && item.sourceKind === 'REPO',
        ),
      ).toBe(true);
    });

    it('T-REPO-API5b 错误白名单逐字：fileName/name/图校验', async () => {
      const base = {
        workspaceId,
        fileName: 'dev.json',
        name: '项目流',
        nodes: configuredNodesFromTemplate(),
      };

      for (const fileName of ['../x.json', 'a/b.json', 'x.txt']) {
        const res = await gqlRequest(CONFIGURE_REPO_WORKFLOW, { input: { ...base, fileName } }, token);
        expect((await res.json()).errors[0].message).toBe('invalid template file name');
      }

      const badName = await gqlRequest(
        CONFIGURE_REPO_WORKFLOW,
        { input: { ...base, name: 'a'.repeat(65) } },
        token,
      );
      expect((await badName.json()).errors[0].message).toBe('invalid workflow name');

      const badGraph = await gqlRequest(
        CONFIGURE_REPO_WORKFLOW,
        {
          input: {
            ...base,
            nodes: [{ nodeKey: 'ai', type: 'AI', name: 'AI 首节点', stage: 's', prompts: ['p'], dependsOn: [], requiresWorktree: false, agentConfig: { acpServerType: 'opencode' } }],
          },
        },
        token,
      );
      expect((await badGraph.json()).errors[0].message).toContain('首节点必须是人类节点');
    });

    it('T-REPO-API7 deleteCloudHost 级联删除 REPO，PLATFORM 保留', async () => {
      const controllerDoc = await db.collection('controllers').findOne({
        _id: new mongoose.Types.ObjectId(fake.controllerId),
      });
      cloudHostId = new mongoose.Types.ObjectId();
      const now = new Date();
      await db.collection('cloudhosts').insertOne({
        _id: cloudHostId,
        userId: new mongoose.Types.ObjectId(controllerDoc!.userId),
        tenantId: new mongoose.Types.ObjectId(controllerDoc!.tenantId),
        resourceWorkspaceId: controllerDoc!.workspaceId ?? null,
        name: `repo-wf-host-${cloudHostId.toString()}`,
        harnessTypes: ['OPENCODE'],
        status: 'STOPPED',
        controllerId: new mongoose.Types.ObjectId(fake.controllerId),
        keyId: controllerDoc!.keyId,
        containerId: null,
        defaultSessionId: null,
        createDefaultSession: false,
        createdAt: now,
        updatedAt: now,
      });

      await gql(DELETE_CLOUD_HOST, { id: cloudHostId.toString() }, token);

      const list = await gql(CONFIGURED_WORKFLOWS, { controllerId: fake.controllerId }, token);
      const kinds = (list.configuredWorkflows as Array<{ sourceKind: string }>).map((item) => item.sourceKind);
      expect(kinds).toContain('PLATFORM');
      expect(kinds).not.toContain('REPO');
    });
  });
});
