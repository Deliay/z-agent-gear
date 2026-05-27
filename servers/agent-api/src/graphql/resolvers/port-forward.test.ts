import { describe, it, expect, vi, beforeEach } from 'vitest';
import { portForwardResolvers } from './port-forward.js';

vi.mock('../../services/port-forward.js', () => ({
  portForwardService: {
    findAllByController: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../config/index.js', () => ({
  config: {
    portForwardMaxPerController: 5,
  },
}));

import { portForwardService } from '../../services/port-forward.js';

const mockContext = {
  currentUser: { id: 'user1', username: 'testuser' },
};

const emptyContext = {
  currentUser: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PortForward Resolvers', () => {
  describe('Query.portForwards', () => {
    it('should return port forwards for authenticated user', async () => {
      const mockResult = { portForwards: [{ id: 'pf1', port: 3000 }], total: 1, limit: 0 };
      vi.mocked(portForwardService.findAllByController).mockResolvedValue(mockResult);

      const result = await portForwardResolvers.Query.portForwards(
        {},
        { controllerId: 'ctrl1' },
        mockContext,
      );

      expect(result).toEqual(mockResult);
      expect(portForwardService.findAllByController).toHaveBeenCalledWith('ctrl1', 'user1');
    });

    it('should throw when not authenticated', async () => {
      await expect(
        portForwardResolvers.Query.portForwards({}, { controllerId: 'ctrl1' }, emptyContext),
      ).rejects.toThrow('Not authenticated');
    });
  });

  describe('Mutation.createPortForward', () => {
    it('should create a port forward', async () => {
      const mockResult = { id: 'pf1', controllerId: 'ctrl1', port: 3000, status: 'active' };
      vi.mocked(portForwardService.create).mockResolvedValue(mockResult);

      const result = await portForwardResolvers.Mutation.createPortForward(
        {},
        { controllerId: 'ctrl1', port: 3000 },
        mockContext,
      );

      expect(result).toEqual(mockResult);
      expect(portForwardService.create).toHaveBeenCalledWith('ctrl1', 'user1', 3000, 5);
    });

    it('should throw when not authenticated', async () => {
      await expect(
        portForwardResolvers.Mutation.createPortForward(
          {},
          { controllerId: 'ctrl1', port: 3000 },
          emptyContext,
        ),
      ).rejects.toThrow('Not authenticated');
    });

    it('should propagate service error messages', async () => {
      vi.mocked(portForwardService.create).mockRejectedValue(new Error('Controller not found'));

      await expect(
        portForwardResolvers.Mutation.createPortForward(
          {},
          { controllerId: 'ctrl1', port: 3000 },
          mockContext,
        ),
      ).rejects.toThrow('Controller not found');
    });
  });

  describe('Mutation.deletePortForward', () => {
    it('should delete a port forward', async () => {
      vi.mocked(portForwardService.delete).mockResolvedValue(true);

      const result = await portForwardResolvers.Mutation.deletePortForward(
        {},
        { controllerId: 'ctrl1', port: 3000 },
        mockContext,
      );

      expect(result).toBe(true);
      expect(portForwardService.delete).toHaveBeenCalledWith('ctrl1', 'user1', 3000);
    });

    it('should throw when not authenticated', async () => {
      await expect(
        portForwardResolvers.Mutation.deletePortForward(
          {},
          { controllerId: 'ctrl1', port: 3000 },
          emptyContext,
        ),
      ).rejects.toThrow('Not authenticated');
    });
  });
});
