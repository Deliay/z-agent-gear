/**
 * K8s 客户端抽象：Job/PVC CRUD + Watch + Pod 读取。
 * `RealK8sClient` 走 @kubernetes/client-node；`InMemoryK8sClient` 用于本地/测试，
 * 记录 Job/PVC spec（含 env）供 E2E/mock 链路读取。
 */

export interface K8sEnvVar {
  name: string;
  value: string;
}

export interface K8sVolumeMount {
  name: string;
  mountPath: string;
  readOnly?: boolean;
}

export interface K8sVolume {
  name: string;
  persistentVolumeClaim?: { claimName: string; readOnly?: boolean };
}

export interface K8sContainer {
  name: string;
  image: string;
  env?: K8sEnvVar[];
  /** 主容器/初始化容器支持自定义命令（归档、恢复、用量、清理 Job）。 */
  command?: string[];
  args?: string[];
  resources?: K8sResourceRequirements;
  volumeMounts?: K8sVolumeMount[];
}

export interface K8sPodSecurityContext {
  fsGroup?: number;
  fsGroupChangePolicy?: 'OnRootMismatch' | 'Always';
}

/** PVC 清单（契约 A.2.7 / 提案实现点 2）。名称全部由服务端生成，不接受用户输入。 */
export interface K8sPvcManifest {
  apiVersion: 'v1';
  kind: 'PersistentVolumeClaim';
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
  };
  spec: {
    accessModes: string[];
    volumeMode?: 'Filesystem' | 'Block';
    resources: { requests: { storage: string } };
    /** 空/缺省时**整段省略**（使用集群默认 StorageClass；显式空串会禁用动态供给）。 */
    storageClassName?: string;
  };
}

export interface K8sPvcInfo {
  name: string;
  namespace: string;
  labels: Record<string, string>;
  capacity: string | null;
  storageClassName: string | null;
  accessModes: string[];
  phase: string | null;
}

export interface K8sResourceList {
  cpu: string;
  memory: string;
  /** 临时存储上限（键名含连字符需引号）；云电脑固定 10Gi（env 可覆盖）。 */
  'ephemeral-storage'?: string;
}

export interface K8sResourceRequirements {
  /** 不设置时由 K8s 处理（当前工作容器只声明 limits）。 */
  requests?: K8sResourceList;
  limits: K8sResourceList;
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
        /**
         * 使用 sysbox 等用户态容器 runtime 时必须为 false：否则 Pod 仍共享宿主 user
         * namespace，容器 init 写 `net.ipv4.ip_unprivileged_port_start` 会被内核拒绝
         * （FailedCreatePodSandBox / permission denied）。
         */
        hostUsers?: boolean;
        /**
         * 纵深防御：worker 不需要 K8s API 凭据，禁止自动挂载 ServiceAccount token
         * （C-6；`ZAG_HOST_KEY` 已注入 env，Pod 内不应再持有集群凭据）。
         */
        automountServiceAccountToken?: boolean;
        /**
         * PVC 写权限（云存储挂载）：`fsGroup: 1000` + `OnRootMismatch`，避免每次挂载全量 chown。
         * 未挂载云存储时**不设置该字段**（零回归）。
         */
        securityContext?: K8sPodSecurityContext;
        /** 已归档恢复的初始化容器（`tar -xjf`）；全新挂载时**不注入**（零回归）。 */
        initContainers?: K8sContainer[];
        /** PVC 卷（storage / archive）；未挂载云存储时**不设置**（零回归）。 */
        volumes?: K8sVolume[];
        /** 用量 du Job 固定节点（RWO PVC 同节点；裁决 15）。 */
        nodeName?: string;
        containers: K8sContainer[];
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
  /** 创建 PVC（已存在时由 Real 返回 409，调用方先 `get` 做幂等判定）。 */
  createPersistentVolumeClaim(manifest: K8sPvcManifest): Promise<void>;
  /** 读取 PVC；404 归一为 `null`（与 `getJob` 同口径）。 */
  getPersistentVolumeClaim(name: string): Promise<K8sPvcInfo | null>;
  /** 删除 PVC；404 视为成功（幂等）。 */
  deletePersistentVolumeClaim(name: string): Promise<void>;
  listPersistentVolumeClaims(labelSelector: string): Promise<K8sPvcInfo[]>;
  /** 读取归属 Pod 的 `spec.nodeName`（RWO PVC 同节点 du/归档用）；无匹配 Pod 返回 `null`。 */
  readPodNodeName(labelSelector: string): Promise<string | null>;
  /** 读取匹配 label 的 Pod 日志（归档/用量标记行解析）；无匹配 Pod 返回空串。 */
  readPodLogs(labelSelector: string): Promise<string>;
}

export const CONTAINER_ID_LABEL = 'zag.cloud/container-id';

/** 按 `k=v[,k2=v2]` 匹配标签（与 K8s labelSelector 的等值语义一致）。 */
export function matchesLabelSelector(
  labels: Record<string, string>,
  selector: string,
): boolean {
  return selector
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .every((part) => {
      const index = part.indexOf('=');
      if (index < 0) return Object.prototype.hasOwnProperty.call(labels, part);
      const key = part.slice(0, index);
      const value = part.slice(index + 1);
      return labels[key] === value;
    });
}

interface StoredJob {
  info: K8sJobInfo;
  manifest: K8sJobManifest;
}

export class InMemoryK8sClient implements K8sClient {
  private readonly jobs = new Map<string, StoredJob>();
  private readonly pvcs = new Map<string, { info: K8sPvcInfo; manifest: K8sPvcManifest }>();
  private watchers: Array<{
    selector: string;
    onEvent: (event: K8sJobEvent) => void;
    onClose?: (error?: unknown) => void;
  }> = [];

  /** 已创建的 manifest（供断言 env/标签）。 */
  readonly createdManifests: K8sJobManifest[] = [];
  /** 已创建的 PVC manifest（供断言标签/容量/StorageClass）。 */
  readonly createdPvcManifests: K8sPvcManifest[] = [];
  /** deleteJob 调用记录（供断言 propagationPolicy 与重试）。 */
  readonly deleteCalls: Array<{ name: string; options?: DeleteJobOptions }> = [];
  /** deletePersistentVolumeClaim 调用记录（供断言 404 幂等/重试）。 */
  readonly deletedPvcNames: string[] = [];
  /** 前 N 次 deleteJob 调用失败（模拟 K8s 异常）。 */
  failDeleteTimes = 0;
  /** 前 N 次 createJob 调用失败（模拟创建失败）。 */
  failCreateTimes = 0;
  /** 前 N 次 createPersistentVolumeClaim 调用失败（模拟 PVC 创建失败）。 */
  failCreatePvcTimes = 0;
  /** 前 N 次 deletePersistentVolumeClaim 调用失败（模拟删除失败，404 之外的异常）。 */
  failDeletePvcTimes = 0;
  /** Job 创建完成钩子（测试用：可在创建瞬间推进 phase / 写入 Pod 日志）。 */
  onJobCreated?: (manifest: K8sJobManifest) => void;

  private readonly podLogsByJob = new Map<string, string>();
  private readonly podNodesByJob = new Map<string, string>();

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
    this.onJobCreated?.(manifest);
    this.emit({ type: 'ADDED', job: info });
  }

  async createPersistentVolumeClaim(manifest: K8sPvcManifest): Promise<void> {
    if (this.failCreatePvcTimes > 0) {
      this.failCreatePvcTimes -= 1;
      throw new Error('createPersistentVolumeClaim failed');
    }
    this.createdPvcManifests.push(manifest);
    const info: K8sPvcInfo = {
      name: manifest.metadata.name,
      namespace: manifest.metadata.namespace,
      labels: manifest.metadata.labels,
      capacity: manifest.spec.resources.requests.storage,
      storageClassName: manifest.spec.storageClassName ?? null,
      accessModes: [...manifest.spec.accessModes],
      phase: 'Bound',
    };
    this.pvcs.set(info.name, { info, manifest });
  }

  async getPersistentVolumeClaim(name: string): Promise<K8sPvcInfo | null> {
    return this.pvcs.get(name)?.info ?? null;
  }

  async deletePersistentVolumeClaim(name: string): Promise<void> {
    this.deletedPvcNames.push(name);
    if (this.failDeletePvcTimes > 0) {
      this.failDeletePvcTimes -= 1;
      throw new Error('deletePersistentVolumeClaim failed');
    }
    this.pvcs.delete(name);
  }

  async listPersistentVolumeClaims(labelSelector: string): Promise<K8sPvcInfo[]> {
    return [...this.pvcs.values()]
      .map((entry) => entry.info)
      .filter((info) => matchesLabelSelector(info.labels, labelSelector));
  }

  async readPodNodeName(labelSelector: string): Promise<string | null> {
    const job = this.findJobByPodSelector(labelSelector);
    if (!job) return null;
    return this.podNodesByJob.get(job.name) ?? null;
  }

  async readPodLogs(labelSelector: string): Promise<string> {
    const job = this.findJobByPodSelector(labelSelector);
    if (!job) return '';
    return this.podLogsByJob.get(job.name) ?? '';
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

  getPvc(name: string): K8sPvcInfo | null {
    return this.pvcs.get(name)?.info ?? null;
  }

  getPvcManifest(name: string): K8sPvcManifest | null {
    return this.pvcs.get(name)?.manifest ?? null;
  }

  setPodLog(jobName: string, log: string): void {
    this.podLogsByJob.set(jobName, log);
  }

  setPodNode(jobName: string, nodeName: string): void {
    this.podNodesByJob.set(jobName, nodeName);
  }

  /** 模拟动态供给结果（Pending → Bound / Lost）。 */
  setPvcPhase(name: string, phase: string): void {
    const entry = this.pvcs.get(name);
    if (!entry) return;
    entry.info = { ...entry.info, phase };
  }

  private findJobBySelector(selector: string): K8sJobInfo | null {
    for (const entry of this.jobs.values()) {
      if (matchesLabelSelector(entry.info.labels, selector)) return entry.info;
    }
    return null;
  }

  /**
   * Pod 标签语义对齐真实集群：K8s 不会把 Job metadata.labels 复制给 Pod，
   * Pod 选择器必须匹配 `spec.template.metadata.labels`（缺省回退 Job labels 兼容历史夹具）。
   */
  private findJobByPodSelector(selector: string): K8sJobInfo | null {
    for (const entry of this.jobs.values()) {
      const podLabels = entry.manifest.spec.template.metadata?.labels ?? entry.info.labels;
      if (matchesLabelSelector(podLabels, selector)) return entry.info;
    }
    return null;
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

/**
 * watch 结束回调归一化：@kubernetes/client-node 的 done 回调在不同版本/异常路径下
 * 可能传入 Error（异常）或不传参数（正常关闭），历史上还曾传入 done 函数。
 * 抽出为纯函数以便在不依赖真实集群的情况下单测该分支。
 */
export function notifyWatchDone(
  err: unknown,
  onClose?: (error?: unknown) => void,
): void {
  if (typeof err === 'function') {
    (err as () => void)();
    onClose?.();
  } else {
    onClose?.(err);
  }
}

/*
 * c8 ignore start —— RealK8sClient 的其它方法直接调用 @kubernetes/client-node 的
 * 集群 API（ensureInitialized / createJob / listJobs / deleteJob），需要真实集群或
 * 完整 SDK mock 才能执行，单测由 InMemoryK8sClient 覆盖同一接口契约、部署侧由镜像
 * 冒烟与 tests/api 覆盖；watch done 回调分支已通过上方 notifyWatchDone 单测覆盖。
 */
export class RealK8sClient implements K8sClient {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  private initialized = false;
  private k8s: any;
  private kc: any;
  private batchApi: any;
  private coreApi: any;

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
    // PVC / Pod 读取（云存储）走 CoreV1Api。
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.initialized = true;
  }

  private isNotFound(err: any): boolean {
    return err?.code === 404 || err?.statusCode === 404 || err?.response?.statusCode === 404;
  }

  private toPvcInfo(pvc: any): K8sPvcInfo {
    return {
      name: pvc?.metadata?.name ?? '',
      namespace: pvc?.metadata?.namespace ?? this.namespace,
      labels: pvc?.metadata?.labels ?? {},
      capacity: pvc?.spec?.resources?.requests?.storage ?? null,
      storageClassName: pvc?.spec?.storageClassName ?? null,
      accessModes: pvc?.spec?.accessModes ?? [],
      phase: pvc?.status?.phase ?? null,
    };
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
      if (this.isNotFound(err)) {
        return null;
      }
      throw err;
    }
  }

  async createPersistentVolumeClaim(manifest: K8sPvcManifest): Promise<void> {
    await this.ensureInitialized();
    await this.coreApi.createNamespacedPersistentVolumeClaim({
      namespace: manifest.metadata.namespace,
      body: manifest,
    });
  }

  async getPersistentVolumeClaim(name: string): Promise<K8sPvcInfo | null> {
    await this.ensureInitialized();
    try {
      const pvc = await this.coreApi.readNamespacedPersistentVolumeClaim({
        name,
        namespace: this.namespace,
      });
      return this.toPvcInfo(pvc);
    } catch (err: any) {
      if (this.isNotFound(err)) return null;
      throw err;
    }
  }

  async deletePersistentVolumeClaim(name: string): Promise<void> {
    await this.ensureInitialized();
    try {
      await this.coreApi.deleteNamespacedPersistentVolumeClaim({
        name,
        namespace: this.namespace,
      });
    } catch (err: any) {
      // 契约 A.2.7：PVC 不存在按成功处理（幂等）。
      if (this.isNotFound(err)) return;
      throw err;
    }
  }

  async listPersistentVolumeClaims(labelSelector: string): Promise<K8sPvcInfo[]> {
    await this.ensureInitialized();
    const result = await this.coreApi.listNamespacedPersistentVolumeClaim({
      namespace: this.namespace,
      labelSelector,
    });
    const items: any[] = result?.items ?? [];
    return items.map((pvc) => this.toPvcInfo(pvc));
  }

  private async listPods(labelSelector: string): Promise<any[]> {
    await this.ensureInitialized();
    const result = await this.coreApi.listNamespacedPod({
      namespace: this.namespace,
      labelSelector,
    });
    return result?.items ?? [];
  }

  async readPodNodeName(labelSelector: string): Promise<string | null> {
    const pods = await this.listPods(labelSelector);
    return pods[0]?.spec?.nodeName ?? null;
  }

  async readPodLogs(labelSelector: string): Promise<string> {
    const pods = await this.listPods(labelSelector);
    const pod = pods[0];
    if (!pod?.metadata?.name) return '';
    try {
      const log = await this.coreApi.readNamespacedPodLog({
        name: pod.metadata.name,
        namespace: this.namespace,
        container: pod.spec?.containers?.[0]?.name,
      });
      return typeof log === 'string' ? log : '';
    } catch (err: any) {
      if (this.isNotFound(err)) return '';
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
        notifyWatchDone(err, onClose);
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
