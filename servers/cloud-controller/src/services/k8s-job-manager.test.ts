import { describe, it, expect } from 'vitest';
import { InMemoryK8sClient } from './k8s-client.js';
import { buildServerEndpoint, K8sJobManager } from './k8s-job-manager.js';

function setup(publicWsEndpoint = 'cloud.example.com:4003') {
  const client = new InMemoryK8sClient();
  const manager = new K8sJobManager(client, {
    namespace: 'zag-workers',
    image: 'core.harbor.internal.fffdan.com/zero-tools/zag-worker:1.0.0',
    runtimeClassName: 'sysbox-runc',
    publicWsEndpoint,
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
    expect(manifest.spec.template.spec.runtimeClassName).toBe('sysbox-runc');
    expect(manifest.spec.template.spec.containers[0]?.image).toBe(
      'core.harbor.internal.fffdan.com/zero-tools/zag-worker:1.0.0',
    );
  });

  it('T-K2: env double-channel is injected with a correctly encoded endpoint', () => {
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
    expect(url.searchParams.get('token')).toBe(token);
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

  it('buildServerEndpoint normalises bare hosts and existing paths', () => {
    expect(buildServerEndpoint('cloud.example.com:4003', 't')).toBe(
      'wss://cloud.example.com:4003/worker?token=t',
    );
    expect(buildServerEndpoint('wss://cloud.example.com/worker', 't')).toBe(
      'wss://cloud.example.com/worker?token=t',
    );
    expect(buildServerEndpoint('https://cloud.example.com', 't')).toBe(
      'wss://cloud.example.com/worker?token=t',
    );
  });
});
