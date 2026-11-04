import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoHarnessSecretRepository } from './harness-secret-repository.js';
import { HarnessSecret } from '../models/harness-secret.js';
import type { HarnessSecrets } from '../services/secret-store.js';

/** 真库用例：secret 持久化的幂等覆盖、全量读取与删除（Issue #446）。 */
describe('MongoHarnessSecretRepository (real db)', () => {
  let server: MongoMemoryServer;
  const repository = new MongoHarnessSecretRepository();

  const secrets = (overrides: Partial<HarnessSecrets> = {}): HarnessSecrets => ({
    hostEndpoint: 'wss://controller.example.com',
    hostKey: 'zag_k_host-secret',
    modelApiKey: 'zag_sk_model-secret',
    modelBaseUrl: 'http://admin-api:8002/v1',
    modelIds: '["model-a"]',
    defaultWorkspace: '/home/worker/workspace',
    ...overrides,
  });

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri('agent-gear-harness-secret-test'));
    await HarnessSecret.init();
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.collection('cloudcontainersecrets').deleteMany({});
  });

  it('upsert 幂等覆盖、findAll 读回、delete 删除', async () => {
    await repository.upsert('container-1', secrets());
    await repository.upsert('container-1', secrets({ modelApiKey: 'zag_sk_rotated' }));
    await repository.upsert('container-2', secrets({ modelContextLengths: '{"model-a":1000}' }));

    const all = await repository.findAll();
    expect(all).toHaveLength(2);
    const first = all.find((record) => record.containerId === 'container-1');
    expect(first?.secrets.modelApiKey).toBe('zag_sk_rotated');
    const second = all.find((record) => record.containerId === 'container-2');
    expect(second?.secrets.modelContextLengths).toBe('{"model-a":1000}');

    await repository.delete('container-1');
    const remaining = await repository.findAll();
    expect(remaining.map((record) => record.containerId)).toEqual(['container-2']);

    // 删除不存在记录视为成功（幂等）
    await expect(repository.delete('container-1')).resolves.toBeUndefined();
  });

  it('containerId 唯一索引存在且重复插入由 upsert 吸收', async () => {
    await repository.upsert('container-1', secrets());
    await repository.upsert('container-1', secrets());
    const collection = mongoose.connection.collection('cloudcontainersecrets');
    const indexes = await collection.indexes();
    expect(
      indexes.some((index) => index.unique === true && index.key.containerId === 1),
    ).toBe(true);
    expect(await collection.countDocuments({ containerId: 'container-1' })).toBe(1);
  });
});
