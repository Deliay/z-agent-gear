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
 * Job 级硬性截止（秒）：防止异常工作容器无限期占用节点资源（24h 兜底）。
 * 注意 `ttlSecondsAfterFinished` 只对已完成的 Job 生效，无法回收 active 状态的 Job。
 */
export const JOB_ACTIVE_DEADLINE_SECONDS = 86400;

/**
 * 由云电脑 `expiresAt` 换算 Job `activeDeadlineSeconds`（裁决 A24 / B13）：
 * `max(60, floor((expiresAt-now)/1000))`；缺省/非法沿用 `JOB_ACTIVE_DEADLINE_SECONDS`。
 */
export function computeActiveDeadlineSeconds(
  expiresAt: Date | null | undefined,
  now: number = Date.now(),
): number {
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
    return JOB_ACTIVE_DEADLINE_SECONDS;
  }
  return Math.max(60, Math.floor((expiresAt.getTime() - now) / 1000));
}

/**
 * 工作容器资源约束：容器内含 dockerd，必须显式限制以免吃满节点。
 * 仅声明 limit 为资源耗尽时的硬上限；不设置 request（由 K8s 按 limit 处理）。
 */
export const JOB_RESOURCES = {
  limits: { cpu: '4', memory: '16Gi' },
} as const;

/**
 * 将 PUBLIC_WS_ENDPOINT 规范化为 `wss://<host>/worker`。
 * PUBLIC_WS_ENDPOINT **只允许 host(:port)**（协议可选、尾部斜杠可省、`/worker` 可显式给出）；
 * 若携带其它路径（如 `host/gateway`）会拼出 `wss://host/gateway/worker`，namespace 变成
 * `/gateway/worker` 永远注册不上，故 fail-fast 抛错（建议 F）。
 * 一次性 token **不放入 URL**（避免进入 ingress/中间层 access log，问题 11），
 * 改由 worker 经 Socket.IO 握手 `auth.token` 携带（见 agent-controller connectToServer）。
 */
export function buildServerEndpoint(publicWsEndpoint: string): string {
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
  } else if (trimmedPath === '/worker') {
    url.pathname = trimmedPath;
  } else {
    throw new Error(
      `PUBLIC_WS_ENDPOINT must be a host(:port) without a path ` +
        `(got path "${trimmedPath}"); the "/worker" namespace is appended automatically`,
    );
  }

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
  /** Job 硬性截止（秒）；缺省 `JOB_ACTIVE_DEADLINE_SECONDS`（云电脑由 expiresAt 换算）。 */
  activeDeadlineSeconds?: number;
  /**
   * 追加 env（`ZAG_*`）：仅 harness 使用；基础两项 `ZAG_SERVER_ENDPOINT` /
   * `ZAG_CONTROLLER_KEY` 始终由本模块注入且顺序在前。
   */
  env?: Record<string, string>;
}

export class K8sJobManager {
  /** 规范化后的 worker 对外地址；构造时即校验，非法 PUBLIC_WS_ENDPOINT fail-fast（建议 F）。 */
  private readonly serverEndpoint: string;

  constructor(
    private readonly client: K8sClient,
    private readonly cfg: JobManagerConfig,
  ) {
    this.serverEndpoint = buildServerEndpoint(cfg.publicWsEndpoint);
  }

  buildManifest(input: CreateJobInput): K8sJobManifest {
    const labels: Record<string, string> = {
      [WORKER_LABEL_KEY]: WORKER_LABEL_VALUE,
      [CONTAINER_ID_LABEL]: input.containerId,
    };
    const serverEndpoint = this.serverEndpoint;

    const spec: K8sJobManifest['spec'] = {
      backoffLimit: 0,
      activeDeadlineSeconds: input.activeDeadlineSeconds ?? JOB_ACTIVE_DEADLINE_SECONDS,
      ttlSecondsAfterFinished: TTL_SECONDS_AFTER_FINISHED,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          // 纵深防御：工作容器不需要集群 API 权限，禁止自动挂载 ServiceAccount token（C-6）。
          automountServiceAccountToken: false,
          containers: [
            {
              name: 'worker',
              image: this.cfg.image,
              env: [
                { name: 'ZAG_SERVER_ENDPOINT', value: serverEndpoint },
                { name: 'ZAG_CONTROLLER_KEY', value: input.token },
                ...Object.entries(input.env ?? {}).map(([name, value]) => ({ name, value })),
              ],
              resources: {
                limits: { ...JOB_RESOURCES.limits },
              },
            },
          ],
        },
      },
    };
    if (this.cfg.runtimeClassName) {
      spec.template.spec.runtimeClassName = this.cfg.runtimeClassName;
      // sysbox 要求 Pod 停用 host user namespace，否则 sandbox 创建失败
      // （见 K8sJobManifest.spec.template.spec.hostUsers 注释）。
      spec.template.spec.hostUsers = false;
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
