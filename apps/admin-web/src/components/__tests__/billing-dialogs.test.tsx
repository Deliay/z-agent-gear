import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MockedProvider } from '@apollo/client/testing/react';
import RechargeDialog from '../billing/RechargeDialog';
import ModelPricingSection from '../billing/ModelPricingSection';
import { ADMIN_MODELS } from '@/graphql/queries';
import { UPDATE_MODEL_PRICING } from '@/graphql/mutations';
import type { BillingAccountData } from '@/graphql/types';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from 'sonner';

const account: BillingAccountData = {
  id: 'a1',
  ownerType: 'admin_user',
  ownerId: 'admin',
  ownerName: 'admin',
  cashBalance: 1,
  giftBalance: 0,
  creditLimit: 0,
  frozenAmount: 0,
  availableBalance: 1,
  status: 'active',
  insufficientSince: null,
  ledgerCount: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

describe('费用中心交互组件', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-AW2: 充值金额 0/负数/超精度被拒', async () => {
    render(
      <MockedProvider mocks={[]}>
        <RechargeDialog account={account} open onClose={() => {}} />
      </MockedProvider>,
    );
    const confirm = screen.getByRole('button', { name: '确认充值' });
    fireEvent.click(confirm);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('充值金额必须为正数'));

    fireEvent.change(screen.getByPlaceholderText('例如 100.00'), { target: { value: '1.001' } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('充值金额最多支持 0.01 credits 精度'),
    );
  });

  it('T-AW6: 模型定价编辑保存调用 updateModelPricing 并回显', async () => {
    const model = {
      __typename: 'Model',
      id: 'm1',
      providerId: 'p1',
      name: 'gpt-5',
      isCustom: false,
      isEnabled: true,
      sortOrder: 0,
      scope: 'global',
      pricing: {
        __typename: 'ModelPricing',
        inputPerMillion: 1,
        cachedInputPerMillion: 0.5,
        outputPerMillion: 2,
        isBillable: true,
      },
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    render(
      <MockedProvider
        mocks={[
          {
            request: { query: ADMIN_MODELS },
            result: { data: { adminModels: [model] } },
          },
          {
            request: { query: ADMIN_MODELS },
            result: { data: { adminModels: [model] } },
          },
          {
            request: {
              query: UPDATE_MODEL_PRICING,
              variables: {
                modelId: 'm1',
                pricing: {
                  inputPerMillion: 3,
                  cachedInputPerMillion: 0.5,
                  outputPerMillion: 2,
                  isBillable: true,
                },
              },
            },
            result: {
              data: {
                updateModelPricing: {
                  __typename: 'Model',
                  id: 'm1',
                  name: 'gpt-5',
                  pricing: {
                    __typename: 'ModelPricing',
                    inputPerMillion: 3,
                    cachedInputPerMillion: 0.5,
                    outputPerMillion: 2,
                    isBillable: true,
                  },
                },
              },
            },
          },
        ]}
       
      >
        <ModelPricingSection />
      </MockedProvider>,
    );
    expect(await screen.findByText('gpt-5')).toBeDefined();
    const inputs = screen.getAllByDisplayValue('1');
    fireEvent.change(inputs[0], { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('模型定价已保存'));
  });
});
