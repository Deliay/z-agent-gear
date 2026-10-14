import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BaseImagePage from '@/pages/BaseImagePage';

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@apollo/client', () => ({
  gql: (strings: TemplateStringsArray) => strings.join(''),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
  useMutation: (doc: unknown) => {
    const source = String(doc);
    if (source.includes('CreateBaseImage')) return [mocks.create, { loading: false }];
    if (source.includes('UpdateBaseImage')) return [mocks.update, { loading: false }];
    if (source.includes('DeleteBaseImage')) return [mocks.remove, { loading: false }];
    return [vi.fn(), { loading: false }];
  },
}));

function image(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    name: 'node-base',
    description: 'Node base image',
    dockerfile: 'FROM node:24-alpine',
    createdAt: '2026-02-01T00:00:00Z',
    updatedAt: '2026-02-03T00:00:00Z',
    ...overrides,
  };
}

function setupImages(images: unknown[]) {
  mocks.useQuery.mockReturnValue({ data: { baseImages: images }, loading: false });
}

describe('BaseImagePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-W5: shows empty state and create guidance', () => {
    setupImages([]);
    render(<BaseImagePage />);
    expect(screen.getByText('暂无基础镜像')).toBeDefined();
    expect(screen.getByRole('button', { name: '新建基础镜像' })).toBeDefined();
  });

  it('T-W4: lists name, description and updated time', () => {
    setupImages([image()]);
    render(<BaseImagePage />);
    expect(screen.getByText('node-base')).toBeDefined();
    expect(screen.getByText('Node base image')).toBeDefined();
  });

  it('T-W4: creates a base image through the dialog', async () => {
    setupImages([]);
    mocks.create.mockResolvedValue({});
    render(<BaseImagePage />);

    fireEvent.click(screen.getByRole('button', { name: '新建基础镜像' }));
    fireEvent.change(screen.getByLabelText('镜像名称'), { target: { value: 'python-base' } });
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: 'Python image' } });
    fireEvent.change(screen.getByLabelText('Dockerfile'), {
      target: { value: 'FROM python:3.12' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: {
            input: { name: 'python-base', description: 'Python image', dockerfile: 'FROM python:3.12' },
          },
        }),
      ),
    );
  });

  it('T-W4: surfaces a duplicate-name error', async () => {
    setupImages([]);
    mocks.create.mockRejectedValue(new Error('Base image name already exists'));
    render(<BaseImagePage />);

    fireEvent.click(screen.getByRole('button', { name: '新建基础镜像' }));
    fireEvent.change(screen.getByLabelText('镜像名称'), { target: { value: 'node-base' } });
    fireEvent.change(screen.getByLabelText('Dockerfile'), { target: { value: 'FROM node' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Base image name already exists'),
    );
  });

  it('T-W4: delete asks for confirmation before mutating', async () => {
    setupImages([image()]);
    mocks.remove.mockResolvedValue({});
    render(<BaseImagePage />);

    fireEvent.click(screen.getByRole('button', { name: '删除 node-base' }));
    // 确认对话框出现
    expect(screen.getByText('删除基础镜像')).toBeDefined();
    expect(mocks.remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledWith(
        expect.objectContaining({ variables: { id: 'b1' } }),
      ),
    );
  });
});
