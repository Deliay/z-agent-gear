const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  vue: 'markup',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'protobuf',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'docker',
};

/**
 * 从文件路径推断 Prism 语言；未知扩展名回退纯文本（text）。
 */
export function languageFromPath(filePath?: string | null): string {
  if (!filePath) return 'text';
  const clean = filePath.split(/[?#]/)[0];
  const base = clean.split('/').pop() ?? clean;

  if (!base.includes('.')) {
    // Dockerfile / Makefile 等无扩展名特例
    if (base.toLowerCase() === 'dockerfile') return 'docker';
    return 'text';
  }

  const ext = base.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_LANGUAGE[ext] ?? 'text';
}
