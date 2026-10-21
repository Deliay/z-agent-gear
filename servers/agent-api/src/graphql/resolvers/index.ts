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
  },
  Provider: {
    ...providerResolvers.Provider,
  },
  Model: {
    ...modelResolvers.Model,
  },
  TodoItem: {
    ...todoResolvers.TodoItem,
  },
  PermissionRequestData: {
    ...todoResolvers.PermissionRequestData,
  },
  Session: {
    ...sessionResolvers.Session,
  },
  WorkflowInstance: {
    ...workflowResolvers.WorkflowInstance,
  },
  Controller: {
    ...homeResolvers.Controller,
    ...cloudHostResolvers.Controller,
  },
  ControllerWorkspace: {
    ...homeResolvers.ControllerWorkspace,
  },
};
