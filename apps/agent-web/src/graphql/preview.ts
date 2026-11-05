import { gql } from '@apollo/client';

/**
 * 会话内容预览与 Review 查询（#461）：
 * - `sessionFileContent`：fs:read-file relay 读取会话工作区内文件
 * - `sessionReview` / `submitSessionReview`：会话内建 Review 生命周期
 */

export interface SessionReviewCommentData {
  id: string;
  anchor: {
    kind: string;
    filePath?: string;
    startLine?: number;
    endLine?: number;
    selector?: string;
    innerHtml?: string;
    text?: string;
    startOffset?: number;
    endOffset?: number;
  };
  body: string;
  createdAt: string;
}

export interface SessionReviewData {
  id: string;
  sessionId: string;
  files: string[];
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'COMMENTED' | 'CANCELLED';
  fileReviews: Record<string, SessionReviewCommentData[]> | null;
  comment: string | null;
  cancelReason: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface SessionFileContentData {
  path: string;
  content: string;
  truncated: boolean;
  sizeBytes: number;
}

export const GET_SESSION_FILE_CONTENT = gql`
  query GetSessionFileContent($sessionId: ID!, $path: String!) {
    sessionFileContent(sessionId: $sessionId, path: $path) {
      path
      content
      truncated
      sizeBytes
    }
  }
`;

export const GET_SESSION_REVIEW = gql`
  query GetSessionReview($id: ID!) {
    sessionReview(id: $id) {
      id
      sessionId
      files
      status
      fileReviews
      comment
      cancelReason
      createdAt
      resolvedAt
    }
  }
`;

export const SUBMIT_SESSION_REVIEW = gql`
  mutation SubmitSessionReview($id: ID!, $input: SubmitSessionReviewInput!) {
    submitSessionReview(id: $id, input: $input) {
      id
      sessionId
      files
      status
      fileReviews
      comment
      cancelReason
      createdAt
      resolvedAt
    }
  }
`;
