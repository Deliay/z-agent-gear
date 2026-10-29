import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Session } from '../models/session.js';
import { Controller } from '../models/controller.js';
import { CloudHost } from '../models/cloud-host.js';
import { WorkflowTemplate } from '../models/workflow-template.js';
import { WorkflowInstance } from '../models/workflow-instance.js';
import { sessionService } from './session.js';
import { controllerService } from './controller.js';
import { cloudHostService } from './cloud-host-service.js';
import { workflowTemplateService } from './workflow/template.js';
import { workflowInstanceService } from './workflow/instance.js';
import { runWithWorkspace, type WorkspaceContext } from './workspace-context.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-workspace-visibility-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
});

const TENANT = new mongoose.Types.ObjectId();
const WS = new mongoose.Types.ObjectId();
const WS_GLOBAL = new mongoose.Types.ObjectId();
const USER_A = new mongoose.Types.ObjectId();
const USER_B = new mongoose.Types.ObjectId();

function context(role: 'admin' | 'developer', type: 'normal' | 'global' = 'normal'): WorkspaceContext {
  return {
    id: type === 'global' ? String(WS_GLOBAL) : String(WS),
    tenantId: String(TENANT),
    type,
    role,
    readOnly: type === 'global' && role === 'developer',
    globalWorkspaceId: String(WS_GLOBAL),
  };
}

/**
 * 阻断-1 回归：同工作区成员可见/可操作他人创建的 11 类资源（userId 仅创建者字段）。
 */
describe('工作区资源共享（T-WS 跨成员可见性，真库）', () => {
  it('developer 成员可见他人创建的会话/控制器/云电脑', async () => {
    const controllerId = new mongoose.Types.ObjectId();
    await mongoose.connection.collection('sessions').insertOne({
      userId: USER_A,
      tenantId: TENANT,
      workspaceId: WS,
      controllerId,
      controllerName: 'c',
      acpServerType: 'opencode',
      status: 'idle',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await mongoose.connection.collection('controllers').insertOne({
      userId: USER_A,
      tenantId: TENANT,
      workspaceId: WS,
      keyId: new mongoose.Types.ObjectId(),
      hostname: 'host-a',
      type: 'local',
      version: '1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await mongoose.connection.collection('cloudhosts').insertOne({
      userId: USER_A,
      tenantId: TENANT,
      resourceWorkspaceId: WS,
      controllerId,
      keyId: new mongoose.Types.ObjectId(),
      name: 'host-a',
      harnessTypes: ['OPENCODE'],
      status: 'RUNNING',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await runWithWorkspace(context('developer'), async () => {
      const sessions = await sessionService.findAllByUser(String(USER_B));
      expect(sessions.map((s) => s.controllerName)).toContain('c');

      const controllers = await controllerService.findAllByUser(String(USER_B));
      expect(controllers.map((c) => c.hostname)).toContain('host-a');

      const hosts = await cloudHostService.list(String(USER_B));
      expect(hosts.map((h) => h.name)).toContain('host-a');
    });
  });

  it('非本工作区资源不可见（工作区上下文切换）', async () => {
    const otherWorkspace = new mongoose.Types.ObjectId();
    await mongoose.connection.collection('sessions').insertOne({
      userId: USER_A,
      tenantId: TENANT,
      workspaceId: otherWorkspace,
      controllerId: new mongoose.Types.ObjectId(),
      controllerName: 'other',
      acpServerType: 'opencode',
      status: 'idle',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await runWithWorkspace(context('developer'), async () => {
      const sessions = await sessionService.findAllByUser(String(USER_B));
      expect(sessions.map((s) => s.controllerName)).not.toContain('other');
    });
  });

  it('工作流自定义模板/实例按工作区共享（含内置模板全局可见）', async () => {
    await mongoose.connection.collection('workflowtemplates').insertMany([
      {
        userId: USER_A,
        tenantId: TENANT,
        resourceWorkspaceId: WS,
        name: '团队模板',
        nodes: [],
        isBuiltin: false,
      },
      {
        userId: null,
        tenantId: null,
        resourceWorkspaceId: null,
        name: '内置模板',
        nodes: [],
        isBuiltin: true,
      },
    ]);
    await mongoose.connection.collection('workflowinstances').insertOne({
      userId: USER_A,
      tenantId: TENANT,
      workspaceId: new mongoose.Types.ObjectId(),
      resourceWorkspaceId: WS,
      controllerId: new mongoose.Types.ObjectId(),
      name: '团队实例',
      nodes: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      archivedAt: null,
    });

    await runWithWorkspace(context('developer'), async () => {
      const templates = await workflowTemplateService.listForUser(String(USER_B));
      expect(templates.map((t) => t.name).sort()).toEqual(['内置模板', '团队模板']);
      const instances = await workflowInstanceService.list(String(USER_B), { archived: false });
      expect(instances.map((i) => i.name)).toContain('团队实例');
    });
  });
});
