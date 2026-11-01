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

vi.mock('../../services/billing-client.js', () => ({
  billingClient: { getPriceQuote: vi.fn(), getAccount: vi.fn() },
}));

import { cloudHostResolvers } from './cloud-host.js';
import { cloudHostService } from '../../services/cloud-host-service.js';
import { CloudHost } from '../../models/cloud-host.js';
import { Session } from '../../models/session.js';
import { billingClient } from '../../services/billing-client.js';
import { logger as rootLogger } from '../../observability/logger.js';

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
    ['cloudHostBillingQuote', () => cloudHostResolvers.Query.cloudHostBillingQuote({}, {}, context)],
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

    // C-27：契约承诺「软删除仍返回」——显式断言 deletedAt 透传，而非仅断言对象存在
    expect(CloudHost.findOne).toHaveBeenCalledWith({ _id: HOST_ID, userId: 'user-1' });
    expect(result).toMatchObject({ id: HOST_ID, name: 'host' });
    expect(result).toMatchObject({ deletedAt: expect.anything() });
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

  it('passes githubAccountId through to the service', async () => {
    vi.mocked(cloudHostService.create).mockResolvedValue({ id: HOST_ID } as never);
    await cloudHostResolvers.Mutation.createCloudHost(
      {},
      { input: { name: 'x', harnessTypes: ['OPENCODE'], githubAccountId: '507f1f77bcf86cd799439099' } },
      authContext,
    );
    expect(vi.mocked(cloudHostService.create).mock.calls[0][1]).toMatchObject({
      githubAccountId: '507f1f77bcf86cd799439099',
    });
  });
});

describe('cloudHostResolvers.Query.cloudHostBillingQuote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-CH-QL1: 聚合价目与可用余额', async () => {
    vi.mocked(billingClient.getPriceQuote).mockResolvedValue([
      { productId: 'cloud_host.create', unitPrice: 5, currency: 'credits' },
      { productId: 'container.minute', unitPrice: 1, currency: 'credits' },
    ] as never);
    vi.mocked(billingClient.getAccount).mockResolvedValue({ availableBalance: 12.5 } as never);
    await expect(
      cloudHostResolvers.Query.cloudHostBillingQuote({}, {}, authContext),
    ).resolves.toEqual({ createCredits: 5, perMinuteCredits: 1, availableBalance: 12.5 });
  });

  it('T-CH-QL2: 计费不可用时降级回退默认价目且余额为 null', async () => {
    vi.mocked(billingClient.getPriceQuote).mockRejectedValue(new Error('down'));
    vi.mocked(billingClient.getAccount).mockRejectedValue(new Error('down'));
    await expect(
      cloudHostResolvers.Query.cloudHostBillingQuote({}, {}, authContext),
    ).resolves.toEqual({ createCredits: 5, perMinuteCredits: 1, availableBalance: null });
  });

  it('T-OBS B1: 降级告警错误对象进 err 字段（message/stack 不丢，不落 reason)', async () => {
    const warnSpy = vi.spyOn(rootLogger, 'warn').mockImplementation((() => rootLogger) as never);
    const priceErr = new Error('price service down');
    const accountErr = new Error('account service down');
    vi.mocked(billingClient.getPriceQuote).mockRejectedValue(priceErr);
    vi.mocked(billingClient.getAccount).mockRejectedValue(accountErr);

    await cloudHostResolvers.Query.cloudHostBillingQuote({}, {}, authContext);

    const priceCall = warnSpy.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === 'price-fallback',
    );
    expect(priceCall).toBeDefined();
    expect(priceCall![0]).toMatchObject({ err: priceErr });
    expect(priceCall![0]).not.toHaveProperty('reason');

    const accountCall = warnSpy.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === 'balance-unavailable',
    );
    expect(accountCall).toBeDefined();
    expect(accountCall![0]).toMatchObject({ err: accountErr });
    expect(accountCall![0]).not.toHaveProperty('reason');

    warnSpy.mockRestore();
  });
});
