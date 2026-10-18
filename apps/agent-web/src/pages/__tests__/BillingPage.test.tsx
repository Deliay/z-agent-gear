import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MockedProvider } from '@apollo/client/testing/react';
import BillingPage from '../BillingPage';
import {
  MY_BILLING_ACCOUNT,
  MY_BILLING_API_CALLS,
  MY_BILLING_API_KEYS,
  MY_BILLING_INVOICES,
  MY_BILLING_RECEIPTS,
} from '@/graphql/queries';
import { CREATE_MY_BILLING_API_KEY, REVOKE_MY_BILLING_API_KEY } from '@/graphql/mutations';

const account = {
  __typename: 'BillingAccount',
  id: 'a1',
  ownerType: 'front_user',
  ownerId: 'u1',
  ownerName: 'alice',
  cashBalance: -3,
  giftBalance: 0,
  creditLimit: 0,
  frozenAmount: 1,
  availableBalance: -4,
  status: 'active',
  insufficientSince: '2026-10-18T00:00:00.000Z',
  ledgerCount: 2,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

function mocks() {
  return [
    {
      request: { query: MY_BILLING_ACCOUNT },
      result: { data: { myBillingAccount: account } },
    },
    {
      request: { query: MY_BILLING_INVOICES, variables: { page: 1, pageSize: 20 } },
      result: {
        data: {
          myBillingInvoices: [
            {
              __typename: 'BillingInvoice',
              id: 'i1',
              accountId: 'a1',
              seq: 0,
              type: 'charge',
              category: 'container',
              amount: -1,
              balanceAfter: -3,
              refType: 'container',
              refId: 'c1',
              description: '容器周期结算',
              items: [
                {
                  __typename: 'InvoiceItem',
                  productId: 'container.minute',
                  quantity: 1,
                  unitPrice: 1,
                  amount: 1,
                  meteringRef: null,
                },
              ],
              receiptId: null,
              createdAt: '2026-10-18T00:00:00.000Z',
            },
          ],
        },
      },
    },
    {
      request: { query: MY_BILLING_RECEIPTS, variables: { page: 1, pageSize: 20 } },
      result: { data: { myBillingReceipts: [] } },
    },
    {
      request: { query: MY_BILLING_API_CALLS, variables: { page: 1, pageSize: 20 } },
      result: {
        data: {
          myBillingApiCalls: [
            {
              __typename: 'BillingApiCall',
              id: 'c1',
              requestId: 'req-1',
              accountId: 'a1',
              modelId: 'm1',
              modelName: 'gpt-5',
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 5,
              cost: 0.1,
              status: 'aborted',
              estimated: false,
              invoiceSeq: 0,
              startedAt: '2026-10-18T00:00:00.000Z',
              finishedAt: '2026-10-18T00:00:01.000Z',
            },
          ],
        },
      },
    },
    {
      request: { query: MY_BILLING_API_KEYS },
      result: {
        data: {
          myBillingApiKeys: [
            {
              __typename: 'BillingApiKey',
              id: 'k1',
              name: 'my-key',
              keyPrefix: 'zag_sk_abcd',
              status: 'active',
              lastUsedAt: null,
              createdAt: '2026-10-18T00:00:00.000Z',
            },
          ],
        },
      },
    },
    {
      request: { query: CREATE_MY_BILLING_API_KEY, variables: { name: 'new-key' } },
      result: {
        data: {
          createMyBillingApiKey: {
            __typename: 'BillingApiKeyPayload',
            apiKey: {
              __typename: 'BillingApiKey',
              id: 'k2',
              name: 'new-key',
              keyPrefix: 'zag_sk_new1',
              status: 'active',
              lastUsedAt: null,
              createdAt: '2026-10-18T00:00:00.000Z',
            },
            secret: 'zag_sk_new1secret',
          },
        },
      },
    },
    {
      request: { query: REVOKE_MY_BILLING_API_KEY, variables: { id: 'k1' } },
      result: {
        data: {
          revokeMyBillingApiKey: {
            __typename: 'BillingApiKey',
            id: 'k1',
            name: 'my-key',
            keyPrefix: 'zag_sk_abcd',
            status: 'revoked',
            lastUsedAt: null,
            createdAt: '2026-10-18T00:00:00.000Z',
          },
        },
      },
    },
  ];
}

function renderPage() {
  return render(
    <MockedProvider mocks={mocks()}>
      <BillingPage />
    </MockedProvider>,
  );
}

describe('前台我的费用', () => {
  it('T-AW7/AW8: 欠费提示、账单可见、无自助充值入口', async () => {
    renderPage();
    expect(await screen.findByText('我的费用')).toBeDefined();
    expect(await screen.findByText(/账户已欠费/)).toBeDefined();
    expect(await screen.findByText('容器周期结算')).toBeDefined();
    expect(screen.queryByRole('button', { name: '充值' })).toBeNull();
    expect(screen.getByText('仅支持后台充值，本页面不提供自助充值入口。')).toBeDefined();
    // T-B26 可见性：中断调用在「模型调用记录」中标注
    expect(await screen.findByText('中断调用')).toBeDefined();
    // 分页控件
    expect(screen.getAllByText(/第 1 页/).length).toBeGreaterThan(0);
  });

  it('T-AW9: 生成 Key 一次性展示、吊销二次确认', async () => {
    renderPage();
    await screen.findByText('my-key');

    fireEvent.change(screen.getByPlaceholderText('Key 名称'), { target: { value: 'new-key' } });
    fireEvent.click(screen.getByRole('button', { name: '生成' }));
    expect(await screen.findByText('zag_sk_new1secret')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '我已保存' }));
    await waitFor(() => {
      expect(screen.queryByText('zag_sk_new1secret')).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: '吊销' }));
    expect(await screen.findByText('吊销 API Key')).toBeDefined();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog.querySelector('button:last-of-type') as HTMLButtonElement);
    await waitFor(() => {
      expect(screen.getByText('已吊销')).toBeDefined();
    });
  });
});
