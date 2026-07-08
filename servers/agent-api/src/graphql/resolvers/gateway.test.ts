import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gatewayResolvers } from './gateway.js';

vi.mock('../../services/gateway.js', () => ({
  gatewayService: {
    findAllByController: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../config/index.js', () => ({
  config: {
    gatewayMaxPerController: 5,
  },
}));

import { gatewayService } from '../../services/gateway.js';

const mockContext = {
  currentUser: { id: 'user1', username: 'testuser' },
};

const emptyContext = {
  currentUser: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Gateway Resolvers', () => {
  describe('Query.gateways', () => {
    it('should return gateways for authenticated user', async () => {
      const mockResult = { gateways: [{ id: 'gw1', name: 'svc', port: 3000 }], total: 1, limit: 0 };
      vi.mocked(gatewayService.findAllByController).mockResolvedValue(mockResult);

      const result = await gatewayResolvers.Query.gateways(
        {},
        { controllerId: 'ctrl1' },
        mockContext,
      );

      expect(result).toEqual(mockResult);
      expect(gatewayService.findAllByController).toHaveBeenCalledWith('ctrl1', 'user1');
    });

    it('should throw when not authenticated', async () => {
      await expect(
        gatewayResolvers.Query.gateways({}, { controllerId: 'ctrl1' }, emptyContext),
      ).rejects.toThrow('Not authenticated');
    });
  });

  describe('Mutation.createGateway', () => {
    it('should create a gateway', async () => {
      const mockResult = { id: 'gw1', controllerId: 'ctrl1', name: 'my-svc', port: 3000, status: 'active' };
      vi.mocked(gatewayService.create).mockResolvedValue(mockResult);

      const result = await gatewayResolvers.Mutation.createGateway(
        {},
        { controllerId: 'ctrl1', name: 'my-svc', port: 3000 },
        mockContext,
      );

      expect(result).toEqual(mockResult);
      expect(gatewayService.create).toHaveBeenCalledWith('ctrl1', 'user1', 'my-svc', 3000, 5);
    });

    it('should throw when not authenticated', async () => {
      await expect(
        gatewayResolvers.Mutation.createGateway(
          {},
          { controllerId: 'ctrl1', name: 'my-svc', port: 3000 },
          emptyContext,
        ),
      ).rejects.toThrow('Not authenticated');
    });

    it('should propagate service error messages', async () => {
      vi.mocked(gatewayService.create).mockRejectedValue(new Error('Controller not found'));

      await expect(
        gatewayResolvers.Mutation.createGateway(
          {},
          { controllerId: 'ctrl1', name: 'my-svc', port: 3000 },
          mockContext,
        ),
      ).rejects.toThrow('Controller not found');
    });
  });

  describe('Mutation.deleteGateway', () => {
    it('should delete a gateway', async () => {
      vi.mocked(gatewayService.delete).mockResolvedValue(true);

      const result = await gatewayResolvers.Mutation.deleteGateway(
        {},
        { controllerId: 'ctrl1', name: 'my-svc' },
        mockContext,
      );

      expect(result).toBe(true);
      expect(gatewayService.delete).toHaveBeenCalledWith('ctrl1', 'user1', 'my-svc');
    });

    it('should throw when not authenticated', async () => {
      await expect(
        gatewayResolvers.Mutation.deleteGateway(
          {},
          { controllerId: 'ctrl1', name: 'my-svc' },
          emptyContext,
        ),
      ).rejects.toThrow('Not authenticated');
    });
  });
});
