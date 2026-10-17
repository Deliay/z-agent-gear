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
    createdAt: new Date('2026-10-17T00:00:00.000Z'),
    updatedAt: new Date('2026-10-17T01:00:00.000Z'),
    ...overrides,
  };
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
      });
      expect(result).toEqual({
        id: 'w1',
        name: 'setup',
        initScript: 'echo init',
        postScript: null,
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

  describe('update (T-W3/T-W4)', () => {
    it('T-W4: returns null when the workload does not exist', async () => {
      (CloudWorkload.findById as any).mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      expect(await service.update('missing', { name: 'x' })).toBeNull();
      expect(CloudWorkload.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('updates the name while keeping existing scripts', async () => {
      const existing = makeWorkload({ initScript: 'echo init', postScript: null });
      (CloudWorkload.findById as any).mockReturnValue({ lean: vi.fn().mockResolvedValue(existing) });
      const updated = makeWorkload({ name: 'renamed', initScript: 'echo init', postScript: null });
      (CloudWorkload.findByIdAndUpdate as any).mockResolvedValue(updated);

      const result = await service.update('w1', { name: 'renamed' });

      expect(CloudWorkload.findByIdAndUpdate).toHaveBeenCalledWith(
        'w1',
        { name: 'renamed', initScript: 'echo init', postScript: null },
        { new: true, lean: true },
      );
      expect(result!.name).toBe('renamed');
    });

    it('T-W2: rejects clearing the only remaining script (merged final state)', async () => {
      const existing = makeWorkload({ initScript: 'echo init', postScript: null });
      (CloudWorkload.findById as any).mockReturnValue({ lean: vi.fn().mockResolvedValue(existing) });

      await expect(service.update('w1', { initScript: '' })).rejects.toThrow(
        'at least one script is required',
      );
      expect(CloudWorkload.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('T-W3: propagates the E11000 duplicate key error on rename', async () => {
      const existing = makeWorkload();
      (CloudWorkload.findById as any).mockReturnValue({ lean: vi.fn().mockResolvedValue(existing) });
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
        exitCode: 0,
        log: 'init done',
        startedAt: '2026-10-17T00:00:00.000Z',
        finishedAt: '2026-10-17T00:00:05.000Z',
      });
    });

    it('maps post/failed and normalizes missing optional fields', () => {
      const mapped = mapWorkloadLog({ id: 'l2', phase: 'post', status: 'failed' });
      expect(mapped.phase).toBe('POST');
      expect(mapped.status).toBe('FAILED');
      expect(mapped.exitCode).toBeNull();
      expect(mapped.startedAt).toBeNull();
      expect(mapped.finishedAt).toBeNull();
      expect(mapped.log).toBe('');
    });

    it('falls back unknown enums to safe values instead of crashing the query', () => {
      const mapped = mapWorkloadLog({ id: 'l3', phase: 'weird', status: 'unknown' });
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
          exitCode: null,
          log: '',
          startedAt: null,
          finishedAt: null,
        },
      ]);
    });
  });
});
