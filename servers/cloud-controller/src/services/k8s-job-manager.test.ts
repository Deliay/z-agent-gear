import { describe, it, expect } from 'vitest';
import { InMemoryK8sClient } from './k8s-client.js';
import {
  buildServerEndpoint,
  K8sJobManager,
} from './k8s-job-manager.js';

function setup(
  publicWsEndpoint = 'cloud.example.com:4003',
  overrides: { ephemeralStorage?: string } = {},
) {
  const client = new InMemoryK8sClient();
  const manager = new K8sJobManager(client, {
    namespace: 'zag-workers',
    image: 'core.harbor.internal.fffdan.com/zero-tools/zag-worker:1.0.0',
    runtimeClassName: 'sysbox-runc',
    publicWsEndpoint,
    ...overrides,
  });
  return { client, manager };
}

describe('K8sJobManager', () => {
  it('T-K1: manifest fields are generated correctly', () => {
    const { manager } = setup();
    const manifest = manager.buildManifest({
      jobName: 'zag-worker-abc123',
      containerId: 'container-1',
      token: 'container-1.secret',
    });

    expect(manifest.apiVersion).toBe('batch/v1');
    expect(manifest.kind).toBe('Job');
    expect(manifest.metadata.name).toBe('zag-worker-abc123');
    expect(manifest.metadata.namespace).toBe('zag-workers');
    expect(manifest.metadata.labels).toMatchObject({
      app: 'zag-worker',
      'zag.cloud/container-id': 'container-1',
    });
    expect(manifest.spec.backoffLimit).toBe(0);
    expect(manifest.spec.ttlSecondsAfterFinished).toBe(600);
    expect(manifest.spec.template.spec.restartPolicy).toBe('Never');
    expect(manifest.spec.template.spec.automountServiceAccountToken).toBe(false);
    expect(manifest.spec.template.spec.runtimeClassName).toBe('sysbox-runc');
    expect(manifest.spec.template.spec.containers[0]?.image).toBe(
      'core.harbor.internal.fffdan.com/zero-tools/zag-worker:1.0.0',
    );
  });

  it('T-K7: sysbox runtimeClassName requires hostUsers: false', () => {
    const { manager } = setup();
    const manifest = manager.buildManifest({
      jobName: 'zag-worker-abc123',
      containerId: 'container-1',
      token: 'container-1.secret',
    });

    // sysbox 要求 Pod 停用 host user namespace（否则写入 net.ipv4.ip_unprivileged_port_start 被拒）
    expect(manifest.spec.template.spec.hostUsers).toBe(false);
  });

  it('T-K8: no runtimeClassName leaves hostUsers unset', () => {
    const client = new InMemoryK8sClient();
    const manager = new K8sJobManager(client, {
      namespace: 'zag-workers',
      image: 'core.harbor.internal.fffdan.com/zero-tools/zag-worker:1.0.0',
      publicWsEndpoint: 'cloud.example.com:4003',
    });
    const manifest = manager.buildManifest({
      jobName: 'zag-worker-abc123',
      containerId: 'container-1',
      token: 'container-1.secret',
    });

    expect(manifest.spec.template.spec.runtimeClassName).toBeUndefined();
    expect(manifest.spec.template.spec.hostUsers).toBeUndefined();
  });

  it('T-K5: manifest declares resource constraints and no activeDeadlineSeconds', () => {
    const { manager } = setup();
    const manifest = manager.buildManifest({
      jobName: 'zag-worker-abc123',
      containerId: 'container-1',
      token: 'container-1.secret',
    });

    // 最长运行时间无限制：不设置 activeDeadlineSeconds，避免活跃容器被 K8s 到期强杀
    expect(manifest.spec).not.toHaveProperty('activeDeadlineSeconds');
    const resources = manifest.spec.template.spec.containers[0]!.resources;
    expect(resources.requests).toBeUndefined();
    expect(resources.limits).toEqual({ cpu: '4', memory: '16Gi', 'ephemeral-storage': '10Gi' });
  });

  it('T-K5b: JOB_EPHEMERAL_STORAGE override applies to limits', () => {
    const { manager } = setup(undefined, { ephemeralStorage: '5Gi' });
    const manifest = manager.buildManifest({
      jobName: 'zag-worker-abc123',
      containerId: 'container-1',
      token: 'container-1.secret',
    });
    const resources = manifest.spec.template.spec.containers[0]!.resources;
    expect(resources.requests).toBeUndefined();
    expect(resources.limits['ephemeral-storage']).toBe('5Gi');
  });

  it('T-K5c: omitting the override falls back to 10Gi', () => {
    const { manager } = setup();
    const manifest = manager.buildManifest({
      jobName: 'zag-worker-abc123',
      containerId: 'container-1',
      token: 'container-1.secret',
    });
    const resources = manifest.spec.template.spec.containers[0]!.resources;
    expect(resources.requests).toBeUndefined();
    expect(resources.limits['ephemeral-storage']).toBe('10Gi');
  });

  it('T-K2: env injects token via ZAG_CONTROLLER_KEY and a token-free endpoint', () => {
    const { manager } = setup('wss://cloud.example.com');
    const token = 'container-1.a+b/c=d';
    const manifest = manager.buildManifest({
      jobName: 'zag-worker-abc123',
      containerId: 'container-1',
      token,
    });
    const env = Object.fromEntries(
      manifest.spec.template.spec.containers[0]!.env.map((e) => [e.name, e.value]),
    );

    expect(env.ZAG_CONTROLLER_KEY).toBe(token);
    const url = new URL(env.ZAG_SERVER_ENDPOINT!);
    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('cloud.example.com');
    expect(url.pathname).toBe('/worker');
    // 问题 11：token 不再进入 URL query（改由握手 auth 携带）
    expect(url.search).toBe('');
  });

  it('T-K3: createJob failure propagates', async () => {
    const { client, manager } = setup();
    client.failCreateTimes = 1;

    await expect(
      manager.createJob({ jobName: 'zag-worker-fail', containerId: 'c1', token: 'c1.s' }),
    ).rejects.toThrow('createJob failed');
    expect(client.getManifest('zag-worker-fail')).toBeNull();
  });

  it('T-K4: deleteJob uses Foreground then falls back to Background after retries', async () => {
    const { client, manager } = setup();
    await manager.createJob({ jobName: 'zag-worker-del', containerId: 'c1', token: 'c1.s' });
    client.failDeleteTimes = 3; // exhaust the 3 Foreground attempts

    await manager.deleteJob('zag-worker-del');

    const foreground = client.deleteCalls.filter(
      (c) => c.options?.propagationPolicy === 'Foreground',
    );
    const background = client.deleteCalls.filter(
      (c) => c.options?.propagationPolicy === 'Background',
    );
    expect(foreground.length).toBe(3);
    expect(background.length).toBe(1);
    expect(await client.getJob('zag-worker-del')).toBeNull();
  });

  it('buildServerEndpoint normalises bare hosts and existing paths (token-free)', () => {
    expect(buildServerEndpoint('cloud.example.com:4003')).toBe(
      'wss://cloud.example.com:4003/worker',
    );
    expect(buildServerEndpoint('wss://cloud.example.com/worker')).toBe(
      'wss://cloud.example.com/worker',
    );
    expect(buildServerEndpoint('https://cloud.example.com')).toBe(
      'wss://cloud.example.com/worker',
    );
  });

  it('T-K6: rejects a PUBLIC_WS_ENDPOINT that carries a non-canonical path (建议 F)', () => {
    // `host/gateway` 会拼出 wss://host/gateway/worker，namespace 变 /gateway/worker
    // 永远注册不上 → fail-fast，而非静默产出坏地址。
    expect(() => buildServerEndpoint('cloud.example.com/gateway')).toThrow(/host\(:port\)/);
    expect(() => setup('wss://cloud.example.com/gateway')).toThrow(/host\(:port\)/);
  });

  it('T-CC7: harness 额外 env 追加在基础两项之后（ZAG_CONTROLLER_KEY 仍为一次性 token）', () => {
    const { manager } = setup();
    const manifest = manager.buildManifest({
      jobName: 'zag-worker-harness',
      containerId: 'container-h',
      token: 'container-h.secret',
      env: {
        ZAG_HOST_ENDPOINT: 'wss://controller.example.com',
        ZAG_HOST_KEY: 'zag_k_1_host',
        ZAG_HOST_NAME: 'my-pc',
        ZAG_HARNESS_TYPES: 'opencode',
        ZAG_DEFAULT_WORKSPACE: '/home/worker/workspace',
        ZAG_USER_TYPE: 'front_user',
        ZAG_USER_ID: 'user-1',
      },
    });

    const env = Object.fromEntries(
      manifest.spec.template.spec.containers[0]!.env.map((e) => [e.name, e.value]),
    );
    expect(manifest.spec.template.spec.containers[0]!.env.slice(0, 2).map((e) => e.name)).toEqual([
      'ZAG_SERVER_ENDPOINT',
      'ZAG_CONTROLLER_KEY',
    ]);
    expect(env.ZAG_CONTROLLER_KEY).toBe('container-h.secret');
    expect(env.ZAG_HOST_ENDPOINT).toBe('wss://controller.example.com');
    expect(env.ZAG_HOST_KEY).toBe('zag_k_1_host');
    expect(env.ZAG_HOST_NAME).toBe('my-pc');
    expect(env.ZAG_HARNESS_TYPES).toBe('opencode');
    expect(env.ZAG_DEFAULT_WORKSPACE).toBe('/home/worker/workspace');
    expect(env.ZAG_USER_TYPE).toBe('front_user');
    expect(env.ZAG_USER_ID).toBe('user-1');
    // 模型 Key 仅走 workload:run.env，不进入 Job env
    expect(env.ZAG_MODEL_API_KEY).toBeUndefined();
    expect(manifest.spec).not.toHaveProperty('activeDeadlineSeconds');
  });

  it('T-CC8: idle Job 保持旧两项 env 且不设置 activeDeadlineSeconds', () => {
    const { manager } = setup();
    const manifest = manager.buildManifest({
      jobName: 'zag-worker-idle',
      containerId: 'container-i',
      token: 'container-i.secret',
    });
    expect(manifest.spec.template.spec.containers[0]!.env.map((e) => e.name)).toEqual([
      'ZAG_SERVER_ENDPOINT',
      'ZAG_CONTROLLER_KEY',
    ]);
    expect(manifest.spec).not.toHaveProperty('activeDeadlineSeconds');
  });
});
