import { describe, it, expect } from 'vitest';
import { resolveResourceSource } from '../workspace-source';
import type { WorkspaceData } from '../../graphql/types';

const TENANT = { id: 't1', name: '团队一', type: 'team' as const, memberCount: 2 };

function ws(id: string, type: 'global' | 'normal', readOnly = false): WorkspaceData {
  return {
    id,
    name: id,
    type,
    tenant: TENANT,
    memberCount: 1,
    myRole: readOnly ? 'developer' : 'admin',
    readOnly,
    createdAt: '',
  };
}

const GLOBAL = ws('ws-global', 'global');
const NORMAL = ws('ws-normal', 'normal');

describe('resolveResourceSource（共享资源来源徽标与只读收敛）', () => {
  it('当前工作区自身资源：标记本工作区且可编辑', () => {
    expect(resolveResourceSource(NORMAL.id, NORMAL, [GLOBAL, NORMAL])).toEqual({
      kind: 'workspace',
      label: '本工作区',
      editable: true,
    });
  });

  it('普通上下文中的全局工作区资源只读', () => {
    expect(resolveResourceSource(GLOBAL.id, NORMAL, [GLOBAL, NORMAL])).toEqual({
      kind: 'global',
      label: '全局工作区',
      editable: false,
    });
  });

  it('平台内置（workspaceId=null）资源只读', () => {
    expect(resolveResourceSource(null, GLOBAL, [GLOBAL, NORMAL])).toEqual({
      kind: 'global',
      label: '全局工作区',
      editable: false,
    });
  });

  it('全局工作区 + developer（readOnly）本工作区资源也不可编辑', () => {
    const readonlyGlobal = ws('ws-global', 'global', true);
    expect(resolveResourceSource(readonlyGlobal.id, readonlyGlobal, [readonlyGlobal])).toEqual({
      kind: 'workspace',
      label: '本工作区',
      editable: false,
    });
  });

  it('旧数据未携带 workspaceId（undefined）保持可编辑且无徽标', () => {
    expect(resolveResourceSource(undefined, NORMAL, [NORMAL])).toEqual({
      kind: 'unknown',
      label: null,
      editable: true,
    });
  });

  it('其他工作区资源只读', () => {
    const other = ws('ws-other', 'normal');
    expect(resolveResourceSource(other.id, NORMAL, [NORMAL])).toEqual({
      kind: 'other',
      label: '其他工作区',
      editable: false,
    });
  });
});
