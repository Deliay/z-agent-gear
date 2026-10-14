/**
 * K8s 客户端抽象：Job CRUD + Watch。
 * `RealK8sClient` 走 @kubernetes/client-node；`InMemoryK8sClient` 用于本地/测试，
 * 记录 Job spec（含 env）供 E2E/mock 链路读取。
 */

export interface K8sEnvVar {
  name: string;
  value: string;
}

export interface K8sJobManifest {
  apiVersion: 'batch/v1';
  kind: 'Job';
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
  };
  spec: {
    backoffLimit: number;
    ttlSecondsAfterFinished: number;
    template: {
      metadata: { labels: Record<string, string> };
      spec: {
        restartPolicy: string;
        runtimeClassName?: string;
        containers: Array<{
          name: string;
          image: string;
          env: K8sEnvVar[];
        }>;
      };
    };
  };
}

export type K8sJobPhase = 'active' | 'succeeded' | 'failed';

export interface K8sJobInfo {
  name: string;
  namespace: string;
  labels: Record<string, string>;
  phase: K8sJobPhase;
  containerId: string | null;
  message?: string;
}

export interface K8sJobEvent {
  type: 'ADDED' | 'MODIFIED' | 'DELETED';
  job: K8sJobInfo;
}

export interface DeleteJobOptions {
  propagationPolicy?: 'Foreground' | 'Background';
}

export interface K8sClient {
  createJob(manifest: K8sJobManifest): Promise<void>;
  getJob(name: string): Promise<K8sJobInfo | null>;
  listJobs(labelSelector: string): Promise<K8sJobInfo[]>;
  deleteJob(name: string, options?: DeleteJobOptions): Promise<void>;
  watchJobs(
    labelSelector: string,
    onEvent: (event: K8sJobEvent) => void,
    onClose?: (error?: unknown) => void,
  ): Promise<() => void>;
}

export const CONTAINER_ID_LABEL = 'zag.cloud/container-id';

interface StoredJob {
  info: K8sJobInfo;
  manifest: K8sJobManifest;
}

export class InMemoryK8sClient implements K8sClient {
  private readonly jobs = new Map<string, StoredJob>();
  private watchers: Array<{
    selector: string;
    onEvent: (event: K8sJobEvent) => void;
    onClose?: (error?: unknown) => void;
  }> = [];

  /** 已创建的 manifest（供断言 env/标签）。 */
  readonly createdManifests: K8sJobManifest[] = [];
  /** deleteJob 调用记录（供断言 propagationPolicy 与重试）。 */
  readonly deleteCalls: Array<{ name: string; options?: DeleteJobOptions }> = [];
  /** 前 N 次 deleteJob 调用失败（模拟 K8s 异常）。 */
  failDeleteTimes = 0;
  /** 前 N 次 createJob 调用失败（模拟创建失败）。 */
  failCreateTimes = 0;

  async createJob(manifest: K8sJobManifest): Promise<void> {
    if (this.failCreateTimes > 0) {
      this.failCreateTimes -= 1;
      throw new Error('createJob failed');
    }
    this.createdManifests.push(manifest);
    const labels = manifest.metadata.labels;
    const info: K8sJobInfo = {
      name: manifest.metadata.name,
      namespace: manifest.metadata.namespace,
      labels,
      phase: 'active',
      containerId: labels[CONTAINER_ID_LABEL] ?? null,
    };
    this.jobs.set(info.name, { info, manifest });
    this.emit({ type: 'ADDED', job: info });
  }

  async getJob(name: string): Promise<K8sJobInfo | null> {
    return this.jobs.get(name)?.info ?? null;
  }

  async listJobs(labelSelector: string): Promise<K8sJobInfo[]> {
    const [key, value] = labelSelector.split('=');
    return [...this.jobs.values()]
      .map((entry) => entry.info)
      .filter((info) => (key && value ? info.labels[key] === value : true));
  }

  async deleteJob(name: string, options?: DeleteJobOptions): Promise<void> {
    this.deleteCalls.push({ name, options });
    if (this.failDeleteTimes > 0) {
      this.failDeleteTimes -= 1;
      throw new Error('deleteJob failed');
    }
    const entry = this.jobs.get(name);
    this.jobs.delete(name);
    if (entry) {
      this.emit({ type: 'DELETED', job: entry.info });
    }
  }

  async watchJobs(
    labelSelector: string,
    onEvent: (event: K8sJobEvent) => void,
    onClose?: (error?: unknown) => void,
  ): Promise<() => void> {
    const watcher = { selector: labelSelector, onEvent, onClose };
    this.watchers.push(watcher);
    return () => {
      this.watchers = this.watchers.filter((w) => w !== watcher);
    };
  }

  // ---- 测试辅助 ----

  getManifest(name: string): K8sJobManifest | null {
    return this.jobs.get(name)?.manifest ?? null;
  }

  getEnv(name: string): Record<string, string> {
    const manifest = this.getManifest(name);
    const env = manifest?.spec.template.spec.containers[0]?.env ?? [];
    return Object.fromEntries(env.map((e) => [e.name, e.value]));
  }

  setPhase(name: string, phase: K8sJobPhase, message?: string): void {
    const entry = this.jobs.get(name);
    if (!entry) return;
    entry.info = { ...entry.info, phase, message };
    this.emit({ type: 'MODIFIED', job: entry.info });
  }

  simulateWatchClose(error?: unknown): void {
    for (const watcher of this.watchers) {
      watcher.onClose?.(error);
    }
  }

  watcherCount(): number {
    return this.watchers.length;
  }

  private emit(event: K8sJobEvent): void {
    for (const watcher of this.watchers) {
      watcher.onEvent(event);
    }
  }
}

/* c8 ignore start */
export class RealK8sClient implements K8sClient {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  private initialized = false;
  private k8s: any;
  private kc: any;
  private batchApi: any;

  constructor(private readonly namespace: string) {}

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const k8s = await import('@kubernetes/client-node');
    const kc = new k8s.KubeConfig();
    try {
      kc.loadFromDefault();
    } catch {
      kc.loadFromCluster();
    }
    this.k8s = k8s;
    this.kc = kc;
    this.batchApi = kc.makeApiClient(k8s.BatchV1Api);
    this.initialized = true;
  }

  private toInfo(job: any): K8sJobInfo {
    const conditions: any[] = job?.status?.conditions ?? [];
    const failed = conditions.find((c) => c.type === 'Failed' && c.status === 'True');
    const complete = conditions.find((c) => c.type === 'Complete' && c.status === 'True');
    const phase: K8sJobPhase = failed ? 'failed' : complete ? 'succeeded' : 'active';
    const labels: Record<string, string> = job?.metadata?.labels ?? {};
    return {
      name: job?.metadata?.name ?? '',
      namespace: job?.metadata?.namespace ?? this.namespace,
      labels,
      phase,
      containerId: labels[CONTAINER_ID_LABEL] ?? null,
      message: failed?.message ?? failed?.reason,
    };
  }

  async createJob(manifest: K8sJobManifest): Promise<void> {
    await this.ensureInitialized();
    await this.batchApi.createNamespacedJob({
      namespace: manifest.metadata.namespace,
      body: manifest,
    });
  }

  async getJob(name: string): Promise<K8sJobInfo | null> {
    await this.ensureInitialized();
    try {
      const job = await this.batchApi.readNamespacedJob({ name, namespace: this.namespace });
      return this.toInfo(job);
    } catch (err: any) {
      if (err?.code === 404 || err?.statusCode === 404 || err?.response?.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async listJobs(labelSelector: string): Promise<K8sJobInfo[]> {
    await this.ensureInitialized();
    const result = await this.batchApi.listNamespacedJob({
      namespace: this.namespace,
      labelSelector,
    });
    const items: any[] = result?.items ?? [];
    return items.map((job) => this.toInfo(job));
  }

  async deleteJob(name: string, options?: DeleteJobOptions): Promise<void> {
    await this.ensureInitialized();
    await this.batchApi.deleteNamespacedJob({
      name,
      namespace: this.namespace,
      propagationPolicy: options?.propagationPolicy ?? 'Foreground',
    });
  }

  async watchJobs(
    labelSelector: string,
    onEvent: (event: K8sJobEvent) => void,
    onClose?: (error?: unknown) => void,
  ): Promise<() => void> {
    await this.ensureInitialized();
    const watch = new this.k8s.Watch(this.kc);
    const path = `/apis/batch/v1/namespaces/${this.namespace}/jobs`;
    const req = await watch.watch(
      path,
      { labelSelector },
      (type: K8sJobEvent['type'], apiObj: any) => {
        onEvent({ type, job: this.toInfo(apiObj) });
      },
      (err: unknown) => {
        if (typeof err === 'function') {
          (err as () => void)();
          onClose?.();
        } else {
          onClose?.(err);
        }
      },
    );
    return () => req.abort();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
/* c8 ignore stop */

export interface K8sClientConfig {
  k8sEnabled: boolean;
  k8sNamespace: string;
}

export function createK8sClient(cfg: K8sClientConfig): K8sClient {
  if (!cfg.k8sEnabled) {
    return new InMemoryK8sClient();
  }
  return new RealK8sClient(cfg.k8sNamespace);
}
