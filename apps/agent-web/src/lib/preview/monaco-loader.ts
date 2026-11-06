/**
 * Monaco 动态加载 seam（裁决 7）。
 *
 * 唯一加载入口：动态 `import()`（对齐 MermaidBlock 懒加载先例），注册
 * `editor.worker?worker` 与 `self.MonacoEnvironment`；仅 editor core +
 * `basic-languages`（无 LSP / 无语言 worker）。测试经 mock 本模块验证交互逻辑，
 * 真实渲染走 E2E。Vite `manualChunks` 将 monaco 单列独立 chunk。
 */

export interface MonacoModule {
  editor: typeof import('monaco-editor').editor;
  languages: typeof import('monaco-editor').languages;
  MarkerSeverity: typeof import('monaco-editor').MarkerSeverity;
  KeyMod: typeof import('monaco-editor').KeyMod;
  KeyCode: typeof import('monaco-editor').KeyCode;
  Range: typeof import('monaco-editor').Range;
  Uri: typeof import('monaco-editor').Uri;
}

let monacoPromise: Promise<MonacoModule> | null = null;

/** 动态加载 monaco editor core（进程内单例；失败可重试） */
export async function loadMonaco(): Promise<MonacoModule> {
  if (monacoPromise) return monacoPromise;
  monacoPromise = (async () => {
    const monaco = await import('monaco-editor');
    // monaco-editor exports map：`./* → ./esm/vs/*.js`（不含 esm/vs 前缀）
    const worker = await import('monaco-editor/editor/editor.worker.js?worker');
    (self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
      getWorker: () => new worker.default(),
    };
    return monaco as unknown as MonacoModule;
  })();
  try {
    return await monacoPromise;
  } catch (err) {
    monacoPromise = null;
    throw err;
  }
}

/** 测试辅助：重置加载单例 */
export function resetMonacoLoader(): void {
  monacoPromise = null;
}
