import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/gateway.js', () => ({
  Gateway: {
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndDelete: vi.fn(),
    countDocuments: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('../models/controller.js', () => ({
  Controller: {
    findOne: vi.fn(),
  },
}));

vi.mock('../middleware/publish.js', () => ({
  publish: vi.fn(async () => 1),
}));

import { gatewayService } from './gateway.js';
import { Gateway } from '../models/gateway.js';
import { Controller } from '../models/controller.js';
import { publish } from '../middleware/publish.js';
import { buildGatewayEndpoint } from './gateway-endpoint.js';
import { config } from '../config/index.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GatewayService', () => {
  describe('findAllByController', () => {
    it('should return gateways for a controller', async () => {
      const now = new Date();
      vi.mocked(Gateway.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            {
              _id: { toString: () => 'gw1' },
              controllerId: { toString: () => 'ctrl1' },
              name: 'my-service',
              port: 3000,
              status: 'active',
              createdAt: now,
            },
          ]),
        }),
      } as never);

      const result = await gatewayService.findAllByController('ctrl1', 'user1');

      expect(result.gateways).toHaveLength(1);
      expect(result.gateways[0].name).toBe('my-service');
      expect(result.gateways[0].port).toBe(3000);
      expect(result.gateways[0].endpoint).toBe(
        buildGatewayEndpoint(config.publicBaseUrl, 'ctrl1', 'my-service'),
      );
      expect(result.total).toBe(1);
      expect(result.limit).toBe(0);
    });

    it('should return empty list when no gateways exist', async () => {
      vi.mocked(Gateway.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      } as never);

      const result = await gatewayService.findAllByController('ctrl1', 'user1');

      expect(result.gateways).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe('create', () => {
    it('should create a gateway and publish Redis command', async () => {
      const now = new Date();
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl1', status: 'online' }),
      } as never);
      vi.mocked(Gateway.countDocuments).mockResolvedValue(0);
      vi.mocked(Gateway.findOne).mockResolvedValue(null);
      vi.mocked(Gateway.create).mockResolvedValue({
        toObject: () => ({
          _id: { toString: () => 'gw1' },
          controllerId: { toString: () => 'ctrl1' },
          name: 'my-service',
          port: 3000,
          status: 'active',
          createdAt: now,
        }),
      } as never);

      const result = await gatewayService.create('ctrl1', 'user1', 'my-service', 3000, 5);

      expect(result.name).toBe('my-service');
      expect(result.port).toBe(3000);
      expect(result.status).toBe('active');
      expect(result.endpoint).toBe(
        buildGatewayEndpoint(config.publicBaseUrl, 'ctrl1', 'my-service'),
      );
      expect(vi.mocked(publish)).toHaveBeenCalledWith('port-forward:command', {
        type: 'tunnel:create',
        controllerId: 'ctrl1',
        port: 3000,
      });
    });

    it('should throw when controller not found', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(gatewayService.create('ctrl1', 'user1', 'svc', 3000, 5)).rejects.toThrow(
        'Controller not found',
      );
    });

    it('should throw when controller is not online', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl1', status: 'offline' }),
      } as never);

      await expect(gatewayService.create('ctrl1', 'user1', 'svc', 3000, 5)).rejects.toThrow(
        'Controller is not online',
      );
    });

    it('should throw when max gateways exceeded', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl1', status: 'online' }),
      } as never);
      vi.mocked(Gateway.countDocuments).mockResolvedValue(5);

      await expect(gatewayService.create('ctrl1', 'user1', 'svc', 3000, 5)).rejects.toThrow(
        'Maximum 5 gateways per controller',
      );
    });

    it('should throw when name already exists', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl1', status: 'online' }),
      } as never);
      vi.mocked(Gateway.countDocuments).mockResolvedValue(1);
      vi.mocked(Gateway.findOne).mockResolvedValue({ _id: 'gw1' } as never);

      await expect(gatewayService.create('ctrl1', 'user1', 'my-service', 3000, 5)).rejects.toThrow(
        'Gateway name already exists',
      );
    });

    it('should throw when name contains invalid characters', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl1', status: 'online' }),
      } as never);

      await expect(gatewayService.create('ctrl1', 'user1', 'my service!', 3000, 5)).rejects.toThrow(
        'Name can only contain letters, numbers, hyphens, and underscores',
      );
    });

    it('should throw when name is too long', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl1', status: 'online' }),
      } as never);

      await expect(gatewayService.create('ctrl1', 'user1', 'a'.repeat(51), 3000, 5)).rejects.toThrow(
        'Name length must be 1-50 characters',
      );
    });
  });

  describe('delete', () => {
    it('should delete a gateway by name and publish Redis command', async () => {
      vi.mocked(Gateway.findOneAndDelete).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ port: 3000 }),
      } as never);

      const result = await gatewayService.delete('ctrl1', 'user1', 'my-service');

      expect(result).toBe(true);
      expect(vi.mocked(publish)).toHaveBeenCalledWith('port-forward:command', {
        type: 'tunnel:close',
        controllerId: 'ctrl1',
        port: 3000,
      });
    });

    it('should return false when gateway not found', async () => {
      vi.mocked(Gateway.findOneAndDelete).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      const result = await gatewayService.delete('ctrl1', 'user1', 'nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('endpoint 派生（T-GWS / T-GMCP-REPRO-1）', () => {
    function mockCreateDeps() {
      const now = new Date();
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl1', status: 'online' }),
      } as never);
      vi.mocked(Gateway.countDocuments).mockResolvedValue(0);
      vi.mocked(Gateway.findOne).mockResolvedValue(null);
      vi.mocked(Gateway.create).mockResolvedValue({
        toObject: () => ({
          _id: { toString: () => 'gw1' },
          controllerId: { toString: () => 'ctrl1' },
          name: 'my-service',
          port: 3000,
          status: 'active',
          createdAt: now,
        }),
      } as never);
    }

    it('T-GWS1/T-GMCP-REPRO-1: create 返回具体 endpoint（默认 PUBLIC_BASE_URL）', async () => {
      mockCreateDeps();

      const result = await gatewayService.create('ctrl1', 'user1', 'my-service', 3000, 5);

      expect(result.endpoint).toBe('http://localhost:10001/api/gateway/ctrl1/my-service/');
    });

    it('T-GWS2: create 的 endpoint 与纯函数 helper 逐字一致', async () => {
      mockCreateDeps();

      const result = await gatewayService.create('ctrl1', 'user1', 'my-service', 3000, 5);

      expect(result.endpoint).toBe(
        buildGatewayEndpoint(config.publicBaseUrl, 'ctrl1', 'my-service'),
      );
    });

    it('T-GWS3: findAllByController 每条均带 endpoint 且与 helper 一致；既有字段不变', async () => {
      const now = new Date();
      vi.mocked(Gateway.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            {
              _id: { toString: () => 'gw1' },
              controllerId: { toString: () => 'ctrl1' },
              name: 'a-svc',
              port: 3000,
              status: 'active',
              createdAt: now,
            },
            {
              _id: { toString: () => 'gw2' },
              controllerId: { toString: () => 'ctrl1' },
              name: 'b-svc',
              port: 3001,
              status: 'active',
              createdAt: now,
            },
          ]),
        }),
      } as never);

      const result = await gatewayService.findAllByController('ctrl1', 'user1');

      expect(result.gateways.map((row) => row.endpoint)).toEqual([
        buildGatewayEndpoint(config.publicBaseUrl, 'ctrl1', 'a-svc'),
        buildGatewayEndpoint(config.publicBaseUrl, 'ctrl1', 'b-svc'),
      ]);
      expect(result.gateways[0]).toMatchObject({
        id: 'gw1',
        controllerId: 'ctrl1',
        name: 'a-svc',
        port: 3000,
        status: 'active',
      });
      expect(result.limit).toBe(0);
    });

    it('T-GWS4: delete 不返回 endpoint（既有行为零变化）', async () => {
      vi.mocked(Gateway.findOneAndDelete).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ port: 3000 }),
      } as never);

      await expect(gatewayService.delete('ctrl1', 'user1', 'my-service')).resolves.toBe(true);
    });
  });
});
