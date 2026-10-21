import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/cloud-host-service.js', () => ({
  cloudHostService: {
    getCapabilities: vi.fn(),
    list: vi.fn(),
    stopImpact: vi.fn(),
    create: vi.fn(),
    stop: vi.fn(),
    delete: vi.fn(),
    mapCloudHost: vi.fn(),
  },
  toCloudHostGraphQLError: (err: unknown): never => {
    throw err;
  },
}));

vi.mock('../../models/cloud-host.js', () => ({
  CloudHost: { findOne: vi.fn() },
}));

vi.mock('../../models/session.js', () => ({
  Session: { countDocuments: vi.fn() },
}));

import { cloudHostResolvers } from './cloud-host.js';
import { cloudHostService } from '../../services/cloud-host-service.js';

const context = { currentUser: null } as never;

describe('cloudHostResolvers authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['cloudHostCapabilities', () => cloudHostResolvers.Query.cloudHostCapabilities({}, {}, context)],
    ['myCloudHosts', () => cloudHostResolvers.Query.myCloudHosts({}, {}, context)],
    [
      'cloudHostStopImpact',
      () => cloudHostResolvers.Query.cloudHostStopImpact({}, { id: '507f1f77bcf86cd799439011' }, context),
    ],
    [
      'createCloudHost',
      () =>
        cloudHostResolvers.Mutation.createCloudHost(
          {},
          { input: { name: 'x', harnessTypes: ['OPENCODE'] } },
          context,
        ),
    ],
    [
      'stopCloudHost',
      () => cloudHostResolvers.Mutation.stopCloudHost({}, { id: '507f1f77bcf86cd799439011' }, context),
    ],
    [
      'deleteCloudHost',
      () => cloudHostResolvers.Mutation.deleteCloudHost({}, { id: '507f1f77bcf86cd799439011' }, context),
    ],
  ])('%s requires authentication', async (_name, invoke) => {
    await expect(invoke()).rejects.toThrow('Not authenticated');
  });

  it('does not call the service for unauthenticated requests', () => {
    expect(cloudHostService.create).not.toHaveBeenCalled();
    expect(cloudHostService.stop).not.toHaveBeenCalled();
    expect(cloudHostService.delete).not.toHaveBeenCalled();
  });
});
