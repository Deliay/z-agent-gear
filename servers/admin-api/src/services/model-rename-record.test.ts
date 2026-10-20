import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/model-rename-record.js', () => ({
  ModelRenameRecord: { find: vi.fn() },
}));

import { ModelRenameRecord } from '../models/model-rename-record.js';
import { modelRenameRecordService } from './model-rename-record';

describe('ModelRenameRecordService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('U-R1: sorts by renamedAt desc and maps every field, renamedAt as ISO string', async () => {
    const lean = vi.fn().mockResolvedValue([
      {
        _id: 'record-1',
        modelId: 'model-1',
        providerId: 'provider-1',
        providerName: 'OpenAI A',
        oldName: 'gpt-4o',
        newName: 'gpt-4o-2',
        batchId: '20261020-005',
        renamedAt: new Date('2026-10-20T08:00:00.000Z'),
      },
    ]);
    (ModelRenameRecord.find as any).mockReturnValue({ sort: vi.fn().mockReturnValue({ lean }) });

    const result = await modelRenameRecordService.findAll();

    expect(ModelRenameRecord.find).toHaveBeenCalledWith();
    expect(result).toEqual([
      {
        id: 'record-1',
        modelId: 'model-1',
        providerId: 'provider-1',
        providerName: 'OpenAI A',
        oldName: 'gpt-4o',
        newName: 'gpt-4o-2',
        batchId: '20261020-005',
        renamedAt: '2026-10-20T08:00:00.000Z',
      },
    ]);
  });
});
