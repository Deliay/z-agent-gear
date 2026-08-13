import { GraphQLError } from 'graphql';
import { workflowTemplateService } from '../../services/workflow/template.js';
import { configuredWorkflowService } from '../../services/workflow/configured.js';
import { workflowInstanceService } from '../../services/workflow/instance.js';
import type { AuthContext } from './auth.js';

type Doc = Record<string, unknown>;

function toId(value: unknown): string | null {
  return value ? (value as { toString(): string }).toString() : null;
}

function toIso(value: unknown): string | null {
  return value ? (value as Date).toISOString() : null;
}

function mapTemplateNode(node: Doc) {
  return {
    nodeKey: node.nodeKey,
    type: node.type,
    name: node.name,
    description: node.description ?? null,
    stage: node.stage,
    prompts: node.prompts ?? null,
    artifactTitles: node.artifactTitles ?? null,
    dependsOn: node.dependsOn ?? [],
    requiresWorktree: node.requiresWorktree ?? false,
  };
}

function mapTemplate(doc: Doc) {
  return {
    id: toId(doc._id),
    name: doc.name,
    description: doc.description ?? null,
    version: doc.version ?? 1,
    nodes: ((doc.nodes as Doc[]) ?? []).map(mapTemplateNode),
    isBuiltin: doc.isBuiltin ?? false,
    createdBy: doc.createdBy ?? 'HUMAN',
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
  };
}

function mapConfigured(doc: Doc) {
  return {
    id: toId(doc._id),
    name: doc.name,
    controllerId: toId(doc.controllerId),
    sourceTemplateId: toId(doc.sourceTemplateId),
    sourceTemplateVersion: doc.sourceTemplateVersion ?? null,
    nodes: ((doc.nodes as Doc[]) ?? []).map((node) => ({
      ...mapTemplateNode(node),
      // 归一化：空对象物化为 null（HUMAN/FLAG 节点无 agentConfig）
      agentConfig:
        node.agentConfig && (node.agentConfig as Doc).acpServerType
          ? {
              acpServerType: (node.agentConfig as Doc).acpServerType,
              modeId: (node.agentConfig as Doc).modeId ?? null,
              modelId: (node.agentConfig as Doc).modelId ?? null,
              initNewWorktree: (node.agentConfig as Doc).initNewWorktree ?? false,
            }
          : null,
    })),
    createdBy: doc.createdBy ?? 'HUMAN',
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
  };
}

function mapInstanceNode(node: Doc) {
  const rejectInfo = node.rejectInfo as Doc | null | undefined;
  const failInfo = node.failInfo as Doc | null | undefined;
  const agentConfig = node.agentConfig as Doc | null | undefined;
  return {
    id: node.nodeId,
    nodeKey: node.nodeKey,
    type: node.type,
    name: node.name,
    description: node.description ?? null,
    status: node.status,
    stage: node.stage,
    sessionId: toId(node.sessionId),
    prompts: node.prompts ?? null,
    artifactTitles: node.artifactTitles ?? null,
    agentConfig:
      agentConfig && (agentConfig as Doc).acpServerType
        ? {
            acpServerType: (agentConfig as Doc).acpServerType,
            modeId: (agentConfig as Doc).modeId ?? null,
            modelId: (agentConfig as Doc).modelId ?? null,
            initNewWorktree: (agentConfig as Doc).initNewWorktree ?? false,
          }
        : null,
    requiresWorktree: node.requiresWorktree ?? null,
    createdAt: toIso(node.createdAt),
    startedAt: toIso(node.startedAt),
    reworkedAt: toIso(node.reworkedAt),
    reworkCount: node.reworkCount ?? 0,
    // 归一化：缺 reason 的空对象视为 null
    rejectInfo: rejectInfo?.reason
      ? { reason: rejectInfo.reason, fromNodeId: rejectInfo.fromNodeId ?? null, at: toIso(rejectInfo.at) }
      : null,
    failInfo: failInfo?.reason
      ? { reason: failInfo.reason, source: failInfo.source, at: toIso(failInfo.at) }
      : null,
  };
}

function mapBlackboardEntries(map: unknown, updatedAtMap: unknown) {
  const entries = map instanceof Map ? map : new Map(Object.entries((map as Record<string, string>) ?? {}));
  const updatedAt = updatedAtMap instanceof Map ? updatedAtMap : new Map();
  return [...entries.entries()].map(([key, value]) => ({
    key,
    value,
    // BlackboardEntry.updatedAt 非空；服务层在 set/remove 时均会记录，此处仅兜底
    updatedAt: toIso(updatedAt.get(key)) ?? new Date().toISOString(),
  }));
}

function mapInstance(doc: Doc) {
  return {
    id: toId(doc._id),
    configuredWorkflowId: toId(doc.configuredWorkflowId),
    controllerId: toId(doc.controllerId),
    workspaceId: toId(doc.workspaceId),
    name: doc.name,
    currentNodeNames: doc.currentNodeNames ?? [],
    lastNodeName: doc.lastNodeName ?? null,
    lastNodeStatus: doc.lastNodeStatus ?? null,
    archived: Boolean(doc.archivedAt),
    nodes: ((doc.nodes as Doc[]) ?? []).map(mapInstanceNode),
    blackboard: mapBlackboardEntries(doc.blackboard, doc.blackboardUpdatedAt),
    blackboardTrash: mapBlackboardEntries(doc.blackboardTrash, doc.blackboardUpdatedAt),
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
  };
}

function requireUser(context: AuthContext): string {
  if (!context.currentUser) {
    throw new GraphQLError('Not authenticated');
  }
  return context.currentUser.id;
}

/** 业务错误包装为 GraphQLError（message 为服务层的中文可读信息） */
async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GraphQLError) throw err;
    throw new GraphQLError((err as Error).message);
  }
}

export const workflowResolvers = {
  Query: {
    workflowTemplates: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      const userId = requireUser(context);
      const docs = await workflowTemplateService.listForUser(userId);
      return docs.map((doc) => mapTemplate(doc as unknown as Doc));
    },
    workflowTemplate: async (_parent: unknown, args: { id: string }, context: AuthContext) => {
      const userId = requireUser(context);
      const doc = await workflowTemplateService.findById(args.id, userId);
      return doc ? mapTemplate(doc as unknown as Doc) : null;
    },
    configuredWorkflows: async (
      _parent: unknown,
      args: { controllerId?: string },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      const docs = await configuredWorkflowService.listForUser(userId, args.controllerId);
      return docs.map((doc) => mapConfigured(doc as unknown as Doc));
    },
    configuredWorkflow: async (_parent: unknown, args: { id: string }, context: AuthContext) => {
      const userId = requireUser(context);
      const doc = await configuredWorkflowService.findById(args.id, userId);
      return doc ? mapConfigured(doc as unknown as Doc) : null;
    },
    workflowInstances: async (_parent: unknown, args: { workspaceId: string; archived?: boolean }, context: AuthContext) => {
      const userId = requireUser(context);
      const docs = await workflowInstanceService.listForWorkspace(userId, args.workspaceId, args.archived ?? false);
      return docs.map((doc) => mapInstance(doc as unknown as Doc));
    },
    workflowInstance: async (_parent: unknown, args: { id: string }, context: AuthContext) => {
      const userId = requireUser(context);
      const doc = await workflowInstanceService.findById(args.id, userId);
      return doc ? mapInstance(doc as unknown as Doc) : null;
    },
  },
  Mutation: {
    createWorkflowTemplate: async (
      _parent: unknown,
      args: { input: never },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      return wrap(async () => mapTemplate((await workflowTemplateService.create(userId, args.input)) as unknown as Doc));
    },
    updateWorkflowTemplate: async (
      _parent: unknown,
      args: { id: string; input: never },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      return wrap(async () =>
        mapTemplate((await workflowTemplateService.update(args.id, userId, args.input)) as unknown as Doc),
      );
    },
    deleteWorkflowTemplate: async (_parent: unknown, args: { id: string }, context: AuthContext) => {
      const userId = requireUser(context);
      return wrap(() => workflowTemplateService.delete(args.id, userId));
    },
    configureWorkflow: async (
      _parent: unknown,
      args: { templateId: string; input: never },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      return wrap(async () =>
        mapConfigured((await configuredWorkflowService.configure(userId, args.templateId, args.input)) as unknown as Doc),
      );
    },
    updateConfiguredWorkflow: async (
      _parent: unknown,
      args: { id: string; input: never },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      return wrap(async () =>
        mapConfigured((await configuredWorkflowService.update(userId, args.id, args.input)) as unknown as Doc),
      );
    },
    deleteConfiguredWorkflow: async (_parent: unknown, args: { id: string }, context: AuthContext) => {
      const userId = requireUser(context);
      return wrap(() => configuredWorkflowService.delete(userId, args.id));
    },
    instantiateWorkflow: async (
      _parent: unknown,
      args: { input: never },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      return wrap(async () =>
        mapInstance(
          (await workflowInstanceService.instantiate(userId, args.input as never)) as unknown as Doc,
        ),
      );
    },
    updateWorkflowNode: async (
      _parent: unknown,
      args: { instanceId: string; nodeId: string; input: never },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      return wrap(async () => {
        const { node } = await workflowInstanceService.updateNode(
          userId,
          args.instanceId,
          args.nodeId,
          args.input as never,
        );
        return mapInstanceNode(node as unknown as Doc);
      });
    },
    completeHumanNode: async (
      _parent: unknown,
      args: { instanceId: string; nodeId: string; input?: string },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      return wrap(async () =>
        mapInstanceNode(
          (await workflowInstanceService.completeHumanNode(userId, args.instanceId, args.nodeId, args.input)) as unknown as Doc,
        ),
      );
    },
    rejectNode: async (
      _parent: unknown,
      args: { instanceId: string; nodeId: string; reason: string },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      return wrap(async () =>
        mapInstanceNode(
          (await workflowInstanceService.rejectNode(userId, args.instanceId, args.nodeId, args.reason)) as unknown as Doc,
        ),
      );
    },
    restartNode: async (
      _parent: unknown,
      args: { instanceId: string; nodeId: string },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      return wrap(async () =>
        mapInstanceNode(
          (await workflowInstanceService.restartNode(userId, args.instanceId, args.nodeId)) as unknown as Doc,
        ),
      );
    },
    deleteWorkflowInstance: async (_parent: unknown, args: { id: string }, context: AuthContext) => {
      const userId = requireUser(context);
      return wrap(() => workflowInstanceService.deleteInstance(userId, args.id));
    },
    archiveWorkflowInstance: async (_parent: unknown, args: { id: string; archived: boolean }, context: AuthContext) => {
      const userId = requireUser(context);
      return wrap(() => workflowInstanceService.setArchived(userId, args.id, args.archived));
    },
  },
};
