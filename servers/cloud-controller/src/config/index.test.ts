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
    expect(cfg.workloadInitTimeoutMs).toBe(300000);
    expect(cfg.workloadPostBudgetMs).toBe(90000);
    expect(cfg.workloadLogMaxBytes).toBe(262144);
  });

  it('reads workload overrides from env', () => {
    const cfg = loadConfig({
      WORKLOAD_INIT_TIMEOUT_MS: '1000',
      WORKLOAD_POST_BUDGET_MS: '2000',
      WORKLOAD_LOG_MAX_BYTES: '4096',
    } as NodeJS.ProcessEnv);
    expect(cfg.workloadInitTimeoutMs).toBe(1000);
    expect(cfg.workloadPostBudgetMs).toBe(2000);
    expect(cfg.workloadLogMaxBytes).toBe(4096);
  });

  it('fails fast on invalid workload numeric config (裁决 15)', () => {
    const invalid = ['not-a-number', '0', '-1', '1.5', ''];
    for (const value of invalid) {
      // 空字符串视为未提供（取默认），其余非法值 fail-fast
      if (value === '') {
        expect(loadConfig({ WORKLOAD_INIT_TIMEOUT_MS: value } as NodeJS.ProcessEnv).workloadInitTimeoutMs).toBe(300000);
        continue;
      }
      expect(
        () => loadConfig({ WORKLOAD_INIT_TIMEOUT_MS: value } as NodeJS.ProcessEnv),
        `WORKLOAD_INIT_TIMEOUT_MS=${value}`,
      ).toThrow(/WORKLOAD_INIT_TIMEOUT_MS/);
    }
    expect(() =>
      loadConfig({ WORKLOAD_POST_BUDGET_MS: 'abc' } as NodeJS.ProcessEnv),
    ).toThrow(/WORKLOAD_POST_BUDGET_MS/);
    expect(() => loadConfig({ WORKLOAD_LOG_MAX_BYTES: '0' } as NodeJS.ProcessEnv)).toThrow(
      /WORKLOAD_LOG_MAX_BYTES/,
    );
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
      INTERNAL_API_TOKEN: 'a-strong-internal-token-0123456789',
      K8S_NAMESPACE: 'zag-cloud',
      WORKER_IMAGE: 'worker:1',
      PUBLIC_WS_ENDPOINT: 'cc.example.com',
    } as NodeJS.ProcessEnv);
    expect(() => assertRuntimeConfig(ok)).not.toThrow();
  });

  it('assertRuntimeConfig rejects short and known-example internal tokens (问题 10)', () => {
    const base = {
      K8S_NAMESPACE: 'zag-cloud',
      WORKER_IMAGE: 'worker:1',
      PUBLIC_WS_ENDPOINT: 'cc.example.com',
    } as NodeJS.ProcessEnv;

    const short = loadConfig({ ...base, INTERNAL_API_TOKEN: 'short' } as NodeJS.ProcessEnv);
    expect(() => assertRuntimeConfig(short)).toThrow(/at least/);

    const example = loadConfig({
      ...base,
      INTERNAL_API_TOKEN: 'change-me-internal-token',
    } as NodeJS.ProcessEnv);
    expect(() => assertRuntimeConfig(example)).toThrow(/example\/default/);
  });

  it('assertRuntimeConfig rejects case/whitespace variants of known-example tokens (建议 C)', () => {
    const base = {
      K8S_NAMESPACE: 'zag-cloud',
      WORKER_IMAGE: 'worker:1',
      PUBLIC_WS_ENDPOINT: 'cc.example.com',
    } as NodeJS.ProcessEnv;

    const variants = [
      'CHANGE-ME-INTERNAL-TOKEN',
      '  change-me-internal-token  ',
      'Change-Me-Internal-Token',
      'change -me-internal-token',
    ];
    for (const token of variants) {
      const cfg = loadConfig({ ...base, INTERNAL_API_TOKEN: token } as NodeJS.ProcessEnv);
      expect(() => assertRuntimeConfig(cfg), `token=${JSON.stringify(token)}`).toThrow(
        /example\/default/,
      );
    }
  });
});
