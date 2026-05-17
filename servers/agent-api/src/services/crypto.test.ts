import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from './crypto';

describe('encrypt / decrypt', () => {
  it('should encrypt and decrypt a value correctly', () => {
    const plaintext = 'sk-proj-test-key-123456';
    const encrypted = encrypt(plaintext);
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.tag).toBeDefined();
    expect(encrypted.ciphertext).not.toBe(plaintext);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('should produce different ciphertext each time (due to random IV)', () => {
    const plaintext = 'same-value';
    const enc1 = encrypt(plaintext);
    const enc2 = encrypt(plaintext);
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    expect(enc1.iv).not.toBe(enc2.iv);
    expect(decrypt(enc1)).toBe(plaintext);
    expect(decrypt(enc2)).toBe(plaintext);
  });

  it('should handle empty string', () => {
    const encrypted = encrypt('');
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe('');
  });

  it('should reject tampered ciphertext', () => {
    const encrypted = encrypt('test-value');
    encrypted.ciphertext = 'tampered';
    expect(() => decrypt(encrypted)).toThrow();
  });

  it('should reject tampered tag', () => {
    const encrypted = encrypt('test-value');
    encrypted.tag = 'tampered';
    expect(() => decrypt(encrypted)).toThrow();
  });
});
