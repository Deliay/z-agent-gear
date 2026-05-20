export const controllerWorkspaceTypeDefs = `#graphql
  type ControllerWorkspace {
    id: ID!
    userId: ID!
    controllerId: ID!
    name: String!
    path: String!
    isEnabled: Boolean!
    createdAt: String!
    updatedAt: String!
  }

  type FolderEntry {
    name: String!
    path: String!
    isDirectory: Boolean!
  }

  input CreateWorkspaceInput {
    controllerId: ID!
    path: String!
  }

  extend type Query {
    controllerWorkspaces(controllerId: ID!): [ControllerWorkspace!]!
    browseFolder(controllerId: ID!, path: String): [FolderEntry!]!
    getHomeDirectory(controllerId: ID!): String
  }

  extend type Mutation {
    createWorkspace(input: CreateWorkspaceInput!): ControllerWorkspace!
    deleteWorkspace(id: ID!): Boolean!
    clearWorkspaces(controllerId: ID!): Boolean!
    toggleWorkspace(id: ID!): ControllerWorkspace!
  }
`;
