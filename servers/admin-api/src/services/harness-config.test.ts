import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  model: {
    find: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock('../models/harness-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../models/harness-config.js')>();
  return { ...actual, HarnessConfig: h.model };
});

import {
  DEFAULT_COMPACT_COMMAND,
  UNSET_UPDATED_AT,
  HarnessConfigService,
  validateCompactCommand,
} from './harness-config.js';
import { HARNESS_CONFIG_TYPES } from '../models/harness-config.js';

const service = new HarnessConfigService();

function leanList(value: unknown[]) {
  return { lean: async () => value };
}
function leanOne(value: unknown) {
  return { lean: async () => value };
}

describe('harness-config 服务（T-HCA）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('T-HCA1: upsert 校验矩阵', () => {
    function expectInvalid(raw: unknown) {
      expect(() => validateCompactCommand(raw)).toThrow(/^invalid compact command$/);
    }

    it('空串 / 纯空白 / 超 64 字符 / 不以 `/` 开头 → invalid compact command', () => {
      expectInvalid('');
      expectInvalid('   ');
      expectInvalid(`/${'a'.repeat(64)}`);
      expectInvalid('compact');
      expectInvalid('#compact');
      expectInvalid(undefined);
      expectInvalid(null);
      expectInvalid(42);
    });

    it('边界值：单字符 `/` 与 trim 后恰好 64 字符合法', () => {
      expect(validateCompactCommand('/')).toBe('/');
      const atLimit = `/${'a'.repeat(63)}`;
      expect(atLimit).toHaveLength(64);
      expect(validateCompactCommand(`  ${atLimit}  `)).toBe(atLimit);
    });

    it('合法值 upsert 成功：trim 后落库、returnDocument=after、返回视图', async () => {
      h.model.findOneAndUpdate.mockReturnValue(
        leanOne({
          harnessType: 'OPENCODE',
          compactCommand: '/trimmed',
          updatedAt: new Date('2026-01-02T03:04:05.000Z'),
        }),
      );

      const view = await service.upsertConfig('OPENCODE', '  /trimmed  ');

      expect(h.model.findOneAndUpdate).toHaveBeenCalledWith(
        { harnessType: 'OPENCODE' },
        { $set: { compactCommand: '/trimmed' } },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      );
      expect(view).toEqual({
        harnessType: 'OPENCODE',
        compactCommand: '/trimmed',
        updatedAt: '2026-01-02T03:04:05.000Z',
      });
    });

    it('非法 compactCommand 在落库前被拒绝（不写库）', async () => {
      await expect(service.upsertConfig('KIMI_CODE', 'no-slash')).rejects.toThrow(
        /^invalid compact command$/,
      );
      expect(h.model.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('非法 harnessType → invalid harness type（不写库）', async () => {
      await expect(service.upsertConfig('CLAUDE_CODE' as never, '/compact')).rejects.toThrow(
        /^invalid harness type$/,
      );
      expect(h.model.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('T-HCA2: listConfigs 恒返回三 Harness', () => {
    it('空库：三种 Harness 全量返回并归一为默认 /compact（updatedAt 稳定占位）', async () => {
      h.model.find.mockReturnValue(leanList([]));

      const list = await service.listConfigs();

      expect(h.model.find).toHaveBeenCalledTimes(1);
      expect(h.model.find).toHaveBeenCalledWith({});
      expect(list.map((item) => item.harnessType)).toEqual([...HARNESS_CONFIG_TYPES]);
      expect(list).toHaveLength(3);
      for (const item of list) {
        expect(item).toEqual({
          harnessType: item.harnessType,
          compactCommand: DEFAULT_COMPACT_COMMAND,
          updatedAt: UNSET_UPDATED_AT,
        });
      }
      expect(UNSET_UPDATED_AT).toBe(new Date(0).toISOString());
    });

    it('部分落库：已配置返回库内值，其余以默认值补齐（顺序固定）', async () => {
      h.model.find.mockReturnValue(
        leanList([
          {
            harnessType: 'KIMI_CODE',
            compactCommand: '/kimi-compact',
            updatedAt: new Date('2026-02-03T04:05:06.000Z'),
          },
        ]),
      );

      const list = await service.listConfigs();
      const byType = new Map(list.map((item) => [item.harnessType, item]));

      expect(list.map((item) => item.harnessType)).toEqual([...HARNESS_CONFIG_TYPES]);
      expect(byType.get('KIMI_CODE')).toEqual({
        harnessType: 'KIMI_CODE',
        compactCommand: '/kimi-compact',
        updatedAt: '2026-02-03T04:05:06.000Z',
      });
      expect(byType.get('OPENCODE')).toEqual({
        harnessType: 'OPENCODE',
        compactCommand: DEFAULT_COMPACT_COMMAND,
        updatedAt: UNSET_UPDATED_AT,
      });
      expect(byType.get('DEEPSEEK_HARNESS')).toEqual({
        harnessType: 'DEEPSEEK_HARNESS',
        compactCommand: DEFAULT_COMPACT_COMMAND,
        updatedAt: UNSET_UPDATED_AT,
      });
    });
  });
});
