import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import ControllerListSection from '../ControllerListSection';

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

interface ControllerFixture {
  id: string;
  name: string;
  hostname: string;
  type: string;
  status: string;
  keyId: string;
  version: string;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function controller(overrides: Partial<ControllerFixture> & { id: string }): ControllerFixture {
  return {
    name: overrides.id,
    hostname: overrides.id,
    type: 'local',
    status: 'online',
    keyId: `key-${overrides.id}`,
    version: '2.0.0',
    lastHeartbeatAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function mockQueries(controllers: ControllerFixture[]) {
  mockUseQuery.mockImplementation((query: { definitions?: Array<{ name?: { value?: string } }> }) => {
    const operation = query?.definitions?.[0]?.name?.value;
    if (operation === 'GetControllers') {
      return { data: { controllers }, loading: false, refetch: vi.fn() };
    }
    return { data: { controllerKeys: [] }, loading: false, refetch: vi.fn() };
  });
}

/** 按控制器名称定位卡片行（行容器为带 rounded-lg 的 flex 卡片）。 */
function controllerRow(name: string): HTMLElement {
  let el: HTMLElement | null = screen.getByText(name).parentElement;
  while (el && !el.className.includes('rounded-lg')) el = el.parentElement;
  if (!el) throw new Error(`controller row for "${name}" not found`);
  return el;
}

describe('ControllerListSection cloud controller operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMutation.mockReturnValue([vi.fn()]);
  });

  it('T-CCOP-WEB1: hides rename/regenerate/unbind for cloud controllers and keeps them for local ones', () => {
    mockQueries([
      controller({ id: 'cloud-1', name: 'Cloud Host', type: 'cloud', status: 'online' }),
      controller({ id: 'local-1', name: 'Local Host', type: 'local', status: 'online' }),
    ]);

    render(<ControllerListSection />);

    const cloudRow = controllerRow('Cloud Host');
    expect(within(cloudRow).getByRole('button', { name: '配置' })).toBeDefined();
    expect(within(cloudRow).queryByRole('button', { name: '重命名' })).toBeNull();
    expect(within(cloudRow).queryByRole('button', { name: '重新生成Key' })).toBeNull();
    expect(within(cloudRow).queryByRole('button', { name: '解绑' })).toBeNull();

    const localRow = controllerRow('Local Host');
    expect(within(localRow).getByRole('button', { name: '配置' })).toBeDefined();
    expect(within(localRow).getByRole('button', { name: '重命名' })).toBeDefined();
    expect(within(localRow).getByRole('button', { name: '重新生成Key' })).toBeDefined();
    expect(within(localRow).getByRole('button', { name: '解绑' })).toBeDefined();
  });

  it('T-CCOP-WEB2: hides regenerate/delete for cloud controllers in the unbound group', () => {
    mockQueries([
      controller({ id: 'cloud-2', name: 'Unbound Cloud', type: 'cloud', status: 'unbound' }),
      controller({ id: 'local-2', name: 'Unbound Local', type: 'local', status: 'unbound' }),
    ]);

    render(<ControllerListSection />);

    const cloudRow = controllerRow('Unbound Cloud');
    expect(within(cloudRow).queryByRole('button', { name: '重新生成Key' })).toBeNull();
    expect(within(cloudRow).queryByRole('button', { name: '删除' })).toBeNull();

    const localRow = controllerRow('Unbound Local');
    expect(within(localRow).getByRole('button', { name: '重新生成Key' })).toBeDefined();
    expect(within(localRow).getByRole('button', { name: '删除' })).toBeDefined();
  });
});
