import { describe, it, expect } from 'vitest';
import {
  CUSTOM_MCP_MAX_HEADERS,
  CUSTOM_MCP_MAX_HEADER_VALUE_LENGTH,
  normalizeCustomMcpHeaders,
} from '../custom-mcp';

describe('normalizeCustomMcpHeaders（请求头归一与本地校验）', () => {
  it('归一：key/value trim、空值行丢弃、空行条目剔除', () => {
    const result = normalizeCustomMcpHeaders([
      { key: '  X-Api-Key  ', values: [' a ', '', 'b'] },
      { key: '', values: [] },
    ]);

    expect(result.error).toBeNull();
    expect(result.headers).toEqual([{ key: 'X-Api-Key', values: ['a', 'b'] }]);
  });

  it('同名多值走同一行（每行一个值）不报错', () => {
    const result = normalizeCustomMcpHeaders([{ key: 'X-List', values: ['1', '2', '3'] }]);

    expect(result.error).toBeNull();
    expect(result.headers).toEqual([{ key: 'X-List', values: ['1', '2', '3'] }]);
  });

  it('同名两行 → 明确中文文案「请求头名称重复」且不返回条目', () => {
    const result = normalizeCustomMcpHeaders([
      { key: 'X-Api-Key', values: ['a'] },
      { key: 'X-Api-Key', values: ['b'] },
    ]);

    expect(result.error).toBe('请求头名称重复：X-Api-Key');
    expect(result.headers).toEqual([]);
  });

  it('同名两行（含两侧空白差异，trim 后同名）同样拒绝', () => {
    const result = normalizeCustomMcpHeaders([
      { key: 'X-Token', values: ['a'] },
      { key: ' X-Token ', values: ['b'] },
    ]);

    expect(result.error).toBe('请求头名称重复：X-Token');
    expect(result.headers).toEqual([]);
  });

  it('key 含空白或冒号 → 拒绝', () => {
    expect(normalizeCustomMcpHeaders([{ key: 'X Bad', values: ['a'] }]).error).toBe(
      '请求头名称不能为空且不能包含空白或冒号',
    );
    expect(normalizeCustomMcpHeaders([{ key: 'X:Bad', values: ['a'] }]).error).toBe(
      '请求头名称不能为空且不能包含空白或冒号',
    );
  });

  it('有 key 无值 → 拒绝', () => {
    expect(normalizeCustomMcpHeaders([{ key: 'X-Empty', values: [] }]).error).toBe(
      '请求头 X-Empty 至少需要一个值',
    );
  });

  it('超条数上限与超长值 → 拒绝', () => {
    const tooMany = Array.from({ length: CUSTOM_MCP_MAX_HEADERS + 1 }, (_, index) => ({
      key: `X-${index}`,
      values: ['v'],
    }));
    expect(normalizeCustomMcpHeaders(tooMany).error).toBe(
      `自定义请求头最多 ${CUSTOM_MCP_MAX_HEADERS} 条`,
    );

    expect(
      normalizeCustomMcpHeaders([
        { key: 'X-Long', values: ['v'.repeat(CUSTOM_MCP_MAX_HEADER_VALUE_LENGTH + 1)] },
      ]).error,
    ).toBe(`请求头 X-Long 的值最多 4096 个字符`);
  });
});
