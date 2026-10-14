import { describe, it, expect } from 'vitest';
import { GraphQLError } from 'graphql';
import { assertAdmin } from './guard';
import type { AdminAuthContext } from './auth.js';

describe('assertAdmin', () => {
  it('T-A7: rejects unauthenticated context', () => {
    expect(() => assertAdmin({ currentAdmin: null })).toThrow('Not authenticated');
  });

  it('T-A7: rejects mustChangePassword=true with MUST_CHANGE_PASSWORD', () => {
    const context: AdminAuthContext = {
      currentAdmin: { id: 'a1', username: 'admin', mustChangePassword: true },
    };

    try {
      assertAdmin(context);
      throw new Error('expected assertAdmin to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GraphQLError);
      expect((err as GraphQLError).message).toBe('MUST_CHANGE_PASSWORD');
    }
  });

  it('allows a fully authenticated admin', () => {
    const context: AdminAuthContext = {
      currentAdmin: { id: 'a1', username: 'admin', mustChangePassword: false },
    };
    expect(() => assertAdmin(context)).not.toThrow();
  });
});
