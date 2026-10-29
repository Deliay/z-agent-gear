import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { buildTenantIdCandidates, resolveGlobalWorkspaceId } from './workspace-resolver.js';

describe('workspace-resolver（多租户二期 workspaceId 回退解析）', () => {
  it('T-MIG002a: buildTenantIdCandidates 追加 ObjectId 候选（兼容 workspaces.tenantId 的 ObjectId/String 双口径）', () => {
    const hex = new mongoose.Types.ObjectId().toHexString();
    const candidates = buildTenantIdCandidates(hex);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toBe(hex);
    expect(candidates[1]).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(candidates[1])).toBe(hex);

    // 非 24 位 hex（personal 期历史值/自定义 id）只保留字符串候选
    expect(buildTenantIdCandidates('tenant-1')).toEqual(['tenant-1']);
  });

  it('resolveGlobalWorkspaceId: 空 tenantId 或未连接数据库时返回 null（不发起查询、不缓冲挂起）', async () => {
    expect(await resolveGlobalWorkspaceId(null)).toBeNull();
    expect(await resolveGlobalWorkspaceId(undefined)).toBeNull();
    expect(await resolveGlobalWorkspaceId('   ')).toBeNull();
    // 未连接（readyState !== 1）：直接降级 null，避免 Mongoose 命令缓冲导致请求挂起
    expect(mongoose.connection.readyState).not.toBe(1);
    expect(await resolveGlobalWorkspaceId('tenant-1')).toBeNull();
  });
});
