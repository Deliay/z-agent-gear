/**
 * 云电脑（`purpose=harness`）运行期 secret 的内存仓库。
 *
 * 约束（提案 §1.3 / 计划 Phase 5）：
 * - **不落库**：`cloudcontainers` 只保存 ID/引用，secret 明文仅在进程内存；
 * - **不打印**：本模块不产生任何日志，调用方也不得打印 secret 内容；
 * - 容器进入终态（exited/failed/destroying→exited）时由 `ContainerService` 删除。
 */
export interface HarnessSecrets {
  /** 标准连接（controller-api）端点，如 `wss://controller.example.com`。 */
  hostEndpoint: string;
  /** 标准连接使用的 ControllerKey（明文，仅内存）。 */
  hostKey: string;
  /** 运行专用模型 Key（明文，仅内存）。 */
  modelApiKey: string;
  /** 模型网关地址，如 `http://admin-api:8002/v1`。 */
  modelBaseUrl: string;
  /** 模型 ID JSON 数组字符串，如 `["model-a"]`。 */
  modelIds: string;
  /** 模型 ID → 最长上下文（token）JSON object 字符串；可选，缺省/空串表示无上下文信息。 */
  modelContextLengths?: string;
  /** 默认工作区（如 `/root/workspace`）。 */
  defaultWorkspace: string;
}

/** 最小 secret 存储契约（便于单测注入替身）。 */
export interface HarnessSecretStore {
  put(containerId: string, secrets: HarnessSecrets): void;
  get(containerId: string): HarnessSecrets | null;
  delete(containerId: string): boolean;
}

/** 进程内 Map 实现；读写均做浅拷贝，避免调用方持有可变引用。 */
export class SecretStore implements HarnessSecretStore {
  private readonly store = new Map<string, HarnessSecrets>();

  put(containerId: string, secrets: HarnessSecrets): void {
    this.store.set(containerId, { ...secrets });
  }

  get(containerId: string): HarnessSecrets | null {
    const found = this.store.get(containerId);
    return found ? { ...found } : null;
  }

  delete(containerId: string): boolean {
    return this.store.delete(containerId);
  }

  /** 当前持有的 secret 条数（仅用于健康检查/单测断言）。 */
  get size(): number {
    return this.store.size;
  }
}
