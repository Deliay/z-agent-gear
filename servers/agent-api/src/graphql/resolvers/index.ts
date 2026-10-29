import GraphQLJSON from 'graphql-type-json';
import { authResolvers } from './auth.js';
import { providerResolvers } from './provider.js';
import { modelResolvers } from './model.js';
import { controllerResolvers } from './controller.js';
import { controllerWorkspaceResolvers } from './controller-workspace.js';
import { sessionResolvers } from './session.js';
import { gatewayResolvers } from './gateway.js';
import { todoResolvers } from './todo.js';
import { mcpServerResolvers } from './mcp-server.js';
import { githubResolvers } from './github.js';
import { workflowResolvers } from './workflow.js';
import { homeResolvers } from './home.js';
import { billingResolvers } from './billing.js';
import { cloudHostResolvers } from './cloud-host.js';
import { workspaceResolvers } from './workspace.js';

export const resolvers = {
  JSON: GraphQLJSON,
  Query: {
    ...authResolvers.Query,
    ...providerResolvers.Query,
    ...modelResolvers.Query,
    ...controllerResolvers.Query,
    ...controllerWorkspaceResolvers.Query,
    ...sessionResolvers.Query,
    ...gatewayResolvers.Query,
    ...todoResolvers.Query,
    ...mcpServerResolvers.Query,
    ...githubResolvers.Query,
    ...workflowResolvers.Query,
    ...homeResolvers.Query,
    ...billingResolvers.Query,
    ...cloudHostResolvers.Query,
    ...workspaceResolvers.Query,
  },
  Mutation: {
    ...authResolvers.Mutation,
    ...providerResolvers.Mutation,
    ...modelResolvers.Mutation,
    ...controllerResolvers.Mutation,
    ...controllerWorkspaceResolvers.Mutation,
    ...sessionResolvers.Mutation,
    ...gatewayResolvers.Mutation,
    ...todoResolvers.Mutation,
    ...mcpServerResolvers.Mutation,
    ...githubResolvers.Mutation,
    ...workflowResolvers.Mutation,
    ...billingResolvers.Mutation,
    ...cloudHostResolvers.Mutation,
    ...workspaceResolvers.Mutation,
  },
  User: {
    ...authResolvers.User,
  },
  Provider: {
    ...providerResolvers.Provider,
  },
  Model: {
    ...modelResolvers.Model,
  },
  Session: {
    ...sessionResolvers.Session,
  },
  TodoItem: {
    ...todoResolvers.TodoItem,
  },
  PermissionRequestData: {
    ...todoResolvers.PermissionRequestData,
  },
  WorkflowInstance: {
    ...workflowResolvers.WorkflowInstance,
  },
  Controller: {
    ...controllerResolvers.Controller,
    ...homeResolvers.Controller,
    ...cloudHostResolvers.Controller,
  },
  CloudHost: {
    ...cloudHostResolvers.CloudHost,
  },
  ControllerWorkspace: {
    ...homeResolvers.ControllerWorkspace,
  },
  Workspace: {
    ...workspaceResolvers.Workspace,
  },
  WorkspaceMember: {
    ...workspaceResolvers.WorkspaceMember,
  },
};
