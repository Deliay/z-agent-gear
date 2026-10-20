import { describe, it, expect } from 'vitest';
import { GraphQLError } from 'graphql';
import { ApiKeyNotFoundError } from '../../services/billing/api-key-service.js';
import { MoneyError } from '../../services/billing/money.js';
import { billingError, toBillingGraphQLError } from './billing.js';

/** R2-5：错误映射断言（MoneyError / ApiKeyNotFound / 业务消息 / 未知错误 四类）。 */
describe('admin-api billing 错误映射（O1/R2-5）', () => {
  const codeOf = (err: unknown) =>
    (toBillingGraphQLError(err) as GraphQLError).extensions?.code as string | undefined;

  it('MoneyError → INVALID_ARGUMENT 且保留消息', () => {
    const mapped = toBillingGraphQLError(new MoneyError('金额精度非法'));
    expect((mapped as GraphQLError).message).toBe('金额精度非法');
    expect(mapped.extensions?.code).toBe('INVALID_ARGUMENT');
  });

  it('ApiKeyNotFoundError → NOT_FOUND', () => {
    expect(codeOf(new ApiKeyNotFoundError('key 不存在'))).toBe('NOT_FOUND');
  });

  it('业务消息启发式：不存在/已存在/余额不足/非法 各自有稳定 code', () => {
    expect(codeOf(new Error('账户不存在'))).toBe('NOT_FOUND');
    expect(codeOf(new Error('该记录已存在'))).toBe('CONFLICT');
    expect(codeOf(new Error('余额不足，请联系管理员充值'))).toBe('INSUFFICIENT_FUNDS');
    expect(codeOf(new Error('授信额度不能为负数'))).toBe('INVALID_ARGUMENT');
  });

  it('未知错误 → INTERNAL_SERVER_ERROR（不泄露内部原文）', () => {
    const mapped = toBillingGraphQLError(new Error('ECONNRESET: socket hang up'));
    expect(mapped.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    expect((mapped as GraphQLError).message).toBe('服务内部错误，请稍后重试');
  });

  it('已是 GraphQLError 的原样透传（不覆盖既有 code）', () => {
    const original = billingError('非法对账线', 'INVALID_ARGUMENT');
    expect(toBillingGraphQLError(original)).toBe(original);
  });
});
