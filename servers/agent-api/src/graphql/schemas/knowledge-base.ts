// 严格对齐 contracts/knowledge-base.graphql（见 schemas/knowledge-base.test.ts 逐字段比对）
// 手写 schema 双写：漏改此处即运行时 `Cannot query field`。
export const knowledgeBaseTypeDefs = `#graphql
  enum KnowledgeBasePermissionMode {
    NONE
    READ_ONLY
    UPDATE_ONLY
    FULL_ACCESS
  }

  enum KnowledgeBaseEventOp {
    CREATE
    UPDATE
    DELETE
    MOVE
  }

  type KnowledgeBaseAccess {
    canRead: Boolean!
    canCreate: Boolean!
    canUpdate: Boolean!
    canDelete: Boolean!
    canManage: Boolean!
  }

  type KnowledgeBase {
    id: ID!
    name: String!
    permissionMode: KnowledgeBasePermissionMode!
    global: Boolean!
    myAccess: KnowledgeBaseAccess!
    createdAt: String!
    updatedAt: String!
  }

  type KnowledgeBaseDocumentMeta {
    path: String!
    title: String!
    tags: [String!]!
    description: String!
    updatedAt: String!
  }

  type KnowledgeBaseDocument {
    path: String!
    title: String!
    tags: [String!]!
    description: String!
    content: String!
    createdByName: String!
    updatedByName: String!
    createdAt: String!
    updatedAt: String!
  }

  type KnowledgeBaseTreeItem {
    knowledgeBase: KnowledgeBase!
    documents: [KnowledgeBaseDocumentMeta!]!
  }

  type KnowledgeBaseEvent {
    id: ID!
    path: String!
    op: KnowledgeBaseEventOp!
    fromPath: String
    title: String!
    tags: [String!]!
    description: String!
    content: String!
    actorName: String!
    createdAt: String!
  }

  input KnowledgeBaseDocumentInput {
    title: String!
    tags: [String!]!
    description: String!
    content: String!
  }

  enum RepoKnowledgeBaseSource {
    ZAG
    DOCS
    DOCS_ROOT
  }

  type RepoKnowledgeBaseHost {
    cloudHostId: ID!
    cloudHostName: String!
    workspaceId: ID!
    scanSupported: Boolean!
  }

  type RepoKnowledgeBase {
    id: ID!
    name: String!
    description: String!
    source: RepoKnowledgeBaseSource!
    folder: String!
    workspaceId: ID!
    cloudHostId: ID!
    cloudHostName: String!
    valid: Boolean!
    errors: [String!]!
    documentCount: Int!
    truncated: Boolean!
  }

  enum RepoKnowledgeBaseNodeKind {
    FOLDER
    DOCUMENT
  }

  type RepoKnowledgeBaseNode {
    kind: RepoKnowledgeBaseNodeKind!
    name: String!
    path: String!
    error: String
  }

  type RepoKnowledgeBaseDocument {
    path: String!
    title: String!
    content: String!
  }

  extend type Query {
    knowledgeBases: [KnowledgeBase!]!
    knowledgeBaseTree: [KnowledgeBaseTreeItem!]!
    knowledgeBaseDocuments(knowledgeBaseId: ID!, prefix: String): [KnowledgeBaseDocumentMeta!]!
    knowledgeBaseDocument(knowledgeBaseId: ID!, path: String!): KnowledgeBaseDocument
    knowledgeBaseEvents(knowledgeBaseId: ID!, path: String, limit: Int, before: String): [KnowledgeBaseEvent!]!

    repoKnowledgeBaseHosts: [RepoKnowledgeBaseHost!]!
    repoKnowledgeBases(workspaceId: ID!, refresh: Boolean): [RepoKnowledgeBase!]!
    repoKnowledgeBaseDocumentChildren(id: ID!, path: String): [RepoKnowledgeBaseNode!]!
    repoKnowledgeBaseDocument(id: ID!, path: String!): RepoKnowledgeBaseDocument
  }

  extend type Mutation {
    createKnowledgeBase(name: String!): KnowledgeBase!
    renameKnowledgeBase(id: ID!, name: String!): KnowledgeBase!
    updateKnowledgeBasePermission(id: ID!, permissionMode: KnowledgeBasePermissionMode!): KnowledgeBase!
    deleteKnowledgeBase(id: ID!): Boolean!
    createKnowledgeBaseDocument(knowledgeBaseId: ID!, path: String!, input: KnowledgeBaseDocumentInput!): KnowledgeBaseDocument!
    updateKnowledgeBaseDocument(knowledgeBaseId: ID!, path: String!, input: KnowledgeBaseDocumentInput!, newPath: String): KnowledgeBaseDocument!
    deleteKnowledgeBaseDocument(knowledgeBaseId: ID!, path: String!): Boolean!
  }
`;
