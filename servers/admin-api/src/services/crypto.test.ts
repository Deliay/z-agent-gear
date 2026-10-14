import { describe, it, expect } from 'vitest';
import { config } from '../config/index.js';
import { encrypt, decrypt } from './crypto';

describe('crypto (AES-256-GCM)', () => {
  it('round-trips a plaintext credential', () => {
    const encrypted = encrypt('sk-secret-key');
    expect(encrypted.iv).toMatch(/^[0-9a-f]+$/);
    expect(encrypted.ciphertext).not.toContain('sk-secret-key');
    expect(decrypt(encrypted)).toBe('sk-secret-key');
  });

  it('produces different ciphertexts for the same input (random IV)', () => {
    expect(encrypt('same-input').ciphertext).not.toBe(encrypt('same-input').ciphertext);
  });

  it('fails to decrypt tampered data', () => {
    const encrypted = encrypt('sk-secret-key');
    expect(() => decrypt({ ...encrypted, ciphertext: 'ff' + encrypted.ciphertext })).toThrow();
  });

  it('throws when the encryption key is not configured', () => {
    const original = config.credentialEncryptionKey;
    config.credentialEncryptionKey = '';
    try {
      expect(() => encrypt('x')).toThrow('CREDENTIAL_ENCRYPTION_KEY is not configured');
    } finally {
      config.credentialEncryptionKey = original;
    }
  });
});
