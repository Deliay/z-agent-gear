import { describe, it, expect } from 'vitest';
import { SecretStore, type HarnessSecrets } from './secret-store.js';

function secrets(overrides: Partial<HarnessSecrets> = {}): HarnessSecrets {
  return {
    hostEndpoint: 'wss://controller.example.com',
    hostKey: 'zag_k_1_host-secret',
    modelApiKey: 'zag_sk_model-secret',
    modelBaseUrl: 'http://admin-api:8002/v1',
    modelIds: '["model-a","model-b"]',
    defaultWorkspace: '/root/workspace',
    ...overrides,
  };
}

describe('SecretStore', () => {
  it('T-CC6: put/get/delete 仅内存持有，按容器 ID 隔离', () => {
    const store = new SecretStore();

    expect(store.get('container-1')).toBeNull();

    store.put('container-1', secrets());
    expect(store.get('container-1')).toEqual(secrets());
    expect(store.get('container-2')).toBeNull();

    expect(store.delete('container-1')).toBe(true);
    expect(store.get('container-1')).toBeNull();
    // 删除不存在的 key 幂等
    expect(store.delete('container-1')).toBe(false);
  });

  it('T-CC6: get 返回副本，调用方修改不污染存储', () => {
    const store = new SecretStore();
    store.put('container-1', secrets());

    const first = store.get('container-1')!;
    first.modelApiKey = 'tampered';
    first.modelIds = '[]';

    const second = store.get('container-1')!;
    expect(second.modelApiKey).toBe('zag_sk_model-secret');
    expect(second.modelIds).toBe('["model-a","model-b"]');

    // put 同样拷贝入参
    const input = secrets();
    store.put('container-2', input);
    input.hostKey = 'tampered';
    expect(store.get('container-2')!.hostKey).toBe('zag_k_1_host-secret');
  });

  it('T-CC6: 重复 put 覆盖原值（不保留旧 secret）', () => {
    const store = new SecretStore();
    store.put('container-1', secrets());
    store.put('container-1', secrets({ modelApiKey: 'zag_sk_next' }));

    expect(store.get('container-1')!.modelApiKey).toBe('zag_sk_next');
    expect(store.size).toBe(1);
  });
});
