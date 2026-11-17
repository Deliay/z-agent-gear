import { gql } from '@apollo/client';

/**
 * 知识库 GraphQL 域文件（契约 `contracts/knowledge-base.graphql`，计划 §5.7）。
 *
 * - 树/文档/历史查询统一 `cache-and-network`（组件侧传 fetchPolicy）；
 * - 全部 mutation 由调用方带 `refetchQueries`（树 + 受影响文档/历史），
 *   本文件只承载 query/mutation 与手写类型（与 preview/custom-tool/workflow 域文件同形态）。
 * - `createKnowledgeBaseDocument` **显式接收 path**（契约与 update 同形）。
 */

export type KnowledgeBasePermissionMode = 'NONE' | 'READ_ONLY' | 'UPDATE_ONLY' | 'FULL_ACCESS';
export type KnowledgeBaseEventOp = 'CREATE' | 'UPDATE' | 'DELETE';

export interface KnowledgeBaseAccessData {
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canManage: boolean;
}

export interface KnowledgeBaseData {
  id: string;
  name: string;
  permissionMode: KnowledgeBasePermissionMode;
  global: boolean;
  myAccess: KnowledgeBaseAccessData;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBaseDocumentMetaData {
  path: string;
  title: string;
  tags: string[];
  description: string;
  updatedAt: string;
}

export interface KnowledgeBaseDocumentData extends KnowledgeBaseDocumentMetaData {
  content: string;
  createdByName: string;
  updatedByName: string;
  createdAt: string;
}

export interface KnowledgeBaseTreeItemData {
  knowledgeBase: KnowledgeBaseData;
  documents: KnowledgeBaseDocumentMetaData[];
}

export interface KnowledgeBaseEventData {
  id: string;
  path: string;
  op: KnowledgeBaseEventOp;
  title: string;
  tags: string[];
  description: string;
  content: string;
  actorName: string;
  createdAt: string;
}

export interface KnowledgeBaseDocumentInput {
  title: string;
  tags: string[];
  description: string;
  content: string;
}

const KNOWLEDGE_BASE_ACCESS_FIELDS = gql`
  fragment KnowledgeBaseAccessFields on KnowledgeBaseAccess {
    canRead
    canCreate
    canUpdate
    canDelete
    canManage
  }
`;

const KNOWLEDGE_BASE_FIELDS = gql`
  fragment KnowledgeBaseFields on KnowledgeBase {
    id
    name
    permissionMode
    global
    myAccess {
      ...KnowledgeBaseAccessFields
    }
    createdAt
    updatedAt
  }
  ${KNOWLEDGE_BASE_ACCESS_FIELDS}
`;

const KNOWLEDGE_BASE_DOCUMENT_META_FIELDS = gql`
  fragment KnowledgeBaseDocumentMetaFields on KnowledgeBaseDocumentMeta {
    path
    title
    tags
    description
    updatedAt
  }
`;

const KNOWLEDGE_BASE_DOCUMENT_FIELDS = gql`
  fragment KnowledgeBaseDocumentFields on KnowledgeBaseDocument {
    path
    title
    tags
    description
    content
    createdByName
    updatedByName
    createdAt
    updatedAt
  }
`;

const KNOWLEDGE_BASE_EVENT_FIELDS = gql`
  fragment KnowledgeBaseEventFields on KnowledgeBaseEvent {
    id
    path
    op
    title
    tags
    description
    content
    actorName
    createdAt
  }
`;

export const GET_KNOWLEDGE_BASES = gql`
  query GetKnowledgeBases {
    knowledgeBases {
      ...KnowledgeBaseFields
    }
  }
  ${KNOWLEDGE_BASE_FIELDS}
`;

export const GET_KNOWLEDGE_BASE_TREE = gql`
  query GetKnowledgeBaseTree {
    knowledgeBaseTree {
      knowledgeBase {
        ...KnowledgeBaseFields
      }
      documents {
        ...KnowledgeBaseDocumentMetaFields
      }
    }
  }
  ${KNOWLEDGE_BASE_FIELDS}
  ${KNOWLEDGE_BASE_DOCUMENT_META_FIELDS}
`;

export const GET_KNOWLEDGE_BASE_DOCUMENT = gql`
  query GetKnowledgeBaseDocument($knowledgeBaseId: ID!, $path: String!) {
    knowledgeBaseDocument(knowledgeBaseId: $knowledgeBaseId, path: $path) {
      ...KnowledgeBaseDocumentFields
    }
  }
  ${KNOWLEDGE_BASE_DOCUMENT_FIELDS}
`;

export const GET_KNOWLEDGE_BASE_EVENTS = gql`
  query GetKnowledgeBaseEvents(
    $knowledgeBaseId: ID!
    $path: String
    $limit: Int
    $before: String
  ) {
    knowledgeBaseEvents(
      knowledgeBaseId: $knowledgeBaseId
      path: $path
      limit: $limit
      before: $before
    ) {
      ...KnowledgeBaseEventFields
    }
  }
  ${KNOWLEDGE_BASE_EVENT_FIELDS}
`;

export const CREATE_KNOWLEDGE_BASE = gql`
  mutation CreateKnowledgeBase($name: String!) {
    createKnowledgeBase(name: $name) {
      ...KnowledgeBaseFields
    }
  }
  ${KNOWLEDGE_BASE_FIELDS}
`;

export const RENAME_KNOWLEDGE_BASE = gql`
  mutation RenameKnowledgeBase($id: ID!, $name: String!) {
    renameKnowledgeBase(id: $id, name: $name) {
      ...KnowledgeBaseFields
    }
  }
  ${KNOWLEDGE_BASE_FIELDS}
`;

export const UPDATE_KNOWLEDGE_BASE_PERMISSION = gql`
  mutation UpdateKnowledgeBasePermission($id: ID!, $permissionMode: KnowledgeBasePermissionMode!) {
    updateKnowledgeBasePermission(id: $id, permissionMode: $permissionMode) {
      ...KnowledgeBaseFields
    }
  }
  ${KNOWLEDGE_BASE_FIELDS}
`;

export const DELETE_KNOWLEDGE_BASE = gql`
  mutation DeleteKnowledgeBase($id: ID!) {
    deleteKnowledgeBase(id: $id)
  }
`;

export const CREATE_KNOWLEDGE_BASE_DOCUMENT = gql`
  mutation CreateKnowledgeBaseDocument(
    $knowledgeBaseId: ID!
    $path: String!
    $input: KnowledgeBaseDocumentInput!
  ) {
    createKnowledgeBaseDocument(knowledgeBaseId: $knowledgeBaseId, path: $path, input: $input) {
      ...KnowledgeBaseDocumentFields
    }
  }
  ${KNOWLEDGE_BASE_DOCUMENT_FIELDS}
`;

export const UPDATE_KNOWLEDGE_BASE_DOCUMENT = gql`
  mutation UpdateKnowledgeBaseDocument(
    $knowledgeBaseId: ID!
    $path: String!
    $input: KnowledgeBaseDocumentInput!
  ) {
    updateKnowledgeBaseDocument(knowledgeBaseId: $knowledgeBaseId, path: $path, input: $input) {
      ...KnowledgeBaseDocumentFields
    }
  }
  ${KNOWLEDGE_BASE_DOCUMENT_FIELDS}
`;

export const DELETE_KNOWLEDGE_BASE_DOCUMENT = gql`
  mutation DeleteKnowledgeBaseDocument($knowledgeBaseId: ID!, $path: String!) {
    deleteKnowledgeBaseDocument(knowledgeBaseId: $knowledgeBaseId, path: $path)
  }
`;

export interface GetKnowledgeBasesQuery {
  knowledgeBases: KnowledgeBaseData[];
}

export interface GetKnowledgeBaseTreeQuery {
  knowledgeBaseTree: KnowledgeBaseTreeItemData[];
}

export interface GetKnowledgeBaseDocumentQuery {
  knowledgeBaseDocument: KnowledgeBaseDocumentData | null;
}

export interface GetKnowledgeBaseEventsQuery {
  knowledgeBaseEvents: KnowledgeBaseEventData[];
}

export interface CreateKnowledgeBaseMutation {
  createKnowledgeBase: KnowledgeBaseData;
}

export interface RenameKnowledgeBaseMutation {
  renameKnowledgeBase: KnowledgeBaseData;
}

export interface UpdateKnowledgeBasePermissionMutation {
  updateKnowledgeBasePermission: KnowledgeBaseData;
}

export interface DeleteKnowledgeBaseMutation {
  deleteKnowledgeBase: boolean;
}

export interface CreateKnowledgeBaseDocumentMutation {
  createKnowledgeBaseDocument: KnowledgeBaseDocumentData;
}

export interface UpdateKnowledgeBaseDocumentMutation {
  updateKnowledgeBaseDocument: KnowledgeBaseDocumentData;
}

export interface DeleteKnowledgeBaseDocumentMutation {
  deleteKnowledgeBaseDocument: boolean;
}

/* ------------------------------------------------------------------ */
/* 仓库内建知识库（需求 #545，四级只读查询 + 懒加载）                   */
/* ------------------------------------------------------------------ */

export type RepoKnowledgeBaseSourceData = 'ZAG' | 'DOCS';
export type RepoKnowledgeBaseNodeKindData = 'FOLDER' | 'DOCUMENT';

export interface RepoKnowledgeBaseHostData {
  cloudHostId: string;
  cloudHostName: string;
  workspaceId: string;
  scanSupported: boolean;
}

export interface RepoKnowledgeBaseData {
  id: string;
  name: string;
  description: string;
  source: RepoKnowledgeBaseSourceData;
  folder: string;
  workspaceId: string;
  cloudHostId: string;
  cloudHostName: string;
  valid: boolean;
  errors: string[];
  documentCount: number;
  truncated: boolean;
}

export interface RepoKnowledgeBaseNodeData {
  kind: RepoKnowledgeBaseNodeKindData;
  name: string;
  path: string;
}

export interface RepoKnowledgeBaseDocumentData {
  path: string;
  title: string;
  content: string;
}

export const GET_REPO_KNOWLEDGE_BASE_HOSTS = gql`
  query GetRepoKnowledgeBaseHosts {
    repoKnowledgeBaseHosts {
      cloudHostId
      cloudHostName
      workspaceId
      scanSupported
    }
  }
`;

export const GET_REPO_KNOWLEDGE_BASES = gql`
  query GetRepoKnowledgeBases($workspaceId: ID!, $refresh: Boolean) {
    repoKnowledgeBases(workspaceId: $workspaceId, refresh: $refresh) {
      id
      name
      description
      source
      folder
      workspaceId
      cloudHostId
      cloudHostName
      valid
      errors
      documentCount
      truncated
    }
  }
`;

export const GET_REPO_KNOWLEDGE_BASE_CHILDREN = gql`
  query GetRepoKnowledgeBaseChildren($id: ID!, $path: String) {
    repoKnowledgeBaseDocumentChildren(id: $id, path: $path) {
      kind
      name
      path
    }
  }
`;

export const GET_REPO_KNOWLEDGE_BASE_DOCUMENT = gql`
  query GetRepoKnowledgeBaseDocument($id: ID!, $path: String!) {
    repoKnowledgeBaseDocument(id: $id, path: $path) {
      path
      title
      content
    }
  }
`;

export interface GetRepoKnowledgeBaseHostsQuery {
  repoKnowledgeBaseHosts: RepoKnowledgeBaseHostData[];
}

export interface GetRepoKnowledgeBasesQuery {
  repoKnowledgeBases: RepoKnowledgeBaseData[];
}

export interface GetRepoKnowledgeBaseChildrenQuery {
  repoKnowledgeBaseDocumentChildren: RepoKnowledgeBaseNodeData[];
}

export interface GetRepoKnowledgeBaseDocumentQuery {
  repoKnowledgeBaseDocument: RepoKnowledgeBaseDocumentData | null;
}
