/**
 * 会话模型来源推断（纯函数，裁决 R6）。
 *
 * 判定顺序：
 * 1. 平台库比对：以会话 `id` 作为模型标识与平台库 `name`（模型 id）比对；
 *    **不用展示名（name）比对**——展示名可由 Agent 任意设置，同名碰撞会把 Agent 自带模型
 *    误归为平台内置/自定义。仅当 `id` 为空时才回退用 name。
 *    平台库空名条目不参与比对。
 * 2. 标识解析（`provider/model` 形式 → Agent 自带）；
 * 3. 兜底「来源未知」。
 */

export type AgentModelSource = 'platform' | 'agent' | 'custom' | 'unknown';

export const SOURCE_GROUP: Record<AgentModelSource, string> = {
  platform: '平台内置',
  agent: 'Agent 自带',
  custom: '自定义',
  unknown: '来源未知',
};

/** 分组固定顺序（组内保持 availableModels 原始顺序） */
export const SOURCE_GROUP_ORDER: AgentModelSource[] = ['platform', 'agent', 'custom', 'unknown'];

export interface SourceLibraryEntry {
  name: string;
  scope: 'user' | 'global';
}

export interface ModelSourceResult {
  source: AgentModelSource;
  sourceProvider: string | null;
  group: string;
  basis: string;
}

const PROVIDER_PREFIX = /^([a-z0-9][a-z0-9._-]*)\/(.+)$/;

function key(value: string): string {
  return value.trim().toLowerCase();
}

/** 纯函数：三档推断（平台库命中优先于标识前缀） */
export function inferModelSource(
  model: { id: string; name: string },
  library: SourceLibraryEntry[],
): ModelSourceResult {
  const name = typeof model.name === 'string' ? model.name : '';
  const id = typeof model.id === 'string' ? model.id : '';

  // 1) 平台库比对：优先（且仅）以会话 id 作为模型标识；id 为空才回退展示名。
  //    不使用 name 兜底，避免展示名同名碰撞误归属。
  const identity = key(id) || key(name);
  const hit = identity
    ? library.find((m) => key(m.name) === identity && key(m.name) !== '')
    : undefined;

  if (hit) {
    const source: AgentModelSource = hit.scope === 'global' ? 'platform' : 'custom';
    return {
      source,
      sourceProvider: null,
      group: SOURCE_GROUP[source],
      basis: hit.scope === 'global' ? '按平台模型库比对（平台内置）' : '按平台模型库比对（自定义）',
    };
  }

  // 2) 标识解析：provider/model → Agent 自带
  const parsed = key(id).match(PROVIDER_PREFIX);
  if (parsed) {
    return {
      source: 'agent',
      sourceProvider: parsed[1],
      group: SOURCE_GROUP.agent,
      basis: `按标识前缀判定（${parsed[1]}）`,
    };
  }

  // 3) 兜底
  return {
    source: 'unknown',
    sourceProvider: null,
    group: SOURCE_GROUP.unknown,
    basis: '无法判定',
  };
}
