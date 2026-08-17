export const controllerWorkspaceTypeDefs = `#graphql
  type ControllerWorkspace {
    id: ID!
    userId: ID!
    controllerId: ID!
    name: String!
    path: String!
    isEnabled: Boolean!
    isGitRepo: Boolean
    defaultBranch: String
    createdAt: String!
    updatedAt: String!
  }

  type FolderEntry {
    name: String!
    path: String!
    isDirectory: Boolean!
  }

  type GitRepoInfo {
    isGitRepo: Boolean!
    currentBranch: String
    branches: [String!]
    defaultBranch: String
  }

  type WorkspaceWorktree {
    worktreePath: String!
    branch: String!
    sessionCount: Int!
    sessionIds: [String!]!
  }

  input CreateWorkspaceInput {
    controllerId: ID!
    path: String!
  }

  extend type Query {
    controllerWorkspaces(controllerId: ID!): [ControllerWorkspace!]!
    workspaces: [ControllerWorkspace!]!
    browseFolder(controllerId: ID!, path: String): [FolderEntry!]!
    getHomeDirectory(controllerId: ID!): String
    detectGitRepo(controllerId: ID!, workspaceId: ID!): GitRepoInfo!
    workspaceWorktrees(controllerId: ID!, workspaceId: ID!): [WorkspaceWorktree!]!
  }

  extend type Mutation {
    createWorkspace(input: CreateWorkspaceInput!): ControllerWorkspace!
    deleteWorkspace(id: ID!): Boolean!
    clearWorkspaces(controllerId: ID!): Boolean!
    toggleWorkspace(id: ID!): ControllerWorkspace!
    initGitRepo(controllerId: ID!, workspaceId: ID!): Boolean!
    setWorkspaceDefaultBranch(id: ID!, defaultBranch: String!): ControllerWorkspace!
    createFolder(controllerId: ID!, parentPath: String!, folderName: String!): FolderEntry!
    deleteWorktree(controllerId: ID!, workspaceId: ID!, worktreePath: String!): Boolean!
  }
`;
