import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApolloClient, ApolloLink, InMemoryCache, Observable } from '@apollo/client';
import { ApolloProvider } from '@apollo/client/react';
import CommitSettingsSection from '../CommitSettingsSection';

const mockToastSuccess = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: vi.fn(),
  },
}));

const ACCOUNT = {
  id: 'acc1',
  githubUserId: 1,
  githubLogin: 'octocat',
  githubAvatarUrl: null,
  installations: [],
  createdAt: '2026-01-01T00:00:00Z',
};

interface SettingsState {
  committerMode: 'AGENT_ONLY' | 'CO_AUTHOR' | 'HUMAN_ONLY' | 'UNSET';
  committerType: 'GITHUB_ACCOUNT' | 'CUSTOM' | 'UNSET';
  githubAccountId: string | null;
  customName: string | null;
  customEmail: string | null;
}

function createHarness() {
  let settings: SettingsState = {
    committerMode: 'UNSET',
    committerType: 'UNSET',
    githubAccountId: null,
    customName: null,
    customEmail: null,
  };
  const operationNames: string[] = [];

  const link = new ApolloLink(
    (operation) =>
      new Observable((observer) => {
        operationNames.push(operation.operationName ?? '');
        if (operation.operationName === 'GetGithubAccounts') {
          observer.next({ data: { githubAccounts: [ACCOUNT] } });
          observer.complete();
          return;
        }
        if (operation.operationName === 'GetCommitSettings') {
          observer.next({ data: { commitSettings: { ...settings } } });
          observer.complete();
          return;
        }
        if (operation.operationName === 'UpdateCommitSettings') {
          const input = operation.variables.input as Partial<SettingsState>;
          settings = {
            committerMode: input.committerMode ?? 'UNSET',
            committerType: input.committerType ?? 'UNSET',
            githubAccountId: input.githubAccountId ?? null,
            customName: input.customName ?? null,
            customEmail: input.customEmail ?? null,
          };
          observer.next({ data: { updateCommitSettings: { ...settings } } });
          observer.complete();
          return;
        }
        observer.error(new Error(`unexpected operation: ${operation.operationName}`));
      }),
  );

  const client = new ApolloClient({ link, cache: new InMemoryCache() });
  return { client, operationNames, settings: () => settings };
}

describe('CommitSettingsSection 缓存回写（真实 Apollo cache）', () => {
  it('保存后卸载重挂载仍展示已保存值（不回到旧缓存）', async () => {
    const harness = createHarness();
    const first = render(
      <ApolloProvider client={harness.client}>
        <CommitSettingsSection />
      </ApolloProvider>,
    );

    const modeGroup = () => screen.getByRole('radiogroup', { name: '提交人模式' });
    const typeGroup = () => screen.getByRole('radiogroup', { name: '提交人' });

    await waitFor(() => {
      expect(modeGroup().querySelector('input[value="UNSET"]')).toBeChecked();
    });

    fireEvent.click(modeGroup().querySelector('input[value="HUMAN_ONLY"]')!);
    fireEvent.click(typeGroup().querySelector('input[value="CUSTOM"]')!);
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'Zhang San' } });
    fireEvent.change(screen.getByLabelText('邮箱'), {
      target: { value: 'zhangsan@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存 Commit 设置' }));

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalled();
    });

    first.unmount();

    render(
      <ApolloProvider client={harness.client}>
        <CommitSettingsSection />
      </ApolloProvider>,
    );

    await waitFor(() => {
      expect(modeGroup().querySelector('input[value="HUMAN_ONLY"]')).toBeChecked();
    });
    expect(typeGroup().querySelector('input[value="CUSTOM"]')).toBeChecked();
    expect((screen.getByLabelText('用户名') as HTMLInputElement).value).toBe('Zhang San');
    expect((screen.getByLabelText('邮箱') as HTMLInputElement).value).toBe('zhangsan@example.com');
    expect(harness.operationNames.filter((name) => name === 'GetCommitSettings').length).toBeGreaterThan(1);
  });
});
