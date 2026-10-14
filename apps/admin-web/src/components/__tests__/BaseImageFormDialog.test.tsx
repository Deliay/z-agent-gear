import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BaseImageFormDialog from '../base-images/BaseImageFormDialog';

describe('BaseImageFormDialog', () => {
  it('T-W4: disables save until name and dockerfile are provided', () => {
    render(<BaseImageFormDialog open onOpenChange={() => {}} onSave={vi.fn()} />);

    const save = screen.getByRole('button', { name: '保存' });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('镜像名称'), { target: { value: 'node-base' } });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Dockerfile'), { target: { value: 'FROM node' } });
    expect(save).not.toBeDisabled();
  });

  it('T-W4: Dockerfile textarea guards against horizontal overflow', () => {
    render(<BaseImageFormDialog open onOpenChange={() => {}} onSave={vi.fn()} />);
    const textarea = screen.getByLabelText('Dockerfile');
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.className).toContain('font-mono');
    expect(textarea.className).toContain('whitespace-pre-wrap');
    expect(textarea.className).toContain('min-w-0');
  });

  it('T-W4: surfaces a save error', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Base image name already exists'));
    render(<BaseImageFormDialog open onOpenChange={() => {}} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText('镜像名称'), { target: { value: 'node-base' } });
    fireEvent.change(screen.getByLabelText('Dockerfile'), { target: { value: 'FROM node' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Base image name already exists'),
    );
  });
});
