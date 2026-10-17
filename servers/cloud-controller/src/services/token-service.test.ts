import { describe, it, expect, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { TokenService } from './token-service.js';
import { InMemoryContainerRepository } from '../repositories/container-repository.js';
import type { CloudContainerStatus } from '../models/cloud-container.js';

async function seed(
  repo: InMemoryContainerRepository,
  status: CloudContainerStatus = 'connecting',
) {
  return repo.create({
    name: `zag-worker-${Math.random().toString(36).slice(2, 8)}`,
    namespace: 'zag-workers',
    purpose: 'idle',
    image: 'zero-tools/zag-worker:latest',
    status,
  });
}

describe('TokenService', () => {
  it('T-T1: issue → verify roundtrip returns the container', async () => {
    const repo = new InMemoryContainerRepository();
    const service = new TokenService(repo);
    const container = await seed(repo);

    const token = await service.issue(container.id);
    expect(token.startsWith(`${container.id}.`)).toBe(true);

    const verified = await service.verify(token);
    expect(verified?.id).toBe(container.id);

    // tokenHash 已落库且为 bcrypt 哈希
    const stored = await repo.findById(container.id);
    expect(stored?.tokenHash).toBeTruthy();
    expect(stored?.tokenHash).not.toBe(token);
  });

  it('T-T2: tampered secret or malformed token is rejected', async () => {
    const repo = new InMemoryContainerRepository();
    const service = new TokenService(repo);
    const container = await seed(repo);
    const token = await service.issue(container.id);
    const [id, secret] = [token.slice(0, token.indexOf('.')), token.slice(token.indexOf('.') + 1)];

    expect(await service.verify(`${id}.${secret}tampered`)).toBeNull();
    expect(await service.verify(secret)).toBeNull();
    expect(await service.verify(`.${secret}`)).toBeNull();
    expect(await service.verify('')).toBeNull();
    expect(await service.verify(undefined)).toBeNull();
  });

  it('T-T3: unknown containerId is rejected without a full-table scan', async () => {
    const repo = new InMemoryContainerRepository();
    const service = new TokenService(repo);
    const findAllSpy = vi.spyOn(repo, 'findAll');
    const compareSpy = vi.spyOn(bcrypt, 'compare');

    const result = await service.verify('64b8f0c2a1d3e4f5a6b7c890.somesecret');

    expect(result).toBeNull();
    expect(findAllSpy).not.toHaveBeenCalled();
    expect(compareSpy).not.toHaveBeenCalled();
    findAllSpy.mockRestore();
    compareSpy.mockRestore();
  });

  it('T-T4: terminal containers or cleared tokenHash are rejected', async () => {
    const repo = new InMemoryContainerRepository();
    const service = new TokenService(repo);
    const container = await seed(repo);
    const token = await service.issue(container.id);

    await repo.update(container.id, { status: 'exited' });
    expect(await service.verify(token)).toBeNull();

    await repo.update(container.id, { status: 'connecting', tokenHash: null });
    expect(await service.verify(token)).toBeNull();
  });
});
