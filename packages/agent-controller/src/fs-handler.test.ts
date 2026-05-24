import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
}));

import { FsHandler } from './fs-handler.js';

describe('FsHandler', () => {
  let handler: FsHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new FsHandler();
  });

  describe('mkdir', () => {
    it('should successfully create a folder', async () => {
      const result = await handler.mkdir('/parent', 'new-folder');

      expect(result.success).toBe(true);
      expect(result.name).toBe('new-folder');
      expect(result.path).toBe('/parent/new-folder');
    });

    it('should handle creation failure', async () => {
      const { mkdirSync } = await import('fs');
      vi.mocked(mkdirSync).mockImplementation(() => {
        throw new Error('EEXIST: file already exists');
      });

      const result = await handler.mkdir('/parent', 'existing');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});