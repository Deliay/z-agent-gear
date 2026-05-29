import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PermissionDialog } from './PermissionDialog';

const mockRespondPermission = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useMutation: vi.fn(() => [mockRespondPermission]),
}));

describe('PermissionDialog', () => {
  it('should render', () => {
    render(<PermissionDialog open={true} onOpenChange={vi.fn()} todo={{
      id: 't', type: 'permission_request', priority: 'immediate',
      title: 'Test', description: null, isRead: false,
      data: { requestId: 'r', sessionId: 's', toolCallId: 'tc', options: [] },
      createdAt: '2026-05-28T10:00:00.000Z',
    }} />);
    expect(screen.getByText('Test')).toBeDefined();
  });
});
