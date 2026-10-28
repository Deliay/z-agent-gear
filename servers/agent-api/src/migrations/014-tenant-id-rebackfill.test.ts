import { describe, it, expect, vi } from 'vitest';

vi.mock('./013-tenant-id-backfill.js', () => ({
  run: vi.fn().mockResolvedValue(undefined),
}));

import * as backfill013 from './013-tenant-id-backfill.js';
import * as migration from './014-tenant-id-rebackfill.js';

describe('migration 014 tenantId re-backfill', () => {
  it('exposes the migration name', () => {
    expect(migration.name).toBe('014-tenant-id-rebackfill');
  });

  it('delegates to the idempotent 013 backfill (single collection list source)', async () => {
    await migration.run();
    expect(backfill013.run).toHaveBeenCalledTimes(1);
  });
});
