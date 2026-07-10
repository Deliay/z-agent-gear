import { authTypeDefs } from './auth.js';
import { providerTypeDefs } from './provider.js';
import { modelTypeDefs } from './model.js';
import { controllerTypeDefs } from './controller.js';
import { controllerWorkspaceTypeDefs } from './controller-workspace.js';
import { sessionTypeDefs } from './session.js';
import { gatewayTypeDefs } from './gateway.js';
import { todoTypeDefs } from './todo.js';
import { mcpServerTypeDefs } from './mcp-server.js';
import { githubTypeDefs } from './github.js';

const baseTypeDefs = `#graphql
  type Query

  type Mutation
`;

export const typeDefs = [baseTypeDefs, authTypeDefs, providerTypeDefs, modelTypeDefs, controllerTypeDefs, controllerWorkspaceTypeDefs, sessionTypeDefs, gatewayTypeDefs, todoTypeDefs, mcpServerTypeDefs, githubTypeDefs];
