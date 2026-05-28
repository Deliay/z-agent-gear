import { authTypeDefs } from './auth.js';
import { providerTypeDefs } from './provider.js';
import { modelTypeDefs } from './model.js';
import { controllerTypeDefs } from './controller.js';
import { controllerWorkspaceTypeDefs } from './controller-workspace.js';
import { sessionTypeDefs } from './session.js';
import { portForwardTypeDefs } from './port-forward.js';
import { todoTypeDefs } from './todo.js';

const baseTypeDefs = `#graphql
  type Query

  type Mutation
`;

export const typeDefs = [baseTypeDefs, authTypeDefs, providerTypeDefs, modelTypeDefs, controllerTypeDefs, controllerWorkspaceTypeDefs, sessionTypeDefs, portForwardTypeDefs, todoTypeDefs];
