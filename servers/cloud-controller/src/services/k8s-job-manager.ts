import {
  CONTAINER_ID_LABEL,
  type DeleteJobOptions,
  type K8sClient,
  type K8sJobEvent,
  type K8sJobInfo,
  type K8sJobManifest,
} from './k8s-client.js';

export const WORKER_LABEL_KEY = 'app';
export const WORKER_LABEL_VALUE = 'zag-worker';
export const WORKER_LABEL_SELECTOR = `${WORKER_LABEL_KEY}=${WORKER_LABEL_VALUE}`;
export const TTL_SECONDS_AFTER_FINISHED = 600;
export const DELETE_MAX_ATTEMPTS = 3;

/**
 * 将 PUBLIC_WS_ENDPOINT 规范化并拼接 `/worker?token=<encoded>`。
 * PUBLIC_WS_ENDPOINT 可能已含协议（wss/https/http）或不含，可能带尾部斜杠或路径。
 * 输出保证 `wss://<host>/worker?token=<url-encoded token>`。
 */
export function buildServerEndpoint(publicWsEndpoint: string, token: string): string {
  const raw = (publicWsEndpoint ?? '').trim();
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `wss://${raw}`;

  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    url = new URL(`wss://${raw.replace(/^\/+/, '')}`);
  }

  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') url.protocol = 'wss:';

  url.hash = '';
  url.search = '';

  const trimmedPath = url.pathname.replace(/\/+$/, '');
  if (!trimmedPath) {
    url.pathname = '/worker';
  } else if (trimmedPath.endsWith('/worker')) {
    url.pathname = trimmedPath;
  } else {
    url.pathname = `${trimmedPath}/worker`;
  }

  url.searchParams.set('token', token);
  return url.toString();
}

export interface JobManagerConfig {
  namespace: string;
  image: string;
  runtimeClassName?: string;
  publicWsEndpoint: string;
}

export interface CreateJobInput {
  jobName: string;
  containerId: string;
  token: string;
}

export class K8sJobManager {
  constructor(
    private readonly client: K8sClient,
    private readonly cfg: JobManagerConfig,
  ) {}

  buildManifest(input: CreateJobInput): K8sJobManifest {
    const labels: Record<string, string> = {
      [WORKER_LABEL_KEY]: WORKER_LABEL_VALUE,
      [CONTAINER_ID_LABEL]: input.containerId,
    };
    const serverEndpoint = buildServerEndpoint(this.cfg.publicWsEndpoint, input.token);

    const spec: K8sJobManifest['spec'] = {
      backoffLimit: 0,
      ttlSecondsAfterFinished: TTL_SECONDS_AFTER_FINISHED,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          containers: [
            {
              name: 'worker',
              image: this.cfg.image,
              env: [
                { name: 'ZAG_SERVER_ENDPOINT', value: serverEndpoint },
                { name: 'ZAG_CONTROLLER_KEY', value: input.token },
              ],
            },
          ],
        },
      },
    };
    if (this.cfg.runtimeClassName) {
      spec.template.spec.runtimeClassName = this.cfg.runtimeClassName;
    }

    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: input.jobName,
        namespace: this.cfg.namespace,
        labels,
      },
      spec,
    };
  }

  async createJob(input: CreateJobInput): Promise<K8sJobManifest> {
    const manifest = this.buildManifest(input);
    await this.client.createJob(manifest);
    return manifest;
  }

  async getJob(name: string): Promise<K8sJobInfo | null> {
    return this.client.getJob(name);
  }

  async listJobs(): Promise<K8sJobInfo[]> {
    return this.client.listJobs(WORKER_LABEL_SELECTOR);
  }

  /**
   * 默认 Foreground 删除，失败重试 2 次（共 3 次）后回退 Background，确保资源回收。
   */
  async deleteJob(name: string, options?: DeleteJobOptions): Promise<void> {
    const primary = options?.propagationPolicy ?? 'Foreground';
    const first = await this.tryDelete(name, primary);
    if (first.ok) return;

    if (primary === 'Foreground') {
      const fallback = await this.tryDelete(name, 'Background');
      if (fallback.ok) return;
      throw fallback.error;
    }
    throw first.error;
  }

  private async tryDelete(
    name: string,
    propagationPolicy: 'Foreground' | 'Background',
  ): Promise<{ ok: true } | { ok: false; error: unknown }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < DELETE_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.client.deleteJob(name, { propagationPolicy });
        return { ok: true };
      } catch (err) {
        lastError = err;
      }
    }
    return { ok: false, error: lastError };
  }

  watchJobs(
    onEvent: (event: K8sJobEvent) => void,
    onClose?: (error?: unknown) => void,
  ): Promise<() => void> {
    return this.client.watchJobs(WORKER_LABEL_SELECTOR, onEvent, onClose);
  }
}
