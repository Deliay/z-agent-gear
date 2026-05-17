import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, signToken, verifyToken } from './auth';

describe('hashPassword / verifyPassword', () => {
  it('should hash a password and verify it correctly', async () => {
    const password = 'myPassword123';
    const hash = await hashPassword(password);
    expect(hash).toBeDefined();
    expect(hash).not.toBe(password);
    const isValid = await verifyPassword(password, hash);
    expect(isValid).toBe(true);
  });

  it('should reject wrong password', async () => {
    const hash = await hashPassword('correctPassword');
    const isValid = await verifyPassword('wrongPassword', hash);
    expect(isValid).toBe(false);
  });

  it('should produce different hashes for the same password (due to salt)', async () => {
    const password = 'samePassword';
    const hash1 = await hashPassword(password);
    const hash2 = await hashPassword(password);
    expect(hash1).not.toBe(hash2);
  });
});

describe('signToken / verifyToken', () => {
  it('should sign a token with userId and verify it', () => {
    const userId = 'abc123';
    const token = signToken(userId);
    expect(token).toBeDefined();
    expect(typeof token).toBe('string');

    const decoded = verifyToken(token);
    expect(decoded.userId).toBe(userId);
  });

  it('should reject an invalid token', () => {
    expect(() => verifyToken('invalid-token')).toThrow();
  });

  it('should reject a tampered token', () => {
    const token = signToken('user1');
    const parts = token.split('.');
    parts[1] = Buffer.from(JSON.stringify({ userId: 'hacker' })).toString('base64url');
    const tampered = parts.join('.');
    expect(() => verifyToken(tampered)).toThrow();
  });
});
