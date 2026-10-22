/**
 * ACP 能力快照归一化（纯函数模块）。
 *
 * 设计要点（见实现计划裁决 R1/R2）：
 * - FeatureId 全集与平台支持矩阵集中在本文件，禁止在其他位置复制；
 * - 状态 = Agent 声明 × 平台支持 的二维合并：
 *     declared=false                        → unsupported
 *     declared=true  + platform full        → supported
 *     declared=true  + platform partial/none → partial（界面无入口或仅动态下发）
 * - `elicitation.*` / `config.boolean` 是 Client 能力，declared 取自本端声明；
 * - 未知 `_meta` 扩展键不产生 feature，只在 raw 中保留原文。
 */

export type AgentFeatureStatus = 'supported' | 'partial' | 'unsupported';

export interface AgentFeatureSupport {
  id: string;
  status: AgentFeatureStatus;
  detail: string | null;
}

export interface AgentCapabilitySnapshot {
  protocolVersion: number | null;
  agentInfo: { name: string; version: string | null } | null;
  features: AgentFeatureSupport[];
  raw: {
    agentCapabilities: unknown;
    authMethods: unknown;
    clientCapabilities: unknown;
  };
}

/** 本端 initialize 声明的 Client 能力（bridge 与 sync-bridge 共用，禁止重复字面量） */
export const CLIENT_CAPABILITIES = {
  session: { configOptions: { boolean: {} } },
  elicitation: { form: {}, url: {} },
} as const;

type PlatformSupport = 'full' | 'partial' | 'none';

/** 平台侧支持矩阵：full=有入口且可用，partial=仅动态/受限，none=无入口 */
const PLATFORM_SUPPORT: Record<string, PlatformSupport> = {
  'session.load': 'full',
  'session.resume': 'full',
  'session.close': 'full',
  'session.list': 'full',
  'session.delete': 'full',
  'session.fork': 'none',
  'session.additionalDirectories': 'none',
  'prompt.image': 'none',
  'prompt.audio': 'none',
  'prompt.embeddedContext': 'none',
  'auth.login': 'none',
  'auth.logout': 'none',
  'mcp.http': 'full',
  'mcp.sse': 'none',
  'config.boolean': 'full',
  'config.model': 'full',
  'config.mode': 'full',
  commands: 'partial',
  'elicitation.form': 'full',
  'elicitation.url': 'full',
};

/** 固定展示顺序（与实现计划裁决 R1 表格逐项一致） */
export const FEATURE_IDS = [
  'session.load',
  'session.resume',
  'session.close',
  'session.list',
  'session.delete',
  'session.fork',
  'session.additionalDirectories',
  'prompt.image',
  'prompt.audio',
  'prompt.embeddedContext',
  'auth.login',
  'auth.logout',
  'mcp.http',
  'mcp.sse',
  'config.boolean',
  'config.model',
  'config.mode',
  'commands',
  'elicitation.form',
  'elicitation.url',
] as const;

/** Agent 未声明时展示的字段路径 */
const SOURCE_FIELD: Record<string, string> = {
  'session.load': 'agentCapabilities.loadSession',
  'session.resume': 'agentCapabilities.sessionCapabilities.resume',
  'session.close': 'agentCapabilities.sessionCapabilities.close',
  'session.list': 'agentCapabilities.sessionCapabilities.list',
  'session.delete': 'agentCapabilities.sessionCapabilities.delete',
  'session.fork': 'agentCapabilities.sessionCapabilities.fork',
  'session.additionalDirectories': 'agentCapabilities.sessionCapabilities.additionalDirectories',
  'prompt.image': 'agentCapabilities.promptCapabilities.image',
  'prompt.audio': 'agentCapabilities.promptCapabilities.audio',
  'prompt.embeddedContext': 'agentCapabilities.promptCapabilities.embeddedContext',
  'auth.login': 'authMethods',
  'auth.logout': 'agentCapabilities.auth.logout',
  'mcp.http': 'agentCapabilities.mcpCapabilities.http',
  'mcp.sse': 'agentCapabilities.mcpCapabilities.sse',
  'config.boolean': 'clientCapabilities.session.configOptions.boolean',
  'config.model': 'configOptions(category=model)',
  'config.mode': 'configOptions(category=mode)/modes',
  commands: 'available_commands_update',
  'elicitation.form': 'clientCapabilities.elicitation.form',
  'elicitation.url': 'clientCapabilities.elicitation.url',
};

const PLATFORM_LIMITATION: Partial<Record<string, string>> = {
  'session.fork': '平台暂未提供入口',
  'session.additionalDirectories': '平台暂未提供入口',
  'prompt.image': '平台暂未提供附件入口',
  'prompt.audio': '平台暂未提供附件入口',
  'prompt.embeddedContext': '平台暂未提供附件入口',
  'auth.login': '平台暂未提供认证入口',
  'auth.logout': '平台暂未提供认证入口',
  'mcp.sse': '平台不支持 SSE 传输',
  commands: '平台仅动态下发（available_commands_update）',
};

const AGENT_NOTE: Partial<Record<string, string>> = {
  commands: '命令集由 available_commands_update 动态下发，平台已支持命令列表与 / 补全',
  'elicitation.form': 'Agent 是否发起取决于其触发条件',
  'elicitation.url': 'Agent 是否发起取决于其触发条件',
};

type CapabilityField = { readonly [key: string]: unknown } | null | undefined;

/**
 * ACP 能力布尔判定：`true` 或非 null 对象（`{}` 表示「已通告」）均视为已声明；
 * `null`/`undefined`/`false` 为未声明。
 */
export function isTruthyCapability(value: unknown): boolean {
  if (value === true) return true;
  return typeof value === 'object' && value !== null;
}

export interface NormalizeCapabilitiesInput {
  protocolVersion: number | null;
  agentInfo: { name: string; version: string | null } | null;
  /** initialize 返回的 agentCapabilities 原文（含 _meta） */
  agentCapabilities: unknown;
  /** initialize 返回的 authMethods 原文 */
  authMethods: unknown;
  /** 本端 initialize 发送的 clientCapabilities 原文 */
  clientCapabilities: unknown;
  /** 已归一化的会话配置项（session/new 响应） */
  configOptions: Array<{ id: string; type: string; category?: string | null }>;
  /** session/new 的 modes[]（旧 Agent 回退通道） */
  modes: Array<{ id: string; name: string }>;
}

interface DeclaredFeature {
  declared: boolean;
  /** Agent 侧补充说明（可选） */
  note?: string;
}

function asRecord(value: unknown): CapabilityField {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function declaredMap(input: NormalizeCapabilitiesInput): Record<string, DeclaredFeature> {
  const caps = asRecord(input.agentCapabilities);
  const sessionCaps = asRecord(caps?.sessionCapabilities);
  const promptCaps = asRecord(caps?.promptCapabilities);
  const mcpCaps = asRecord(caps?.mcpCapabilities);
  const authCaps = asRecord(caps?.auth);
  const clientCaps = asRecord(input.clientCapabilities);
  const clientSession = asRecord(clientCaps?.session);
  const clientConfigOptions = asRecord(clientSession?.configOptions);
  const clientElicitation = asRecord(clientCaps?.elicitation);

  const authMethods = Array.isArray(input.authMethods) ? input.authMethods : [];
  const hasSelectConfig = (category: string): boolean =>
    input.configOptions.some((opt) => opt.category === category && opt.type === 'select');

  return {
    'session.load': { declared: caps?.loadSession === true },
    'session.resume': { declared: isTruthyCapability(sessionCaps?.resume) },
    'session.close': { declared: isTruthyCapability(sessionCaps?.close) },
    'session.list': { declared: isTruthyCapability(sessionCaps?.list) },
    'session.delete': { declared: isTruthyCapability(sessionCaps?.delete) },
    'session.fork': { declared: isTruthyCapability(sessionCaps?.fork) },
    'session.additionalDirectories': { declared: isTruthyCapability(sessionCaps?.additionalDirectories) },
    'prompt.image': { declared: promptCaps?.image === true },
    'prompt.audio': { declared: promptCaps?.audio === true },
    'prompt.embeddedContext': { declared: promptCaps?.embeddedContext === true },
    'auth.login': { declared: authMethods.length > 0 },
    'auth.logout': { declared: isTruthyCapability(authCaps?.logout) },
    'mcp.http': { declared: mcpCaps?.http === true },
    'mcp.sse': { declared: mcpCaps?.sse === true },
    'config.boolean': { declared: isTruthyCapability(clientConfigOptions?.boolean) },
    'config.model': { declared: hasSelectConfig('model') },
    'config.mode': { declared: hasSelectConfig('mode') || input.modes.length > 0 },
    commands: { declared: true },
    'elicitation.form': { declared: isTruthyCapability(clientElicitation?.form) },
    'elicitation.url': { declared: isTruthyCapability(clientElicitation?.url) },
  };
}

function mergeStatus(
  id: string,
  declared: boolean,
  note: string | undefined,
): AgentFeatureSupport {
  const platform = PLATFORM_SUPPORT[id] ?? 'none';

  if (!declared) {
    return {
      id,
      status: 'unsupported',
      detail: `未声明 ${SOURCE_FIELD[id] ?? 'unknown'}`,
    };
  }

  if (platform === 'full') {
    return { id, status: 'supported', detail: note ?? null };
  }

  const limitation = PLATFORM_LIMITATION[id] ?? '平台暂未提供入口';
  const detail = [note, limitation].filter((part): part is string => Boolean(part)).join('；');
  return { id, status: 'partial', detail };
}

/** 快照 raw 体积上限：`_meta` 等扩展字段由 Agent 任意控制，避免放大 WS/Mongo 写入 */
export const RAW_SNAPSHOT_MAX_BYTES = 16 * 1024;

/** 原文留存带体积上限：超限时只保留可诊断摘要，不原样外露/落库 */
function capRaw(value: unknown): unknown {
  if (value == null) return null;
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return null;
    // UTF-8 字节口径（TextEncoder 在 Node/浏览器一致；避免依赖 Buffer 类型）
    const bytes = new TextEncoder().encode(json).length;
    if (bytes <= RAW_SNAPSHOT_MAX_BYTES) return value;
    return {
      truncated: true,
      originalBytes: bytes,
      preview: json.slice(0, 512),
    };
  } catch {
    return null;
  }
}

/**
 * 归一化能力快照。输出固定 20 项（FEATURE_IDS 顺序），与 Agent 是否广播无关。
 */
export function normalizeCapabilities(input: NormalizeCapabilitiesInput): AgentCapabilitySnapshot {
  const declared = declaredMap(input);

  const features = FEATURE_IDS.map((id) => {
    const entry = declared[id] ?? { declared: false };
    const note = entry.note ?? AGENT_NOTE[id];
    return mergeStatus(id, entry.declared, note);
  });

  return {
    protocolVersion: input.protocolVersion ?? null,
    agentInfo: input.agentInfo ?? null,
    features,
    raw: {
      agentCapabilities: capRaw(input.agentCapabilities),
      authMethods: capRaw(input.authMethods),
      clientCapabilities: capRaw(input.clientCapabilities),
    },
  };
}
