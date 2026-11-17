import { describe, it, expect } from 'vitest';
import {
  decodeRepoKnowledgeBaseId,
  isRepoKnowledgeBaseId,
  sourceLabel,
} from '../repo-knowledge-base';

describe('repo-knowledge-base id（T-RKB-WEB-L1）', () => {
  it('repo: 前缀判定', () => {
    expect(isRepoKnowledgeBaseId('repo:ws-1:zag:a')).toBe(true);
    expect(isRepoKnowledgeBaseId('507f1f77bcf86cd799439011')).toBe(false);
    expect(isRepoKnowledgeBaseId('')).toBe(false);
  });

  it('三段解码（folder decodeURIComponent）', () => {
    expect(
      decodeRepoKnowledgeBaseId('repo:ws-1:docs:%E5%9B%A2%E9%98%9F%20%E8%A7%84%E8%8C%83'),
    ).toEqual({ workspaceId: 'ws-1', source: 'DOCS', folder: '团队 规范' });
    expect(decodeRepoKnowledgeBaseId('repo:ws-1:zag:a')).toEqual({
      workspaceId: 'ws-1',
      source: 'ZAG',
      folder: 'a',
    });
  });

  it('非法形态返回 null', () => {
    expect(decodeRepoKnowledgeBaseId('repo:ws-1')).toBeNull();
    expect(decodeRepoKnowledgeBaseId('repo:ws-1:other:a')).toBeNull();
    expect(decodeRepoKnowledgeBaseId('repo:ws-1:zag:')).toBeNull();
    expect(decodeRepoKnowledgeBaseId('repo:ws-1:zag:%E0%A4%A')).toBeNull();
    expect(decodeRepoKnowledgeBaseId('abc')).toBeNull();
  });

  it('sourceLabel 两个来源', () => {
    expect(sourceLabel('ZAG')).toBe('.zag/knowledges');
    expect(sourceLabel('DOCS')).toBe('docs/knowledges');
  });
});
