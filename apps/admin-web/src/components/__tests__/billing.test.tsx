import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AccountTable from '../billing/AccountTable';
import ReceiptDrawer from '../billing/ReceiptDrawer';
import RollupChart from '../billing/RollupChart';
import type { BillingAccountData, BillingInvoiceData } from '@/graphql/types';

const accounts: BillingAccountData[] = [
  {
    id: 'a1',
    ownerType: 'front_user',
    ownerId: 'u1',
    ownerName: 'alice',
    cashBalance: -30,
    giftBalance: 0,
    creditLimit: 0,
    frozenAmount: 100,
    availableBalance: -130,
    status: 'active',
    insufficientSince: '2026-10-18T00:00:00.000Z',
    ledgerCount: 3,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    id: 'a2',
    ownerType: 'admin_user',
    ownerId: 'admin',
    ownerName: 'admin',
    cashBalance: 500,
    giftBalance: 0,
    creditLimit: 1000,
    frozenAmount: 0,
    availableBalance: 1500,
    status: 'active',
    insufficientSince: null,
    ledgerCount: 1,
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
  },
];

describe('费用中心组件', () => {
  it('T-AW1: 账户列表展示余额/冻结/欠费状态并可筛选充值目标', () => {
    const onSelect = vi.fn();
    const onRecharge = vi.fn();
    render(
      <AccountTable
        accounts={accounts}
        selectedId={null}
        onSelect={onSelect}
        onRecharge={onRecharge}
      />,
    );

    expect(screen.getByText('alice')).toBeDefined();
    expect(screen.getByText('-130.00')).toBeDefined();
    expect(screen.getByText('正常')).toBeDefined();
    expect(screen.getByText(/欠费/)).toBeDefined();

    fireEvent.click(screen.getAllByRole('button', { name: '充值' })[0]);
    expect(onRecharge).toHaveBeenCalledWith(accounts[0]);
  });

  it('T-MT-ADMIN: 账户类型兼容 tenant 文案', () => {
    render(
      <AccountTable
        accounts={[{ ...accounts[0], id: 'a3', ownerType: 'tenant', ownerName: 'tenant-a' }]}
        selectedId={null}
        onSelect={vi.fn()}
        onRecharge={vi.fn()}
      />,
    );
    expect(screen.getByText('tenant-a')).toBeDefined();
    expect(screen.getByText('租户')).toBeDefined();
  });

  it('T-AW4: 汇总图按桶渲染消费与充值', () => {
    render(
      <RollupChart
        rollups={[
          { bucketStart: '2026-10-18T00:00:00.000Z', chargeTotal: 5, rechargeTotal: 100, chargeCount: 2 },
        ]}
      />,
    );
    expect(screen.getByText(/消费 5\.00/)).toBeDefined();
    expect(screen.getByText(/充值 100\.00/)).toBeDefined();
  });

  it('T-AUI-RD1: ReceiptDrawer 以右侧 Sheet 呈现，金额等宽右对齐', () => {
    const invoice: BillingInvoiceData = {
      id: 'i1',
      accountId: 'a1',
      seq: 12,
      type: 'charge',
      category: 'model',
      amount: -12.34,
      balanceAfter: 87.66,
      refType: 'metering',
      refId: 'm1',
      description: '模型调用扣费',
      items: [
        {
          productId: 'gpt-5',
          unitPrice: 2,
          quantity: 1,
          amount: -12.34,
          meteringRef: 'mr1',
          segment: 'aborted',
        },
      ],
      receiptId: 'r1',
      createdAt: '2026-10-18T00:00:00.000Z',
    };

    render(
      <ReceiptDrawer
        invoice={invoice}
        receipt={null}
        open
        onClose={() => {}}
      />,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('data-side', 'right');
    expect(dialog.className).toContain('sm:max-w-[560px]');
    expect(screen.getByRole('heading', { name: '收据' })).toBeDefined();
    expect(screen.getByText('用量与单价快照')).toBeDefined();
    const amount = screen.getByText('-12.34 credits');
    expect(amount.className).toContain('tabular-nums');
    expect(amount.className).toContain('text-right');
  });
});
