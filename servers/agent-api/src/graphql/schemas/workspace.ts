export const workspaceTypeDefs = `#graphql
  # 租户内工作区与租户成员管理（租户级资源分组；与「项目工作区」ControllerWorkspace 是不同概念）
  # 角色：admin / developer；personal 租户唯一成员恒 admin；每租户至少保留一名 admin（last-admin 保护）。
  enum WorkspaceType {
    global
    normal
  }

  enum TenantRole {
    admin
    developer
  }

  type Workspace {
    id: ID!
    name: String!
    type: WorkspaceType!
    tenant: Tenant!
    memberCount: Int!
    myRole: TenantRole!
    readOnly: Boolean!
    createdAt: String!
  }

  type WorkspaceMember {
    id: ID!
    name: String!
    username: String!
    role: TenantRole
    createdAt: String!
  }

  type TenantMembership {
    tenant: Tenant!
    role: TenantRole!
  }

  type AccountSummary {
    username: String!
    name: String!
    userId: ID!
  }

  extend type Query {
    myWorkspaces: [Workspace!]!
    myTenants: [TenantMembership!]!
    workspaceMembers(workspaceId: ID!): [WorkspaceMember!]!
    tenantMembers(tenantId: ID!): [WorkspaceMember!]!
    searchAccounts(keyword: String!): [AccountSummary!]!
  }

  extend type Mutation {
    createWorkspace(name: String!): Workspace!
    renameWorkspace(id: ID!, name: String!): Workspace!
    deleteWorkspace(id: ID!): Boolean!
    addWorkspaceMember(workspaceId: ID!, userId: ID!): Workspace!
    removeWorkspaceMember(workspaceId: ID!, userId: ID!): Workspace!
    addTenantMember(tenantId: ID!, username: String!, role: TenantRole): WorkspaceMember!
    removeTenantMember(tenantId: ID!, userId: ID!): Boolean!
    changeTenantMemberRole(tenantId: ID!, userId: ID!, role: TenantRole!): WorkspaceMember!
  }
`;
