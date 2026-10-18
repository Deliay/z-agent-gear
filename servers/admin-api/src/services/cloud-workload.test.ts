import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/cloud-workload.js', () => ({
  CloudWorkload: {
    find: vi.fn(),
    findById: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    create: vi.fn(),
    deleteOne: vi.fn(),
  },
}));
vi.mock('../models/cloud-workload-log.js', () => ({
  findStoredWorkloadLogs: vi.fn(),
}));

import { CloudWorkload } from '../models/cloud-workload.js';
import { findStoredWorkloadLogs } from '../models/cloud-workload-log.js';
import {
  CloudWorkloadService,
  WORKLOAD_SCRIPT_MAX_BYTES,
  mapWorkloadLog,
} from './cloud-workload';

function makeWorkload(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'w1' },
    name: 'setup',
    initScript: 'echo init',
    postScript: null,
    paramSchema: [],
    dependsOnWorkloadIds: [],
    isPreset: false,
    createdAt: new Date('2026-10-17T00:00:00.000Z'),
    updatedAt: new Date('2026-10-17T01:00:00.000Z'),
    ...overrides,
  };
}

/** findById mock helper */
function mockFindById(doc: unknown) {
  (CloudWorkload.findById as any).mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });
}

describe('CloudWorkloadService', () => {
  const service = new CloudWorkloadService();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create (T-W1/T-W2/T-W3)', () => {
    it('T-W1: creates a workload with only an init script', async () => {
      const doc = makeWorkload({ name: 'setup', initScript: 'echo init', postScript: null });
      (CloudWorkload.create as any).mockResolvedValue({ ...doc, toObject: () => doc });

      const result = await service.create({ name: 'setup', initScript: 'echo init' });

      expect(CloudWorkload.create).toHaveBeenCalledWith({
        name: 'setup',
        initScript: 'echo init',
        postScript: null,
        paramSchema: [],
        dependsOnWorkloadIds: [],
      });
      expect(result).toEqual({
        id: 'w1',
        name: 'setup',
        initScript: 'echo init',
        postScript: null,
        paramSchema: [],
        dependsOnWorkloadIds: [],
        isPreset: false,
        createdAt: '2026-10-17T00:00:00.000Z',
        updatedAt: '2026-10-17T01:00:00.000Z',
      });
    });

    it('T-W1: creates a workload with only a post script', async () => {
      const doc = makeWorkload({ name: 'cleanup', initScript: null, postScript: 'echo bye' });
      (CloudWorkload.create as any).mockResolvedValue({ ...doc, toObject: () => doc });

      const result = await service.create({ name: 'cleanup', postScript: 'echo bye' });

      expect(result.initScript).toBeNull();
      expect(result.postScript).toBe('echo bye');
    });

    it('T-W1: creates a workload with both scripts (trims the name)', async () => {
      const doc = makeWorkload({ name: 'both' });
      (CloudWorkload.create as any).mockResolvedValue({ ...doc, toObject: () => doc });

      await service.create({ name: '  both  ', initScript: 'a', postScript: 'b' });

      expect(CloudWorkload.create).toHaveBeenCalledWith({
        name: 'both',
        initScript: 'a',
        postScript: 'b',
        paramSchema: [],
        dependsOnWorkloadIds: [],
      });
    });

    it('T-W2: rejects a blank name', async () => {
      await expect(service.create({ name: '   ', initScript: 'a' })).rejects.toThrow('name is required');
      expect(CloudWorkload.create).not.toHaveBeenCalled();
    });

    it('T-W2: rejects a name longer than 64 characters', async () => {
      await expect(service.create({ name: 'x'.repeat(65), initScript: 'a' })).rejects.toThrow(
        'name must be at most 64 characters',
      );
    });

    it('T-W2: rejects when both scripts are empty', async () => {
      await expect(service.create({ name: 'setup' })).rejects.toThrow('at least one script is required');
      await expect(service.create({ name: 'setup', initScript: '  ', postScript: '' })).rejects.toThrow(
        'at least one script is required',
      );
      expect(CloudWorkload.create).not.toHaveBeenCalled();
    });

    it('T-W2: rejects an init script larger than 16 KiB', async () => {
      const huge = 'a'.repeat(WORKLOAD_SCRIPT_MAX_BYTES + 1);
      await expect(service.create({ name: 'setup', initScript: huge })).rejects.toThrow(
        'initScript must be at most 16 KiB',
      );
    });

    it('T-W2: rejects a post script larger than 16 KiB', async () => {
      const huge = 'a'.repeat(WORKLOAD_SCRIPT_MAX_BYTES + 1);
      await expect(service.create({ name: 'setup', postScript: huge })).rejects.toThrow(
        'postScript must be at most 16 KiB',
      );
    });

    it('T-W2: accepts a script exactly at the 16 KiB limit', async () => {
      const exact = 'a'.repeat(WORKLOAD_SCRIPT_MAX_BYTES);
      const doc = makeWorkload({ initScript: exact });
      (CloudWorkload.create as any).mockResolvedValue({ ...doc, toObject: () => doc });

      await expect(service.create({ name: 'setup', initScript: exact })).resolves.toBeTruthy();
    });

    it('T-W3: propagates the E11000 duplicate key error for resolver mapping', async () => {
      (CloudWorkload.create as any).mockRejectedValue(new Error('E11000 duplicate key error'));
      await expect(service.create({ name: 'setup', initScript: 'a' })).rejects.toThrow('E11000');
    });
  });

  describe('paramSchema (T-W8/T-W9)', () => {
    it('T-W8: normalizes the four param types and uppercases the type on output', async () => {
      const doc = makeWorkload({
        paramSchema: [
          { key: 'mode', label: '模式', type: 'select', options: ['a', 'b'], defaultValue: 'a' },
          {
            key: 'managers',
            label: '管理器',
            type: 'multi_select',
            options: ['npm', 'pnpm'],
            defaultValue: ['npm'],
          },
          { key: 'note', label: '备注', type: 'text', options: [], defaultValue: 'x' },
          { key: 'enabled', label: '启用', type: 'boolean', options: [], defaultValue: true },
        ],
      });
      (CloudWorkload.create as any).mockResolvedValue({ ...doc, toObject: () => doc });

      const result = await service.create({
        name: 'setup',
        initScript: 'a',
        paramSchema: [
          { key: 'mode', label: '模式', type: 'SELECT', options: ['a', 'b'], defaultValue: 'a' },
          {
            key: 'managers',
            label: '管理器',
            type: 'MULTI_SELECT',
            options: ['npm', 'pnpm'],
            defaultValue: ['npm'],
          },
          { key: 'note', label: '备注', type: 'TEXT', options: null, defaultValue: 'x' },
          { key: 'enabled', label: '启用', type: 'BOOLEAN', defaultValue: true },
        ],
      });

      // 存储为小写类型；非下拉类型的 options 归一为 []
      expect(CloudWorkload.create).toHaveBeenCalledWith({
        name: 'setup',
        initScript: 'a',
        postScript: null,
        paramSchema: [
          { key: 'mode', label: '模式', type: 'select', options: ['a', 'b'], defaultValue: 'a' },
          {
            key: 'managers',
            label: '管理器',
            type: 'multi_select',
            options: ['npm', 'pnpm'],
            defaultValue: ['npm'],
          },
          { key: 'note', label: '备注', type: 'text', options: [], defaultValue: 'x' },
          { key: 'enabled', label: '启用', type: 'boolean', options: [], defaultValue: true },
        ],
        dependsOnWorkloadIds: [],
      });

      // 输出为 GraphQL 大写枚举
      expect(result.paramSchema.map((field) => field.type)).toEqual([
        'SELECT',
        'MULTI_SELECT',
        'TEXT',
        'BOOLEAN',
      ]);
    });

    it('T-W8: an empty/omitted paramSchema means no configuration', async () => {
      const doc = makeWorkload();
      (CloudWorkload.create as any).mockResolvedValue({ ...doc, toObject: () => doc });

      await service.create({ name: 'setup', initScript: 'a', paramSchema: [] });

      expect((CloudWorkload.create as any).mock.calls[0][0].paramSchema).toEqual([]);
    });

    it('T-W9: rejects more than 20 parameters', async () => {
      const paramSchema = Array.from({ length: 21 }, (_v, i) => ({
        key: `p${i}`,
        label: 'p',
        type: 'TEXT',
        defaultValue: 'x',
      }));
      await expect(service.create({ name: 'setup', initScript: 'a', paramSchema })).rejects.toThrow(
        'too many parameters',
      );
    });

    it('T-W9: rejects an invalid key', async () => {
      await expect(
        service.create({
          name: 'setup',
          initScript: 'a',
          paramSchema: [{ key: 'BadKey', label: 'x', type: 'TEXT', defaultValue: 'x' }],
        }),
      ).rejects.toThrow('paramSchema[0].key is invalid');
    });

    it('T-W9: rejects a duplicate key with the field path', async () => {
      await expect(
        service.create({
          name: 'setup',
          initScript: 'a',
          paramSchema: [
            { key: 'mode', label: 'x', type: 'TEXT', defaultValue: 'x' },
            { key: 'mode', label: 'y', type: 'TEXT', defaultValue: 'y' },
          ],
        }),
      ).rejects.toThrow('paramSchema[1].key is duplicated');
    });

    it('T-W9: rejects an over-long label', async () => {
      await expect(
        service.create({
          name: 'setup',
          initScript: 'a',
          paramSchema: [{ key: 'mode', label: 'x'.repeat(65), type: 'TEXT', defaultValue: 'x' }],
        }),
      ).rejects.toThrow('paramSchema[0].label is invalid');
    });

    it('T-W9: rejects empty / duplicate / over-limit options', async () => {
      await expect(
        service.create({
          name: 'setup',
          initScript: 'a',
          paramSchema: [{ key: 'mode', label: 'x', type: 'SELECT', options: [], defaultValue: 'a' }],
        }),
      ).rejects.toThrow('paramSchema[0].options is invalid');

      await expect(
        service.create({
          name: 'setup',
          initScript: 'a',
          paramSchema: [
            { key: 'mode', label: 'x', type: 'SELECT', options: ['a', 'a'], defaultValue: 'a' },
          ],
        }),
      ).rejects.toThrow('paramSchema[0].options is invalid');

      await expect(
        service.create({
          name: 'setup',
          initScript: 'a',
          paramSchema: [
            {
              key: 'mode',
              label: 'x',
              type: 'SELECT',
              options: Array.from({ length: 51 }, (_v, i) => `o${i}`),
              defaultValue: 'o0',
            },
          ],
        }),
      ).rejects.toThrow('paramSchema[0].options is invalid');
    });

    it('T-W9: rejects a default value outside options / with the wrong type', async () => {
      await expect(
        service.create({
          name: 'setup',
          initScript: 'a',
          paramSchema: [{ key: 'mode', label: 'x', type: 'SELECT', options: ['a'], defaultValue: 'b' }],
        }),
      ).rejects.toThrow('paramSchema[0].defaultValue is invalid');

      await expect(
        service.create({
          name: 'setup',
          initScript: 'a',
          paramSchema: [{ key: 'enabled', label: 'x', type: 'BOOLEAN', defaultValue: 'yes' }],
        }),
      ).rejects.toThrow('paramSchema[0].defaultValue is invalid');
    });

    it('T-W9: rejects a missing default value', async () => {
      await expect(
        service.create({
          name: 'setup',
          initScript: 'a',
          paramSchema: [{ key: 'note', label: 'x', type: 'TEXT', defaultValue: null }],
        }),
      ).rejects.toThrow('paramSchema[0].defaultValue is invalid');
    });
  });

  describe('dependsOnWorkloadIds (T-W10)', () => {
    it('T-W10: accepts valid dependencies (existence check)', async () => {
      (CloudWorkload.find as any).mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ _id: 'w2' }, { _id: 'w3' }]),
      });
      const doc = makeWorkload({ dependsOnWorkloadIds: ['w2', 'w3'] });
      (CloudWorkload.create as any).mockResolvedValue({ ...doc, toObject: () => doc });

      const result = await service.create({
        name: 'setup',
        initScript: 'a',
        dependsOnWorkloadIds: ['w2', 'w3'],
      });

      expect(CloudWorkload.find).toHaveBeenCalledWith({ _id: { $in: ['w2', 'w3'] } });
      expect(result.dependsOnWorkloadIds).toEqual(['w2', 'w3']);
    });

    it('T-W10: dedupes dependencies while preserving order', async () => {
      (CloudWorkload.find as any).mockReturnValue({ lean: vi.fn().mockResolvedValue([{ _id: 'w2' }]) });
      const doc = makeWorkload({ dependsOnWorkloadIds: ['w2'] });
      (CloudWorkload.create as any).mockResolvedValue({ ...doc, toObject: () => doc });

      await service.create({ name: 'setup', initScript: 'a', dependsOnWorkloadIds: ['w2', 'w2'] });

      expect((CloudWorkload.create as any).mock.calls[0][0].dependsOnWorkloadIds).toEqual(['w2']);
    });

    it('T-W10: rejects more than 5 dependencies', async () => {
      await expect(
        service.create({
          name: 'setup',
          initScript: 'a',
          dependsOnWorkloadIds: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'],
        }),
      ).rejects.toThrow('too many dependencies');
      expect(CloudWorkload.find).not.toHaveBeenCalled();
    });

    it('T-W10: rejects a self dependency on update', async () => {
      mockFindById(makeWorkload());
      await expect(
        service.update('w1', { dependsOnWorkloadIds: ['w1'] }),
      ).rejects.toThrow('workload cannot depend on itself');
    });

    it('T-W10: rejects a missing dependency', async () => {
      (CloudWorkload.find as any).mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
      await expect(
        service.create({ name: 'setup', initScript: 'a', dependsOnWorkloadIds: ['ghost'] }),
      ).rejects.toThrow('dependency workload not found');
    });

    it('T-W10: rejects a dependency cycle with the cycle path', async () => {
      mockFindById(makeWorkload());
      (CloudWorkload.find as any).mockImplementation((filter: Record<string, unknown>) => {
        if (filter && filter._id) {
          return { lean: vi.fn().mockResolvedValue([{ _id: 'w2' }]) };
        }
        // 全量依赖图：w1 → w2 → w1
        return {
          lean: vi.fn().mockResolvedValue([
            { _id: 'w1', dependsOnWorkloadIds: [] },
            { _id: 'w2', dependsOnWorkloadIds: ['w1'] },
          ]),
        };
      });

      await expect(service.update('w1', { dependsOnWorkloadIds: ['w2'] })).rejects.toThrow(
        'dependency cycle detected',
      );
      expect(CloudWorkload.findByIdAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('update (T-W3/T-W4)', () => {
    it('T-W4: returns null when the workload does not exist', async () => {
      mockFindById(null);

      expect(await service.update('missing', { name: 'x' })).toBeNull();
      expect(CloudWorkload.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('updates the name while keeping existing scripts', async () => {
      const existing = makeWorkload({ initScript: 'echo init', postScript: null });
      mockFindById(existing);
      const updated = makeWorkload({ name: 'renamed', initScript: 'echo init', postScript: null });
      (CloudWorkload.findByIdAndUpdate as any).mockResolvedValue(updated);

      const result = await service.update('w1', { name: 'renamed' });

      expect(CloudWorkload.findByIdAndUpdate).toHaveBeenCalledWith(
        'w1',
        {
          name: 'renamed',
          initScript: 'echo init',
          postScript: null,
          paramSchema: [],
          dependsOnWorkloadIds: [],
        },
        { new: true, lean: true },
      );
      expect(result!.name).toBe('renamed');
    });

    it('T-W2: rejects clearing the only remaining script (merged final state)', async () => {
      mockFindById(makeWorkload({ initScript: 'echo init', postScript: null }));

      await expect(service.update('w1', { initScript: '' })).rejects.toThrow(
        'at least one script is required',
      );
      expect(CloudWorkload.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('T-W3: propagates the E11000 duplicate key error on rename', async () => {
      mockFindById(makeWorkload());
      (CloudWorkload.findByIdAndUpdate as any).mockRejectedValue(new Error('E11000 duplicate key error'));

      await expect(service.update('w1', { name: 'taken' })).rejects.toThrow('E11000');
    });
  });

  describe('delete (T-W4)', () => {
    it('deletes and returns true', async () => {
      (CloudWorkload.deleteOne as any).mockResolvedValue({ deletedCount: 1 });
      await expect(service.delete('w1')).resolves.toBe(true);
      expect(CloudWorkload.deleteOne).toHaveBeenCalledWith({ _id: 'w1' });
    });

    it('returns false when the workload does not exist', async () => {
      (CloudWorkload.deleteOne as any).mockResolvedValue({ deletedCount: 0 });
      await expect(service.delete('missing')).resolves.toBe(false);
    });
  });

  describe('list', () => {
    it('lists workloads sorted by createdAt desc', async () => {
      const lean = vi.fn().mockResolvedValue([makeWorkload(), makeWorkload({ _id: { toString: () => 'w0' } })]);
      const sort = vi.fn().mockReturnValue({ lean });
      (CloudWorkload.find as any).mockReturnValue({ sort });

      const result = await service.list();

      expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
      expect(result).toHaveLength(2);
    });
  });

  describe('getByIds (T-W6)', () => {
    it('returns workloads in input order and omits deleted ones', async () => {
      const w1 = makeWorkload({ _id: { toString: () => 'w1' } });
      const w2 = makeWorkload({ _id: { toString: () => 'w2' } });
      (CloudWorkload.find as any).mockReturnValue({ lean: vi.fn().mockResolvedValue([w1, w2]) });

      const result = await service.getByIds(['w2', 'w1', 'w3']);

      expect(result.map((w) => w.id)).toEqual(['w2', 'w1']);
      expect(CloudWorkload.find).toHaveBeenCalledWith({ _id: { $in: ['w2', 'w1', 'w3'] } });
    });

    it('skips the DB query for an empty id list', async () => {
      await expect(service.getByIds([])).resolves.toEqual([]);
      expect(CloudWorkload.find).not.toHaveBeenCalled();
    });
  });

  describe('mapWorkloadLog (T-W8)', () => {
    it('maps a stored Mongo doc (Date timestamps + lowecase enums) to contract shape', () => {
      const mapped = mapWorkloadLog({
        _id: { toString: () => 'l1' },
        containerId: { toString: () => 'c1' },
        workloadId: { toString: () => 'w1' },
        workloadName: 'setup',
        phase: 'init',
        status: 'success',
        script: 'echo init',
        params: { version: '20' },
        exitCode: 0,
        log: 'init done',
        startedAt: new Date('2026-10-17T00:00:00.000Z'),
        finishedAt: new Date('2026-10-17T00:00:05.000Z'),
      });

      expect(mapped).toEqual({
        id: 'l1',
        containerId: 'c1',
        workloadId: 'w1',
        workloadName: 'setup',
        phase: 'INIT',
        status: 'SUCCESS',
        script: 'echo init',
        params: { version: '20' },
        required: false,
        exitCode: 0,
        log: 'init done',
        startedAt: '2026-10-17T00:00:00.000Z',
        finishedAt: '2026-10-17T00:00:05.000Z',
      });
    });

    it('T-MLOG1: maps required true/false and defaults a missing value to false', () => {
      expect(mapWorkloadLog({ id: 'l6', required: true }).required).toBe(true);
      expect(mapWorkloadLog({ id: 'l7', required: false }).required).toBe(false);
      // 历史记录缺省 false
      expect(mapWorkloadLog({ id: 'l8' }).required).toBe(false);
      // 非布尔按缺省 false
      expect(mapWorkloadLog({ id: 'l9', required: 'true' }).required).toBe(false);
    });

    it('maps post/failed and normalizes missing optional fields', () => {
      const mapped = mapWorkloadLog({ id: 'l2', phase: 'post', status: 'failed' });
      expect(mapped.phase).toBe('POST');
      expect(mapped.status).toBe('FAILED');
      expect(mapped.params).toEqual({});
      expect(mapped.exitCode).toBeNull();
      expect(mapped.startedAt).toBeNull();
      expect(mapped.finishedAt).toBeNull();
      expect(mapped.log).toBe('');
    });

    it('normalizes a non-object params snapshot to {}', () => {
      expect(mapWorkloadLog({ id: 'l3', params: 'not-an-object' }).params).toEqual({});
      expect(mapWorkloadLog({ id: 'l4', params: ['x'] }).params).toEqual({});
    });

    it('falls back unknown enums to safe values instead of crashing the query', () => {
      const mapped = mapWorkloadLog({ id: 'l5', phase: 'weird', status: 'unknown' });
      expect(mapped.phase).toBe('INIT');
      expect(mapped.status).toBe('FAILED');
    });
  });

  describe('listByContainerLogs (T-W8 degrade)', () => {
    it('reads the read-only Mongo model and maps to contract shape', async () => {
      (findStoredWorkloadLogs as any).mockResolvedValue([
        {
          _id: { toString: () => 'l1' },
          containerId: { toString: () => 'c1' },
          workloadId: { toString: () => 'w1' },
          workloadName: 'setup',
          phase: 'init',
          status: 'running',
          script: 'echo init',
          params: {},
          exitCode: null,
          log: '',
          startedAt: null,
          finishedAt: null,
        },
      ]);

      const result = await service.listByContainerLogs('c1');

      expect(findStoredWorkloadLogs).toHaveBeenCalledWith('c1');
      expect(result).toEqual([
        {
          id: 'l1',
          containerId: 'c1',
          workloadId: 'w1',
          workloadName: 'setup',
          phase: 'INIT',
          status: 'RUNNING',
          script: 'echo init',
          params: {},
          required: false,
          exitCode: null,
          log: '',
          startedAt: null,
          finishedAt: null,
        },
      ]);
    });
  });
});
