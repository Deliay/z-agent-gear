import { describe, it, expect } from 'vitest';
import { loadConfig, assertRuntimeConfig } from './index.js';

describe('cloud-controller config', () => {
  it('applies defaults and parses numbers/booleans', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(4003);
    expect(cfg.mongodbUri).toBe('mongodb://localhost:27017/agent-gear');
    expect(cfg.connectTimeoutMs).toBe(300000);
    expect(cfg.k8sEnabled).toBe(true);
    expect(cfg.runtimeClassName).toBe('sysbox-runc');
  });

  it('reads overrides from env', () => {
    const cfg = loadConfig({
      PORT: '10004',
      MONGODB_URI: 'mongodb://mongo:27017/ag',
      INTERNAL_API_TOKEN: 'tok',
      K8S_NAMESPACE: 'zag-cloud',
      WORKER_IMAGE: 'worker:1',
      PUBLIC_WS_ENDPOINT: 'cc.example.com',
      CONNECT_TIMEOUT_MS: '1000',
      K8S_ENABLED: 'false',
      RUNTIME_CLASS_NAME: 'runc',
    } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({
      port: 10004,
      mongodbUri: 'mongodb://mongo:27017/ag',
      internalApiToken: 'tok',
      k8sNamespace: 'zag-cloud',
      workerImage: 'worker:1',
      publicWsEndpoint: 'cc.example.com',
      connectTimeoutMs: 1000,
      k8sEnabled: false,
      runtimeClassName: 'runc',
    });
  });

  it('parses K8S_ENABLED=1 as true and invalid numbers as defaults', () => {
    const cfg = loadConfig({ K8S_ENABLED: '1', PORT: 'not-a-number' } as NodeJS.ProcessEnv);
    expect(cfg.k8sEnabled).toBe(true);
    expect(cfg.port).toBe(4003);
  });

  it('assertRuntimeConfig fails fast on missing required values', () => {
    const missing = loadConfig({} as NodeJS.ProcessEnv);
    expect(() => assertRuntimeConfig(missing)).toThrow(/INTERNAL_API_TOKEN/);

    const ok = loadConfig({
      INTERNAL_API_TOKEN: 'tok',
      K8S_NAMESPACE: 'zag-cloud',
      WORKER_IMAGE: 'worker:1',
      PUBLIC_WS_ENDPOINT: 'cc.example.com',
    } as NodeJS.ProcessEnv);
    expect(() => assertRuntimeConfig(ok)).not.toThrow();
  });
});
