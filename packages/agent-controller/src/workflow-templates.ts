import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * 项目工作流模板扫描（契约 agent-session-websocket.md §3.27/§3.28）。
 *
 * 仓库为模板唯一事实源：仅直读 `<workspacePath>/.zag/workflow/templates/` 下
 * 文件名以 `.json` 结尾的常规文件，不递归、不写回、不执行。
 * 上限：20 个文件 / 单文件 128KiB / 总量 1MiB。
 */

/** 固定子目录（相对项目工作区根） */
export const WORKFLOW_TEMPLATES_SUBDIR = '.zag/workflow/templates';
/** 最多扫描的文件数 */
export const WORKFLOW_TEMPLATES_MAX_FILES = 20;
/** 单文件读取上限（字节） */
export const WORKFLOW_TEMPLATES_MAX_FILE_BYTES = 128 * 1024;
/** 全部文件内容累计上限（字节） */
export const WORKFLOW_TEMPLATES_MAX_TOTAL_BYTES = 1024 * 1024;

export interface WorkflowTemplateFile {
  fileName: string;
  content?: string;
  /** 白名单文案：file too large / not found / permission denied */
  error?: string;
}

export interface WorkflowTemplateScanResult {
  success: boolean;
  templates: WorkflowTemplateFile[];
  truncated: boolean;
  /** 整体失败原因（白名单文案：file too large / not found / permission denied） */
  error?: string;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

/** 文件级错误归一为契约白名单文案 */
function mapFileError(err: unknown): string {
  const code = errorCode(err);
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'EFBIG' || code === 'ERR_FS_FILE_TOO_LARGE') return 'file too large';
  return 'not found';
}

/**
 * 扫描项目工作流模板目录。
 *
 * - 目录不存在（ENOENT / ENOTDIR）→ `{ success: true, templates: [], truncated: false }`
 * - 目录读取权限失败 → `{ success: false, templates: [], truncated: false, error: 'permission denied' }`
 * - 符号链接按 `stat` 判定为常规文件才读取；指向目录/设备的条目跳过
 */
export async function scanWorkflowTemplates(
  workspacePath: string,
): Promise<WorkflowTemplateScanResult> {
  const templatesDir = resolve(workspacePath, WORKFLOW_TEMPLATES_SUBDIR);

  let entries;
  try {
    entries = await readdir(templatesDir, { withFileTypes: true });
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { success: true, templates: [], truncated: false };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { success: false, templates: [], truncated: false, error: 'permission denied' };
    }
    return { success: false, templates: [], truncated: false, error: 'permission denied' };
  }

  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    if (entry.isFile()) {
      candidates.push(entry.name);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    try {
      const target = await stat(join(templatesDir, entry.name));
      if (target.isFile()) candidates.push(entry.name);
    } catch {
      // 悬空/不可解析的符号链接：跳过
    }
  }

  candidates.sort((a, b) => a.localeCompare(b));

  let truncated = false;
  if (candidates.length > WORKFLOW_TEMPLATES_MAX_FILES) {
    candidates.length = WORKFLOW_TEMPLATES_MAX_FILES;
    truncated = true;
  }

  const templates: WorkflowTemplateFile[] = [];
  let totalBytes = 0;

  for (const fileName of candidates) {
    const fullPath = join(templatesDir, fileName);
    try {
      const info = await stat(fullPath);
      if (info.size > WORKFLOW_TEMPLATES_MAX_FILE_BYTES) {
        templates.push({ fileName, error: 'file too large' });
        continue;
      }
      if (totalBytes + info.size > WORKFLOW_TEMPLATES_MAX_TOTAL_BYTES) {
        // 总量超限：停止读取后续文件（已读取的保留）
        truncated = true;
        break;
      }
      const content = await readFile(fullPath, { encoding: 'utf8' });
      const bytes = Buffer.byteLength(content, 'utf8');
      if (totalBytes + bytes > WORKFLOW_TEMPLATES_MAX_TOTAL_BYTES) {
        truncated = true;
        break;
      }
      totalBytes += bytes;
      templates.push({ fileName, content });
    } catch (err) {
      templates.push({ fileName, error: mapFileError(err) });
    }
  }

  return { success: true, templates, truncated };
}
