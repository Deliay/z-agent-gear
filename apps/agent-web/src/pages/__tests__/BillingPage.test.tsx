import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MockedProvider } from '@apollo/client/testing/react';
import BillingPage from '../BillingPage';
import {
  MY_BILLING_ACCOUNT,
  MY_BILLING_API_CALLS,
  MY_BILLING_API_KEYS,
  MY_BILLING_INVOICES,
  MY_BILLING_RECEIPT,
} from '@/graphql/queries';
import { CREATE_MY_BILLING_API_KEY, REVOKE_MY_BILLING_API_KEY } from '@/graphql/mutations';

const account = {
  __typename: 'BillingAccount',
  id: 'a1',
  ownerType: 'tenant',
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

function mocks(options: { receiptError?: boolean } = {}) {
  return [
    {
      request: { query: MY_BILLING_ACCOUNT },
      result: { data: { myBillingAccount: account } },
    },
    {
      request: {
        query: MY_BILLING_INVOICES,
        variables: { from: null, to: null, type: null, category: null, page: 1, pageSize: 20 },
      },
      result: {
        data: {
          myBillingInvoices: Array.from({ length: 20 }, (_, index) => ({
            __typename: 'BillingInvoice',
            id: index === 0 ? 'i1' : `i1-${index}`,
            accountId: 'a1',
            seq: index,
            type: index === 1 ? 'recharge' : 'charge',
            category: index === 1 ? 'manual' : 'container',
            amount: index === 1 ? 10 : -1,
            balanceAfter: -3,
            refType: 'container',
            refId: `c${index}`,
            description: index === 0 ? '容器周期结算' : index === 1 ? '后台充值' : `容器周期结算 ${index}`,
            items: [
              {
                __typename: 'InvoiceItem',
                productId: 'container.minute',
                quantity: 1,
                unitPrice: 1,
                amount: 1,
                meteringRef: null,
                segment: null,
              },
            ],
            receiptId: index === 1 ? 'r1' : null,
            createdAt: '2026-10-18T00:00:00.000Z',
          })),
        },
      },
    },
    {
      request: {
        query: MY_BILLING_INVOICES,
        variables: { from: null, to: null, type: null, category: null, page: 2, pageSize: 20 },
      },
      result: {
        data: {
          myBillingInvoices: [
            {
              __typename: 'BillingInvoice',
              id: 'i2',
              accountId: 'a1',
              seq: 21,
              type: 'charge',
              category: 'model',
              amount: -2,
              balanceAfter: -5,
              refType: 'model_call',
              refId: 'r2',
              description: '模型调用 m1',
              items: [
                {
                  __typename: 'InvoiceItem',
                  productId: 'model.m1.output',
                  quantity: 2,
                  unitPrice: 1,
                  amount: 2,
                  meteringRef: null,
                  segment: 'output',
                },
              ],
              receiptId: null,
              createdAt: '2026-10-17T00:00:00.000Z',
            },
          ],
        },
      },
    },
    {
      request: { query: MY_BILLING_RECEIPT, variables: { invoiceId: 'i1-1' } },
      result: {
        data: {
          myBillingReceipt: {
            __typename: 'BillingReceipt',
            id: 'r1',
            receiptNo: 'R-0001',
            invoiceId: 'i1-1',
            accountId: 'a1',
            amount: 10,
            balanceAfter: -3,
            issuedAt: '2026-10-18T00:00:01.000Z',
          },
        },
      },
    },
    {
      request: { query: MY_BILLING_RECEIPT, variables: { invoiceId: 'i2' } },
      ...(options.receiptError
        ? { error: new Error('receipt query failed') }
        : {
            result: {
              data: {
                myBillingReceipt: {
                  __typename: 'BillingReceipt',
                  id: 'r2',
                  receiptNo: 'R-0002',
                  invoiceId: 'i2',
                  accountId: 'a1',
                  amount: -2,
                  balanceAfter: -5,
                  issuedAt: '2026-10-17T00:00:01.000Z',
                },
              },
            },
          }),
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

function renderPage(options: { receiptError?: boolean } = {}) {
  return render(
    <MockedProvider mocks={mocks(options)}>
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

  it('T-AW10: 账单翻页后查看收据仍显示正确收据号（不误报无收据）', async () => {
    renderPage();
    await screen.findByText('容器周期结算');

    // 账单卡片是页面上第一个分页控件
    fireEvent.click(screen.getAllByRole('button', { name: '下一页' })[0]);
    expect(await screen.findByText('模型调用 m1')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    expect(await screen.findByText('收据号 R-0002')).toBeDefined();
    expect(screen.queryByText('该账单暂无收据')).toBeNull();
  });

  it('R10-5: 充值账单（recharge）同样可查看收据', async () => {
    renderPage();
    await screen.findByText('后台充值');
    // 第一页第二个「查看」对应 receiptId 非空的充值账单。
    fireEvent.click(screen.getAllByRole('button', { name: '查看' })[1]);
    expect(await screen.findByText('收据号 R-0001')).toBeDefined();
  });

  it('T-AW11: 收据查询失败展示错误态而非误报「暂无收据」', async () => {
    renderPage({ receiptError: true });
    await screen.findByText('容器周期结算');
    fireEvent.click(screen.getAllByRole('button', { name: '下一页' })[0]);
    expect(await screen.findByText('模型调用 m1')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    expect(await screen.findByText('收据加载失败，请稍后重试')).toBeDefined();
    expect(screen.queryByText('该账单暂无收据')).toBeNull();
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
