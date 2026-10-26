import { describe, it, expect } from 'vitest';
import {
  CloudHostIssuesLinkage,
  dedupeRepoNames,
} from './cloud-host-issues-linkage.js';

describe('dedupeRepoNames', () => {
  it('trim、去空、大小写不敏感去重并保留首序', () => {
    expect(dedupeRepoNames([' a/b ', 'A/B', '', null as never, 'c/d'])).toEqual(['a/b', 'c/d']);
  });
});

describe('CloudHostIssuesLinkage 归一化', () => {
  it('保存前生成 labelNameLower 并归一仓库列表', async () => {
    const doc = new CloudHostIssuesLinkage({
      userId: '507f1f77bcf86cd799439011',
      controllerId: '507f1f77bcf86cd799439012',
      configuredWorkflowId: '507f1f77bcf86cd799439013',
      configuredWorkflowName: '开发流程',
      labelName: '  Start-Dev  ',
      repoFullNames: [' a/b ', 'A/B', 'c/d'],
    });

    await doc.validate();

    expect(doc.labelName).toBe('Start-Dev');
    expect(doc.labelNameLower).toBe('start-dev');
    expect(doc.repoFullNames).toEqual(['a/b', 'c/d']);
  });
});
