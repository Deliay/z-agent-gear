import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/session.js', () => ({
  sessionService: {
    findAllByUser: vi.fn(),
    findById: vi.fn(),
    getMessages: vi.fn(),
    getAcpCapabilities: vi.fn(),
    getAcpServerOptions: vi.fn(),
    create: vi.fn(),
    close: vi.fn(),
    delete: vi.fn(),
    addMessage: vi.fn(),
    cancelGeneration: vi.fn(),
    resume: vi.fn(),
    setMode: vi.fn(),
    setModel: vi.fn(),
    setConfigOption: vi.fn(),
    refreshAcpCapabilities: vi.fn(),
    assertSessionWritable: vi.fn(),
  },
}));

vi.mock('../../services/session-import.js', () => ({
  sessionImportService: {
    listHistorySessions: vi.fn(),
    deleteHistorySession: vi.fn(),
    importSessions: vi.fn(),
  },
}));

vi.mock('../../services/cloud-host-service.js', () => ({
  cloudHostService: {
    mapCloudHost: vi.fn((host: Record<string, unknown>) => ({
      id: String(host._id),
      status: host.status,
      deletedAt: host.deletedAt ?? null,
    })),
  },
}));

vi.mock('../../models/controller.js', () => ({
  Controller: { findOne: vi.fn() },
}));

vi.mock('../../models/cloud-host.js', () => ({
  CloudHost: { findOne: vi.fn() },
}));

import { sessionResolvers } from './session.js';
import { Controller } from '../../models/controller.js';
import { CloudHost } from '../../models/cloud-host.js';

function chain(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value) } as never;
}

const context = { currentUser: { id: 'user-1' } } as never;
const parent = { controllerId: 'ctrl-1', userId: 'user-1' } as never;

describe('sessionResolvers.Session cloud host read-only fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('D-1 controllerType returns the controller type without relying on controllers list', async () => {
    vi.mocked(Controller.findOne).mockReturnValue(
      chain({ type: 'cloud' }) as never,
    );

    await expect(
      sessionResolvers.Session.controllerType(parent, {}, context),
    ).resolves.toBe('cloud');
    expect(Controller.findOne).toHaveBeenCalledWith({ _id: 'ctrl-1', userId: 'user-1' });
  });

  it('D-1 cloudHost returns the soft-deleted host for read-only rendering', async () => {
    vi.mocked(Controller.findOne).mockReturnValue(chain({ type: 'cloud' }) as never);
    vi.mocked(CloudHost.findOne).mockReturnValue(
      chain({ _id: 'cloud-1', status: 'STOPPED', deletedAt: new Date() }) as never,
    );

    const result = await sessionResolvers.Session.cloudHost(parent, {}, context);

    expect(result).toMatchObject({ id: 'cloud-1', status: 'STOPPED' });
    expect((result as { deletedAt: Date | null }).deletedAt).toBeInstanceOf(Date);
    // 软删除留档必须可返回：不过滤 deletedAt
    expect(CloudHost.findOne).toHaveBeenCalledWith({
      controllerId: 'ctrl-1',
      userId: 'user-1',
    });
  });

  it('cloudHost returns null for non-cloud controllers', async () => {
    vi.mocked(Controller.findOne).mockReturnValue(chain({ type: 'local' }) as never);

    await expect(
      sessionResolvers.Session.cloudHost(parent, {}, context),
    ).resolves.toBeNull();
    expect(CloudHost.findOne).not.toHaveBeenCalled();
  });

  it('returns null without authentication', async () => {
    const anon = { currentUser: null } as never;
    await expect(sessionResolvers.Session.controllerType(parent, {}, anon)).resolves.toBeNull();
    await expect(sessionResolvers.Session.cloudHost(parent, {}, anon)).resolves.toBeNull();
  });
});
