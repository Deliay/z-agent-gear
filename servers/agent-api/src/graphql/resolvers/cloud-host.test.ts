import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/cloud-host-service.js', () => ({
  cloudHostService: {
    getCapabilities: vi.fn(),
    list: vi.fn(),
    stopImpact: vi.fn(),
    create: vi.fn(),
    stop: vi.fn(),
    delete: vi.fn(),
    mapCloudHost: vi.fn((host: Record<string, unknown>) => ({ id: String(host._id), ...host })),
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
import { CloudHost } from '../../models/cloud-host.js';
import { Session } from '../../models/session.js';

const context = { currentUser: null } as never;
const authContext = { currentUser: { id: 'user-1', username: 'u' } } as never;

const HOST_ID = '507f1f77bcf86cd799439011';

function chain(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value) } as never;
}

describe('cloudHostResolvers authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['cloudHostCapabilities', () => cloudHostResolvers.Query.cloudHostCapabilities({}, {}, context)],
    ['myCloudHosts', () => cloudHostResolvers.Query.myCloudHosts({}, {}, context)],
    [
      'cloudHostWorkloadCatalog',
      () => cloudHostResolvers.Query.cloudHostWorkloadCatalog({}, {}, context),
    ],
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

describe('cloudHostResolvers.Query.cloudHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the host owned by the caller, including soft-deleted ones', async () => {
    vi.mocked(CloudHost.findOne).mockReturnValue(
      chain({
        _id: HOST_ID,
        userId: 'user-1',
        name: 'host',
        controllerId: 'ctrl-1',
        status: 'RUNNING',
        deletedAt: new Date(),
      }) as never,
    );
    vi.mocked(Session.countDocuments).mockResolvedValue(2 as never);

    const result = await cloudHostResolvers.Query.cloudHost(
      {},
      { id: HOST_ID },
      authContext,
    );

    expect(CloudHost.findOne).toHaveBeenCalledWith({ _id: HOST_ID, userId: 'user-1' });
    expect(result).toMatchObject({ id: HOST_ID, name: 'host' });
  });

  it('returns null for a malformed id without querying the database', async () => {
    await expect(
      cloudHostResolvers.Query.cloudHost({}, { id: 'not-an-id' }, authContext),
    ).resolves.toBeNull();
    expect(CloudHost.findOne).not.toHaveBeenCalled();
  });

  it('returns null when the host belongs to someone else', async () => {
    vi.mocked(CloudHost.findOne).mockReturnValue(chain(null) as never);
    await expect(
      cloudHostResolvers.Query.cloudHost({}, { id: HOST_ID }, authContext),
    ).resolves.toBeNull();
  });

  it('forwards createDefaultSession only when provided', async () => {
    vi.mocked(cloudHostService.create).mockResolvedValue({ id: 'host-1' } as never);

    await cloudHostResolvers.Mutation.createCloudHost(
      {},
      { input: { name: 'x', harnessTypes: ['OPENCODE'], createDefaultSession: false } },
      authContext,
    );
    expect(cloudHostService.create).toHaveBeenCalledWith('user-1', {
      name: 'x',
      harnessTypes: ['OPENCODE'],
      workloadIds: undefined,
      createDefaultSession: false,
    });

    await cloudHostResolvers.Mutation.createCloudHost(
      {},
      { input: { name: 'y', harnessTypes: ['OPENCODE'] } },
      authContext,
    );
    expect(vi.mocked(cloudHostService.create).mock.calls[1][1]).not.toHaveProperty(
      'createDefaultSession',
    );
  });
});
