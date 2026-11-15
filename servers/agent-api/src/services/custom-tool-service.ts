import mongoose from 'mongoose';
import { CustomTool } from '../models/custom-tool.js';
import { validateFragments, type Fragment } from './fragment-render.js';
import {
  assertWorkspaceWritable,
  getWorkspaceContext,
  type WorkspaceContext,
} from './workspace-context.js';

/**
 * 自定义工具**唯一读写口**（需求 #449；契约 `contracts/custom-tool.graphql` + `fragment-template.md`）。
 *
 * 语义（计划 Phase 2）：
 * - 读写入口统一 `requireContext()`（无 ALS 工作区上下文 → `workspace not found`）+ 写入口
 *   `assertWorkspaceWritable`（全局工作区 developer → `global workspace is read-only`）；
 * - 跨工作区 id → `Not found`（存在性探针区分）、不存在 id → `custom tool not found`；
 * - 创建/更新共用 `validateCustomToolInput` 纯函数：name/description/args/Fragment 引用一致性/http
 *   各项逐字命中契约白名单；
 * - 重名两道防线：服务层预检 + 唯一索引 E11000 映射 `duplicate custom tool name`；
 * - 删除按 id + 可见集 `deleteOne`，无级联（Valut 引用按名弱引用，不持有 ref）。
 *
 * 明文边界：本服务不接触任何 Valut 明文（只校验引用名规则），不记录配置内容日志。
 */

type Doc = Record<string, unknown>;

const WORKSPACE_NOT_FOUND = 'workspace not found';

const NAME_MIN_LENGTH = 1;
const NAME_MAX_LENGTH = 64;
const DESCRIPTION_MAX_LENGTH = 512;
const ARG_MAX_COUNT = 32;
const ARG_NAME_MAX_LENGTH = 64;
const ARG_DESCRIPTION_MAX_LENGTH = 256;
const ARG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const VALUT_KEY_MAX_LENGTH = 128;
const VALUT_KEY_FORBIDDEN = /[\s\p{Cc}]/u;
const HTTP_METHOD_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/;
const HEADER_KEY_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const QUERY_KEY_FORBIDDEN = /[\s\p{Cc}]/u;
/** GET 类不承载 body（PRD「GET 类隐藏 body」）。 */
const BODY_FORBIDDEN_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'DELETE']);

export type CustomToolType = 'prompt' | 'http';
export type CustomToolBodyType = 'text' | 'json' | 'form';

export interface CustomToolArgView {
  key: string;
  name: string;
  description: string | null;
}

export interface CustomToolFormFieldView {
  key: string;
  type: 'text' | 'file';
  value: Fragment[];
}

export interface CustomToolKeyValueView {
  key: string;
  value: Fragment[];
}

export interface CustomToolHttpConfigView {
  method: string;
  endpoint: Fragment[];
  insecure: boolean;
  bodyType: CustomToolBodyType | null;
  body: Fragment[] | null;
  form: CustomToolFormFieldView[] | null;
  headers: CustomToolKeyValueView[];
  queries: CustomToolKeyValueView[];
}

export interface CustomToolView {
  id: string;
  name: string;
  description: string | null;
  type: CustomToolType;
  args: CustomToolArgView[];
  prompt: Fragment[] | null;
  http: CustomToolHttpConfigView | null;
  workspaceId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomToolArgInput {
  key: string;
  name: string;
  description?: string | null;
}

export interface CustomToolFormFieldInput {
  key: string;
  type: 'text' | 'file';
  value: Fragment[];
}

export interface CustomToolKeyValueInput {
  key: string;
  value: Fragment[];
}

export interface CustomToolHttpConfigInput {
  method: string;
  endpoint: Fragment[];
  insecure?: boolean | null;
  bodyType?: CustomToolBodyType | null;
  body?: Fragment[] | null;
  form?: CustomToolFormFieldInput[] | null;
  headers?: CustomToolKeyValueInput[] | null;
  queries?: CustomToolKeyValueInput[] | null;
}

export interface CustomToolInput {
  name?: string | null;
  description?: string | null;
  type?: CustomToolType | null;
  args?: CustomToolArgInput[] | null;
  prompt?: Fragment[] | null;
  http?: CustomToolHttpConfigInput | null;
}

export interface CreateCustomToolParams {
  name: string;
  description?: string | null;
  type: CustomToolType;
  args: CustomToolArgInput[];
  prompt?: Fragment[] | null;
  http?: CustomToolHttpConfigInput | null;
  createdBy: string;
}

export interface UpdateCustomToolParams {
  name?: string | null;
  description?: string | null;
  type?: CustomToolType | null;
  args?: CustomToolArgInput[] | null;
  prompt?: Fragment[] | null;
  http?: CustomToolHttpConfigInput | null;
}

/** MCP 链路所需最小字段（`custom-tools-mcp` 暴露目录与调用）。 */
export interface CustomToolMcpEntry {
  id: string;
  name: string;
  description: string | null;
  type: CustomToolType;
  args: CustomToolArgView[];
  prompt: Fragment[] | null;
  http: CustomToolHttpConfigView | null;
  workspaceId: string;
  createdBy: string;
}

interface ValidatedInput {
  name: string;
  description: string | null;
  type: CustomToolType;
  args: CustomToolArgView[];
  prompt: Fragment[] | null;
  http: CustomToolHttpConfigView | null;
}

function str(value: unknown): string {
  return String(value);
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return date.toISOString();
}

function isDuplicateKeyError(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) return true;
  return err instanceof Error && /E11000|duplicate key/i.test(err.message);
}

function mapWriteError(err: unknown): Error {
  return isDuplicateKeyError(err) ? new Error('duplicate custom tool name') : (err as Error);
}

function validateName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length < NAME_MIN_LENGTH || name.length > NAME_MAX_LENGTH) {
    throw new Error('invalid custom tool name');
  }
  return name;
}

function validateDescription(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string' || raw.length > DESCRIPTION_MAX_LENGTH) {
    throw new Error('invalid custom tool description');
  }
  const description = raw.trim();
  return description ? description : null;
}

function validateArgs(raw: unknown): CustomToolArgView[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > ARG_MAX_COUNT) throw new Error('invalid custom tool args');
  const seen = new Set<string>();
  return (raw as unknown[]).map((item) => {
    if (!item || typeof item !== 'object') throw new Error('invalid custom tool args');
    const { key: rawKey, name: rawName, description: rawDescription } = item as {
      key?: unknown;
      name?: unknown;
      description?: unknown;
    };
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!ARG_KEY_RE.test(key) || seen.has(key)) throw new Error('invalid custom tool args');
    if (!name || name.length > ARG_NAME_MAX_LENGTH) throw new Error('invalid custom tool args');
    let description: string | null = null;
    if (rawDescription !== null && rawDescription !== undefined) {
      if (
        typeof rawDescription !== 'string' ||
        rawDescription.length > ARG_DESCRIPTION_MAX_LENGTH
      ) {
        throw new Error('invalid custom tool args');
      }
      description = rawDescription.trim() || null;
    }
    seen.add(key);
    return { key, name, description };
  });
}

function validateValutKey(value: string): boolean {
  return value.length >= 1 && value.length <= VALUT_KEY_MAX_LENGTH && !VALUT_KEY_FORBIDDEN.test(value);
}

/** Fragment 模板校验（保存期统一收敛为 `invalid fragment template`）。 */
function validateTemplate(raw: unknown, label: string): Fragment[] {
  if (raw === undefined || raw === null) throw new Error(label);
  try {
    return validateFragments(raw);
  } catch {
    throw new Error(label);
  }
}

/**
 * 引用一致性：Parameter 片段必须引用已声明 args；Valut 片段必须符合 valut key 规则。
 * 任一违反 → 传入的 label（默认 `invalid fragment template`）。
 */
function assertReferences(
  fragments: Fragment[],
  argKeys: Set<string>,
  label = 'invalid fragment template',
): void {
  for (const fragment of fragments) {
    if (fragment.type === 'Parameter' && !argKeys.has(fragment.value)) {
      throw new Error(label);
    }
    if (fragment.type === 'Valut' && !validateValutKey(fragment.value)) {
      throw new Error(label);
    }
  }
}

function validateKeyValues(raw: unknown, kind: 'header' | 'query'): CustomToolKeyValueView[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 32) throw new Error('invalid http config');
  const seen = new Set<string>();
  return (raw as unknown[]).map((item) => {
    if (!item || typeof item !== 'object') throw new Error('invalid http config');
    const { key: rawKey, value } = item as { key?: unknown; value?: unknown };
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!key) throw new Error('invalid http config');
    if (kind === 'header') {
      if (!HEADER_KEY_RE.test(key)) throw new Error('invalid http config');
    } else if (QUERY_KEY_FORBIDDEN.test(key)) {
      throw new Error('invalid http config');
    }
    const lower = key.toLowerCase();
    if (seen.has(lower)) throw new Error('invalid http config');
    seen.add(lower);
    return { key, value: validateTemplate(value, 'invalid http config') };
  });
}

function validateForm(raw: unknown): CustomToolFormFieldView[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('invalid http config');
  const seen = new Set<string>();
  return (raw as unknown[]).map((item) => {
    if (!item || typeof item !== 'object') throw new Error('invalid http config');
    const { key: rawKey, type, value } = item as {
      key?: unknown;
      type?: unknown;
      value?: unknown;
    };
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!key || seen.has(key)) throw new Error('invalid http config');
    if (type === 'file') throw new Error('invalid http config'); // 本期保留字段但拒绝保存
    if (type !== 'text') throw new Error('invalid http config');
    seen.add(key);
    return { key, type, value: validateTemplate(value, 'invalid http config') };
  });
}

function validateHttp(raw: unknown): CustomToolHttpConfigView {
  if (!raw || typeof raw !== 'object') throw new Error('invalid http config');
  const input = raw as CustomToolHttpConfigInput;

  const method = typeof input.method === 'string' ? input.method.trim() : '';
  if (!method || !HTTP_METHOD_RE.test(method)) throw new Error('invalid http config');

  const endpoint = validateTemplate(input.endpoint, 'invalid http config');
  if (endpoint.length === 0) throw new Error('invalid http config');
  const first = endpoint[0];
  if (first.type !== 'Plain') throw new Error('invalid http config');
  const firstValue = first.value.trim().toLowerCase();
  if (!firstValue.startsWith('http://') && !firstValue.startsWith('https://')) {
    throw new Error('invalid http config');
  }

  const bodyType =
    input.bodyType === null || input.bodyType === undefined
      ? null
      : typeof input.bodyType === 'string' &&
          ['text', 'json', 'form'].includes(input.bodyType)
        ? input.bodyType
        : undefined;
  if (bodyType === undefined) throw new Error('invalid http config');
  if (bodyType && BODY_FORBIDDEN_METHODS.has(method.toUpperCase())) {
    throw new Error('invalid http config');
  }

  const body =
    bodyType === 'text' || bodyType === 'json'
      ? validateTemplate(input.body, 'invalid http config')
      : null;
  const form = bodyType === 'form' ? validateForm(input.form) : null;
  if (bodyType === 'text' || bodyType === 'json') {
    if (!body || body.length === 0) throw new Error('invalid http config');
  }

  const headers = validateKeyValues(input.headers, 'header');
  const queries = validateKeyValues(input.queries, 'query');

  return {
    method,
    endpoint,
    insecure: input.insecure === true,
    bodyType,
    body,
    form,
    headers,
    queries,
  };
}

/**
 * 创建/更新共用的纯校验函数（唯一形状收敛点）：
 * name → description → args → type 配置（prompt/http）→ 引用一致性。
 */
export function validateCustomToolInput(
  type: CustomToolType,
  input: CustomToolInput,
  nameOverride?: string,
): ValidatedInput {
  const name = validateName(nameOverride ?? input.name);
  const description = validateDescription(input.description);
  const args = validateArgs(input.args);
  const argKeys = new Set(args.map((arg) => arg.key));

  if (type === 'prompt') {
    const prompt = validateTemplate(input.prompt, 'invalid fragment template');
    if (prompt.length === 0) throw new Error('invalid fragment template');
    assertReferences(prompt, argKeys);
    return { name, description, type, args, prompt, http: null };
  }

  if (type !== 'http') throw new Error('invalid custom tool name');
  const http = validateHttp(input.http);
  assertReferences(http.endpoint, argKeys, 'invalid http config');
  for (const header of http.headers) {
    assertReferences(header.value, argKeys, 'invalid http config');
  }
  for (const query of http.queries) {
    assertReferences(query.value, argKeys, 'invalid http config');
  }
  if (http.body) assertReferences(http.body, argKeys, 'invalid http config');
  if (http.form) {
    for (const field of http.form) assertReferences(field.value, argKeys, 'invalid http config');
  }
  return { name, description, type, args, prompt: null, http };
}

function mapFragments(raw: unknown): Fragment[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Doc[]).map((fragment) => ({
    type: str(fragment.type) as Fragment['type'],
    value: str(fragment.value),
    format: str(fragment.format) as Fragment['format'],
  }));
}

function mapHttp(raw: unknown): CustomToolHttpConfigView | null {
  if (!raw || typeof raw !== 'object') return null;
  const doc = raw as Doc;
  const bodyType =
    doc.bodyType === null || doc.bodyType === undefined
      ? null
      : (str(doc.bodyType) as CustomToolBodyType);
  const mapKeyValues = (value: unknown): CustomToolKeyValueView[] =>
    Array.isArray(value)
      ? (value as Doc[]).map((item) => ({
          key: str(item.key),
          value: mapFragments(item.value),
        }))
      : [];
  return {
    method: str(doc.method),
    endpoint: mapFragments(doc.endpoint),
    insecure: doc.insecure === true,
    bodyType,
    body: bodyType === 'text' || bodyType === 'json' ? mapFragments(doc.body) : null,
    form:
      bodyType === 'form' && Array.isArray(doc.form)
        ? (doc.form as Doc[]).map((field) => ({
            key: str(field.key),
            type: str(field.type) === 'file' ? 'file' : 'text',
            value: mapFragments(field.value),
          }))
        : null,
    headers: mapKeyValues(doc.headers),
    queries: mapKeyValues(doc.queries),
  };
}

function mapTool(doc: Doc): CustomToolView {
  const type = str(doc.type) === 'http' ? 'http' : 'prompt';
  return {
    id: str(doc._id),
    name: str(doc.name),
    description:
      doc.description === null || doc.description === undefined ? null : str(doc.description),
    type,
    args: Array.isArray(doc.args)
      ? (doc.args as Doc[]).map((arg) => ({
          key: str(arg.key),
          name: str(arg.name),
          description:
            arg.description === null || arg.description === undefined
              ? null
              : str(arg.description),
        }))
      : [],
    prompt: type === 'prompt' ? mapFragments(doc.prompt) : null,
    http: type === 'http' ? mapHttp(doc.http) : null,
    workspaceId: str(doc.workspaceId),
    createdBy: str(doc.createdBy),
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
}

export class CustomToolService {
  private requireContext(): WorkspaceContext {
    const context = getWorkspaceContext();
    if (!context) throw new Error(WORKSPACE_NOT_FOUND);
    return context;
  }

  /** 当前工作区列表（独占型可见集）；无上下文 → 拒绝。 */
  async list(): Promise<CustomToolView[]> {
    this.requireContext();
    const docs = (await CustomTool.find({}).sort({ createdAt: 1, _id: 1 }).lean()) as unknown as Doc[];
    return docs.map(mapTool);
  }

  /** 单条查询：不存在 → null；跨工作区 → `Not found`。 */
  async get(id: string): Promise<CustomToolView | null> {
    this.requireContext();
    try {
      return await this.loadView(id);
    } catch (err) {
      if (err instanceof Error && err.message === 'custom tool not found') return null;
      throw err;
    }
  }

  /** MCP 链路最小字段列表（与 `list` 同可见集，实时查询无快照）。 */
  async listForMcp(): Promise<CustomToolMcpEntry[]> {
    this.requireContext();
    const docs = (await CustomTool.find({}).sort({ createdAt: 1, _id: 1 }).lean()) as unknown as Doc[];
    return docs.map((doc) => {
      const view = mapTool(doc);
      return {
        id: view.id,
        name: view.name,
        description: view.description,
        type: view.type,
        args: view.args,
        prompt: view.prompt,
        http: view.http,
        workspaceId: view.workspaceId,
        createdBy: view.createdBy,
      };
    });
  }

  async create(params: CreateCustomToolParams): Promise<CustomToolView> {
    const context = this.requireContext();
    assertWorkspaceWritable(context);

    const validated = validateCustomToolInput(params.type, params);
    const dup = await CustomTool.findOne({ name: validated.name }).lean();
    if (dup) throw new Error('duplicate custom tool name');

    const doc = new CustomTool({
      tenantId: context.tenantId,
      workspaceId: context.id,
      name: validated.name,
      description: validated.description,
      type: validated.type,
      args: validated.args,
      prompt: validated.prompt,
      http: validated.http,
      createdBy: params.createdBy,
    });
    try {
      await doc.save();
    } catch (err) {
      throw mapWriteError(err);
    }
    return this.loadView(String(doc._id));
  }

  async update(id: string, params: UpdateCustomToolParams): Promise<CustomToolView> {
    const context = this.requireContext();
    assertWorkspaceWritable(context);
    const tool = await this.loadTool(id);
    const current = mapTool(tool);

    const type = params.type ?? current.type;
    const merged: CustomToolInput = {
      name: params.name !== undefined ? params.name : current.name,
      description: params.description !== undefined ? params.description : current.description,
      type,
      args: params.args !== undefined ? params.args : current.args,
      prompt: params.prompt !== undefined ? params.prompt : current.prompt,
      http: params.http !== undefined ? params.http : current.http,
    };
    const validated = validateCustomToolInput(type, merged, String(merged.name));

    if (validated.name !== current.name) {
      const dup = await CustomTool.findOne({ name: validated.name }).lean();
      if (dup) throw new Error('duplicate custom tool name');
    }

    try {
      await CustomTool.updateOne(
        { _id: tool._id },
        {
          $set: {
            name: validated.name,
            description: validated.description,
            type: validated.type,
            args: validated.args,
            prompt: validated.prompt,
            http: validated.http,
          },
        },
      );
    } catch (err) {
      throw mapWriteError(err);
    }
    return this.loadView(str(tool._id));
  }

  async delete(id: string): Promise<boolean> {
    const context = this.requireContext();
    assertWorkspaceWritable(context);
    const tool = await this.loadTool(id);
    const result = await CustomTool.deleteOne({ _id: tool._id });
    return result.deletedCount === 1;
  }

  private async loadView(id: string): Promise<CustomToolView> {
    return mapTool(await this.loadTool(id));
  }

  /**
   * 按 id 载入（受工作区可见集约束）：
   * - 非法 id / 不存在 → `custom tool not found`；
   * - 存在但不在当前工作区 → `Not found`。
   */
  private async loadTool(id: string): Promise<Doc> {
    if (!mongoose.isValidObjectId(id)) throw new Error('custom tool not found');
    const doc = (await CustomTool.findOne({ _id: id }).lean()) as Doc | null;
    if (doc) return doc;
    const foreign = await mongoose.connection
      .collection('customtools')
      .findOne({ _id: new mongoose.Types.ObjectId(id) }, { projection: { _id: 1 } });
    if (foreign) throw new Error('Not found');
    throw new Error('custom tool not found');
  }
}

export const customToolService = new CustomToolService();
